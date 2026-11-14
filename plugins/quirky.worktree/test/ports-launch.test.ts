import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type Session, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { call, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { hookEnvironment, shellQuote } from '../src/daemon/hooks-run'
import { WorktreePorts, isPortFree, migrateWorktreePorts, type PortBlock } from '../src/daemon/ports'
import { makeProject, repoSet, setSetting, startWorld, type SessionMode, type World } from './fixtures/repos'
import { startGithubWorld, type GithubWorld } from './github-fixtures/world'
import { portsLaunchHook } from '../main'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'

setDefaultTimeout(60_000)
const { scratch } = isolateGitConfig()
let w: World | undefined
let github: GithubWorld | undefined
const servers: Server[] = []
afterEach(async () => {
  await github?.cleanup()
  github = undefined
  await w?.t.cleanup()
  w = undefined
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    return promise
  }))
})

async function freeBase() {
  let base = 0
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = 42000 + Math.floor(Math.random() * 59) * 100
    let free = true
    for (let port = candidate; port < candidate + 200; port++) {
      if (!await isPortFree(port)) { free = false; break }
    }
    if (free) { base = candidate; break }
  }
  if (!base) throw new Error('no free test port range')
  return base
}

async function start(sessions: SessionMode = 'fake', blocks = 20) {
  w = await startWorld(sessions)
  const base = await freeBase()
  await setSetting(w.client, 'portRangeStart', base)
  await setSetting(w.client, 'portRangeEnd', base + blocks * 10 - 1)
  const dir = makeProject(join(scratch(), 'api'))
  await w.add(dir)
  return { base, dir }
}

type Result = WorktreeCreateResult & { creationReceipt: { ports?: PortBlock } }
const create = (name: string) => call(w!.client, 'quirky.worktree/create', { repo: 'api', name }) as Promise<Result>
async function listen(port: number) {
  const server = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
  await promise
  servers.push(server)
}

const script = 'printf "%s|%s|%s|%s\\n" "$PORT" "$WORKTREE_PORT" "$WORKTREE_PORT_COUNT" "$CONDUCTOR_PORT" > ports.txt'
const runnerOf = (path: string) => resolve(path, git(path, 'rev-parse', '--git-path', 'quirky/setup-runner.sh'))

test('script hooks receive the reserved block and Conductor alias', () => {
  expect(hookEnvironment({ rootPath: '/repo', worktreePath: '/wt', ports: { base: 42000, count: 10 } })).toMatchObject({
    PORT: '42000', WORKTREE_PORT: '42000', WORKTREE_PORT_COUNT: '10', CONDUCTOR_PORT: '42000'
  })
})

test('create reserves lowest free blocks and skips a busy port', async () => {
  const { base } = await start()
  await listen(base + 3)
  const a = await create('a')
  const b = await create('b')
  expect(a.creationReceipt.ports).toEqual({ base: base + 10, count: 10 })
  expect(b.creationReceipt.ports).toEqual({ base: base + 20, count: 10 })
  expect(a.warnings).toEqual([])
  expect(b.warnings).toEqual([])
})

for (const mode of ['real', 'none'] as const) {
  test(`setup receives the same reserved ports through ${mode === 'real' ? 'a terminal runner' : 'the daemon'}`, async () => {
    const { base } = await start(mode)
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: script })
    const a = await create('setup')
    expect(a.creationReceipt.ports).toEqual({ base, count: 10 })
    if (mode === 'real') {
      expect(a.setup.ran).toBe('terminal')
      const outcome = Bun.spawnSync(['/bin/bash', runnerOf(a.worktree.path)], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      expect(outcome.exitCode).toBe(0)
    } else expect(a.setup).toMatchObject({ ran: 'daemon', exitCode: 0 })
    expect(readFileSync(join(a.worktree.path, 'ports.txt'), 'utf8')).toBe(`${base}|${base}|10|${base}\n`)
  })
}

