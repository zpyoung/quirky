import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, RpcError, RpcErrorCode } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { builtinsDir, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { NavigationService, type NavResult } from '../src/service'
import { ServerPool, type NavServerStatus } from '../src/servers'

let harness: Harness | undefined
let root: string | undefined
let savedEnv: Map<string, string | undefined> | undefined
const pids = new Set<number>()
const envKeys = ['HOME', 'QUIRKY_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_HOME', 'OPENAI_HOME']
type Status = { servers: NavServerStatus[]; limits: Record<string, number>; idleMs: number }

async function call<T = unknown>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return await client.callAny(`quirky.navigation/${method}`, params) as T
}

async function start(symlink = false) {
  savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  root = mkdtempSync(join(tmpdir(), 'nav ts é-'))
  process.env.HOME = root
  process.env.QUIRKY_HOME = join(root, 'home')
  for (const key of envKeys.slice(2)) delete process.env[key]
  const real = join(root, 'real-ws')
  cpSync(join(import.meta.dir, 'fixtures/ts'), real, { recursive: true })
  const workspace = symlink ? join(root, 'link-ws') : real
  if (symlink) symlinkSync(real, workspace)
  harness = await startHarness({ home: process.env.QUIRKY_HOME, builtinPluginsDir: builtinsDir() })
  const admin = await harness.connect()
  await admin.callAny('quirky.repo/add', { path: workspace, folder: true })
  const worktree = await admin.callAny('quirky.worktree/resolve', { selector: 'current', cwd: workspace }) as { id: string; path: string }
  const client = await QuirkyClient.connect(rpcUrl(harness.runtime), { role: 'cli', cwd: workspace, worktreeId: worktree.id })
  harness.clients.push(client)
  return { client, admin, workspace, real: realpathSync(real), worktree }
}

async function status(client: QuirkyClient): Promise<Status> {
  const result = await call<Status>(client, 'status')
  for (const server of result.servers) if (server.pid) pids.add(server.pid)
  return result
}

