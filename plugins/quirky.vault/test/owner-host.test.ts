import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type OwnerSessionHostRef, type OwnerSessionWorkspaceRef, type QuirkyClient, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { startPtyServer, type PtyServer } from '../../../packages/pty-host/src/server'
import { HandoffDialog } from '../../quirky.handoff/src/window/model'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { writeEveryAgentFixture, writeJsonlFixture, writeScopeFixture } from './fixtures/scanner-fixtures'

const { scratch } = isolateGitConfig()
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const FAKE_AGENT = resolve(import.meta.dir, '../../quirky.agents/test/support/fake-agent.ts')
const PLUGINS = [
  'quirky.cli',
  'quirky.mobile',
  'quirky.repo',
  'quirky.worktree',
  'quirky.git',
  'quirky.editor',
  'quirky.sidebar-extras',
  'quirky.agents',
  'quirky.agent-status',
  'quirky.session',
  'quirky.terminal',
  'quirky.vault',
  'quirky.handoff',
  'quirky.ask'
]
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'QUIRKY_HOME',
  'QUIRKY_VAULT_SOURCE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'QUIRKY_AGENT_SEARCH_DIRS',
  'QUIRKY_TEST_OPEN_LOG',
  'QUIRKY_MOBILE_PORT',
  'QUIRKY_MOBILE_HOST',
  'SHELL',
  'PATH'
] as const
const DUPLICATE_PROVIDER_ID = 'claude-fixture-session'
const RESUME_PROVIDER_ID = 'owner-resume-session'
const HOST_SEARCH_MARKER = 'vault-fixture-claude-marker'

type HostIdentity = { hostId: string; generation: string }
type SavedRuntime = { id: string; name: string; endpoint: string; grantId: string }
type RegisteredHost = {
  id: string
  runtime: SavedRuntime
  identity: HostIdentity
  connected: boolean
  error: string | null
  updatedAt: number
}
type Worktree = { id: string; path: string; repoId: string; instanceId: string; name?: string }
type Mirror = { id: string; hostId: string; identity: HostIdentity; worktree: Worktree; connected: boolean; fingerprint: string }
type Outcome = { hostId: string; label: string; kind: 'ok' | 'unavailable' | 'error'; reason?: string }
type PublicSession = {
  id: string
  sourceId: string
  hostId: string
  sessionId: string
  title: string
  cwd: string | null
  source: { presence: string; filePath?: string; codexHome?: string }
  [key: string]: unknown
}
type PublicList = { sessions: PublicSession[]; hosts: Outcome[]; [key: string]: unknown }
type SearchReply = { kind: string; hits?: { id: string; hostId?: string }[]; hosts?: Outcome[]; [key: string]: unknown }
type FakeAgent = { launcher: string; log: string; ownerEnvLog: string; secretName: string; secretValue: string }
type HostRig = {
  label: string
  root: string
  home: string
  userHome: string
  sourceHome: string
  xdgHome: string
  agentSearchDir: string
  fakeBin: string
  openLog: string
  builtinPluginsDir: string
  harness: Harness
  realPty?: PtyServer
  client: QuirkyClient
  cleaned: boolean
  fake?: FakeAgent
  resumeTranscriptPath?: string
}
type RegisteredOwner = {
  rig: HostRig
  runtime: SavedRuntime
  host: RegisteredHost
  repoId: string
  worktree: Worktree
  mirror: Mirror
  ownerRef: OwnerSessionHostRef
  workspaceRef: OwnerSessionWorkspaceRef
}
type WorldState = {
  root: string
  previousEnvironment: Map<typeof ENV_KEYS[number], string | undefined>
  rigs: HostRig[]
  cleaned: boolean
}
type World = WorldState & {
  local: HostRig
  owners: [RegisteredOwner, RegisteredOwner]
  repoPath: string
}

type OwnerTranscript = { title: string; firstPrompt: string; lastPrompt: string; lastMessage: string }

const worlds: WorldState[] = []

afterEach(async () => {
  for (const world of worlds.splice(0).reverse()) await cleanupWorld(world)
})

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function call<T>(rig: HostRig, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return rig.client.callAny(method, params) as Promise<T>
}

function applyRigEnvironment(rig: Pick<HostRig, 'home' | 'userHome' | 'sourceHome' | 'xdgHome' | 'agentSearchDir' | 'fakeBin' | 'openLog'>): void {
  process.env.HOME = rig.userHome
  process.env.XDG_CONFIG_HOME = rig.xdgHome
  process.env.QUIRKY_HOME = rig.home
  process.env.QUIRKY_VAULT_SOURCE_HOME = rig.sourceHome
  process.env.CLAUDE_CONFIG_DIR = join(rig.sourceHome, '.claude')
  process.env.CODEX_HOME = join(rig.sourceHome, '.codex')
  process.env.QUIRKY_AGENT_SEARCH_DIRS = rig.agentSearchDir
  process.env.QUIRKY_TEST_OPEN_LOG = rig.openLog
  process.env.QUIRKY_MOBILE_PORT = '0'
  process.env.QUIRKY_MOBILE_HOST = '127.0.0.1'
  process.env.SHELL = '/bin/sh'
  process.env.PATH = `${rig.fakeBin}:/usr/bin:/bin`
}

