import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeInfo } from '@quirky/protocol/node'
import type { ProcessScope } from '../test-support/process-scope'
import { createRemoteFixtures } from './remote-fixtures'
import { createIsolatedRuntimeEnvironment, type FixtureRpcClient, type RegisteredCaptureFixtures } from './fixtures'
import type { RuntimeAssets } from './runtime-assets'

type Fault = { side: 'home' | 'host'; method: string; occurrence?: number }
const temporaryWatchers: Array<{ close(): void }> = []
const temporaryHomes: string[] = []
afterEach(() => {
  for (const watcher of temporaryWatchers.splice(0)) watcher.close()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeRig(fault?: Fault) {
  const home = mkdtempSync(join(tmpdir(), 'quirky-remote-fixture-test-'))
  temporaryHomes.push(home)
  const hostHome = join(home, 'remote-host')
  const secrets: string[] = []
  const events: Array<{ side: string; method: string; params: Record<string, unknown> }> = []
  const spawns: Array<{ command: string[]; options: Record<string, unknown> }> = []
  const calls = new Map<string, number>()
  let hostClosed = 0
  let hostStopped = 0
  const runtime: RuntimeInfo = {
    pid: 123, port: 4000, token: 'host-rpc-token-secret', hookToken: 'host-hook-token-secret',
    daemonVersion: 'test', protocolVersion: 1, startedAt: 1
  }
  const faultAt = (side: string, method: string): boolean => {
    const key = `${side}:${method}`
    const occurrence = (calls.get(key) ?? 0) + 1
    calls.set(key, occurrence)
    return fault?.side === side && fault.method === method && (fault.occurrence ?? 1) === occurrence
  }
  const hostClient: FixtureRpcClient & { close(): void } = {
    async callAny(method, params = {}) {
      events.push({ side: 'host', method, params })
      if (method === 'daemon.stop') { hostStopped += 1; return { ok: true } }
      if (faultAt('host', method)) throw new Error(`failed at ${method}`)
      if (method === 'setting.set' || method === 'quirky.repo/add') return { id: method === 'quirky.repo/add' ? 'repo:remote-fixture' : undefined }
      if (method === 'quirky.worktree/create') return { worktree: { id: 'worktree:remote-review', branch: 'remote-review' } }
      if (method === 'quirky.mobile/ownerPair') return { offer: 'owner-pairing-offer-secret' }
      if (method === 'quirky.orchestration/peerListen') {
        if (!secrets.includes(String(params.token))) throw new Error('peer token was not registered before peerListen')
        return { endpoint: 'ws://127.0.0.1:4000/peer', fingerprint: `fingerprint-${events.length}`, incarnation: 'inc-host' }
      }
      if (method === 'quirky.orchestration/peerPair') return { ok: true }
      throw new Error(`unexpected host RPC ${method}`)
    },
    close() { hostClosed += 1 }
  }
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      events.push({ side: 'home', method, params })
      if (faultAt('home', method)) throw new Error(`failed at ${method}`)
      if (method === 'quirky.cli/runtimeAdd') {
        if (!secrets.includes('owner-pairing-offer-secret')) throw new Error('offer was not registered before runtimeAdd')
        return { id: 'runtime:ui-review-owner' }
      }
      if (method === 'quirky.worktree/remoteHostRegister') return { id: 'host:ui-review-owner', connected: true }
      if (method === 'quirky.worktree/remoteAttach') return { id: 'remote_fixture-mirror', connected: true }
      if (method === 'quirky.orchestration/peerListen') {
        if (!secrets.includes(String(params.token))) throw new Error('peer token was not registered before peerListen')
        return { endpoint: 'ws://127.0.0.1:5000/peer', fingerprint: `fingerprint-${events.length}`, incarnation: 'inc-home' }
      }
      if (method === 'quirky.orchestration/peerPair') return { ok: true }
      if (method === 'quirky.session/create') {
        const workerHome = join(home, 'worker-fixture')
        mkdirSync(workerHome, { recursive: true })
        writeFileSync(join(workerHome, 'session-coordinator.events.jsonl'), JSON.stringify({ type: 'started', sessionId: 'session-coordinator' }) + '\n')
        return { id: 'session-coordinator' }
      }
      throw new Error(`unexpected home RPC ${method}`)
    }
  }
  const never = new Promise<number>(() => undefined)
  const fakeChild = {
    pid: 1234, exitCode: null, exited: never,
    stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    kill() {}
  }
  const scope = {
    home,
    env: { QUIRKY_HOME: home, QUIRKY_TEST_SCOPE: 'test-scope' },
    spawn(command: string[], options: Record<string, unknown> = {}) {
      spawns.push({ command, options })
      return fakeChild
    },
    track() {}, async cleanup() {}, killNow() {}
  } as unknown as ProcessScope
  const assets: RuntimeAssets = {
    repoRoot: process.cwd(), uiDir: join(process.cwd(), 'packages/ui/dist'),
    pluginsDir: join(process.cwd(), 'plugins'), ownedRoot: null
  }
  const fixtures = { primaryWorktree: { id: 'worktree:primary', path: join(home, 'project'), repoId: 'repo:primary', name: 'primary' } } as RegisteredCaptureFixtures
  const env = createIsolatedRuntimeEnvironment(home, { repoRoot: process.cwd() })
  const options = { timeoutMs: 10_000, repoRoot: process.cwd(), assets, secrets, fixtures }
  const dependencies = {
    async waitForRuntime(candidateHome: string): Promise<RuntimeInfo> {
      expect(candidateHome).toBe(hostHome)
      expect(secrets).toContain(hostHome)
      return runtime
    },
    async connectDaemon({ home: candidateHome, role }: { home: string; role: 'cli' }) {
      expect(candidateHome).toBe(hostHome)
      expect(role).toBe('cli')
      expect(secrets).toContain(runtime.token)
      expect(secrets).toContain(runtime.hookToken)
      return hostClient
    }
  }
  return { home, hostHome, scope, client, hostClient, events, spawns, secrets, options, env, dependencies, get hostClosed() { return hostClosed }, get hostStopped() { return hostStopped } }
}

