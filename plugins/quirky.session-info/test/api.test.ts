import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cliJson,
  installAgents,
  newSession,
  sessionOf,
  startOf,
  startStatusE2E,
  waitFor,
  type StatusE2E
} from '../../quirky.agent-status/test/e2e/support'
import type { StartOptions } from '../../quirky.agents/test/support/e2e'
import type { PluginContext, Session } from '@quirky/protocol'

import { resolveClaudeSettings } from '../src/claude-settings'
import { isRecord } from '../src/json'
import type { Inspection } from '../src/types'

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
type Identity = {
  agent: string
  sessionId: string
  providerSessionId: string | null
  model?: string
  pane: string | null
  paneTitle?: string
  worktreeId: string
  cwd: string
  startedAt: number
  updatedAt: number
  transcriptPath?: string
  version?: string
  outputStyle?: string
  branch?: string
}

describe('Claude file-backed settings limits', () => {
  test('accepts settings at 4 MiB and reports larger files without reading unbounded content', async () => {
    const h = await start()
    const configDir = join(h.userHome, 'bounded-config')
    mkdirSync(configDir, { recursive: true })
    const path = join(configDir, 'settings.json')
    const prefix = '{"padding":"'
    const suffix = '"}'
    const atLimit = `${prefix}${'x'.repeat(MAX_SETTINGS_BYTES - prefix.length - suffix.length)}${suffix}`
    const context = {
      call: async (method: string) => method === 'quirky.agents/settingsOverlay' ? { settings: {} } : {},
      error: (_code: string, message: string) => new Error(message)
    } as unknown as PluginContext
    const input = { cwd: h.repo, env: { CLAUDE_CONFIG_DIR: configDir } }

    writeFileSync(path, atLimit)
    const accepted = await resolveClaudeSettings(context, input)
    expect((accepted.settings.padding as string).length).toBe(MAX_SETTINGS_BYTES - prefix.length - suffix.length)

    writeFileSync(path, `${atLimit} `)
    const rejected = await resolveClaudeSettings(context, input)
    expect(rejected.errors.join(' ')).toContain(`exceeds ${MAX_SETTINGS_BYTES} bytes`)
  })
})

type SessionInfo = {
  identity: Identity
  liveActivity: { state: string; label: string; toolName?: string; toolInput?: string; subagentCount: number; startedAt: number; updatedAt: number }
  usage?: { status: 'waiting' | 'ready'; freshness?: 'fresh' | 'refreshing' | 'stale'; totalTokens?: number; turnCount?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; updatedAt?: number; error?: string }
  context?: { status: 'waiting' | 'ready'; usedPercentage?: number; remainingPercentage?: number; window?: number; used?: number; remaining?: number; estimated?: boolean; updatedAt?: number; planWindows?: { fiveHour?: { usedPercentage: number; resetsAt: number }; sevenDay?: { usedPercentage: number; resetsAt: number } } }
  filesTouched?: { added?: number; removed?: number; updatedAt: number }
  hooksAndMcp?: { hooks?: { state: string; detail?: string }; statusline?: { state: string; detail?: string }; mcp: { name: string; transport: string; state: string }[]; updatedAt: number; error?: string }
}

type PanelState = { session: string | null; pane: string | null; workspace: string | null; openSections: string[]; info: SessionInfo | null }
type SessionFixture = { session: Session; pid: number; transcriptPath: string }

type RpcGuard<T> = (value: unknown) => value is T
type RpcValidator = (value: unknown) => boolean
type HistorySummary = { id: string; title?: string }
type InfoRpcResults = {
  get: PanelState
  sections: { open: string[] }
  inspect: Inspection
  telemetry: { accepted: boolean }
  enableTelemetry: { statusline: NonNullable<Inspection['statusline']>; nextLaunchEffect: string }
  history: HistorySummary[]
  transcript: { path: string; text: string }
  resumeCommand: { command: string }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalProperty(
  record: Record<string, unknown>,
  name: string,
  guard: RpcValidator
): boolean {
  return record[name] === undefined || guard(record[name])
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isIdentity(value: unknown): value is Identity {
  if (!isRecord(value)) return false
  return isString(value.agent) &&
    isString(value.sessionId) &&
    (isString(value.providerSessionId) || value.providerSessionId === null) &&
    (isString(value.pane) || value.pane === null) &&
    isString(value.worktreeId) &&
    isString(value.cwd) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.updatedAt) &&
    ['model', 'paneTitle', 'transcriptPath', 'version', 'outputStyle', 'branch']
      .every((name) => optionalProperty(value, name, isString))
}

function isLiveActivity(value: unknown): value is SessionInfo['liveActivity'] {
  if (!isRecord(value)) return false
  return isString(value.state) &&
    isString(value.label) &&
    optionalProperty(value, 'toolName', isString) &&
    optionalProperty(value, 'toolInput', isString) &&
    isFiniteNumber(value.subagentCount) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.updatedAt)
}

function isUsage(value: unknown): value is NonNullable<SessionInfo['usage']> {
  if (!isRecord(value)) return false
  return (value.status === 'waiting' || value.status === 'ready') &&
    (value.freshness === undefined || ['fresh', 'refreshing', 'stale'].some((state) => state === value.freshness)) &&
    ['totalTokens', 'turnCount', 'input', 'output', 'cacheRead', 'cacheWrite', 'updatedAt']
      .every((name) => optionalProperty(value, name, isFiniteNumber)) &&
    optionalProperty(value, 'error', isString)
}

function isPlanWindow(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.usedPercentage) && isFiniteNumber(value.resetsAt)
}