function restoreEnvironment(environment: Map<typeof ENV_KEYS[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = environment.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function cleanupWorld(world: WorldState): Promise<void> {
  if (world.cleaned) return
  let failed = false
  let firstError: unknown
  const attempt = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  for (const rig of world.rigs.slice().reverse()) {
    if (rig.cleaned) continue
    if (rig.realPty) {
      const realPty = rig.realPty
      await attempt(() => rig.harness.daemon.stop())
      await attempt(() => realPty.stop())
      rig.realPty = undefined
    }
    try {
      await rig.harness.cleanup()
      rig.cleaned = true
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  try {
    rmSync(world.root, { recursive: true, force: true })
  } catch (error) {
    if (!failed) firstError = error
    failed = true
  }
  restoreEnvironment(world.previousEnvironment)
  world.cleaned = true
  if (failed) throw firstError
}

async function startRig(world: WorldState, label: string): Promise<HostRig> {
  const root = join(world.root, label)
  const home = join(root, 'quirky-home')
  const userHome = join(root, 'user-home')
  const sourceHome = join(root, 'source-home')
  const xdgHome = join(root, 'xdg-config')
  const agentSearchDir = join(root, 'empty-agent-search')
  const fakeBin = join(root, 'controlled-agent-bin')
  const openLog = join(home, 'open-external.jsonl')
  for (const path of [home, userHome, sourceHome, xdgHome, agentSearchDir, fakeBin]) mkdirSync(path, { recursive: true })
  applyRigEnvironment({ home, userHome, sourceHome, xdgHome, agentSearchDir, fakeBin, openLog })
  await writeEveryAgentFixture(sourceHome, { cwdRoot: join(sourceHome, 'workspaces') })
  await writeScopeFixture(sourceHome, 0)

  const builtinPluginsDir = join(home, 'builtins')
  mkdirSync(builtinPluginsDir, { recursive: true })
  for (const id of PLUGINS) symlinkSync(join(REPO_ROOT, 'plugins', id), join(builtinPluginsDir, id), 'dir')

  const harness = await startHarness({ home, builtinPluginsDir })
  try {
    const connected = await harness.connectWithEvents('cli')
    const rig: HostRig = {
      label,
      root,
      home,
      userHome,
      sourceHome,
      xdgHome,
      agentSearchDir,
      fakeBin,
      openLog,
      builtinPluginsDir,
      harness,
      client: connected.client,
      cleaned: false
    }
    await call(rig, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: join(home, 'worktrees')
    })
    // Activate lazy Vault under this rig's environment without enabling transcript indexing.
    await call(rig, 'quirky.vault/searchStatus', { host: 'local' })
    world.rigs.push(rig)
    return rig
  } catch (error) {
    await harness.cleanup()
    throw error
  }
}

function ownerReference(host: RegisteredHost): OwnerSessionHostRef {
  if (host.id !== host.identity.hostId) throw new Error('registered owner ID did not match its producer-issued host ID')
  return {
    hostId: host.id,
    identity: { hostId: host.identity.hostId, generation: host.identity.generation },
    runtime: { id: host.runtime.id, endpoint: host.runtime.endpoint, grantId: host.runtime.grantId }
  }
}

function workspaceReference(owner: OwnerSessionHostRef, mirror: Mirror): OwnerSessionWorkspaceRef {
  return {
    owner,
    mirrorId: mirror.id,
    worktreeId: mirror.worktree.id,
    instanceId: mirror.worktree.instanceId,
    fingerprint: mirror.fingerprint
  }
}

async function registerOwner(local: HostRig, rig: HostRig, repoPath: string): Promise<RegisteredOwner> {
  const offer = await call<{ offer: string }>(rig, 'quirky.mobile/ownerPair', {
    name: `${rig.label} full owner`,
    address: '127.0.0.1',
    confirm: true
  })
  const runtime = await call<SavedRuntime>(local, 'quirky.cli/runtimeAdd', {
    name: `${rig.label} full owner`,
    pairingCode: offer.offer
  })
  const registered = await call<RegisteredHost>(local, 'quirky.worktree/remoteHostRegister', { runtime: runtime.id })
  const hosts = await call<{ hosts: RegisteredHost[] }>(local, 'quirky.worktree/remoteHostList')
  const host = hosts.hosts.find((candidate) => candidate.id === registered.id)
  if (!host) throw new Error(`registered host ${registered.id} was absent from the canonical owner registry`)
  const ownerRef = ownerReference(host)

  const repo = await call<{ id: string }>(rig, 'quirky.repo/add', { path: repoPath })
  const created = await call<{ worktree: Worktree }>(rig, 'quirky.worktree/create', {
    repo: repo.id,
    name: `${rig.label}-owner-workspace`
  })
  const worktree = created.worktree
  if (typeof worktree.path !== 'string' || !existsSync(worktree.path)) {
    throw new Error(`owner ${rig.label} did not create an existing canonical workspace`)
  }
  await call(local, 'quirky.worktree/remoteAttach', { host: host.id, worktree: worktree.id })
  await call(local, 'quirky.worktree/remoteRefresh', { host: host.id })
  const mirrors = await call<{ workspaces: Mirror[] }>(local, 'quirky.worktree/remoteList', { host: host.id })
  const mirror = mirrors.workspaces.find((candidate) => candidate.worktree.id === worktree.id)
  if (!mirror) throw new Error(`owner ${rig.label} workspace was not present in its registered mirror list`)
  return {
    rig,
    runtime,
    host,
    repoId: repo.id,
    worktree,
    mirror,
    ownerRef,
    workspaceRef: workspaceReference(ownerRef, mirror)
  }
}

async function startWorld(): Promise<World> {
  const world: WorldState = {
    root: mkdtempSync(join(tmpdir(), 'qv-owner-host-')),
    previousEnvironment: new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const)),
    rigs: [],
    cleaned: false
  }
  worlds.push(world)
  try {
    const local = await startRig(world, 'local')
    const ownerARig = await startRig(world, 'owner-a')
    const ownerBRig = await startRig(world, 'owner-b')
    const repoPath = makeRepo(scratch())
    await call(local, 'quirky.repo/add', { path: repoPath })
    const ownerA = await registerOwner(local, ownerARig, repoPath)
    const ownerB = await registerOwner(local, ownerBRig, repoPath)
    return Object.assign(world, { local, owners: [ownerA, ownerB] as [RegisteredOwner, RegisteredOwner], repoPath })
  } catch (error) {
    await cleanupWorld(world)
    throw error
  }
}

async function writeResumeTranscript(rig: HostRig, cwd: string, hostName: string): Promise<OwnerTranscript> {
  const transcript: OwnerTranscript = {
    title: `${hostName} archived resume source`,
    firstPrompt: `First prompt from ${hostName}: ${HOST_SEARCH_MARKER}`,
    lastPrompt: `Last prompt from ${hostName}: ${HOST_SEARCH_MARKER}`,
    lastMessage: `Last response from ${hostName}`
  }
  const at = Date.UTC(2026, 9, 27, 10, 0, 0)
  rig.resumeTranscriptPath = await writeJsonlFixture(rig.sourceHome, 'claude', RESUME_PROVIDER_ID, [
    {
      type: 'user',
      sessionId: RESUME_PROVIDER_ID,
      timestamp: new Date(at).toISOString(),
      cwd,
      message: { role: 'user', content: transcript.firstPrompt }
    },
    {
      type: 'assistant',
      sessionId: RESUME_PROVIDER_ID,
      timestamp: new Date(at + 1_000).toISOString(),
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: `First answer from ${hostName}` }] }
    },
    {
      type: 'user',
      sessionId: RESUME_PROVIDER_ID,
      timestamp: new Date(at + 2_000).toISOString(),
      cwd,
      message: { role: 'user', content: transcript.lastPrompt }
    },
    {
      type: 'assistant',
      sessionId: RESUME_PROVIDER_ID,
      timestamp: new Date(at + 3_000).toISOString(),
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: transcript.lastMessage }] }
    },
    {
      type: 'custom-title',
      sessionId: RESUME_PROVIDER_ID,
      timestamp: new Date(at + 4_000).toISOString(),
      customTitle: transcript.title
    }
  ])
  return transcript
}

