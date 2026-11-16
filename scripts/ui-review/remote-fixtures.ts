import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { connectDaemon } from '@quirky/protocol/node'
import { type ProcessScope } from '../test-support/process-scope'
import { bounded, registerPathSecret, rpc, sanitizedError, waitForRuntime } from './capture'
import {
  createIsolatedRuntimeEnvironment,
  prepareProviderExecutables,
  type FixtureOptions,
  type FixtureRpcClient,
  type RegisteredCaptureFixtures
} from './fixtures'
import { runtimeAssetEnvironment, type RuntimeAssets } from './runtime-assets'

type HostClient = FixtureRpcClient & { close(): void }
type RemoteConnectOptions = { home: string; role: 'cli' }
type RemoteFixtureDependencies = {
  waitForRuntime: typeof waitForRuntime
  connectDaemon(options: RemoteConnectOptions): Promise<HostClient>
}
const defaultDependencies: RemoteFixtureDependencies = {
  waitForRuntime,
  connectDaemon: options => connectDaemon({ ...options, name: 'ui-review-host', autostart: false })
}
type BridgeReply = { code: number; stdout: string; stderr: string }

export type RemoteFixtures = { mirrorId: string; dispatchId: string; stop(): Promise<string[]> }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} did not return a value`)
  return value
}

function runGit(args: string[], cwd: string, env: Record<string, string>): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
}

function prepareHostRepository(hostHome: string, env: Record<string, string>): void {
  const root = join(hostHome, 'projects', 'remote-fixture')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const readme = join(root, 'README.md')
  writeFileSync(readme, '# Remote fixture\n\nInitial committed content.\n', { mode: 0o600 })
  runGit(['init', '--initial-branch=main', root], hostHome, env)
  runGit(['-C', root, 'config', 'user.name', 'UI Review Fixture'], hostHome, env)
  runGit(['-C', root, 'config', 'user.email', 'ui-review-fixture@localhost'], hostHome, env)
  runGit(['-C', root, 'add', 'README.md'], hostHome, env)
  runGit(['-C', root, 'commit', '-m', 'Seed remote UI review fixture'], hostHome, env)
  writeFileSync(readme, '# Remote fixture\n\nCommitted content with one local change.\n', { mode: 0o600 })
}

async function waitForFile(path: string, options: FixtureOptions, label: string): Promise<string> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    if (existsSync(path)) return readFileSync(path, 'utf8')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${label} exceeded ${options.timeoutMs}ms`)
    await bounded(Bun.sleep(Math.min(25, remaining)), options.timeoutMs, options.signal, label)
  }
}

async function waitForStartedEvent(home: string, session: string, options: FixtureOptions): Promise<void> {
  const path = join(home, 'worker-fixture', `${session}.events.jsonl`)
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    if (existsSync(path)) {
      const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      if (events.some(event => event.type === 'started')) return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`coordinator ${session} did not write a started event within ${options.timeoutMs}ms`)
    await bounded(Bun.sleep(Math.min(25, remaining)), options.timeoutMs, options.signal, 'coordinator started event')
  }
}

async function runBridgeCommand(
  home: string,
  session: string,
  args: string[],
  options: FixtureOptions
): Promise<unknown> {
  options.signal?.throwIfAborted()
  const root = join(home, 'worker-fixture')
  const id = randomUUID()
  appendFileSync(join(root, `${session}.requests.jsonl`), JSON.stringify({ id, args }) + '\n', { mode: 0o600 })
  const raw = await waitForFile(join(root, `${id}.reply.json`), options, `worker CLI ${args.slice(0, 2).join(' ')}`)
  const reply = JSON.parse(raw) as BridgeReply
  if (!reply || typeof reply !== 'object' || typeof reply.code !== 'number' || typeof reply.stdout !== 'string' || typeof reply.stderr !== 'string') {
    throw new Error('worker CLI bridge returned an invalid reply')
  }
  if (reply.code !== 0) throw new Error(`worker CLI ${args[1]} exited ${reply.code}: ${reply.stderr.trim() || reply.stdout.trim() || 'no details'}`)
  try {
    return JSON.parse(reply.stdout) as unknown
  } catch {
    throw new Error(`worker CLI ${args[1]} did not return JSON: ${reply.stdout}`)
  }
}