test('archive receives the existing block before remove frees it for reuse', async () => {
  const { base, dir } = await start('none')
  const archive = join(dir, 'archive.txt')
  await repoSet(w!.client, 'api', { archiveScript: `printf "%s|%s\\n" "$PORT" "$WORKTREE_PORT_COUNT" > ${shellQuote(archive)}` })
  const a = await create('a')
  const b = await create('b')
  expect(b.creationReceipt.ports).toEqual({ base: base + 10, count: 10 })
  await call(w!.client, 'quirky.worktree/remove', { worktree: a.worktree.id, yes: true })
  expect(readFileSync(archive, 'utf8')).toBe(`${base}|10\n`)
  expect(await call(w!.client, 'quirky.worktree/ports')).toMatchObject({ blocks: [{ worktreeId: b.worktree.id, base: base + 10 }] })
  expect((await create('c')).creationReceipt.ports).toEqual({ base, count: 10 })
})

test('archive does not allocate a block for an external worktree', async () => {
  const { dir } = await start('none')
  const external = join(scratch(), 'external')
  git(dir, 'worktree', 'add', '-q', '-b', 'external', external)
  const archive = join(dir, 'archive.txt')
  await repoSet(w!.client, 'api', { archiveScript: `printf "%s|%s|%s|%s\\n" "\${PORT-unset}" "\${WORKTREE_PORT-unset}" "\${WORKTREE_PORT_COUNT-unset}" "\${CONDUCTOR_PORT-unset}" > ${shellQuote(archive)}` })
  await call(w!.client, 'quirky.worktree/remove', { worktree: `path:${external}`, yes: true })
  expect(readFileSync(archive, 'utf8')).toBe('unset|unset|unset|unset\n')
})

test('full range warns without refusing create', async () => {
  const { base } = await start('none', 2)
  expect((await create('a')).creationReceipt.ports).toEqual({ base, count: 10 })
  expect((await create('b')).creationReceipt.ports).toEqual({ base: base + 10, count: 10 })
  const c = await create('c')
  expect(c.creationReceipt.ports).toBeUndefined()
  expect(c.warnings).toContain(`could not reserve ports for ${c.worktree.path}: no free block of 10 ports between ${base} and ${base + 19}`)
  expect(await failure(call(w!.client, 'quirky.worktree/ports', { worktree: c.worktree.id }))).toMatchObject({
    code: RpcErrorCode.Conflict, message: `no free block of 10 ports between ${base} and ${base + 19}`
  })
})

test('issue command runner receives all four port variables against a local GitHub stand-in', async () => {
  github = await startGithubWorld()
  const base = await freeBase()
  await setSetting(github.client, 'portRangeStart', base)
  await setSetting(github.client, 'portRangeEnd', base + 199)
  await github.call('quirky.repo/set', { repo: github.repo.id, issueCommand: script })
  const made = await github.call('quirky.worktree/create', { repo: github.repo.id, github: '#4' }) as Result
  expect(made.creationReceipt.ports).toEqual({ base, count: 10 })
  expect(made.issueCommand).toMatchObject({ ran: 'daemon', exitCode: 0 })
  expect(readFileSync(join(made.worktree.path, 'ports.txt'), 'utf8')).toBe(`${base}|${base}|10|${base}\n`)
})

test('shell and agent launches retain a held block even while its dev server is listening', async () => {
  const { base } = await start('real')
  const a = await create('a')
  await listen(base)
  for (const agent of ['shell', 'claude']) {
    const session = await call(w!.client, 'quirky.session/create', { worktree: a.worktree.id, agent }) as Session
    const request = w!.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id)
    expect(request).toMatchObject({ env: { PORT: String(base), WORKTREE_PORT: String(base), WORKTREE_PORT_COUNT: '10' } })
    if (request?.type !== 'create') throw new Error('missing PTY create')
    expect(request.env.CONDUCTOR_PORT).toBeUndefined()
    expect(Object.keys(request.env).filter((name) => name.startsWith('QUIRKY_') && name.includes('WORKTREE_PORT'))).toEqual([])
  }
  const restarted = await w!.t.restart()
  w!.client = restarted.client
  const session = await call(w!.client, 'quirky.session/create', { worktree: a.worktree.id, agent: 'shell' }) as Session
  expect(w!.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id)).toMatchObject({ env: { PORT: String(base) } })
  expect(await call(w!.client, 'quirky.worktree/ports', { worktree: a.worktree.id })).toMatchObject({ blocks: [{ base, count: 10 }] })
})