function installFakeAgent(rig: HostRig): FakeAgent {
  const launcher = join(rig.fakeBin, `claude-${rig.label}`)
  const log = `${launcher}.log.jsonl`
  const ownerEnvLog = `${launcher}.owner-env.jsonl`
  const secretName = `OWNER_TEST_SECRET_${rig.label.replaceAll('-', '_').toUpperCase()}`
  const secretValue = `private-launch-environment-${rig.label}`
  writeFileSync(launcher, `#!${process.execPath}
import ${JSON.stringify(FAKE_AGENT)}
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ownerEnvLog)}, JSON.stringify({
  type: 'owner-env',
  name: ${JSON.stringify(secretName)},
  value: process.env[${JSON.stringify(secretName)}] ?? null
}) + '\\n')
`)
  chmodSync(launcher, 0o700)
  return { launcher, log, ownerEnvLog, secretName, secretValue }
}

async function configureFakeAgent(rig: HostRig): Promise<void> {
  const fake = rig.fake ?? installFakeAgent(rig)
  rig.fake = fake
  await call(rig, 'quirky.agents/configure', {
    agent: 'claude',
    command: `'${fake.launcher}'`,
    args: `--owner-controlled ${rig.label}`,
    env: { [fake.secretName]: fake.secretValue }
  })
}

function fakeStarts(fake: FakeAgent): { type: string; argv: string[]; env: Record<string, string>; cwd: string }[] {
  if (!existsSync(fake.log)) return []
  return readFileSync(fake.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; argv: string[]; env: Record<string, string>; cwd: string })
    .filter((event) => event.type === 'start')
}
function usePhysicalPty(rig: HostRig): void {
  const fakePty = rig.harness.pty
  const stopFakePty = fakePty.stop.bind(fakePty)
  let stopped = false
  fakePty.stop = () => {
    if (stopped) return
    stopped = true
    stopFakePty()
  }
  fakePty.stop()
  rig.realPty = startPtyServer({ home: rig.home })
}

function sessionFor(sessions: PublicSession[], hostId: string, sessionId: string): PublicSession {
  const session = sessions.find((candidate) => candidate.hostId === hostId && candidate.sessionId === sessionId)
  if (!session) throw new Error(`Vault omitted ${sessionId} from host ${hostId}`)
  return session
}

function hitsOf(result: SearchReply): SearchReply['hits'] {
  return Array.isArray(result.hits) ? result.hits : []
}

async function expectConflict(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toMatchObject({ code: RpcErrorCode.Conflict })
  return error
}

function searchDatabase(rig: HostRig): string {
  return join(rig.home, 'plugin-data', 'quirky.vault', 'session-search.sqlite')
}