function isPlanWindows(value: unknown): boolean {
  return isRecord(value) &&
    optionalProperty(value, 'fiveHour', isPlanWindow) &&
    optionalProperty(value, 'sevenDay', isPlanWindow)
}

function isContext(value: unknown): value is NonNullable<SessionInfo['context']> {
  if (!isRecord(value)) return false
  return (value.status === 'waiting' || value.status === 'ready') &&
    ['usedPercentage', 'remainingPercentage', 'window', 'used', 'remaining', 'updatedAt']
      .every((name) => optionalProperty(value, name, isFiniteNumber)) &&
    optionalProperty(value, 'estimated', (candidate): candidate is boolean => typeof candidate === 'boolean') &&
    optionalProperty(value, 'planWindows', isPlanWindows)
}

function isFilesTouched(value: unknown): value is NonNullable<SessionInfo['filesTouched']> {
  if (!isRecord(value)) return false
  return optionalProperty(value, 'added', isFiniteNumber) &&
    optionalProperty(value, 'removed', isFiniteNumber) &&
    isFiniteNumber(value.updatedAt)
}

function isStatusline(value: unknown): value is NonNullable<Inspection['statusline']> {
  if (!isRecord(value)) return false
  return ['managed', 'chained', 'available', 'drifted', 'disabled', 'error'].some((state) => state === value.state) &&
    optionalProperty(value, 'detail', isString)
}

function isInspection(value: unknown): value is Inspection {
  if (!isRecord(value)) return false
  const isHookState = (candidate: unknown): boolean =>
    isRecord(candidate) && isString(candidate.state) && optionalProperty(candidate, 'detail', isString)
  const isMcpEntry = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    isString(candidate.name) &&
    isString(candidate.transport) &&
    ['enabled', 'disabled', 'invalid'].some((state) => state === candidate.state)
  return optionalProperty(value, 'hooks', isHookState) &&
    optionalProperty(value, 'statusline', isStatusline) &&
    Array.isArray(value.mcp) &&
    value.mcp.every(isMcpEntry) &&
    isFiniteNumber(value.updatedAt) &&
    optionalProperty(value, 'error', isString)
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) return false
  return isIdentity(value.identity) &&
    isLiveActivity(value.liveActivity) &&
    optionalProperty(value, 'usage', isUsage) &&
    optionalProperty(value, 'context', isContext) &&
    optionalProperty(value, 'filesTouched', isFilesTouched) &&
    optionalProperty(value, 'hooksAndMcp', isInspection)
}

function isPanelState(value: unknown): value is PanelState {
  return isRecord(value) &&
    (isString(value.session) || value.session === null) &&
    (isString(value.pane) || value.pane === null) &&
    (isString(value.workspace) || value.workspace === null) &&
    isStringArray(value.openSections) &&
    (value.info === null || isSessionInfo(value.info))
}

function isSectionsResult(value: unknown): value is InfoRpcResults['sections'] {
  return isRecord(value) && isStringArray(value.open)
}

function isTelemetryResult(value: unknown): value is InfoRpcResults['telemetry'] {
  return isRecord(value) && typeof value.accepted === 'boolean'
}

function isHistoryResult(value: unknown): value is HistorySummary[] {
  return Array.isArray(value) && value.every((entry: unknown) =>
    isRecord(entry) && isString(entry.id) && optionalProperty(entry, 'title', isString)
  )
}

function isTranscriptResult(value: unknown): value is InfoRpcResults['transcript'] {
  return isRecord(value) && isString(value.path) && isString(value.text)
}

function isResumeCommandResult(value: unknown): value is InfoRpcResults['resumeCommand'] {
  return isRecord(value) && isString(value.command)
}

function isEnableTelemetryResult(value: unknown): value is InfoRpcResults['enableTelemetry'] {
  return isRecord(value) && isStatusline(value.statusline) && isString(value.nextLaunchEffect)
}

const infoResultGuards: { [Method in keyof InfoRpcResults]: RpcGuard<InfoRpcResults[Method]> } = {
  get: isPanelState,
  sections: isSectionsResult,
  inspect: isInspection,
  telemetry: isTelemetryResult,
  enableTelemetry: isEnableTelemetryResult,
  history: isHistoryResult,
  transcript: isTranscriptResult,
  resumeCommand: isResumeCommandResult
}

type AgentStatus = { display?: string; toolName?: string } | null | undefined
type FocusContext = { workspace: string | null }
type SettingsOverlay = { settings: Record<string, unknown> }
type ApiDescription = { methods: { name: string }[] }

function isAgentStatus(value: unknown): value is AgentStatus {
  return value === null || value === undefined ||
    (isRecord(value) && optionalProperty(value, 'display', isString) && optionalProperty(value, 'toolName', isString))
}

function isFocusContext(value: unknown): value is FocusContext {
  return isRecord(value) && (isString(value.workspace) || value.workspace === null)
}

function isSettingsOverlay(value: unknown): value is SettingsOverlay {
  return isRecord(value) && isRecord(value.settings)
}

function isApiDescription(value: unknown): value is ApiDescription {
  return isRecord(value) &&
    Array.isArray(value.methods) &&
    value.methods.every((method: unknown) => isRecord(method) && isString(method.name))
}

let e2e: StatusE2E | undefined

async function start(options: StartOptions = {}): Promise<StatusE2E> {
  e2e = await startStatusE2E({ fakes: { claude: true, codex: true }, ...options })
  await installAgents(e2e, ['claude', 'codex'])
  return e2e
}

afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => e2e!.call(method, params)