/** Starts an isolated owner daemon, attaches its worktree, and launches one federated worker fixture. */
export async function createRemoteFixtures(
  scope: ProcessScope,
  home: string,
  client: FixtureRpcClient,
  env: Record<string, string>,
  options: FixtureOptions & { repoRoot: string; assets: RuntimeAssets; secrets: string[]; fixtures: RegisteredCaptureFixtures },
  dependencies: RemoteFixtureDependencies = defaultDependencies
): Promise<RemoteFixtures> {
  const timeoutMs = options.timeoutMs
  const secrets = options.secrets
  const hostHome = resolve(home, 'remote-host')
  let hostClient: HostClient | undefined
  let stopped = false
  let step = 'host setup'

  const stopHost = async (): Promise<string[]> => {
    if (stopped) return []
    stopped = true
    const failures: string[] = []
    if (hostClient) {
      try { await rpc(hostClient, 'daemon.stop', {}, timeoutMs) } catch (error) { failures.push(`daemon stop: ${sanitizedError(error, secrets)}`) }
      try { hostClient.close() } catch (error) { failures.push(`daemon client close: ${sanitizedError(error, secrets)}`) }
      hostClient = undefined
    }
    return failures
  }

  try {
    registerPathSecret(hostHome, secrets)
    mkdirSync(hostHome, { recursive: true, mode: 0o700 })
    prepareProviderExecutables(hostHome)
    const fakebin = join(hostHome, 'fakebin')
    const hostEnv = runtimeAssetEnvironment(
      createIsolatedRuntimeEnvironment(hostHome, { repoRoot: resolve(options.repoRoot), uiDir: join(resolve(options.repoRoot), 'packages/ui/dist') }),
      options.assets
    )
    if (env.WORKER_TEST_CLI) hostEnv.WORKER_TEST_CLI = env.WORKER_TEST_CLI
    hostEnv.PATH = `${fakebin}${delimiter}${hostEnv.PATH}`
    hostEnv.QUIRKY_AGENT_SEARCH_DIRS = fakebin
    hostEnv.QUIRKY_MOBILE_HOST = '127.0.0.1'
    hostEnv.QUIRKY_MOBILE_PORT = '0'

    step = 'host daemon startup'
    const daemonEntry = join(resolve(options.repoRoot), 'packages/daemon/src/main.ts')
    const daemon = scope.spawn(['/usr/bin/env', `QUIRKY_HOME=${hostHome}`, process.execPath, daemonEntry], {
      cwd: resolve(options.repoRoot), env: hostEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
    })
    const runtime = await dependencies.waitForRuntime(hostHome, daemon, timeoutMs, options.signal)
    secrets.push(runtime.token, runtime.hookToken)
    const connecting = dependencies.connectDaemon({ home: hostHome, role: 'cli' })
    try {
      hostClient = await bounded(connecting, timeoutMs, options.signal, 'host daemon RPC connection')
    } catch (error) {
      void connecting.then(lateClient => lateClient.close(), () => undefined)
      throw error
    }

    step = 'setting.set'
    await rpc(hostClient, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(hostHome, 'worktrees') }, timeoutMs, options.signal)
    await rpc(hostClient, 'setting.set', { id: 'setting:quirky.worktree/branchPrefix', value: 'none' }, timeoutMs, options.signal)
    step = 'host repository'
    prepareHostRepository(hostHome, hostEnv)
    step = 'quirky.repo/add'
    const repo = record(await rpc(hostClient, 'quirky.repo/add', { path: join(hostHome, 'projects/remote-fixture') }, timeoutMs, options.signal))
    const repoId = requiredString(repo.id, 'quirky.repo/add')
    step = 'quirky.worktree/create'
    const created = record(await rpc(hostClient, 'quirky.worktree/create', {
      repo: repoId, name: 'remote-review', setup: 'skip', noParent: true, activate: false
    }, timeoutMs, options.signal))
    const worktree = record(created.worktree)
    const hostWorktreeId = requiredString(worktree.id, 'quirky.worktree/create')
    if (worktree.branch !== 'remote-review') throw new Error('quirky.worktree/create did not return branch remote-review')

    step = 'quirky.mobile/ownerPair'
    const paired = record(await rpc(hostClient, 'quirky.mobile/ownerPair', { name: 'UI review owner', address: '127.0.0.1', confirm: true }, timeoutMs, options.signal))
    const offer = requiredString(paired.offer, 'quirky.mobile/ownerPair')
    secrets.push(offer)
    step = 'quirky.cli/runtimeAdd'
    await rpc(client, 'quirky.cli/runtimeAdd', { name: 'ui-review-owner', pairingCode: offer }, timeoutMs, options.signal)
    step = 'quirky.worktree/remoteHostRegister'
    const registered = record(await rpc(client, 'quirky.worktree/remoteHostRegister', { runtime: 'runtime:ui-review-owner' }, timeoutMs, options.signal))
    if (registered.connected !== true) throw new Error('remote host registration did not return connected: true')
    const registeredHost = requiredString(registered.id, 'quirky.worktree/remoteHostRegister')
    step = 'quirky.worktree/remoteAttach'
    const mirror = record(await rpc(client, 'quirky.worktree/remoteAttach', { host: registeredHost, worktree: hostWorktreeId }, timeoutMs, options.signal))
    const mirrorId = requiredString(mirror.id, 'quirky.worktree/remoteAttach')
    if (!mirrorId.startsWith('remote_') || mirror.connected !== true) throw new Error('remote attachment did not return a connected mirror')

    const token = randomBytes(32).toString('base64url')
    secrets.push(token)
    step = 'quirky.orchestration/peerListen (home)'
    const homeListener = record(await rpc(client, 'quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }, timeoutMs, options.signal))
    step = 'quirky.orchestration/peerListen (host)'
    const hostListener = record(await rpc(hostClient, 'quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }, timeoutMs, options.signal))
    step = 'quirky.orchestration/peerPair (home)'
    await rpc(client, 'quirky.orchestration/peerPair', {
      peerId: 'ui-review-host', label: 'UI review host', endpoint: requiredString(hostListener.endpoint, 'host peer listener'),
      token, fingerprint: requiredString(hostListener.fingerprint, 'host peer listener')
    }, timeoutMs, options.signal)
    step = 'quirky.orchestration/peerPair (host)'
    await rpc(hostClient, 'quirky.orchestration/peerPair', {
      peerId: 'ui-review-home', label: 'UI review home', endpoint: requiredString(homeListener.endpoint, 'home peer listener'),
      token, fingerprint: requiredString(homeListener.fingerprint, 'home peer listener')
    }, timeoutMs, options.signal)

    step = 'quirky.session/create'
    const createdSession = record(await rpc(client, 'quirky.session/create', {
      worktree: options.fixtures.primaryWorktree.id, agent: 'claude', title: 'UI review coordinator'
    }, timeoutMs, options.signal))
    const session = requiredString(createdSession.id, 'quirky.session/create')
    step = 'coordinator started event'
    await waitForStartedEvent(home, session, options)
    step = 'orchestration run-create'
    await runBridgeCommand(home, session, ['orchestration', 'run-create', '--objective', 'UI review federated output', '--json'], options)
    step = 'orchestration worker-start'
    const receipt = record(await runBridgeCommand(home, session, [
      'orchestration', 'worker-start', '--on', 'ui-review-host', '--spec', 'Report the remote fixture status.',
      '--agent', 'claude', '--worktree', hostWorktreeId, '--timeout-ms', '60000', '--json'
    ], options))
    if (receipt.state !== 'ready') throw new Error(`worker-start did not return a ready receipt (state: ${String(receipt.state)})`)
    const dispatchId = requiredString(receipt.dispatchId, 'orchestration worker-start')
    if (!dispatchId.startsWith('ctx_')) throw new Error('worker-start did not return a context dispatch ID')
    return { mirrorId, dispatchId, stop: stopHost }
  } catch (error) {
    await stopHost()
    throw new Error(`remote fixture ${step}: ${sanitizedError(error, secrets)}`)
  }
}