test('production Vault hosts preserve owner-qualified records, opt-in search and partial offline results', async () => {
  const world = await startWorld()
  const hostIds = ['local', ...world.owners.map((owner) => owner.host.id)]

  const listed = await call<PublicList>(world.local, 'quirky.vault/list', {
    host: 'all',
    agents: ['claude', 'codex'],
    unlimited: true
  })
  const duplicateClaude = listed.sessions.filter((session) => session.sessionId === DUPLICATE_PROVIDER_ID)
  expect(duplicateClaude).toHaveLength(3)
  expect(duplicateClaude.map((session) => session.hostId).sort()).toEqual(hostIds.slice().sort())
  expect(new Set(duplicateClaude.map((session) => session.id)).size).toBe(3)

  const duplicateCodex = listed.sessions.filter((session) => session.sessionId === 'codex-session')
  expect(duplicateCodex).toHaveLength(3)
  expect(new Set(duplicateCodex.map((session) => session.id)).size).toBe(3)
  for (const owner of world.owners) {
    const claude = sessionFor(duplicateClaude, owner.host.id, DUPLICATE_PROVIDER_ID)
    const codex = sessionFor(duplicateCodex, owner.host.id, 'codex-session')
    expect(claude.source).toEqual({ presence: 'present' })
    expect(codex.source).toEqual({ presence: 'present' })
    expect(claude).not.toHaveProperty('filePath')
    expect(claude).not.toHaveProperty('codexHome')
    expect(codex).not.toHaveProperty('filePath')
    expect(codex).not.toHaveProperty('codexHome')
  }
  expect(listed.hosts.map((host) => host.hostId).sort()).toEqual(hostIds.slice().sort())

  for (const owner of world.owners) {
    const selected = await call<PublicList>(world.local, 'quirky.vault/list', {
      host: owner.host.id,
      agents: ['claude'],
      unlimited: true
    })
    expect(selected.sessions.length).toBeGreaterThan(0)
    expect(selected.sessions.every((session) => session.hostId === owner.host.id)).toBe(true)
    expect(selected.sessions.some((session) => session.sessionId === DUPLICATE_PROVIDER_ID)).toBe(true)
  }

  const cli = await runCli(['vault', 'list', '--host', 'all', '--unlimited', '--json'], {
    home: world.local.home,
    cwd: world.local.home
  })
  expect(cli.code).toBe(0)
  expect(cli.stderr).toBe('')
  const cliList = JSON.parse(cli.stdout) as PublicList
  expect(cliList.sessions.filter((session) => session.sessionId === DUPLICATE_PROVIDER_ID).map((session) => session.hostId).sort())
    .toEqual(hostIds.slice().sort())

  const disabledStatus = await call<{ status: { enabled: boolean }; hosts: Outcome[] }>(world.local, 'quirky.vault/searchStatus', { host: 'all' })
  expect(disabledStatus.hosts.map((host) => host.hostId).sort()).toEqual(hostIds.slice().sort())
  expect(disabledStatus.hosts.every((host) => host.kind === 'ok')).toBe(true)
  expect(disabledStatus.status.enabled).toBe(false)
  for (const rig of world.rigs) expect(existsSync(searchDatabase(rig))).toBe(false)

  const disabledSearch = await call<SearchReply>(world.local, 'quirky.vault/search', {
    query: HOST_SEARCH_MARKER,
    host: 'all',
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  })
  expect(hitsOf(disabledSearch)).toEqual([])
  expect(JSON.stringify(disabledSearch)).not.toContain(HOST_SEARCH_MARKER)

  const enableOrder: string[] = []
  const seenEnable = new Set<string>()
  const listeners = world.rigs.map((rig) => rig.client.onEvent((event: QuirkyEvent) => {
    if (event.type !== 'quirky.vault/searchStatus') return
    const status = recordOf(event.data)
    if (status?.enabled !== true || seenEnable.has(rig.label)) return
    seenEnable.add(rig.label)
    enableOrder.push(rig.label)
  }))
  let enabled: { status: { enabled: boolean }; hosts: Outcome[] }
  try {
    enabled = await call<{ status: { enabled: boolean }; hosts: Outcome[] }>(world.local, 'quirky.vault/setSearchEnabled', { enabled: true, host: 'all' })
    await waitForAsync(() => enableOrder.length === world.rigs.length ? true : undefined, 15_000)
  } finally {
    for (const unsubscribe of listeners) unsubscribe()
  }
  const registeredOrder = (await call<{ hosts: RegisteredHost[] }>(world.local, 'quirky.worktree/remoteHostList')).hosts
    .map((host) => host.id)
  expect(enabled.hosts.map((host) => host.hostId)).toEqual(['local', ...registeredOrder])
  expect(enabled.hosts.every((host) => host.kind === 'ok')).toBe(true)
  const labelsByHost = new Map(world.owners.map((owner) => [owner.host.id, owner.rig.label]))
  const expectedEnableOrder = enabled.hosts.map((host) => {
    if (host.hostId === 'local') return 'local'
    const label = labelsByHost.get(host.hostId)
    if (label === undefined) throw new Error(`Enabled host ${host.hostId} has no matching test rig`)
    return label
  })
  expect(enableOrder).toEqual(expectedEnableOrder)
  expect(enabled.status.enabled).toBe(true)
  for (const rig of world.rigs) expect(existsSync(searchDatabase(rig))).toBe(true)

  const scoped = await call<SearchReply>(world.local, 'quirky.vault/search', {
    query: HOST_SEARCH_MARKER,
    host: 'all',
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  })
  const duplicateIds = duplicateClaude.map((session) => session.id)
  expect(scoped.kind).toBe('results')
  for (const id of duplicateIds) expect(hitsOf(scoped)?.some((hit) => hit.id === id)).toBe(true)

  const unknownWorkspace = await call<SearchReply>(world.local, 'quirky.vault/search', {
    query: HOST_SEARCH_MARKER,
    host: 'all',
    within: { worktree: 'owner-workspace-that-is-not-registered' },
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  })
  expect(hitsOf(unknownWorkspace)).toEqual([])
  expect(JSON.stringify(unknownWorkspace)).not.toContain(HOST_SEARCH_MARKER)

  const unavailableOwner = world.owners[1]!
  await unavailableOwner.rig.harness.cleanup()
  unavailableOwner.rig.cleaned = true

  const partialList = await call<PublicList>(world.local, 'quirky.vault/list', {
    host: 'all',
    agents: ['claude'],
    unlimited: true
  })
  const goodHost = world.owners[0]!.host.id
  expect(partialList.sessions.some((session) => session.hostId === 'local' && session.sessionId === DUPLICATE_PROVIDER_ID)).toBe(true)
  expect(partialList.sessions.some((session) => session.hostId === goodHost && session.sessionId === DUPLICATE_PROVIDER_ID)).toBe(true)
  expect(partialList.sessions.some((session) => session.hostId === unavailableOwner.host.id)).toBe(false)
  expect(partialList.hosts.find((host) => host.hostId === unavailableOwner.host.id)?.kind).not.toBe('ok')

  const partialStatus = await call<{ status: { enabled: boolean }; hosts: Outcome[] }>(world.local, 'quirky.vault/searchStatus', { host: 'all' })
  expect(partialStatus.hosts.find((host) => host.hostId === 'local')?.kind).toBe('ok')
  expect(partialStatus.hosts.find((host) => host.hostId === goodHost)?.kind).toBe('ok')
  expect(partialStatus.hosts.find((host) => host.hostId === unavailableOwner.host.id)?.kind).not.toBe('ok')

  const partialSearch = await call<SearchReply>(world.local, 'quirky.vault/search', {
    query: HOST_SEARCH_MARKER,
    host: 'all',
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  })
  expect(partialSearch.kind).toBe('results')
  const partialHits = hitsOf(partialSearch) ?? []
  expect(partialHits.some((hit) => hit.id === duplicateClaude.find((session) => session.hostId === 'local')!.id)).toBe(true)
  expect(partialHits.some((hit) => hit.id === duplicateClaude.find((session) => session.hostId === goodHost)!.id)).toBe(true)
  expect(partialHits.some((hit) => hit.id === duplicateClaude.find((session) => session.hostId === unavailableOwner.host.id)!.id)).toBe(false)
  expect(partialSearch.hosts?.find((host) => host.hostId === unavailableOwner.host.id)?.kind).not.toBe('ok')
  expect(JSON.stringify(partialSearch)).not.toContain(unavailableOwner.rig.sourceHome)
}, 120_000)