async function navigate(client: QuirkyClient, method: 'definition' | 'references', line: number, column: number, path = 'src/use.ts') {
  try {
    return await call<NavResult>(client, method, { path, line, column })
  } finally {
    await status(client)
  }
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
  try { await harness?.cleanup() } finally {
    harness = undefined
    for (const pid of pids) {
      if (exists(pid)) process.kill(pid, 'SIGKILL')
    }
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

test('definitions resolve re-exports, methods, types, imports, modules and empty positions', async () => {
  const { client, real, worktree } = await start()
  const result = await navigate(client, 'definition', 4, 27)
  expect(result).toEqual({
    worktreeId: worktree.id, language: 'typescript', truncated: false,
    locations: [{ path: join(real, 'src/greet.ts'), relativePath: 'src/greet.ts', line: 3, column: 17, endLine: 3, endColumn: 22, preview: 'export function greet(name: Name): string {' }]
  })
  expect(positions(await navigate(client, 'definition', 6, 9))).toEqual([['src/greet.ts', 10, 3, 10, 8]])
  expect((await navigate(client, 'definition', 6, 9)).locations[0]!.preview).toBe('  hello(name: Name): string {')
  const typeDefinition = await navigate(client, 'definition', 3, 12)
  expect(positions(typeDefinition)).toEqual([['src/greet.ts', 1, 13, 1, 17]])
  expect(typeDefinition.locations[0]!.preview).toBe('export type Name = string')
  expect(positions(await navigate(client, 'definition', 1, 17))).toEqual([['src/greet.ts', 7, 14, 7, 21]])
  expect(positions(await navigate(client, 'definition', 1, 44))).toEqual([['src/index.ts', 1, 1, 1, 1]])
  expect(await navigate(client, 'definition', 2, 1)).toMatchObject({ locations: [], truncated: false })
}, 60000)

test('references include declarations and have deterministic UTF-16 ranges', async () => {
  const { client } = await start()
  expect(positions(await navigate(client, 'references', 4, 27))).toEqual([
    ['src/greet.ts', 3, 17, 3, 22], ['src/greet.ts', 11, 30, 11, 35],
    ['src/index.ts', 1, 10, 1, 15], ['src/use.ts', 1, 10, 1, 15],
    ['src/use.ts', 4, 27, 4, 32], ['src/use.ts', 7, 23, 7, 28]
  ])
  expect(positions(await navigate(client, 'references', 6, 9))).toEqual([
    ['src/greet.ts', 10, 3, 10, 8], ['src/use.ts', 6, 9, 6, 14], ['src/use.ts', 7, 45, 7, 50]
  ])
  expect(positions(await navigate(client, 'references', 3, 12))).toEqual([
    ['src/greet.ts', 1, 13, 1, 17], ['src/greet.ts', 3, 29, 3, 33], ['src/greet.ts', 10, 15, 10, 19],
    ['src/index.ts', 2, 15, 2, 19], ['src/use.ts', 1, 31, 1, 35], ['src/use.ts', 3, 12, 3, 16]
  ])
}, 60000)

test('refreshes open files and watches unopened dependencies on disk', async () => {
  const { client, workspace } = await start()
  await navigate(client, 'definition', 4, 27)
  const use = join(workspace, 'src/use.ts')
  writeFileSync(use, '\n\n' + readFileSync(use, 'utf8'))
  expect(positions(await navigate(client, 'definition', 6, 27))).toEqual([['src/greet.ts', 3, 17, 3, 22]])
  const greet = join(workspace, 'src/greet.ts')
  writeFileSync(greet, '\n\n' + readFileSync(greet, 'utf8'))
  const updated = await waitForAsync(async () => {
    const result = await navigate(client, 'definition', 6, 27)
    return result.locations[0]?.line === 5 ? result : undefined
  }, 10000)
  expect(positions(updated)).toEqual([['src/greet.ts', 5, 17, 5, 22]])
}, 60000)

test('rejects invalid paths and positions before starting a server', async () => {
  const { client, workspace } = await start()
  const outside = join(root!, 'outside.ts')
  writeFileSync(outside, 'export const outside = 1\n')
  symlinkSync(outside, join(workspace, 'src/link.ts'))
  const cases: [string, number, number, number, string][] = [
    ['../outside.ts', 1, 1, RpcErrorCode.InvalidParams, 'outside the worktree'],
    [outside, 1, 1, RpcErrorCode.InvalidParams, 'outside the worktree'],
    [join(root!, 'missing-outside.ts'), 1, 1, RpcErrorCode.InvalidParams, 'outside the worktree'],
    ['src/link.ts', 1, 1, RpcErrorCode.InvalidParams, 'outside the worktree'],
    ['src/nope.ts', 1, 1, RpcErrorCode.NotFound, 'src/nope.ts'],
    ['tsconfig.json', 1, 1, RpcErrorCode.InvalidParams, '.json'],
    ['src', 1, 1, RpcErrorCode.InvalidParams, 'file'],
    ['src/use.ts', 99, 1, RpcErrorCode.InvalidParams, 'line 99'],
    ['src/use.ts', 3, 0, RpcErrorCode.InvalidParams, 'column'],
    ['src/use.ts', 3, 40, RpcErrorCode.InvalidParams, 'column 40']
  ]
  for (const [path, line, column, code, message] of cases) {
    await expect(call(client, 'definition', { path, line, column })).rejects.toMatchObject({ code, message: expect.stringContaining(message) })
    expect((await status(client)).servers).toEqual([])
  }
}, 30000)

test('preserves the worktree resolver error when the caller has no worktree', async () => {
  const { admin } = await start()
  const resolver = await admin.callAny('quirky.worktree/resolve', { selector: 'current' }).catch((error: unknown) => error)
  expect(resolver).toBeInstanceOf(RpcError)
  await expect(call(admin, 'definition', { path: 'src/use.ts', line: 4, column: 27 })).rejects.toMatchObject({
    code: resolver instanceof RpcError ? resolver.code : undefined, message: resolver instanceof Error ? resolver.message : undefined
  })
  expect((await status(admin)).servers).toEqual([])
}, 30000)

test('reuses servers, recovers after crashes, and stops the process group', async () => {
  const { client } = await start()
  await navigate(client, 'definition', 4, 27)
  const first = (await status(client)).servers[0]!
  expect(first).toMatchObject({ language: 'typescript', requests: 1, inFlight: 0, runtime: Bun.which('node') ? 'node' : 'bun' })
  await navigate(client, 'definition', 4, 27)
  expect((await status(client)).servers[0]).toMatchObject({ pid: first.pid, requests: 2 })
  process.kill(first.pid!, 'SIGKILL')
  await waitForAsync(async () => (await status(client)).servers.length === 0 ? true : undefined, 5000)
  expect(positions(await navigate(client, 'definition', 4, 27))).toEqual([['src/greet.ts', 3, 17, 3, 22]])
  const replacement = (await status(client)).servers[0]!
  expect(replacement.pid).not.toBe(first.pid)
  expect(await call<{ stopped: number }>(client, 'stop')).toEqual({ stopped: 1 })
  expect((await status(client)).servers).toEqual([])
  await waitFor(() => !exists(replacement.pid!) || undefined, 5000)
}, 60000)

test('prefers worktree TypeScript and falls back to the plugin-resolvable version', async () => {
  const { client, workspace } = await start()
  const fallback = Bun.resolveSync('typescript/lib/tsserver.js', join(import.meta.dir, '..'))
  await navigate(client, 'definition', 4, 27)
  expect((await status(client)).servers[0]!.serverPath).toBe(fallback)
  await call(client, 'stop')
  const shim = join(workspace, 'node_modules/typescript/lib/tsserver.js')
  mkdirSync(join(shim, '..'), { recursive: true })
  writeFileSync(shim, `require(${JSON.stringify(fallback)})\n`)
  await navigate(client, 'definition', 4, 27)
  expect((await status(client)).servers[0]!.serverPath).toBe(realpathSync(shim))
}, 60000)

test('canonicalizes relative locations when the registered workspace is a symlink', async () => {
  const { client, workspace, real, worktree } = await start(true)
  const result = await navigate(client, 'definition', 4, 27)
  expect(result.locations[0]).toMatchObject({ path: join(real, 'src/greet.ts'), relativePath: 'src/greet.ts' })
  const exit = Promise.withResolvers<{ exitCode: number | null; stderrTail: string }>()
  const location = { path: join(real, 'src/greet.ts'), line: 3, column: 17, endLine: 3, endColumn: 22 }
  const pool = new ServerPool({
    factories: { typescript: async () => ({
      pid: null, runtime: 'fixture', serverPath: 'fixture', exited: exit.promise,
      definition: async () => [location], references: async () => [],
      stop: async () => { exit.resolve({ exitCode: 0, stderrTail: '' }) }
    }) },
    limits: { typescript: 1 }, idleMs: 600000, requestTimeoutMs: 120000
  })
  // the daemon canonicalizes folder records; this isolates the service's alias-root contract.
  const context = {
    call: async () => ({ ...worktree, path: workspace }),
    error: (_kind: string, message: string) => new Error(message)
  }
  const service = new NavigationService(context, pool)
  try {
    for (const path of [join(workspace, 'src/use.ts'), join(real, 'src/use.ts')]) {
      expect((await service.navigate('definition', { path, line: 4, column: 27 }, { role: 'cli' })).locations).toEqual(result.locations)
    }
  } finally {
    await pool.dispose()
  }
}, 60000)

test('caps sorted references at 1000 and bounds Unicode previews', async () => {
  const { client, workspace } = await start()
  const sourceLine = `target(); // ${'é🙂'.repeat(100)}`
  writeFileSync(join(workspace, 'src/many.ts'), `export function target() {}\r\n${Array(1002).fill(sourceLine).join('\r\n')}\r\n`)
  const result = await navigate(client, 'references', 2, 1, 'src/many.ts')
  expect(result.truncated).toBe(true)
  expect(result.locations).toHaveLength(1000)
  expect(result.locations[0]).toMatchObject({ relativePath: 'src/many.ts', line: 1, column: 17, endColumn: 23, preview: 'export function target() {}' })
  expect(result.locations[1]!.preview).toBe(sourceLine.slice(0, 240))
  expect(result.locations[999]).toMatchObject({ line: 1000, column: 1, endColumn: 7 })
}, 60000)

test('answers JavaScript files with the TypeScript server', async () => {
  const { client, workspace } = await start()
  writeFileSync(join(workspace, 'src/plain.js'), 'function hello() {}\nhello()\n')
  const result = await navigate(client, 'definition', 2, 1, 'src/plain.js')
  expect(result.language).toBe('typescript')
  expect(positions(result)).toEqual([['src/plain.js', 1, 10, 1, 15]])
}, 60000)

test('matches TypeScript Unicode line separators for positions and previews', async () => {
  const { client, workspace } = await start()
  writeFileSync(join(workspace, 'src/separators.ts'), 'function hi() {}\u2028hi()\u2029hi()\n')
  expect(positions(await navigate(client, 'definition', 2, 1, 'src/separators.ts'))).toEqual([['src/separators.ts', 1, 10, 1, 12]])
  const references = await navigate(client, 'references', 3, 1, 'src/separators.ts')
  expect(references.locations.map(({ line, preview }) => [line, preview])).toEqual([
    [1, 'function hi() {}'], [2, 'hi()'], [3, 'hi()']
  ])
}, 60000)

test('rejects NUL-containing paths as invalid input before a server starts', async () => {
  const { client } = await start()
  await expect(call(client, 'definition', { path: 'src/bad\u0000.ts', line: 1, column: 1 })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  expect((await status(client)).servers).toEqual([])
}, 30000)