function watchChanges(path: string): { wait(): Promise<void>; close(): void } {
  let waiters: Array<() => void> = []
  const watcher = watch(path, () => {
    for (const resolve of waiters) resolve()
    waiters = []
  })
  return {
    wait: () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      waiters.push(resolve)
      return promise
    },
    close: () => watcher.close()
  }
}

async function answerBridgeRequest(
  home: string,
  index: number,
  response: unknown,
  waitForChange: () => Promise<void>,
  code = 0
): Promise<Record<string, unknown>> {
  const root = join(home, 'worker-fixture')
  const requests = join(root, 'session-coordinator.requests.jsonl')
  let rows: Array<{ id: string; args: string[] }> = []
  while (!rows[index]) {
    const changed = waitForChange()
    if (existsSync(requests)) rows = readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; args: string[] })
    if (!rows[index]) await changed
  }
  const request = rows[index]!
  writeFileSync(join(root, `${request.id}.reply.json`), JSON.stringify({ code, stdout: JSON.stringify(response), stderr: code === 0 ? '' : 'fixture bridge refused' }))
  return request as unknown as Record<string, unknown>
}

function gitOutput(path: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('builds remote fixtures through public RPCs and the worker CLI bridge', async () => {
  const rig = makeRig()
  mkdirSync(join(rig.home, 'worker-fixture'), { recursive: true })
  const watcher = watchChanges(join(rig.home, 'worker-fixture'))
  temporaryWatchers.push(watcher)
  const creating = createRemoteFixtures(rig.scope, rig.home, rig.client, rig.env, rig.options, rig.dependencies)
  const createRequest = await answerBridgeRequest(rig.home, 0, { run: { id: 'run-fixture' } }, watcher.wait)
  const workerRequest = await answerBridgeRequest(rig.home, 1, { state: 'ready', dispatchId: 'ctx_fixture' }, watcher.wait)
  watcher.close()
  const remote = await creating

  expect(remote.mirrorId).toBe('remote_fixture-mirror')
  expect(remote.dispatchId).toBe('ctx_fixture')
  const calls = rig.events.filter(({ method }) => method !== 'daemon.stop')
  expect(calls.map(({ side, method }) => `${side}:${method}`)).toEqual([
    'host:setting.set', 'host:setting.set', 'host:quirky.repo/add', 'host:quirky.worktree/create',
    'host:quirky.mobile/ownerPair', 'home:quirky.cli/runtimeAdd', 'home:quirky.worktree/remoteHostRegister', 'home:quirky.worktree/remoteAttach',
    'home:quirky.orchestration/peerListen', 'host:quirky.orchestration/peerListen',
    'home:quirky.orchestration/peerPair', 'host:quirky.orchestration/peerPair', 'home:quirky.session/create'
  ])
  expect(calls.slice(0, 4).map(({ params }) => params)).toEqual([
    { id: 'setting:quirky.worktree/worktreesRoot', value: join(rig.hostHome, 'worktrees') },
    { id: 'setting:quirky.worktree/branchPrefix', value: 'none' },
    { path: join(rig.hostHome, 'projects/remote-fixture') },
    { repo: 'repo:remote-fixture', name: 'remote-review', setup: 'skip', noParent: true, activate: false }
  ])
  const token = calls.find(({ method }) => method === 'quirky.orchestration/peerListen')!.params.token
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(calls.filter(({ method }) => method === 'quirky.orchestration/peerListen').map(({ params }) => params)).toEqual([
    { host: '127.0.0.1', port: 0, token }, { host: '127.0.0.1', port: 0, token }
  ])
  expect(calls.filter(({ method }) => method === 'quirky.orchestration/peerPair').map(({ side, params }) => [side, params])).toEqual([
    ['home', { peerId: 'ui-review-host', label: 'UI review host', endpoint: 'ws://127.0.0.1:4000/peer', token, fingerprint: expect.any(String) }],
    ['host', { peerId: 'ui-review-home', label: 'UI review home', endpoint: 'ws://127.0.0.1:5000/peer', token, fingerprint: expect.any(String) }]
  ])
  expect(calls.at(-1)!.params).toEqual({ worktree: 'worktree:primary', agent: 'claude', title: 'UI review coordinator' })
  expect((createRequest.args as string[])).toEqual(['orchestration', 'run-create', '--objective', 'UI review federated output', '--json'])
  expect((workerRequest.args as string[])).toEqual(['orchestration', 'worker-start', '--on', 'ui-review-host', '--spec', 'Report the remote fixture status.', '--agent', 'claude', '--worktree', 'worktree:remote-review', '--timeout-ms', '60000', '--json'])

  const daemonStart = rig.spawns.find(({ command }) => command.some(part => part.endsWith('packages/daemon/src/main.ts')))
  expect(daemonStart).toBeDefined()
  const daemonEnv = daemonStart!.options.env as Record<string, string>
  expect(daemonEnv.PATH.split(':')[0]).toBe(join(rig.hostHome, 'fakebin'))
  expect(daemonEnv.QUIRKY_AGENT_SEARCH_DIRS).toBe(join(rig.hostHome, 'fakebin'))
  expect(daemonEnv.QUIRKY_MOBILE_HOST).toBe('127.0.0.1')
  expect(daemonEnv.QUIRKY_MOBILE_PORT).toBe('0')
  expect(daemonEnv.WORKER_TEST_CLI).toBe(daemonEnv.QUIRKY_CLI_ENTRY)
  expect(existsSync(join(rig.hostHome, 'fakebin/security'))).toBe(true)
  expect(statSync(join(rig.hostHome, 'fakebin/security')).mode & 0o111).not.toBe(0)
  const project = join(rig.hostHome, 'projects/remote-fixture')
  expect(gitOutput(project, 'branch', '--show-current')).toBe('main')
  expect(gitOutput(project, 'diff', '--name-only')).toBe('README.md')
  expect(gitOutput(project, 'rev-list', '--count', 'HEAD')).toBe('1')
  expect(gitOutput(project, 'config', 'user.name')).toBe('UI Review Fixture')
  expect(gitOutput(project, 'config', 'user.email')).toBe('ui-review-fixture@localhost')

  expect(await remote.stop()).toEqual([])
  expect(rig.hostStopped).toBe(1)
  expect(rig.hostClosed).toBe(1)
})

test('redacts an owner offer and host runtime token when runtime registration rejects', async () => {
  const rig = makeRig({ side: 'home', method: 'quirky.cli/runtimeAdd' })
  rig.client.callAny = async (method, params = {}) => {
    rig.events.push({ side: 'home', method, params })
    if (method === 'quirky.cli/runtimeAdd') throw new Error('rejected owner-pairing-offer-secret host-rpc-token-secret')
    return { id: 'unused' }
  }
  const failure = await createRemoteFixtures(rig.scope, rig.home, rig.client, rig.env, rig.options, rig.dependencies)
    .catch((error: unknown) => error)
  const message = failure instanceof Error ? failure.message : String(failure)
  expect(message).toBe('remote fixture quirky.cli/runtimeAdd: rejected <redacted> <redacted>')
  expect(message).not.toContain('owner-pairing-offer-secret')
  expect(message).not.toContain('host-rpc-token-secret')
  expect(rig.hostStopped).toBe(1)
  expect(rig.hostClosed).toBe(1)
})

test('stops the host daemon and closes its client after a failed RPC step', async () => {
  const faults: Fault[] = [
    { side: 'host', method: 'setting.set' }, { side: 'host', method: 'setting.set', occurrence: 2 },
    { side: 'host', method: 'quirky.repo/add' }, { side: 'host', method: 'quirky.worktree/create' },
    { side: 'host', method: 'quirky.mobile/ownerPair' }, { side: 'home', method: 'quirky.worktree/remoteHostRegister' },
    { side: 'home', method: 'quirky.worktree/remoteAttach' },
    { side: 'home', method: 'quirky.orchestration/peerListen' }, { side: 'host', method: 'quirky.orchestration/peerListen' },
    { side: 'home', method: 'quirky.orchestration/peerPair' }, { side: 'host', method: 'quirky.orchestration/peerPair' },
    { side: 'home', method: 'quirky.session/create' }
  ]
  for (const fault of faults) {
    const rig = makeRig(fault)
    const step = fault.method.startsWith('quirky.orchestration/') ? `${fault.method} (${fault.side})` : fault.method
    await expect(createRemoteFixtures(rig.scope, rig.home, rig.client, rig.env, rig.options, rig.dependencies))
      .rejects.toThrow(`remote fixture ${step}: failed at ${fault.method}`)
    expect(rig.hostStopped).toBe(1)
    expect(rig.hostClosed).toBe(1)
  }
})
test('bridge command failures identify their step and still stop the host', async () => {
  for (const failedVerb of ['run-create', 'worker-start']) {
    const rig = makeRig()
    mkdirSync(join(rig.home, 'worker-fixture'), { recursive: true })
    const watcher = watchChanges(join(rig.home, 'worker-fixture'))
    temporaryWatchers.push(watcher)
    const creating = createRemoteFixtures(rig.scope, rig.home, rig.client, rig.env, rig.options, rig.dependencies)
    if (failedVerb === 'worker-start') {
      await answerBridgeRequest(rig.home, 0, {}, watcher.wait)
      await answerBridgeRequest(rig.home, 1, {}, watcher.wait, 1)
    } else {
      await answerBridgeRequest(rig.home, 0, {}, watcher.wait, 1)
    }
    watcher.close()
    await expect(creating).rejects.toThrow(`remote fixture orchestration ${failedVerb}: worker CLI ${failedVerb} exited 1: fixture bridge refused`)
    expect(rig.hostStopped).toBe(1)
    expect(rig.hostClosed).toBe(1)
  }
})