test('remote Vault actions stay owner-bound, sanitize handoff, and fence stale registrations and instances', async () => {
  const world = await startWorld()
  const [ownerA, ownerB] = world.owners
  const localTranscript = await writeResumeTranscript(world.local, world.repoPath, 'local')
  const transcriptA = await writeResumeTranscript(ownerA.rig, ownerA.worktree.path, 'owner-a')
  const transcriptB = await writeResumeTranscript(ownerB.rig, ownerB.worktree.path, 'owner-b')
  for (const rig of world.rigs) await configureFakeAgent(rig)

  const listed = await call<PublicList>(world.local, 'quirky.vault/list', {
    host: 'all',
    agents: ['claude', 'codex'],
    unlimited: true
  })
  const sessionA = sessionFor(listed.sessions, ownerA.host.id, RESUME_PROVIDER_ID)
  const sessionB = sessionFor(listed.sessions, ownerB.host.id, RESUME_PROVIDER_ID)
  const localSession = sessionFor(listed.sessions, 'local', RESUME_PROVIDER_ID)
  expect(sessionA.id).not.toBe(sessionB.id)
  expect(sessionA.title).toBe(transcriptA.title)
  expect(sessionB.title).toBe(transcriptB.title)
  expect(localSession.title).toBe(localTranscript.title)

  const details = await call<PublicSession>(world.local, 'quirky.vault/get', { id: sessionA.id })
  expect(details).toMatchObject({
    id: sessionA.id,
    sourceId: sessionA.sourceId,
    hostId: ownerA.host.id,
    sessionId: RESUME_PROVIDER_ID,
    title: transcriptA.title
  })
  expect(details.source).toEqual({ presence: 'present' })
  expect(details).not.toHaveProperty('filePath')
  expect(details).not.toHaveProperty('codexHome')
  expect(JSON.stringify(details)).not.toContain(ownerA.rig.resumeTranscriptPath!)
  expect(JSON.stringify(details)).not.toContain(ownerA.rig.fake!.launcher)
  expect(JSON.stringify(details)).not.toContain(ownerA.rig.fake!.secretValue)

  const firstPrompt = await call<{ prompt: string | null }>(world.local, 'quirky.vault/firstPrompt', { id: sessionA.id })
  expect(firstPrompt.prompt).toBe(transcriptA.firstPrompt)
  expect(JSON.stringify(firstPrompt)).not.toContain(ownerA.rig.resumeTranscriptPath!)
  expect(JSON.stringify(firstPrompt)).not.toContain(ownerA.rig.fake!.secretValue)
  const transcriptPath = ownerA.rig.resumeTranscriptPath!
  const originalTranscript = readFileSync(transcriptPath)
  chmodSync(transcriptPath, 0)
  try {
    const unreadable = await world.local.client.callAny('quirky.vault/firstPrompt', { id: sessionA.id })
      .then(() => undefined, (error: unknown) => error)
    expect(unreadable).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(JSON.stringify(unreadable)).not.toContain(transcriptPath)
  } finally {
    chmodSync(transcriptPath, 0o600)
  }
  expect(readFileSync(transcriptPath)).toEqual(originalTranscript)

  const scopedParent = sessionFor(listed.sessions, ownerA.host.id, 'worktree-session')
  const subagents = await call<PublicSession[]>(world.local, 'quirky.vault/subagents', { id: scopedParent.id })
  expect(subagents).toHaveLength(1)
  expect(subagents[0]).toMatchObject({ hostId: ownerA.host.id, source: { presence: 'present' } })
  expect(subagents[0]!.id).toMatch(/^vault1\./)
  expect(subagents[0]!.id).not.toBe(scopedParent.id)
  expect(subagents[0]).not.toHaveProperty('filePath')
  expect(subagents[0]).not.toHaveProperty('codexHome')
  expect(JSON.stringify(subagents)).not.toContain(ownerA.rig.sourceHome)

  const ownerLocalList = await call<PublicList>(ownerA.rig, 'quirky.vault/list', {
    host: 'local',
    agents: ['claude'],
    unlimited: true
  })
  const ownerLocalSession = sessionFor(ownerLocalList.sessions, 'local', RESUME_PROVIDER_ID)
  expect(ownerLocalSession.id).toMatch(/^vault1\./)

  const connectedUi = await world.local.harness.connectWithEvents('ui')
  const uiContext = {
    call: (method: string, params: Record<string, unknown> = {}) => connectedUi.client.callAny(method, params),
    toast: () => {}
  } as unknown as UiPluginContext
  const dialog = new HandoffDialog(uiContext)
  const openedSources: Record<string, unknown>[] = []
  const { promise: openArchivedRequest, resolve: resolveOpenedSource } = Promise.withResolvers<Record<string, unknown>>()
  const unlisten = connectedUi.client.onEvent((event: QuirkyEvent) => {
    const value = event as unknown as { type?: string; id?: string; args?: unknown; requestId?: string }
    if (value.type !== 'ui.command.request' || value.id !== 'command:quirky.handoff/open-archived') return
    const args = recordOf(value.args)
    const source = recordOf(args?.source)
    const archived = recordOf(source?.archived)
    const requestId = value.requestId
    if (!archived || typeof requestId !== 'string') return
    openedSources.push(archived)
    resolveOpenedSource(archived)
    void dialog.openArchived(archived as unknown as Parameters<typeof dialog.openArchived>[0]).then(
      (result) => connectedUi.client.call('ui.command.reply', { requestId, result }),
      (error: unknown) => connectedUi.client.call('ui.command.reply', {
        requestId,
        result: { ok: false, reason: error instanceof Error ? error.message : String(error) }
      })
    )
  })

  const handoff = await call<{ available: boolean; result?: { opened?: boolean }; reason?: string }>(
    world.local,
    'quirky.vault/handoff',
    { id: sessionA.id }
  )
  expect(handoff).toMatchObject({ available: true, result: { opened: true } })
  const archived = await openArchivedRequest
  expect(archived).toMatchObject({
    agent: 'claude',
    title: transcriptA.title,
    providerSessionId: RESUME_PROVIDER_ID,
    prompt: transcriptA.lastPrompt,
    lastMessage: transcriptA.lastMessage,
    owner: ownerA.ownerRef,
    vaultId: ownerLocalSession.id
  })
  for (const key of ['transcriptPath', 'cwd', 'worktree', 'command', 'env', 'codexHome']) {
    expect(archived).not.toHaveProperty(key)
  }
  const archivedJson = JSON.stringify(archived)
  expect(archivedJson).not.toContain(ownerA.rig.sourceHome)
  expect(archivedJson).not.toContain(ownerA.rig.resumeTranscriptPath!)
  expect(archivedJson).not.toContain(ownerA.worktree.path)
  expect(archivedJson).not.toContain(ownerA.rig.fake!.launcher)
  expect(archivedJson).not.toContain(ownerA.rig.fake!.secretName)
  expect(archivedJson).not.toContain(ownerA.rig.fake!.secretValue)
  expect(archivedJson).not.toContain('deviceToken')
  expect(openedSources).toHaveLength(1)
  expect(dialog.getSnapshot()).toMatchObject({
    shown: true,
    source: {
      session: null,
      agent: 'claude',
      title: transcriptA.title,
      providerSessionId: RESUME_PROVIDER_ID,
      prompt: transcriptA.lastPrompt,
      lastMessage: transcriptA.lastMessage,
      live: false
    }
  })
  const dialogSourceJson = JSON.stringify(dialog.getSnapshot().source)
  expect(dialogSourceJson).not.toContain(ownerA.rig.sourceHome)
  expect(dialogSourceJson).not.toContain(ownerA.rig.resumeTranscriptPath!)
  expect(dialogSourceJson).not.toContain(ownerA.worktree.path)
  expect(dialogSourceJson).not.toContain(ownerA.rig.fake!.secretValue)
  unlisten()
  dialog.stop()

  const codexRemote = sessionFor(listed.sessions, ownerA.host.id, 'codex-session')
  expect(codexRemote.source).toEqual({ presence: 'present' })
  expect(codexRemote).not.toHaveProperty('codexHome')
  expect(codexRemote.source).not.toHaveProperty('codexHome')
  expect(codexRemote.source).not.toHaveProperty('filePath')

  const beforeTrash = readFileSync(ownerA.rig.resumeTranscriptPath!)
  const previousOpenLog = process.env.QUIRKY_TEST_OPEN_LOG
  process.env.QUIRKY_TEST_OPEN_LOG = world.local.openLog
  try {
    await expectConflict(call(world.local, 'quirky.vault/prepareResume', { id: sessionA.id }))
    await expectConflict(call(world.local, 'quirky.vault/deleteSession', { id: sessionA.id, yes: true }))
    await expectConflict(call(world.local, 'quirky.vault/openSource', { id: sessionA.id, mode: 'open' }))
    await expectConflict(call(world.local, 'quirky.vault/openSource', { id: sessionA.id, mode: 'reveal' }))
    await expectConflict(call(world.local, 'quirky.vault/openWorkingDirectory', { id: sessionA.id }))
  } finally {
    if (previousOpenLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
    else process.env.QUIRKY_TEST_OPEN_LOG = previousOpenLog
  }
  expect(existsSync(world.local.openLog)).toBe(false)
  expect(readFileSync(ownerA.rig.resumeTranscriptPath!)).toEqual(beforeTrash)
  expect(fakeStarts(ownerA.rig.fake!)).toHaveLength(0)
  expect(fakeStarts(world.local.fake!)).toHaveLength(0)

  const oldWorktreeB = ownerB.worktree
  await call(ownerB.rig, 'quirky.worktree/remove', {
    worktree: `id:${oldWorktreeB.id}`,
    safeOnly: true,
    skipArchive: true,
    yes: true
  })
  const replacement = await call<{ worktree: Worktree }>(ownerB.rig, 'quirky.worktree/create', {
    repo: ownerB.repoId,
    name: oldWorktreeB.name ?? 'owner-b-owner-workspace'
  })
  expect(replacement.worktree.id).toBe(oldWorktreeB.id)
  expect(replacement.worktree.instanceId).not.toBe(oldWorktreeB.instanceId)
  expect(replacement.worktree.path).toBe(oldWorktreeB.path)
  await call(world.local, 'quirky.worktree/remoteRefresh', { host: ownerB.host.id })

  const directOwnerResume = await world.local.client.callAny('quirky.cli/runtimeCall', {
    runtime: ownerB.runtime.id,
    method: 'quirky.vault/ownerResume',
    params: {
      id: sessionFor((await call<PublicList>(ownerB.rig, 'quirky.vault/list', {
        host: 'local', agents: ['claude'], unlimited: true
      })).sessions, 'local', RESUME_PROVIDER_ID).sourceId,
      worktree: oldWorktreeB.id,
      expectedInstanceId: oldWorktreeB.instanceId
    },
    expectedHost: ownerB.ownerRef.identity,
    expectedRuntime: ownerB.ownerRef.runtime
  }).then(() => undefined, (error: unknown) => error)
  expect(directOwnerResume).toMatchObject({ code: RpcErrorCode.Conflict })
  expect(JSON.stringify(directOwnerResume)).not.toContain(ownerB.rig.sourceHome)
  expect(JSON.stringify(directOwnerResume)).not.toContain(ownerB.worktree.path)
  await expectConflict(call(world.local, 'quirky.vault/resume', { id: sessionB.id, remote: ownerB.workspaceRef }))
  await expectConflict(call(world.local, 'quirky.vault/resume', { id: sessionA.id, remote: ownerB.workspaceRef }))
  expect(fakeStarts(ownerB.rig.fake!)).toHaveLength(0)
  expect(fakeStarts(ownerA.rig.fake!)).toHaveLength(0)
  expect(fakeStarts(world.local.fake!)).toHaveLength(0)

  const replacementOffer = await call<{ offer: string }>(ownerB.rig, 'quirky.mobile/ownerPair', {
    name: 'owner-b replacement grant',
    address: '127.0.0.1',
    confirm: true
  })
  await call(world.local, 'quirky.cli/runtimeRemove', { selector: ownerB.runtime.id, yes: true })
  const replacementRuntime = await call<SavedRuntime>(world.local, 'quirky.cli/runtimeAdd', {
    name: ownerB.runtime.name,
    pairingCode: replacementOffer.offer
  })
  const rebound = await call<RegisteredHost>(world.local, 'quirky.worktree/remoteHostRegister', {
    runtime: replacementRuntime.id,
    replace: true
  })
  expect(rebound.id).toBe(ownerB.host.id)
  expect(rebound.runtime.grantId).not.toBe(ownerB.ownerRef.runtime.grantId)
  await call(world.local, 'quirky.worktree/remoteRefresh', { host: rebound.id })
  const currentHost = await call<{ hosts: RegisteredHost[] }>(world.local, 'quirky.worktree/remoteHostList')
  const currentOwner = currentHost.hosts.find((host) => host.id === rebound.id)
  if (!currentOwner) throw new Error('rebound host was absent from the canonical owner registry')
  const currentOwnerRef = ownerReference(currentOwner)
  const currentMirrorList = await call<{ workspaces: Mirror[] }>(world.local, 'quirky.worktree/remoteList', { host: rebound.id })
  const currentMirror = currentMirrorList.workspaces.find((mirror) => mirror.worktree.id === replacement.worktree.id)
  if (!currentMirror) throw new Error('rebound host workspace was absent from its canonical mirror list')
  const staleGrantWorkspace = { ...workspaceReference(currentOwnerRef, currentMirror), owner: ownerB.ownerRef }
  await expectConflict(call(world.local, 'quirky.vault/resume', { id: sessionB.id, remote: staleGrantWorkspace }))
  expect(fakeStarts(ownerB.rig.fake!)).toHaveLength(0)

  const phonePair = await call<{ pairingUrl: string }>(ownerA.rig, 'quirky.mobile/pair', { address: '127.0.0.1' })
  const phoneRuntime = await call<SavedRuntime>(world.local, 'quirky.cli/runtimeAdd', {
    name: 'phone-scoped target only',
    pairingCode: phonePair.pairingUrl
  })
  const phoneRegistration = await world.local.client.callAny('quirky.worktree/remoteHostRegister', { runtime: phoneRuntime.id })
    .then(() => undefined, (error: unknown) => error)
  expect(phoneRegistration).toBeDefined()
  const registeredAfterPhoneAttempt = await call<{ hosts: RegisteredHost[] }>(world.local, 'quirky.worktree/remoteHostList')
  expect(registeredAfterPhoneAttempt.hosts.map((host) => host.id).sort()).toEqual([ownerA.host.id, ownerB.host.id].sort())
  expect(fakeStarts(world.local.fake!)).toHaveLength(0)
  expect(fakeStarts(ownerA.rig.fake!)).toHaveLength(0)
  expect(fakeStarts(ownerB.rig.fake!)).toHaveLength(0)

  const resumeEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const))
  try {
    applyRigEnvironment(ownerA.rig)
    usePhysicalPty(ownerA.rig)
    const resumeCli = await runCli([
      'vault',
      'resume',
      sessionA.id,
      '--remote',
      JSON.stringify(ownerA.workspaceRef),
      '--json'
    ], { home: world.local.home, cwd: world.repoPath })
    expect(resumeCli.code).toBe(0)
    expect(resumeCli.stderr).toBe('')
    const resumeResult = JSON.parse(resumeCli.stdout) as unknown
    expect(JSON.stringify(resumeResult)).not.toContain(ownerA.rig.sourceHome)
    expect(JSON.stringify(resumeResult)).not.toContain(ownerA.rig.resumeTranscriptPath!)
    expect(JSON.stringify(resumeResult)).not.toContain(ownerA.rig.fake!.launcher)
    expect(JSON.stringify(resumeResult)).not.toContain(ownerA.rig.fake!.secretValue)
    expect(JSON.stringify(resumeResult)).not.toContain(ownerA.worktree.path)
    const launched = await waitForAsync(() => {
      const start = fakeStarts(ownerA.rig.fake!).find((event) => event.type === 'start')
      return start && existsSync(ownerA.rig.fake!.ownerEnvLog) ? start : undefined
    }, 15_000)
    expect(launched.cwd).toBe(ownerA.worktree.path)
    expect(launched.env.HOME).toBe(ownerA.rig.userHome)
    const ownerEnv = JSON.parse(readFileSync(ownerA.rig.fake!.ownerEnvLog, 'utf8')) as {
      type: string
      name: string
      value: string | null
    }
    expect(ownerEnv).toEqual({
      type: 'owner-env',
      name: ownerA.rig.fake!.secretName,
      value: ownerA.rig.fake!.secretValue
    })
    expect(launched.argv).toContain('--resume')
    expect(launched.argv).toContain(RESUME_PROVIDER_ID)
    expect(fakeStarts(world.local.fake!)).toHaveLength(0)
    expect(fakeStarts(ownerB.rig.fake!)).toHaveLength(0)
    expect(fakeStarts(ownerA.rig.fake!)).toHaveLength(1)
  } finally {
    restoreEnvironment(resumeEnvironment)
  }
  const endpoint = new URL(ownerA.host.runtime.endpoint)
  if (endpoint.port === '') throw new Error('saved owner endpoint did not include its mobile listener port')
  const previousEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const))
  for (const client of ownerA.rig.harness.clients) client.close()
  await ownerA.rig.harness.daemon.stop()
  const realPty = ownerA.rig.realPty
  if (!realPty) throw new Error('owner A physical PTY host was unavailable during restart')
  await realPty.stop()
  ownerA.rig.realPty = undefined
  applyRigEnvironment(ownerA.rig)
  process.env.QUIRKY_MOBILE_PORT = endpoint.port
  try {
    ownerA.rig.harness = await startHarness({ home: ownerA.rig.home, builtinPluginsDir: ownerA.rig.builtinPluginsDir })
    ownerA.rig.client = (await ownerA.rig.harness.connectWithEvents('cli')).client
  } finally {
    restoreEnvironment(previousEnvironment)
  }

  const reactivated = await call<{ runtime: SavedRuntime; result: HostIdentity }>(world.local, 'quirky.cli/runtimeCall', {
    runtime: ownerA.runtime.id,
    method: 'quirky.cli/hostIdentity',
    params: {}
  })
  expect(reactivated.result.hostId).toBe(ownerA.host.identity.hostId)
  expect(reactivated.result.generation).not.toBe(ownerA.ownerRef.identity.generation)
  const staleStatus = await call<RegisteredHost>(world.local, 'quirky.worktree/remoteHostStatus', { host: ownerA.host.id })
  expect(staleStatus.connected).toBe(false)

  const staleGet = await world.local.client.callAny('quirky.vault/get', { id: sessionA.id })
    .then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
  expect('error' in staleGet).toBe(true)
  if ('error' in staleGet) {
    expect(staleGet.error).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(JSON.stringify(staleGet.error)).not.toContain(ownerA.rig.sourceHome)
  }
  await expectConflict(call(world.local, 'quirky.vault/resume', { id: sessionA.id, remote: ownerA.workspaceRef }))
  const stillLocal = await call<PublicSession>(world.local, 'quirky.vault/get', { id: localSession.id })
  expect(stillLocal).toMatchObject({ hostId: 'local', title: localTranscript.title })
  expect(fakeStarts(world.local.fake!)).toHaveLength(0)
  expect(fakeStarts(ownerA.rig.fake!)).toHaveLength(1)

}, 120_000)