async function callResult<T>(
  method: string,
  params: Record<string, unknown>,
  guard: RpcGuard<T>
): Promise<T> {
  const result = await call(method, params)
  if (!guard(result)) throw new Error(`${method} returned an invalid result`)
  return result
}

async function withRemoteCallDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(message)), 2_000)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

function infoCall<Method extends keyof InfoRpcResults>(
  method: Method,
  params: Record<string, unknown> = {}
): Promise<InfoRpcResults[Method]> {
  return callResult<InfoRpcResults[Method]>(`quirky.session-info/${method}`, params, infoResultGuards[method])
}

async function claudeSession(providerId: string, transcript?: string): Promise<SessionFixture> {
  const session = await newSession(e2e!, 'claude')
  const started = await startOf(e2e!, 'claude', session.id)
  const transcriptPath = join(e2e!.userHome, 'claude-project', `${providerId}.jsonl`)
  mkdirSync(join(e2e!.userHome, 'claude-project'), { recursive: true })
  if (transcript !== undefined) writeFileSync(transcriptPath, transcript)
  await e2e!.shim(
    'claude',
    session.id,
    {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: providerId,
      transcript_path: transcriptPath,
      cwd: e2e!.repo,
      model: 'claude-status-model'
    },
    { pid: started.pid }
  )
  await waitFor(async () => {
    const current = await sessionOf(e2e!, session.id)
    return current.providerSession?.id === providerId ? current : undefined
  }, 10_000, 'captured Claude provider session')
  return { session: await sessionOf(e2e!, session.id), pid: started.pid, transcriptPath }
}

async function deliverStop(session: string, pid: number, providerId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await e2e!.shim('claude', session, { hook_event_name: 'Stop', session_id: providerId, ...extra }, { pid, event: 'Stop' })
}

function assistantRecord(
  sessionId: string,
  id: string,
  usage: Record<string, number>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    isSidechain: false,
    cwd: '/transcript/cwd',
    gitBranch: 'transcript-branch',
    message: { id, role: 'assistant', model: 'transcript-model', usage, content: [{ type: 'text', text: 'answer' }] },
    ...extra
  })
}

function settingsArguments(argv: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--settings') {
      const value = argv[index + 1]
      if (value !== undefined) values.push(value)
      index += 1
    } else if (argument.startsWith('--settings=')) {
      values.push(argument.slice('--settings='.length))
    }
  }
  return values
}