test('external and primary worktrees lazily receive blocks in first-session order', async () => {
  const { base, dir } = await start('real')
  const path = join(scratch(), 'external')
  git(dir, 'worktree', 'add', '-q', '-b', 'external', path)
  const listed = await call(w!.client, 'quirky.worktree/list') as Worktree[]
  const external = listed.find((worktree) => worktree.path === path)!
  const primary = listed.find((worktree) => worktree.isMain)!
  for (const [worktree, port] of [[external, base], [primary, base + 10]] as const) {
    const session = await call(w!.client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' }) as Session
    expect(w!.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id)).toMatchObject({ env: { PORT: String(port) } })
  }
  expect(await call(w!.client, 'quirky.worktree/ports')).toMatchObject({
    blocks: [{ worktreeId: external.id, base }, { worktreeId: primary.id, base: base + 10 }]
  })
})

test('restoring a host-restart shell launch keeps its worktree block', async () => {
  const { base } = await start('real')
  const a = await create('restore')
  const session = await call(w!.client, 'quirky.session/create', { worktree: a.worktree.id, agent: 'shell' }) as Session
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>()
  const unsubscribe = w!.client.onEvent((event) => {
    if (event.type !== 'quirky.session/changed') return
    const data = event.data
    if (typeof data !== 'object' || data === null || !('session' in data)) return
    const changed = data.session
    if (typeof changed === 'object' && changed !== null && 'id' in changed && 'status' in changed &&
      changed.id === session.id && changed.status === 'exited') markExited()
  })
  await call(w!.client, 'events.subscribe')
  try {
    w!.t.h.pty.exit(session.id, null, { exitSignal: 'SIGHUP', exitCause: 'host-restart' })
    await exited
  } finally { unsubscribe() }
  await call(w!.client, 'quirky.session/restore', { session: session.id })
  expect(w!.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id && request.restore)).toMatchObject({
    restore: true, env: { PORT: String(base), WORKTREE_PORT: String(base), WORKTREE_PORT_COUNT: '10' }
  })
})

test('exhausted ports do not prevent a shell launch', async () => {
  await start('real', 2)
  await create('a')
  await create('b')
  const c = await create('c')
  const session = await call(w!.client, 'quirky.session/create', { worktree: c.worktree.id, agent: 'shell' }) as Session
  const request = w!.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id)
  if (request?.type !== 'create') throw new Error('missing PTY create')
  expect(request.env.PORT).toBeUndefined()
  expect(request.env.WORKTREE_PORT).toBeUndefined()
  expect(request.env.WORKTREE_PORT_COUNT).toBeUndefined()
})

test('launch hook leaves an unknown remote or VM worktree alone', async () => {
  const opened = openPluginStore({ home: scratch(), pluginId: 'quirky.worktree', isActive: () => true, migrations: [
    (store) => store.exec('CREATE TABLE worktrees (id TEXT PRIMARY KEY)'), migrateWorktreePorts
  ] })
  try {
    const ports = new WorktreePorts({ store: opened.store, range: () => { throw new Error('must not allocate') } })
    expect(await portsLaunchHook(opened.store, ports)({
      sessionId: 's_remote', worktreeId: 'remote:missing', repoId: 'remote:repo', cwd: '/remote',
      agent: 'shell', env: {}, args: [], jsonArgs: {}
    })).toBeUndefined()
    expect(opened.store.all('SELECT * FROM worktree_ports')).toEqual([])
  } finally { opened.close() }
})
