import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { builtinsDir, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { pythonFactory, resolverPath } from '../src/python'
import { ServerPoolError, type NavServerStatus, type NavigationServer } from '../src/servers'
import type { NavResult } from '../src/service'

let harness: Harness | undefined
let root: string | undefined
let runner: OwnedProcessRunner | undefined
let server: NavigationServer | undefined
let savedEnv: Map<string, string | undefined> | undefined
const pids = new Set<number>()
const envKeys = ['HOME', 'QUIRKY_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_HOME', 'OPENAI_HOME']
const pluginDir = join(import.meta.dir, '..')
type Status = { servers: NavServerStatus[]; limits: Record<string, number>; idleMs: number }

function isolate() {
  savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  root = mkdtempSync(join(tmpdir(), 'nav py é-'))
  process.env.HOME = root
  process.env.QUIRKY_HOME = join(root, 'home')
  for (const key of envKeys.slice(2)) delete process.env[key]
  return root
}

async function call<T = unknown>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return await client.callAny(`quirky.navigation/${method}`, params) as T
}

async function status(client: QuirkyClient): Promise<Status> {
  const result = await call<Status>(client, 'status')
  for (const entry of result.servers) if (entry.pid) pids.add(entry.pid)
  return result
}

async function start() {
  const temp = isolate()
  const workspace = join(temp, 'workspace')
  cpSync(join(import.meta.dir, 'fixtures/py'), workspace, { recursive: true })
  harness = await startHarness({ home: process.env.QUIRKY_HOME!, builtinPluginsDir: builtinsDir() })
  const admin = await harness.connect()
  await admin.callAny('quirky.repo/add', { path: workspace, folder: true })
  const worktree = await admin.callAny('quirky.worktree/resolve', { selector: 'current', cwd: workspace }) as { id: string }
  const client = await QuirkyClient.connect(rpcUrl(harness.runtime), { role: 'cli', cwd: workspace, worktreeId: worktree.id })
  harness.clients.push(client)
  return { client, workspace, real: realpathSync(workspace), worktree }
}

async function navigate(client: QuirkyClient, method: 'definition' | 'references', line = 5, column = 21, path = 'main.py') {
  try { return await call<NavResult>(client, method, { path, line, column }) }
  finally { await status(client) }
}

function positions(result: NavResult) {
  return result.locations.map(({ relativePath, line, column, endLine, endColumn }) => [relativePath, line, column, endLine, endColumn])
}

