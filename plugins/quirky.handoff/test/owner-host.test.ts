import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { OwnerSessionWorkspaceRef, QuirkyClient, Repo, Session, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir, removeTempDirs, writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { writeClaudeFixture } from '../../quirky.vault/test/fixtures/scanner-fixtures'
import { CURSOR_ON, PASTE_END, PASTE_ON, PASTE_START } from './support'

const { scratch } = isolateGitConfig()
const PLUGINS_ROOT = resolve(import.meta.dir, '../..')
const BUILTIN_OWNERS = [
  'quirky.accounts', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.cli', 'quirky.git', 'quirky.handoff',
  'quirky.mobile', 'quirky.repo', 'quirky.session', 'quirky.structured', 'quirky.terminal', 'quirky.vault', 'quirky.worktree'
]
const ENV_KEYS = [
  'HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'QUIRKY_TEST_AGENT_TIME_SCALE',
  'QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST', 'QUIRKY_VAULT_SOURCE_HOME'
] as const

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
const owners: OwnerRig[] = []
const stoppers: (() => void)[] = []

type OwnerRig = {
  home: string
  userHome: string
  builtinPluginsDir: string
  shell: string
  h: Harness
  client: QuirkyClient
}

type Host = {
  id: string
  runtime: { id: string; name: string; endpoint: string; grantId: string }
  identity: { hostId: string; generation: string }
  connected: boolean
  error: string | null
}

type Mirror = {
  id: string
  hostId: string
  identity: { hostId: string; generation: string }
  worktree: Worktree
  connected: boolean
  fingerprint: string
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.QUIRKY_MOBILE_PORT = '0'
  process.env.QUIRKY_MOBILE_HOST = '127.0.0.1'
  process.env.QUIRKY_TEST_AGENT_TIME_SCALE = '0.05'
  process.env.QUIRKY_AGENT_SEARCH_DIRS = ''
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
})

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop()
  let cleanupError: unknown
  for (const owner of owners.splice(0).reverse()) {
    try {
      await owner.h.cleanup()
    } catch (error) {
      cleanupError ??= error
    }
  }
  try {
    removeTempDirs()
  } finally {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv = {}
  }
  if (cleanupError) throw cleanupError
})

const call = (owner: OwnerRig, method: string, params: Record<string, unknown> = {}) => owner.client.callAny(method, params)

function agentDefinition(id: string) {
  return {
    id,
    label: id === 'target-bot' ? 'Remote Target Bot' : id === 'blind-bot' ? 'Unobservable Bot' : 'Local Only Bot',
    detect: id,
    prompt: 'stdin-after-start',
    readySignal: 'render-cursor-after-bracketed-paste',
    readyTimeoutMs: 8000,
    blindPaste: id === 'blind-bot'
  }
}