describe('session-info projection and preferences', () => {
  test('SC-1/3: empty focus is neutral; section defaults and durable replacement survive restart', async () => {
    const h = await start()
    const initial = await infoCall('get')
    expect(initial).toMatchObject({ session: null, pane: null, workspace: null, openSections: ['liveActivity'], info: null })

    expect(await infoCall('sections')).toEqual({ open: ['liveActivity'] })
    expect(await infoCall('sections', { open: ['identity', 'context', 'hooksAndMcp'] })).toEqual({ open: ['identity', 'context', 'hooksAndMcp'] })
    expect(await infoCall('sections')).toEqual({ open: ['identity', 'context', 'hooksAndMcp'] })
    await expect(infoCall('sections', { open: ['unknown'] })).rejects.toMatchObject({ code: -32602 })

    await h.restartDaemon()
    const afterRestart = await cliJson<{ open: string[] }>(h, ['session-info', 'sections'])
    expect(afterRestart).toEqual({ open: ['identity', 'context', 'hooksAndMcp'] })
  }, 60_000)

  test('SC-2/4/10/11/12: Claude has neutral identity and precise live state; Codex receives no Claude data', async () => {
    await start()
    const claude = await claudeSession('provider-claude')
    await e2e!.shim(
      'claude',
      claude.session.id,
      { hook_event_name: 'UserPromptSubmit', session_id: 'provider-claude', prompt: 'work' },
      { pid: claude.pid }
    )
    await e2e!.shim(
      'claude',
      claude.session.id,
      { hook_event_name: 'PreToolUse', session_id: 'provider-claude', tool_name: 'Read', tool_input: { file_path: '/tmp/file.ts' }, tool_use_id: 'tool-1' },
      { pid: claude.pid }
    )
    await waitFor(async () => (await callResult('quirky.agent-status/get', { session: claude.session.id }, isAgentStatus))?.toolName === 'Read', 10_000, 'Claude tool status')

    const claudeState = await infoCall('get', { session: claude.session.id })
    expect(claudeState.info).toMatchObject({
      identity: {
        agent: 'claude',
        sessionId: claude.session.id,
        providerSessionId: 'provider-claude',
        cwd: e2e!.repo,
        transcriptPath: claude.transcriptPath
      },
      liveActivity: { toolName: 'Read', subagentCount: 0 },
      usage: { status: 'waiting' },
      context: { status: 'waiting' }
    })
    expect(claudeState.info!.identity.model).toBe('claude-status-model')
    expect(claudeState.info!.filesTouched).toBeUndefined()
    await e2e!.shim(
      'claude',
      claude.session.id,
      { hook_event_name: 'Stop', session_id: 'provider-claude', is_interrupt: true },
      { pid: claude.pid, event: 'Stop' }
    )
    await waitFor(async () => (await callResult('quirky.agent-status/get', { session: claude.session.id }, isAgentStatus))?.display === 'interrupted', 10_000, 'interrupted Claude status')
    const interrupted = await infoCall('get', { session: claude.session.id })
    expect(interrupted.info?.liveActivity).toMatchObject({ state: 'interrupted', label: 'Interrupted' })

    const codex = await newSession(e2e!, 'codex')
    await startOf(e2e!, 'codex', codex.id)
    const codexState = await infoCall('get', { session: codex.id })
    expect(codexState.info).toMatchObject({ identity: { agent: 'codex', sessionId: codex.id }, liveActivity: { subagentCount: 0 } })
    expect(codexState.info).not.toHaveProperty('usage')
    expect(codexState.info).not.toHaveProperty('context')
    expect(codexState.info).not.toHaveProperty('filesTouched')

    const missing = infoCall('get', { session: 'missing-session-id' })
    await expect(missing).rejects.toMatchObject({ code: -32004 })
  }, 60_000)

  test('SC-34: a visible terminal root selects the active session; empty and nonterminal roots do not', async () => {
    await start()
    const focused = await claudeSession('provider-focus')
    await call('quirky.terminal/workspace', { workspace: focused.session.worktreeId, ensure: true })
    await call('quirky.terminal/focusPane', { session: focused.session.id, workspace: focused.session.worktreeId })
    await call('quirky.terminal/focusContext', { workspace: focused.session.worktreeId })

    expect(await callResult('quirky.terminal/focusContext', {}, isFocusContext)).toEqual({ workspace: focused.session.worktreeId })
    expect(await call('ui.state')).toMatchObject({ layout: { view: null } })
    expect((await infoCall('get')).session).toBeNull()

    await call('ui.view.open', { id: 'view:quirky.session-info/history', input: { query: 'provider-focus' } })
    expect((await infoCall('get')).session).toBeNull()

    await call('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: focused.session.worktreeId } })
    expect(await call('ui.state')).toMatchObject({ layout: { view: { id: 'view:quirky.session/worktree' } } })
    expect((await infoCall('get')).session).toBe(focused.session.id)

    await call('ui.panel.open', { id: 'panel:quirky.session-info/info' })
    await call('ui.focus', { target: 'panel' })
    expect((await callResult('quirky.terminal/focusContext', {}, isFocusContext)).workspace).toBe(focused.session.worktreeId)
    expect((await infoCall('get')).session).toBe(focused.session.id)
  }, 60_000)

  test('SC-34: focused floating workspace is selected over a nonterminal root', async () => {
    await start()
    await call('quirky.terminal/setFloating', { open: true })
    const created = await call('quirky.terminal/newTab', { workspace: 'floating', agent: 'claude' }) as {
      workspace: { root: { tabs: { root: { session: string } }[] } }
    }
    const focusedSession = created.workspace.root.tabs[0]!.root.session
    await call('quirky.terminal/focusContext', { workspace: 'floating' })
    await call('ui.view.open', { id: 'view:quirky.session-info/history', input: { query: 'floating' } })

    expect(await callResult('quirky.terminal/focusContext', {}, isFocusContext)).toEqual({ workspace: 'floating' })
    expect((await infoCall('get')).session).toBe(focusedSession)
  }, 60_000)

  test('SC-5/6/7/8/9/32: history, transcript, resume command, and routed UI actions use public methods', async () => {
    await start()
    const transcript = assistantRecord('provider-history', 'message-1', { input_tokens: 1, output_tokens: 2 }) + '\n'
    const claude = await claudeSession('provider-history', transcript)
    const history = await infoCall('history', { query: 'provider-history' })
    expect(history.map((session) => session.id)).toContain(claude.session.id)
    expect(await infoCall('history', { query: claude.session.title })).toEqual(expect.arrayContaining([expect.objectContaining({ id: claude.session.id })]))

    expect(await infoCall('transcript', { session: claude.session.id })).toEqual({ path: claude.transcriptPath, text: transcript })
    await expect(infoCall('transcript', { session: claude.session.id, path: '/not/authorized.jsonl' })).rejects.toMatchObject({ code: -32602 })
    await expect(infoCall('transcript', { session: 'missing-session-id' })).rejects.toMatchObject({ code: -32004 })

    const command = await infoCall('resumeCommand', { session: claude.session.id })
    expect(command.command).toContain('--resume provider-history')
    const startsBefore = e2e!.fakeLog('claude').filter((event) => event.type === 'start').length
    const forkCommand = await infoCall('resumeCommand', { session: claude.session.id, fork: true })
    expect(forkCommand.command).toContain('--resume provider-history')
    expect(e2e!.fakeLog('claude').filter((event) => event.type === 'start')).toHaveLength(startsBefore)
    const transcriptCli = await cliJson<{ path: string; text: string }>(e2e!, ['session-info', 'transcript', claude.session.id])
    expect(transcriptCli).toEqual({ path: claude.transcriptPath, text: transcript })
    const resumeCli = await cliJson<{ command: string }>(e2e!, ['session-info', 'resume-command', claude.session.id])
    expect(resumeCli.command).toContain('--resume provider-history')

    const result = await cliJson<PanelState>(e2e!, ['session-info', 'get', '--session', claude.session.id])
    expect(result.session).toBe(claude.session.id)
    expect((await e2e!.cli(['session-info', 'copy-id', '--session', claude.session.id])).stderr).not.toContain('unknown command')
  }, 60_000)
})

describe('Claude telemetry and transcript usage', () => {
  test('SC-13/14/18/19/20/21: Stop scans only captured lead session and accepted telemetry correlates per provider', async () => {
    await start()
    const lines = [
      assistantRecord('provider-usage', 'msg-1', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
      assistantRecord('provider-usage', 'msg-1', { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
      assistantRecord('provider-usage', 'msg-2', { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }),
      assistantRecord('someone-else', 'msg-other', { input_tokens: 900, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      assistantRecord('provider-usage', 'msg-sidechain', { input_tokens: 700, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true })
    ].join('\n') + '\n'
    const claude = await claudeSession('provider-usage', lines)
    await deliverStop(claude.session.id, claude.pid, 'provider-usage')

    const ready = await waitFor(async () => {
      const current = await infoCall('get', { session: claude.session.id })
      return current.info?.usage?.status === 'ready' ? current.info : undefined
    }, 10_000, 'transcript usage scan')
    expect(ready.usage).toMatchObject({ status: 'ready', freshness: 'fresh', input: 150, output: 35, cacheRead: 32, cacheWrite: 6, totalTokens: 223, turnCount: 2 })
    expect(ready.context).toMatchObject({ status: 'ready', estimated: true, window: 200000 })
    expect(ready.identity.model).toBe('claude-status-model')
    expect(ready.identity.transcriptPath).toBe(claude.transcriptPath)

    const accepted = await infoCall('telemetry', {
      session: claude.session.id,
      payload: {
        session_id: 'provider-usage',
        transcript_path: '/attacker/replacement.jsonl',
        model: { id: 'model-id', display_name: 'Claude 4.5' },
        context_window: { used_percentage: 81, remaining_percentage: 19, context_window_size: 200000 },
        cost: { total_lines_added: 12, total_lines_removed: 4 },
        version: '2.1.310',
        output_style: { name: 'Explanatory' },
        cwd: '/statusline-updated-cwd',
        rate_limits: {
          five_hour: { used_percentage: 20, resets_at: 1793136000 },
          seven_day: { used_percentage: 35, resets_at: 1793222400 }
        }
      }
    })
    expect(accepted).toEqual({ accepted: true })
    const projected = (await infoCall('get', { session: claude.session.id })).info!
    expect(projected).toMatchObject({
      identity: { model: 'Claude 4.5', transcriptPath: claude.transcriptPath, cwd: '/statusline-updated-cwd', version: '2.1.310', outputStyle: 'Explanatory' },
      context: { status: 'ready', usedPercentage: 81, remainingPercentage: 19, window: 200000, planWindows: { fiveHour: { usedPercentage: 20, resetsAt: 1793136000000 }, sevenDay: { usedPercentage: 35, resetsAt: 1793222400000 } } },
      filesTouched: { added: 12, removed: 4 }
    })

    const partial = await infoCall('telemetry', {
      session: claude.session.id,
      payload: { session_id: 'provider-usage', model: { display_name: 'Partial update' } }
    })
    expect(partial.accepted).toBe(true)
    expect((await infoCall('get', { session: claude.session.id })).info).toMatchObject({
      identity: { model: 'Partial update', transcriptPath: claude.transcriptPath, cwd: '/statusline-updated-cwd' },
      context: { usedPercentage: 81 },
      filesTouched: { added: 12, removed: 4 }
    })
    const cliTelemetry = await cliJson<{ accepted: boolean }>(e2e!, [
      'session-info', 'telemetry', claude.session.id, '--payload', JSON.stringify({ session_id: 'provider-usage', version: '2.1.311' })
    ])
    expect(cliTelemetry.accepted).toBe(true)


    expect((await infoCall('telemetry', { session: claude.session.id, payload: { session_id: 'old-provider', context_window: { used_percentage: 10 } } })).accepted).toBe(false)
    const codex = await newSession(e2e!, 'codex')
    await startOf(e2e!, 'codex', codex.id)
    expect((await infoCall('telemetry', { session: codex.id, payload: { session_id: 'provider-usage', context_window: { used_percentage: 1 } } })).accepted).toBe(false)
    expect((await infoCall('telemetry', { session: claude.session.id, payload: { session_id: 'x'.repeat(513), context_window: { used_percentage: 2 } } })).accepted).toBe(false)

    const rejectedFields = await infoCall('telemetry', {
      session: claude.session.id,
      payload: {
        session_id: 'provider-usage',
        model: { display_name: 'bad\u0000model' },
        context_window: { used_percentage: 101, remaining_percentage: -2, context_window_size: -4 },
        cost: { total_lines_added: -10, total_lines_removed: Number.NaN }
      }
    })
    expect(rejectedFields.accepted).toBe(false)

    await e2e!.shim('claude', claude.session.id, { hook_event_name: 'SessionStart', source: 'resume', session_id: 'replacement-provider' }, { pid: claude.pid })
    await waitFor(async () => (await sessionOf(e2e!, claude.session.id)).providerSession?.id === 'replacement-provider', 10_000, 'provider replacement')
    const replacement = await infoCall('get', { session: claude.session.id })
    expect(replacement.info?.usage).toMatchObject({ status: 'waiting' })
    expect(replacement.info?.context).toMatchObject({ status: 'waiting' })
    expect(replacement.info?.filesTouched).toBeUndefined()
    expect((await infoCall('telemetry', { session: claude.session.id, payload: { session_id: 'provider-usage', context_window: { used_percentage: 50 } } })).accepted).toBe(false)
  }, 60_000)

  test('SC-12/15/16/17: zero values, bounded percentages and partial statusline updates preserve optional data', async () => {
    await start()
    const claude = await claudeSession('provider-zero')
    expect((await infoCall('get', { session: claude.session.id })).info).toMatchObject({
      usage: { status: 'waiting' }, context: { status: 'waiting' }
    })
    const posted = await infoCall('telemetry', {
      session: claude.session.id,
      payload: { session_id: 'provider-zero', context_window: { used_percentage: 0, remaining_percentage: 100, context_window_size: 200000 }, cost: { total_lines_added: 0, total_lines_removed: 0 } }
    })
    expect(posted.accepted).toBe(true)
    expect((await infoCall('get', { session: claude.session.id })).info).toMatchObject({
      context: { status: 'ready', usedPercentage: 0, remainingPercentage: 100, used: 0, remaining: 200000, window: 200000 },
      filesTouched: { added: 0, removed: 0 }
    })
  }, 60_000)

  test('SC-14/30: transcript read errors retain ready values as stale and session removal invalidates telemetry', async () => {
    await start()
    const initialText = assistantRecord('provider-stale', 'message-1', { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }) + '\n'
    const claude = await claudeSession('provider-stale', initialText)
    await deliverStop(claude.session.id, claude.pid, 'provider-stale')
    await waitFor(async () => (await infoCall('get', { session: claude.session.id })).info?.usage?.status === 'ready', 10_000, 'initial transcript usage')

    rmSync(claude.transcriptPath)
    await deliverStop(claude.session.id, claude.pid, 'provider-stale')
    const stale = await waitFor(async () => {
      const info = (await infoCall('get', { session: claude.session.id })).info
      return info?.usage?.freshness === 'stale' ? info : undefined
    }, 10_000, 'stale usage on failed scan')
    expect(stale.usage).toMatchObject({ status: 'ready', freshness: 'stale', input: 8, output: 3 })
    expect(stale.usage?.error?.length).toBeLessThanOrEqual(500)

    await call('quirky.session/close', { session: claude.session.id })
    await expect(infoCall('get', { session: claude.session.id })).rejects.toMatchObject({ code: -32004 })
  }, 60_000)
})

describe('statusline settings, consent, and inspection', () => {
  test('SC-22/23/24/25/33: managed statusline defaults, explicit custom consent, drift and opt-out preserve user files', async () => {
    await start()
    const original = { theme: 'dark', statusLine: { type: 'command', command: './format.sh', padding: 3, display: 'compact' } }
    const originalBytes = `${JSON.stringify(original, null, 2)}\n`
    mkdirSync(join(e2e!.userHome, '.claude'), { recursive: true })
    writeFileSync(join(e2e!.userHome, '.claude', 'settings.json'), originalBytes)

    const first = await claudeSession('provider-config')
    const beforeConsent = await infoCall('inspect', { session: first.session.id })
    expect(beforeConsent.statusline).toMatchObject({ state: 'available' })
    expect(readFileSync(join(e2e!.userHome, '.claude', 'settings.json'), 'utf8')).toBe(originalBytes)

    const enabled = await infoCall('enableTelemetry', { session: first.session.id })
    expect(enabled.statusline.state).toBe('chained')
    expect(enabled.nextLaunchEffect.toLowerCase()).toContain('next launch')
    expect(readFileSync(join(e2e!.userHome, '.claude', 'settings.json'), 'utf8')).toBe(originalBytes)

    const next = await newSession(e2e!, 'claude')
    const startEvent = await startOf(e2e!, 'claude', next.id)
    const settingsArgs = startEvent.argv!.reduce<string[]>((found, arg, index, argv) => arg === '--settings' && argv[index + 1] ? [...found, argv[index + 1]!] : found, [])
    expect(settingsArgs).toHaveLength(1)
    const launchSettings = JSON.parse(settingsArgs[0]!)
    expect(launchSettings).toMatchObject({ statusLine: { type: 'command', command: expect.stringContaining('session-info'), padding: 3, display: 'compact' }, hooks: expect.any(Object) })
    expect(readFileSync(join(e2e!.userHome, '.claude', 'settings.json'), 'utf8')).toBe(originalBytes)

    writeFileSync(join(e2e!.userHome, '.claude', 'settings.json'), JSON.stringify({ ...original, statusLine: { ...original.statusLine, command: './changed.sh' } }, null, 2))
    expect((await infoCall('inspect', { session: first.session.id })).statusline?.state).toBe('drifted')
    const drifted = await newSession(e2e!, 'claude')
    const driftedStart = await startOf(e2e!, 'claude', drifted.id)
    const driftedSettings = settingsArguments(driftedStart.argv!)
    expect(driftedSettings).toHaveLength(1)
    expect(JSON.parse(driftedSettings[0]!).statusLine).toBeUndefined()
    expect(readFileSync(join(e2e!.userHome, '.claude', 'settings.json'), 'utf8')).toContain('./changed.sh')
    const disabled = await cliJson<{ statusline: { state: string }; nextLaunchEffect: string }>(e2e!, [
      'session-info', 'enable-telemetry', '--session', first.session.id, '--enabled=false'
    ])
    expect(disabled.statusline.state).toBe('disabled')
    expect(disabled.nextLaunchEffect.toLowerCase()).toContain('next launch')
  }, 60_000)

  test('SC-22: a Claude launch without a custom statusline gets one managed --settings overlay and leaves HOME untouched', async () => {
    const h = await start()
    const session = await newSession(h, 'claude')
    const started = await startOf(h, 'claude', session.id)
    const args = settingsArguments(started.argv!)
    expect(args).toHaveLength(1)
    expect(JSON.parse(args[0]!)).toMatchObject({
      hooks: expect.any(Object),
      statusLine: { type: 'command', command: expect.stringContaining('statusline-runner') }
    })
    expect(h.read('.claude/settings.json')).toBeNull()
  }, 60_000)

  test('rejects FIFO settings promptly and keeps the daemon and later MCP scopes responsive', async () => {
    const h = await start()
    const session = await newSession(h, 'claude')
    const claudeDir = join(h.repo, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, 'settings.json')
    const mkfifo = h.processScope.spawn(['/usr/bin/mkfifo', settingsPath], {
      env: { HOME: h.userHome, PATH: '/usr/bin:/bin' },
      stdout: 'ignore',
      stderr: 'ignore'
    })
    expect(await mkfifo.exited).toBe(0)

    // Real time bounds a remote RPC that can stall on FIFO I/O; fake timers cannot interrupt the daemon.
    const overlayError = await withRemoteCallDeadline(
      call('quirky.agents/settingsOverlay', {
        agent: 'claude',
        cwd: h.repo,
        record: { command: 'claude', args: `--settings '${settingsPath}'`, env: {} }
      }).then(
        () => { throw new Error('settingsOverlay accepted a FIFO settings file') },
        (error) => error as { code: number; message: string }
      ),
      'settingsOverlay blocked while reading a FIFO'
    )
    expect(overlayError).toMatchObject({ code: -32602 })
    expect(overlayError.message).toContain('regular file')
    expect(await call('quirky.agents/settingsOverlay', {
      agent: 'claude',
      cwd: h.repo,
      record: { command: 'claude', args: '', env: {} }
    })).toEqual({ settings: {} })

    writeFileSync(join(h.repo, '.mcp.json'), JSON.stringify({
      mcpServers: { workspace: { command: 'safe' } }
    }))
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      mcpServers: { local: { command: 'safe' } }
    }))
    const inspection = await withRemoteCallDeadline(
      infoCall('inspect', { session: session.id }),
      'session inspection blocked while reading a FIFO'
    )
    expect(inspection.mcp).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'workspace', transport: 'stdio' }),
      expect.objectContaining({ name: 'local', transport: 'stdio' })
    ]))
    expect(inspection.error).toContain('regular file')
  }, 60_000)

  test('SC-23/35: effective statusline reads CLAUDE_CONFIG_DIR and user --settings JSON, file and equals forms', async () => {
    const h = await start()
    const configDir = join(h.userHome, 'custom-claude-config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: './from-config.sh', padding: 4 } }))
    const cliConfigPath = join(h.repo, 'cli-settings.json')
    writeFileSync(cliConfigPath, JSON.stringify({ theme: 'cli-file', statusLine: { type: 'command', command: './from-cli.sh', padding: 7, color: 'cyan' } }))
    const configured = await h.cli(['agents', 'configure', 'claude', '--env', `CLAUDE_CONFIG_DIR=${configDir}`])
    expect(configured.code).toBe(0)

    const session = await newSession(h, 'claude')
    const started = await startOf(h, 'claude', session.id)
    await h.shim('claude', session.id, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'provider-cli-config', transcript_path: join(h.userHome, 'transcript.jsonl') }, { pid: started.pid })
    await waitFor(async () => (await sessionOf(h, session.id)).providerSession?.id === 'provider-cli-config', 10_000, 'session launch record')
    const record = (await sessionOf(h, session.id)).launch!
    expect(record.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    const args = `${record.args} --settings '${cliConfigPath}' --settings='${JSON.stringify({ statusLine: { type: 'command', command: './inline.sh', padding: 9 } })}'`
    const asOverlay = await callResult('quirky.agents/settingsOverlay', { agent: 'claude', cwd: h.repo, record: { ...record, args } }, isSettingsOverlay)
    expect(asOverlay.settings).toMatchObject({ theme: 'cli-file', statusLine: { command: './inline.sh', padding: 9 } })

    const custom = await infoCall('inspect', { session: session.id })
    expect(custom.statusline?.state).toBe('available')

    await expect(call('quirky.agents/settingsOverlay', {
      agent: 'claude', cwd: h.repo, record: { ...record, args: `${record.args} --settings './missing-settings.json'` }
    })).rejects.toMatchObject({ code: -32602 })
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('./from-config.sh')
  }, 60_000)

  test('SC-35: CLI --settings consent is exact across create and resume, with one effective JSON argument', async () => {
    const h = await start()
    const originalStatusline = { type: 'command', command: './cli-statusline.sh', padding: 9, display: 'compact' }
    const configuredArgs = `--settings='${JSON.stringify({ statusLine: originalStatusline })}'`
    const configured = await h.cli(['agents', 'configure', 'claude', `--args=${configuredArgs}`])
    expect(configured.code).toBe(0)
    const newArgs = ['session', 'new', '--agent', 'claude']
    const first = await cliJson<Session>(h, newArgs)
    const firstStart = await startOf(h, 'claude', first.id)
    const beforeConsentArgs = settingsArguments(firstStart.argv!)
    expect(beforeConsentArgs).toHaveLength(1)
    expect(JSON.parse(beforeConsentArgs[0]!).statusLine).toEqual(originalStatusline)

    const transcriptPath = join(h.userHome, 'cli-statusline.jsonl')
    await h.shim('claude', first.id, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'provider-cli-statusline',
      transcript_path: transcriptPath
    }, { pid: firstStart.pid })
    await waitFor(async () => (await sessionOf(h, first.id)).providerSession?.id === 'provider-cli-statusline', 10_000, 'CLI statusline provider session')
    expect((await infoCall('inspect', { session: first.id })).statusline?.state).toBe('available')

    await call('quirky.session-info/enableTelemetry', { session: first.id })
    const second = await cliJson<Session>(h, newArgs)
    const secondStart = await startOf(h, 'claude', second.id)
    const secondArgs = settingsArguments(secondStart.argv!)
    expect(secondArgs).toHaveLength(1)
    expect(JSON.parse(secondArgs[0]!).statusLine).toMatchObject({
      type: 'command',
      command: expect.stringContaining('statusline-runner'),
      padding: 9,
      display: 'compact'
    })

    const resumed = await cliJson<Session>(h, ['session', 'resume', first.id])
    const resumedStart = await startOf(h, 'claude', resumed.id)
    const resumedArgs = settingsArguments(resumedStart.argv!)
    expect(resumedArgs).toHaveLength(1)
    expect(JSON.parse(resumedArgs[0]!).statusLine).toMatchObject({
      type: 'command',
      command: expect.stringContaining('statusline-runner'),
      padding: 9,
      display: 'compact'
    })
    expect(h.read('.claude/settings.json')).toBeNull()
  }, 60_000)

  test('SC-28/29: hooks, MCP scopes and parse errors are inspected independently and deduplicated first-scope-wins', async () => {
    const h = await start()
    const claude = await claudeSession('provider-mcp')
    const unobserved = await newSession(h, 'claude')
    const waiting = await infoCall('inspect', { session: unobserved.id })
    expect(waiting.hooks).toMatchObject({ state: 'waiting' })
    expect(waiting.hooks?.detail).toContain('Waiting')
    await waitFor(async () => {
      const status = await call('quirky.agent-status/get', { session: claude.session.id })
      return isRecord(status) &&
        status.agent === 'claude' &&
        typeof status.lastHookAt === 'number' &&
        isRecord(status.lead) &&
        status.lead.providerSession === 'provider-mcp'
    }, 10_000, 'correlated Claude hook evidence')
    writeFileSync(join(h.repo, '.mcp.json'), JSON.stringify({ mcpServers: {
      overlap: { command: 'node', args: ['server.js'], env: { TOKEN: 'must-not-leak' } },
      workspaceHttp: { type: 'http', url: 'https://example.invalid/mcp' },
      malformed: { command: 5 }
    } }))
    mkdirSync(join(h.repo, '.claude'), { recursive: true })
    writeFileSync(join(h.repo, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { projectClaude: { command: 'node', args: ['p.js'] } } }))
    h.put('.claude/settings.json', { mcpServers: { overlap: { command: 'private-user-server' }, userOnly: { command: 'node', args: ['u.js'] } }, disabledMcpServers: ['userOnly'] })

    const inspection = await infoCall('inspect', { session: claude.session.id })
    expect(inspection?.mcp).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'overlap', transport: 'stdio', state: 'enabled' }),
      expect.objectContaining({ name: 'workspaceHttp', transport: 'http', state: 'enabled' }),
      expect.objectContaining({ name: 'malformed', state: 'invalid' }),
      expect.objectContaining({ name: 'projectClaude', transport: 'stdio', state: 'enabled' }),
      expect.objectContaining({ name: 'userOnly', state: 'disabled' })
    ]))
    expect(inspection?.mcp.filter((server) => server.name === 'overlap')).toHaveLength(1)
    expect(JSON.stringify(inspection)).not.toContain('must-not-leak')
    const cliInspection = await cliJson<SessionInfo['hooksAndMcp']>(h, ['session-info', 'inspect', '--session', claude.session.id])
    expect(cliInspection?.mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'userOnly', state: 'disabled' })]))

    writeFileSync(join(h.repo, '.mcp.json'), '{ malformed')
    const withParseError = await infoCall('inspect', { session: claude.session.id })
    expect(withParseError?.error).toBeTruthy()
    expect(withParseError?.hooks).toMatchObject({ state: 'installed' })
    expect(withParseError?.mcp).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'userOnly' })]))
  }, 60_000)

  test('SC-8/20: transcript errors are visible, bounded and cannot substitute a caller path', async () => {
    await start()
    const claude = await claudeSession('provider-too-large')
    writeFileSync(claude.transcriptPath, '')
    truncateSync(claude.transcriptPath, 16 * 1024 * 1024 + 1)
    await expect(infoCall('transcript', { session: claude.session.id })).rejects.toBeDefined()
  }, 60_000)
})