function exists(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

afterEach(async () => {
  try { await server?.stop(); await harness?.cleanup(); await runner?.dispose() } finally {
    server = undefined
    harness = undefined
    runner = undefined
    for (const pid of pids) if (exists(pid)) process.kill(pid, 'SIGKILL')
    pids.clear()
    for (const [key, value] of savedEnv ?? []) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

test('reports a missing Python interpreter as not-found', async () => {
  const path = isolate()
  runner = createProcessRunner({ owner: 'python-factory-test' })
  const factory = pythonFactory({ process: runner, pluginDir, findPython: () => null })
  const error = await factory({ id: 'test', path }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ServerPoolError)
  expect(error).toMatchObject({ kind: 'not-found', message: expect.stringContaining('python3') })
})

test('reports Python below 3.8 with the startup diagnostic', async () => {
  const path = isolate()
  const executable = join(path, 'old-python')
  writeFileSync(executable, '#!/bin/sh\necho "quirky navigation needs Python 3.8 or newer, found 3.7" >&2\nexit 3\n', { mode: 0o755 })
  runner = createProcessRunner({ owner: 'python-factory-test' })
  const error = await pythonFactory({ process: runner, pluginDir, findPython: () => executable })({ id: 'test', path }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ServerPoolError)
  expect(error).toMatchObject({ kind: 'not-found', message: expect.stringContaining('quirky navigation needs Python 3.8 or newer, found 3.7') })
})

test('identifies the interpreter and shipped resolver', async () => {
  const path = isolate()
  runner = createProcessRunner({ owner: 'python-factory-test' })
  const python = Bun.which('python3')!
  server = await pythonFactory({ process: runner, pluginDir, findPython: () => python })({ id: 'test', path })
  expect(server.runtime).toBe(python)
  expect(server.serverPath).toBe(resolverPath(pluginDir))
  expect(await Bun.file(server.serverPath).exists()).toBe(true)
})

test('answers Python definitions, references, module previews and pool status', async () => {
  const { client, real, worktree } = await start()
  expect(await navigate(client, 'definition')).toEqual({
    worktreeId: worktree.id, language: 'python', truncated: false,
    locations: [{ path: join(real, 'pkg/mod.py'), relativePath: 'pkg/mod.py', line: 4, column: 5, endLine: 4, endColumn: 10, preview: 'def greet(name):' }]
  })
  const references = await navigate(client, 'references')
  expect(positions(references)).toEqual([
    ['main.py', 2, 17, 2, 22], ['main.py', 5, 21, 5, 26], ['main.py', 8, 9, 8, 14],
    ['pkg/__init__.py', 1, 18, 1, 23], ['pkg/mod.py', 4, 5, 4, 10], ['pkg/mod.py', 13, 36, 13, 41]
  ])
  expect(references.locations[0]!.preview).toBe('from pkg import greet')
  expect(await status(client)).toMatchObject({
    servers: [{ language: 'python', requests: 2, runtime: Bun.which('python3'), serverPath: expect.stringContaining('/plugins/quirky.navigation/assets/resolver.py') }],
    limits: { typescript: 2, python: 4 }, idleMs: 600000
  })
  expect(await navigate(client, 'definition', 8, 7)).toMatchObject({ locations: [{ line: 1, column: 1, endLine: 1, endColumn: 1, preview: 'GREETING = "hello"' }] })
}, 60000)

test('navigates Python stubs and keeps Unicode separators inside Python lines', async () => {
  const { client, workspace } = await start()
  writeFileSync(join(workspace, 'types.pyi'), 'from pkg.mod import Greeter\nx: Greeter\n')
  const stub = await navigate(client, 'definition', 2, 4, 'types.pyi')
  expect(stub.language).toBe('python')
  expect(positions(stub)).toEqual([['pkg/mod.py', 8, 7, 8, 14]])
  writeFileSync(join(workspace, 'ls.py'), 's = "a\u2028b"\nfrom pkg.mod import greet\ngreet(s)\n')
  expect((await navigate(client, 'references', 4, 5, 'pkg/mod.py')).locations).toContainEqual(expect.objectContaining({ relativePath: 'ls.py', line: 3, column: 1, endLine: 3, endColumn: 6, preview: 'greet(s)' }))
  expect(positions(await navigate(client, 'definition', 3, 1, 'ls.py'))).toEqual([['pkg/mod.py', 4, 5, 4, 10]])
}, 60000)

test('caps Python references in stable file and position order', async () => {
  const { client, workspace } = await start()
  mkdirSync(join(workspace, 'gen'))
  for (let i = 0; i < 500; i++) writeFileSync(join(workspace, 'gen', `m${String(i).padStart(3, '0')}.py`), `from pkg import greet\n\n\ndef f${i}():\n    return greet("${i}")\n`)
  const result = await navigate(client, 'references', 4, 5, 'pkg/mod.py')
  expect(result.truncated).toBe(true)
  expect(result.locations).toHaveLength(1000)
  expect(positions(result)[0]).toEqual(['gen/m000.py', 1, 17, 1, 22])
  expect(positions(result).at(-1)).toEqual(['gen/m499.py', 5, 12, 5, 17])
}, 60000)

test('stops the Python process and removes it from status', async () => {
  const { client } = await start()
  await navigate(client, 'definition')
  const pid = (await status(client)).servers[0]!.pid!
  expect(await call<{ stopped: number }>(client, 'stop', { language: 'python' })).toEqual({ stopped: 1 })
  expect((await status(client)).servers).toEqual([])
  await waitFor(() => !exists(pid), 5000)
}, 60000)

test('CLI answers Python definition from the worktree cwd', async () => {
  const { client, workspace, real, worktree } = await start()
  try {
    const result = await runCli(['nav', 'definition', 'main.py', '--line', '5', '--column', '21', '--json'], {
      home: process.env.QUIRKY_HOME!, cwd: workspace, env: { HOME: root!, QUIRKY_HOME: process.env.QUIRKY_HOME! }
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ worktreeId: worktree.id, language: 'python', truncated: false,
      locations: [{ path: join(real, 'pkg/mod.py'), relativePath: 'pkg/mod.py', line: 4, column: 5, endLine: 4, endColumn: 10, preview: 'def greet(name):' }] })
  } finally { await status(client) }
}, 60000)