async function startOwner(name: string, agents: string[]): Promise<OwnerRig> {
  const home = makeHomeWithoutAutoHooks(`handoff-owner-${name}-`)
  const userHome = realpathSync(makeTempDir(`handoff-user-${name}-`))
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const agent of agents) {
    const executable = join(bin, agent)
    writeFileSync(executable, '#!/bin/sh\ncat >/dev/null\n')
    chmodSync(executable, 0o755)
  }
  const shell = join(home, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho ${bin}\n`)
  chmodSync(shell, 0o755)

  const builtinPluginsDir = makeTempDir(`handoff-builtin-${name}-`)
  mkdirSync(builtinPluginsDir, { recursive: true })
  for (const id of BUILTIN_OWNERS) symlinkSync(join(PLUGINS_ROOT, id), join(builtinPluginsDir, id))
  const bots = writePlugin(join(home, 'bots-src'), {
    id: 'acme.bots', name: 'Controlled test agents', version: '1.0.0',
    contributes: { agent: agents.filter((agent) => agent !== 'claude').map(agentDefinition) }
  }, {})
  symlinkSync(bots, join(builtinPluginsDir, 'acme.bots'))

  process.env.HOME = userHome
  process.env.QUIRKY_VAULT_SOURCE_HOME = userHome
  const h = await startHarness({ home, shell, builtinPluginsDir })
  const owner: OwnerRig = { home, userHome, builtinPluginsDir, shell, h, client: await h.connect('cli') }
  owners.push(owner)
  await call(owner, 'setting.set', {
    id: 'setting:quirky.worktree/worktreesRoot',
    value: makeTempDir(`handoff-worktrees-${name}-`)
  })
  await call(owner, 'quirky.vault/searchStatus', { host: 'local' })
  return owner
}

/** A real remote PTY child is created during start; this polls the existing fake PTY host to inject its readiness bytes. */
function watchReady(owner: OwnerRig): () => void {
  const seen = new Set(owner.h.pty.sessions.keys())
  const timer = setInterval(() => {
    for (const id of owner.h.pty.sessions.keys()) {
      if (seen.has(id)) continue
      seen.add(id)
      owner.h.pty.emit(id, PASTE_ON + CURSOR_ON)
    }
  }, 5)
  const stop = () => clearInterval(timer)
  stoppers.push(stop)
  return stop
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('the operation should have refused the stale or non-owner target')
}

async function refusedOrFailed(promise: Promise<unknown>, privatePath: string): Promise<void> {
  let result: unknown
  try {
    result = await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).not.toContain(privatePath)
    return
  }
  expect(result).toMatchObject({ state: 'failed', list: [], defaultAgent: null })
  expect(JSON.stringify(result)).not.toContain(privatePath)
}

function targetRefOf(candidate: { remote?: OwnerSessionWorkspaceRef }): OwnerSessionWorkspaceRef {
  if (!candidate.remote) throw new Error('remote candidate has no owner workspace reference')
  return candidate.remote
}

function remoteCandidate(prepared: { candidates: { id: string; remote?: OwnerSessionWorkspaceRef }[] }, mirrorId: string) {
  const candidate = prepared.candidates.find((item) => item.id === mirrorId && item.remote !== undefined)
  if (!candidate) throw new Error(`Handoff did not expose mirror ${mirrorId} as an exact remote target candidate`)
  return candidate
}

async function prepare(owner: OwnerRig, session: string) {
  return await call(owner, 'quirky.handoff/prepare', { source: { session } }) as {
    candidates: { id: string; name: string; path: string; kind: string; branch: string | null; remote?: OwnerSessionWorkspaceRef }[]
    agents: { state: string; list: { id: string; label: string }[] }
  }
}

async function sessions(owner: OwnerRig): Promise<Session[]> {
  return await call(owner, 'quirky.session/list', {}) as Session[]
}

async function restartOwner(owner: OwnerRig, port: string): Promise<void> {
  for (const client of owner.h.clients) client.close()
  await owner.h.daemon.stop()
  owner.h.pty.stop()
  const previousPort = process.env.QUIRKY_MOBILE_PORT
  const previousHome = process.env.HOME
  const previousVaultSourceHome = process.env.QUIRKY_VAULT_SOURCE_HOME
  process.env.HOME = owner.userHome
  process.env.QUIRKY_VAULT_SOURCE_HOME = owner.userHome
  process.env.QUIRKY_MOBILE_PORT = port
  try {
    owner.h = await startHarness({ home: owner.home, shell: owner.shell, builtinPluginsDir: owner.builtinPluginsDir })
    owner.client = await owner.h.connect('cli')
    await call(owner, 'quirky.vault/searchStatus', { host: 'local' })
  } finally {
    if (previousPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousPort
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousVaultSourceHome === undefined) delete process.env.QUIRKY_VAULT_SOURCE_HOME
    else process.env.QUIRKY_VAULT_SOURCE_HOME = previousVaultSourceHome
  }
}

test('S5-S7: a genuine owner mirror detects, probes, launches, delivers and jumps only on its exact host binding', async () => {
  const local = await startOwner('local', ['claude', 'local-bot'])
  const remote = await startOwner('remote', ['claude', 'target-bot', 'blind-bot'])
  process.env.HOME = local.userHome
  process.env.QUIRKY_VAULT_SOURCE_HOME = local.userHome

  const pair = await call(remote, 'quirky.mobile/ownerPair', { name: 'Remote Handoff Owner', address: '127.0.0.1', confirm: true }) as { offer: string }
  const runtime = await call(local, 'quirky.cli/runtimeAdd', { name: 'Remote Handoff Owner', pairingCode: pair.offer }) as { id: string }
  const host = await call(local, 'quirky.worktree/remoteHostRegister', { runtime: `runtime:${runtime.id}` }) as Host
  expect(host.connected).toBe(true)

  const repositoryPath = makeRepo(scratch())
  const localRepo = await call(local, 'quirky.repo/add', { path: repositoryPath }) as Repo
  const remoteRepo = await call(remote, 'quirky.repo/add', { path: repositoryPath }) as Repo
  const localMain = ((await call(local, 'quirky.worktree/list', { repo: localRepo.id })) as Worktree[]).find((worktree) => worktree.isMain)!
  const remoteMain = ((await call(remote, 'quirky.worktree/list', { repo: remoteRepo.id })) as Worktree[]).find((worktree) => worktree.isMain)!
  expect(remoteMain.id).toBe(localMain.id)
  expect(remoteMain.path).toBe(localMain.path)

  const mirror = await call(local, 'quirky.worktree/remoteAttach', { host: host.id, worktree: remoteMain.id }) as Mirror
  const source = await call(local, 'quirky.session/create', { worktree: localMain.id, agent: 'claude' }) as Session
  local.h.pty.setHistoryResult({ lines: ['captured source context'], cursor: null })
  const providerSessionId = 'same-provider-session-on-two-hosts'
  const callerPath = join(local.userHome, '.claude', 'projects', 'caller-source', `${providerSessionId}.jsonl`)
  mkdirSync(join(local.userHome, '.claude', 'projects', 'caller-source'), { recursive: true })
  writeFileSync(callerPath, [
    JSON.stringify({ type: 'user', sessionId: providerSessionId, timestamp: '2026-10-28T10:00:00.000Z', cwd: localMain.path, message: { role: 'user', content: 'local provider transcript fixture' } }),
    JSON.stringify({ type: 'assistant', sessionId: providerSessionId, timestamp: '2026-10-28T10:00:01.000Z', cwd: localMain.path, message: { role: 'assistant', content: 'local transcript with duplicate provider ID' } })
  ].join('\n') + '\n')
  await call(local, 'quirky.session/setProviderSession', { session: source.id, id: providerSessionId, transcriptPath: callerPath })
  const remoteTranscript = join(remote.userHome, '.claude', 'projects', 'remote-target', `${providerSessionId}.jsonl`)
  mkdirSync(join(remote.userHome, '.claude', 'projects', 'remote-target'), { recursive: true })
  writeFileSync(remoteTranscript, [
    JSON.stringify({ type: 'user', sessionId: providerSessionId, timestamp: '2026-10-28T10:00:00.000Z', cwd: remoteMain.path, message: { role: 'user', content: 'remote native transcript fixture' } }),
    JSON.stringify({ type: 'assistant', sessionId: providerSessionId, timestamp: '2026-10-28T10:00:01.000Z', cwd: remoteMain.path, message: { role: 'assistant', content: 'target-side transcript evidence' } })
  ].join('\n') + '\n')

  const prepared = await prepare(local, source.id)
  const candidate = remoteCandidate(prepared, mirror.id)
  const targetRef = targetRefOf(candidate)

  const vaultFixture = await writeClaudeFixture(remote.userHome, { cwd: remoteMain.path })
  const vaultIndex = await call(remote, 'quirky.vault/list', { agents: ['claude'], unlimited: true }) as {
    sessions: { id: string; sessionId: string; title: string; source: { filePath: string } }[]
  }
  const archivedRecord = vaultIndex.sessions.find((session) => session.sessionId === 'claude-fixture-session')
  if (!archivedRecord) throw new Error("the remote owner's native Claude transcript was not indexed")
  const archivedSource = {
    archived: {
      agent: 'claude',
      owner: targetRef.owner,
      vaultId: archivedRecord.id,
      title: 'caller-supplied title',
      cwd: callerPath,
      providerSessionId: 'caller-provider-id',
      transcriptPath: callerPath
    }
  }
  const localArchiveDuplicate = join(local.userHome, '.claude', 'projects', 'same-provider-id')
  const localArchiveDuplicatePath = join(localArchiveDuplicate, `${archivedRecord.sessionId}.jsonl`)
  mkdirSync(localArchiveDuplicate, { recursive: true })
  writeFileSync(localArchiveDuplicatePath, [
    JSON.stringify({ type: 'user', sessionId: archivedRecord.sessionId, timestamp: '2026-10-28T12:00:00.000Z', cwd: localMain.path, message: { role: 'user', content: 'different local transcript with same provider id' } }),
    JSON.stringify({ type: 'assistant', sessionId: archivedRecord.sessionId, timestamp: '2026-10-28T12:00:01.000Z', cwd: localMain.path, message: { role: 'assistant', content: 'not the owner archive transcript' } })
  ].join('\n') + '\n')
  const archivedPrepared = await call(local, 'quirky.handoff/prepare', { source: archivedSource }) as { source: Record<string, unknown> }
  expect(archivedPrepared.source).toMatchObject({ session: null, agent: 'claude', title: 'Claude fixture title', live: false })
  expect(JSON.stringify(archivedPrepared.source)).not.toContain(archivedRecord.source.filePath)
  expect(JSON.stringify(archivedPrepared.source)).not.toContain(vaultFixture.filePath)
  expect(JSON.stringify(archivedPrepared.source)).not.toContain(callerPath)
  expect(JSON.stringify(archivedPrepared.source)).not.toContain(remoteMain.path)
  // The daemon fixture shares one process environment; make the owner probe use only the target's provider roots.
  process.env.CLAUDE_CONFIG_DIR = join(remote.userHome, '.claude')

  expect(candidate).toMatchObject({ id: mirror.id, path: remoteMain.path, remote: {
    owner: { hostId: host.id, identity: host.identity, runtime: { id: host.runtime.id, endpoint: host.runtime.endpoint, grantId: host.runtime.grantId } },
    mirrorId: mirror.id, worktreeId: remoteMain.id, instanceId: remoteMain.instanceId, fingerprint: mirror.fingerprint
  } })

  const localAgents = await call(local, 'quirky.handoff/targetAgents', { target: { worktree: localMain.id } }) as { state: string; list: { id: string; label: string }[] }
  const remoteAgents = await call(local, 'quirky.handoff/targetAgents', { target: { remote: targetRef } }) as { state: string; list: { id: string; label: string }[]; defaultAgent: string | null }
  const directRemoteAgents = await call(remote, 'quirky.handoff/ownerAgents', { worktree: remoteMain.id, expectedInstanceId: remoteMain.instanceId }) as { state: string; list: { id: string; label: string }[] }
  expect(localAgents.list.map((agent) => agent.id)).toContain('local-bot')
  expect(localAgents.list.map((agent) => agent.id)).not.toContain('target-bot')
  expect(remoteAgents.state).toBe('ready')
  expect(remoteAgents.list.map((agent) => agent.id)).toContain('target-bot')
  expect(remoteAgents.list.map((agent) => agent.id)).not.toContain('local-bot')
  expect(directRemoteAgents.list.map((agent) => agent.id)).toContain('target-bot')
  const controls = {
    target: { remote: targetRef },
    agent: 'target-bot',
    relationship: 'continues',
    context: 'full',
    include: { repoState: false, diffBodies: false, openEditorTabs: false },
    templateId: null,
    note: 'api_key=abcdefghijklmnop1234'
  }
  const localArchiveControls = { ...controls, target: { worktree: localMain.id }, note: 'owner archive selected for local review' }
  process.env.CLAUDE_CONFIG_DIR = join(local.userHome, '.claude')
  const localArchivePreview = await call(local, 'quirky.handoff/preview', { source: archivedSource, controls: localArchiveControls }) as {
    probe: { verdict: string; path: string | null }
    warnings: { code: string; message: string }[]
  }
  expect(localArchivePreview.probe).toMatchObject({ verdict: 'unverifiable', path: null })
  expect(localArchivePreview.warnings.some((warning) => warning.code === 'transcript-unverifiable')).toBe(true)
  expect(JSON.stringify(localArchivePreview)).not.toContain(localArchiveDuplicatePath)
  process.env.CLAUDE_CONFIG_DIR = join(remote.userHome, '.claude')

  const archivedControls = { ...controls, note: 'reviewed owner-local archive handoff' }
  const archivedPreview = await call(local, 'quirky.handoff/preview', { source: archivedSource, controls: archivedControls }) as {
    brief: string
    notice: string
    probe: { verdict: string; path: string | null }
  }
  expect(archivedPreview.probe.verdict).toBe('usable')
  expect(archivedPreview.probe.path).toBeNull()
  expect(JSON.stringify(archivedPreview)).not.toContain(callerPath)
  expect(archivedPreview.brief).not.toContain('caller-supplied title')
  const archivedReviewedBody = `Owner-local archive reviewed:\n${archivedPreview.brief}`
  const stopArchivedReady = watchReady(remote)
  const archivedStarted = await call(local, 'quirky.handoff/start', {
    source: archivedSource, controls: archivedControls, body: archivedReviewedBody, wait: true
  }) as { child: { session: string; worktreeId: string }; lineageId: string; delivery: string }
  stopArchivedReady()
  expect(archivedStarted.delivery).toBe('delivered')
  expect(archivedStarted.child.worktreeId).toBe(remoteMain.id)
  const archivedPaste = remote.h.pty.inputs.filter((input) => input.sessionId === archivedStarted.child.session && input.text.startsWith(PASTE_START))
  expect(archivedPaste).toHaveLength(1)
  expect(archivedPaste[0]!.text).toBe(`${PASTE_START}${archivedReviewedBody.replace(/\n/g, '\r')}\r\r${archivedPreview.notice.replace(/\n/g, '\r')}${PASTE_END}`)
  expect(archivedPaste[0]!.text).not.toContain(callerPath)
  expect(archivedPaste[0]!.text).not.toContain('caller-supplied title')
  const archiveLineage = await call(local, 'quirky.handoff/lineage', {}) as { records: Record<string, any>[] }
  const archivedRecordLineage = archiveLineage.records.find((record) => record.id === archivedStarted.lineageId)
  expect(archivedRecordLineage).toMatchObject({
    parent: {
      session: null,
      title: 'Claude fixture title',
      providerSessionId: archivedRecord.sessionId,
      executionHost: targetRef.owner.identity
    },
    child: {
      session: archivedStarted.child.session,
      executionHost: targetRef.owner.identity,
      instanceId: remoteMain.instanceId
    }
  })
  const preview = await call(local, 'quirky.handoff/preview', { source: { session: source.id }, controls }) as {
    brief: string
    notice: string
    warnings: { code: string; message: string }[]
    probe: { verdict: string; path: string | null }
  }
  expect(preview.probe.verdict).toBe('usable')
  expect(preview.warnings.some((warning) => warning.code === 'secrets')).toBe(true)
  expect(preview.warnings.some((warning) => /host/i.test(warning.message))).toBe(true)
  expect(preview.probe.path).toBeNull()
  expect(JSON.stringify(preview)).not.toContain(remoteTranscript)
  expect(JSON.stringify(preview)).not.toContain(callerPath)

  const localInputsBefore = local.h.pty.inputs.filter((input) => input.sessionId === source.id).map((input) => input.text)
  const remoteLayout = await call(remote, 'quirky.terminal/workspace', { workspace: remoteMain.id, ensure: true }) as { workspace: { root: { activeTab: string | null } } }
  const reviewedBody = `Reviewed for the remote owner:\n${preview.brief}\n\nOperator edit with api_key=abcdefghijklmnop1234`
  const stopReady = watchReady(remote)
  const started = await call(local, 'quirky.handoff/start', {
    source: { session: source.id }, controls, body: reviewedBody, wait: true
  }) as { child: { session: string; tab: string; worktreeId: string }; lineageId: string; delivery: string }
  stopReady()
  expect(started.delivery).toBe('delivered')
  expect(started.child.worktreeId).toBe(remoteMain.id)
  expect(await call(remote, 'quirky.session/get', { session: started.child.session })).toMatchObject({ id: started.child.session, agent: 'target-bot', worktreeId: remoteMain.id })
  expect((await sessions(local)).map((session) => session.id)).toEqual([source.id])
  expect(local.h.pty.inputs.filter((input) => input.sessionId === source.id).map((input) => input.text)).toEqual(localInputsBefore)
  const delivered = remote.h.pty.inputs.filter((input) => input.sessionId === started.child.session && input.text.startsWith(PASTE_START))
  expect(delivered).toHaveLength(1)
  expect(delivered[0]!.text).toBe(`${PASTE_START}${reviewedBody.replace(/\n/g, '\r')}\r\r${preview.notice.replace(/\n/g, '\r')}${PASTE_END}`)
  expect(delivered[0]!.text).not.toContain(callerPath)
  expect(delivered[0]!.text).toContain('api_key=abcdefghijklmnop1234')
  expect(delivered[0]!.text.indexOf('## Locked Quirky handoff notice')).toBeGreaterThan(delivered[0]!.text.indexOf('Reviewed for the remote owner'))

  const localIdentity = await call(local, 'quirky.cli/hostIdentity', {}) as { hostId: string; generation: string }
  const lineage = await call(local, 'quirky.handoff/lineage', { session: source.id }) as { records: Record<string, any>[] }
  expect(lineage.records).toHaveLength(1)
  const record = lineage.records[0]!
  expect(record).toMatchObject({ id: started.lineageId, parent: { session: source.id, worktreeId: localMain.id }, child: { agent: 'target-bot', worktreeId: remoteMain.id } })
  const parentEnd = JSON.stringify(record.parent)
  const childEnd = JSON.stringify(record.child)
  expect(parentEnd).toContain(localMain.instanceId)
  expect(childEnd).toContain(remoteMain.instanceId)
  expect(parentEnd).toContain(localIdentity.hostId)
  expect(parentEnd).toContain(localIdentity.generation)
  expect(childEnd).toContain(host.identity.hostId)
  expect(childEnd).toContain(host.identity.generation)
  expect(parentEnd).not.toContain(host.identity.hostId)
  expect(childEnd).not.toContain(localIdentity.hostId)

  const sourcePane = await call(local, 'quirky.terminal/paneOf', { session: source.id }) as { tab: string }
  await call(local, 'quirky.handoff/jump', { session: source.id, lineage: started.lineageId })
  const localLayout = await call(local, 'quirky.terminal/workspace', { workspace: localMain.id }) as { workspace: { root: { activeTab: string | null } } }
  const remoteLayoutAfterJump = await call(remote, 'quirky.terminal/workspace', { workspace: remoteMain.id }) as { workspace: { root: { activeTab: string | null; tabs: { id: string }[] } } }
  expect(localLayout.workspace.root.activeTab).toBe(sourcePane.tab)
  expect(remoteLayoutAfterJump.workspace.root.tabs.map((tab) => tab.id)).toContain(started.child.tab)
  expect(remoteLayoutAfterJump.workspace.root.activeTab).toBe(started.child.tab)
  expect(remoteLayout.workspace.root.activeTab).not.toBe(started.child.tab)

  const blindControls = { ...controls, agent: 'blind-bot', note: 'uncertain delivery must not duplicate automatically' }
  const blindReviewedBody = 'Reviewed remote retry body'
  const blindStarted = await call(local, 'quirky.handoff/start', {
    source: { session: source.id }, controls: blindControls, body: blindReviewedBody, wait: true
  }) as { child: { session: string; tab: string; worktreeId: string }; lineageId: string; delivery: string }
  expect(blindStarted.delivery).toBe('unobservable')
  const blindPastesBeforeResend = remote.h.pty.inputs.filter((input) => input.sessionId === blindStarted.child.session && input.text.startsWith(PASTE_START))
  expect(blindPastesBeforeResend).toHaveLength(1)
  expect(blindPastesBeforeResend[0]!.text).toContain(blindReviewedBody)
  expect(local.h.pty.inputs.filter((input) => input.sessionId === source.id).map((input) => input.text)).toEqual(localInputsBefore)
  remote.h.pty.emit(blindStarted.child.session, PASTE_ON + CURSOR_ON)
  const resent = await call(local, 'quirky.handoff/resend', {
    session: blindStarted.child.session, lineage: blindStarted.lineageId
  }) as { delivery: string }
  expect(resent.delivery).toBe('delivered')
  const blindPastesAfterResend = remote.h.pty.inputs.filter((input) => input.sessionId === blindStarted.child.session && input.text.startsWith(PASTE_START))
  expect(blindPastesAfterResend).toHaveLength(2)
  expect(blindPastesAfterResend[1]!.text).toBe(blindPastesAfterResend[0]!.text)
  expect(local.h.pty.inputs.filter((input) => input.sessionId === source.id).map((input) => input.text)).toEqual(localInputsBefore)

  const callerOnlyPath = join(local.userHome, '.claude', 'projects', 'caller-source', 'attacker-transcript.jsonl')
  mkdirSync(join(local.userHome, '.claude', 'projects', 'caller-source'), { recursive: true })
  writeFileSync(callerOnlyPath, [
    JSON.stringify({ type: 'user', sessionId: 'caller-path-is-not-target-authority', timestamp: '2026-10-28T11:00:00.000Z', cwd: remoteMain.path, message: { role: 'user', content: 'caller-only transcript' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'caller-path-is-not-target-authority', timestamp: '2026-10-28T11:00:01.000Z', cwd: remoteMain.path, message: { role: 'assistant', content: 'not on target owner' } })
  ].join('\n') + '\n')
  await call(local, 'quirky.session/setProviderSession', {
    session: source.id, id: 'caller-path-is-not-target-authority', transcriptPath: callerOnlyPath
  })
  const callerPathPreview = await call(local, 'quirky.handoff/preview', {
    source: { session: source.id }, controls
  }) as { probe: { verdict: string }; warnings: { code: string; message: string }[] }
  expect(callerPathPreview.probe.verdict).toBe('unverifiable')
  expect(callerPathPreview.warnings.some((warning) => warning.code === 'transcript-unverifiable')).toBe(true)
  expect(JSON.stringify(callerPathPreview)).not.toContain(callerOnlyPath)

  const staleCreated = await call(remote, 'quirky.worktree/create', { repo: remoteRepo.id, name: 'handoff-stale-instance' }) as WorktreeCreateResult
  const staleMirror = await call(local, 'quirky.worktree/remoteAttach', { host: host.id, worktree: staleCreated.worktree.id }) as Mirror
  const withStaleCandidate = await prepare(local, source.id)
  const staleRef = targetRefOf(remoteCandidate(withStaleCandidate, staleMirror.id))
  await call(remote, 'quirky.worktree/remove', { worktree: `id:${staleCreated.worktree.id}`, safeOnly: true, skipArchive: true, yes: true })
  const replacement = await call(remote, 'quirky.worktree/create', { repo: remoteRepo.id, name: 'handoff-stale-instance' }) as WorktreeCreateResult
  expect(replacement.worktree.id).toBe(staleCreated.worktree.id)
  expect(replacement.worktree.instanceId).not.toBe(staleCreated.worktree.instanceId)
  await call(local, 'quirky.worktree/remoteRefresh', { host: host.id })
  const remoteSessionsBeforeStaleStart = await sessions(remote)
  const localSessionsBeforeStaleStart = await sessions(local)
  await refusedOrFailed(call(local, 'quirky.handoff/targetAgents', { target: { remote: staleRef } }), remoteMain.path)
  await refusedOrFailed(call(remote, 'quirky.handoff/ownerAgents', {
    worktree: staleCreated.worktree.id, expectedInstanceId: staleCreated.worktree.instanceId
  }), staleCreated.worktree.path)
  const staleTargetCli = await runCli(
    ['handoff', 'target', 'agents', '--remote', JSON.stringify(staleRef), '--json'],
    { home: local.home, env: { HOME: local.userHome } }
  )
  expect(staleTargetCli.code).toBe(1)
  expect(JSON.parse(staleTargetCli.stdout).error).toMatchObject({ reason: 'target-stale' })
  expect(staleTargetCli.stdout).not.toContain(replacement.worktree.path)
  const staleStart = await rejected(call(local, 'quirky.handoff/start', {
    source: { session: source.id },
    controls: { ...controls, target: { remote: staleRef } },
    body: 'must not start on the replacement instance'
  }))
  expect(staleStart.message).not.toContain(replacement.worktree.path)
  expect((await sessions(remote)).map((session) => session.id)).toEqual(remoteSessionsBeforeStaleStart.map((session) => session.id))
  expect((await sessions(local)).map((session) => session.id)).toEqual(localSessionsBeforeStaleStart.map((session) => session.id))

  const phonePair = await call(remote, 'quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const phoneRuntime = await call(local, 'quirky.cli/runtimeAdd', { name: 'phone-only target', pairingCode: phonePair.pairingUrl }) as {
    id: string; endpoint: string; grantId?: string; scope: string
  }
  expect(phoneRuntime.scope).toBe('mobile')
  const phoneRef: OwnerSessionWorkspaceRef = {
    ...targetRef,
    owner: {
      ...targetRef.owner,
      runtime: { id: phoneRuntime.id, endpoint: phoneRuntime.endpoint, grantId: phoneRuntime.grantId ?? '' }
    }
  }
  const remoteSessionsBeforePhoneTarget = await sessions(remote)
  await refusedOrFailed(call(local, 'quirky.handoff/targetAgents', { target: { remote: phoneRef } }), remoteMain.path)
  expect((await sessions(remote)).map((session) => session.id)).toEqual(remoteSessionsBeforePhoneTarget.map((session) => session.id))

  const replacementPair = await call(remote, 'quirky.mobile/ownerPair', { name: 'Replacement Handoff Owner', address: '127.0.0.1', confirm: true }) as { offer: string }
  const replacementRuntime = await call(local, 'quirky.cli/runtimeAdd', { name: 'Replacement Handoff Owner', pairingCode: replacementPair.offer }) as { id: string }
  const replacedHost = await call(local, 'quirky.worktree/remoteHostRegister', { runtime: `runtime:${replacementRuntime.id}`, replace: true }) as Host
  expect(replacedHost.id).toBe(host.id)
  expect(replacedHost.runtime.grantId).not.toBe(host.runtime.grantId)
  await refusedOrFailed(call(local, 'quirky.handoff/targetAgents', { target: { remote: targetRef } }), remoteMain.path)

  await call(local, 'quirky.worktree/remoteRefresh', { host: host.id })
  const freshPrepared = await prepare(local, source.id)
  const freshRef = targetRefOf(remoteCandidate(freshPrepared, mirror.id))
  const runtimePort = new URL(replacedHost.runtime.endpoint).port
  if (runtimePort === '') throw new Error('the paired owner runtime has no listener port')
  await restartOwner(remote, runtimePort)
  const localAgentsAfterRemoteRestart = await call(local, 'quirky.handoff/targetAgents', { target: { worktree: localMain.id } }) as { list: { id: string }[] }
  expect(localAgentsAfterRemoteRestart.list.map((agent) => agent.id)).toContain('local-bot')
  const restartedOwnerAgents = await call(remote, 'quirky.handoff/ownerAgents', {
    worktree: remoteMain.id, expectedInstanceId: remoteMain.instanceId
  }) as { list: { id: string }[] }
  expect(restartedOwnerAgents.list.map((agent) => agent.id)).toContain('target-bot')
  await refusedOrFailed(call(local, 'quirky.handoff/targetAgents', { target: { remote: freshRef } }), remoteMain.path)
})