describe('session-info CLI declarations and command routing', () => {
  test('API methods have real CLI commands with JSON conventions, and UI actions route through ui.command.run', async () => {
    const h = await start()
    const shell = await newSession(h, 'shell')
    const get = await h.cli(['session-info', 'get', '--json'])
    expect(get.code).toBe(0)
    expect(JSON.parse(get.stdout)).toMatchObject({ session: null, info: null })

    const sections = await h.cli(['session-info', 'sections', '--open', 'identity', '--open', 'context', '--json'])
    expect(sections.code).toBe(0)
    expect(JSON.parse(sections.stdout)).toEqual({ open: ['identity', 'context'] })
    const history = await h.cli(['session-info', 'history', '--query', shell.id, '--json'])
    expect(history.code).toBe(0)
    expect(JSON.parse(history.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: shell.id })]))

    const missingWindow = await h.cli(['session-info', 'copy-id', '--session', shell.id, '--json'])
    expect(missingWindow.code).not.toBe(0)
    expect(missingWindow.stderr).not.toContain('unknown command')
    for (const action of ['open', 'open-history', 'focus-pane', 'open-transcript', 'reveal-transcript', 'resume', 'fork', 'copy-resume-command']) {
      const selected = action === 'open' ? [] : ['--session', shell.id]
      const routed = await h.cli(['session-info', action, ...selected, '--json'])
      expect(routed.stderr).not.toContain('unknown command')
    }


    const description = await callResult('api.describe', {}, isApiDescription)
    expect(description.methods.map((method: { name: string }) => method.name)).toEqual(expect.arrayContaining([
      'quirky.session-info/get', 'quirky.session-info/sections', 'quirky.session-info/inspect', 'quirky.session-info/telemetry',
      'quirky.session-info/enableTelemetry', 'quirky.session-info/history', 'quirky.session-info/transcript', 'quirky.session-info/resumeCommand'
    ]))
  }, 60_000)
})
