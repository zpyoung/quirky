import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch as fsWatch } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AgentKind, AvatarApp, ClassifyContext, Mandate, PendingRecordCall, RecordCursor, ToolCall } from '../contracts'
import { callFingerprint } from '../fingerprint'
import { classifyCall } from '../gate/classify'
import { decide } from '../gate/decide'
import { branchName, readCompare, readHead } from '../shipping/outbox'
import type { Evidence } from './stuck'

const RECEIPT_WINDOW_MS = 60_000
const JOURNAL_INPUT_CHARS = 4000
const MAX_EDIT_FILE_BYTES = 1_000_000
const HOSTED_TOOLS: Record<string, string> = { web_search_call: 'web_search', image_generation_call: 'image_generation' }
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'write', 'apply_patch'])
const AGENTS: readonly string[] = ['claude', 'codex', 'pi', 'omp']

type Watcher = (dir: string, listener: (filename: string | null) => void) => (() => void) | null

export type RecordsDeps = {
  evidence: Evidence
  /** How long an unmatched call waits for its receipt before it is judged skipped; defaults to the judgment timeout plus 15 s. */
  graceMs?: number
  /** Watches a directory for changes; the default is `fs.watch`. */
  watch?: Watcher
  /** Quiet time after a config change before the gate check re-runs. */
  debounceMs?: number
  env?: Record<string, string | undefined>
}

export type Records = {
  /** One pass over every supervised session's record: receipts matched, skipped calls triaged, hosted tools logged, watchers synced. */
  check(): Promise<void>
  /** Re-runs the gate check after a hook-config change; only a failure stops the worker. */
  configChanged(worktreeId: string): Promise<void>
  dispose(): void
}

type Observed = { toolName: string; toolInput: unknown; at: number | null; hosted: boolean }
type Cursor = { path: string; offset: number; worktreeId: string; dirty: boolean }
type Pending = PendingRecordCall & { worktreeId: string; sessionId: string }
type SessionRead = { sessionId: string; agent: string; cwd: string; createdAt: number | null; transcriptPath: string | null }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function timestampOf(value: Record<string, unknown>): number | null {
  const raw = value.timestamp ?? (isRecord(value.message) ? value.message.timestamp : undefined)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function piCalls(value: Record<string, unknown>, at: number | null): Observed[] {
  const body = isRecord(value.message) ? value.message : value
  if (!Array.isArray(body.content)) return []
  return body.content.flatMap((item): Observed[] => {
    if (!isRecord(item) || item.type !== 'toolCall' || typeof item.name !== 'string' || item.name === '') return []
    return [{ toolName: item.name, toolInput: item.arguments ?? item.input ?? {}, at, hosted: false }]
  })
}

function jsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function claudeCalls(value: Record<string, unknown>, at: number | null): Observed[] {
  const body = isRecord(value.message) ? value.message : value
  if (value.type !== 'assistant' || !Array.isArray(body.content)) return []
  return body.content.flatMap((item): Observed[] =>
    isRecord(item) && item.type === 'tool_use' && typeof item.name === 'string' && item.name !== '' ? [{ toolName: item.name, toolInput: item.input ?? {}, at, hosted: false }] : []
  )
}

function codexCalls(value: Record<string, unknown>, at: number | null): Observed[] {
  const payload = isRecord(value.payload) ? value.payload : null
  if (value.type !== 'response_item' || payload === null) return []
  const type = typeof payload.type === 'string' ? payload.type : ''
  if ((type === 'function_call' || type === 'custom_tool_call') && typeof payload.name === 'string' && payload.name !== '') {
    return [{ toolName: payload.name, toolInput: jsonInput(payload.arguments ?? payload.input), at, hosted: false }]
  }
  const hosted = HOSTED_TOOLS[type]
  if (hosted === undefined) return []
  const input = type === 'web_search_call' ? (payload.action ?? {}) : { revisedPrompt: payload.revised_prompt ?? null }
  return [{ toolName: hosted, toolInput: input, at, hosted: true }]
}

/** Every tool call on one transcript line: Claude `tool_use`, Codex `function_call` and its hosted `web_search_call` / `image_generation_call`, pi and omp `toolCall`. */
function callsOnLine(agent: string, line: string): Observed[] {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(value)) return []
  const at = timestampOf(value)
  if (agent === 'pi' || agent === 'omp') return piCalls(value, at)
  if (agent === 'codex') return codexCalls(value, at)
  return claudeCalls(value, at)
}

const bounded = (value: unknown): unknown => {
  const text = JSON.stringify(value) ?? 'null'
  return text.length > JOURNAL_INPUT_CHARS ? { truncated: text.slice(0, JOURNAL_INPUT_CHARS) } : value
}

const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

function pathOf(input: unknown): string | null {
  if (!isRecord(input)) return null
  return str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
}

function patchPaths(input: unknown): string[] {
  const text = typeof input === 'string' ? input : isRecord(input) ? (str(input.input) ?? str(input.patch) ?? '') : ''
  return [...text.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)].map((match) => match[1].trim())
}

function replacements(input: unknown): { before: string; after: string }[] {
  if (!isRecord(input)) return []
  const pair = (item: unknown) => {
    if (!isRecord(item)) return []
    const before = str(item.old_string) ?? str(item.oldText) ?? str(item.old_text)
    const after = item.new_string ?? item.newText ?? item.new_text
    return before !== null && typeof after === 'string' ? [{ before, after }] : []
  }
  return Array.isArray(input.edits) ? input.edits.flatMap(pair) : pair(input)
}

/** The sequence of content states one edit call moved a file through, so an undo shows up as a state seen before. */
function editStates(cwd: string, toolName: string, toolInput: unknown): { path: string; states: string[] }[] {
  const swaps = replacements(toolInput)
  const path = pathOf(toolInput)
  if (path !== null && swaps.length > 0) return [{ path, states: swaps.flatMap((swap) => [hashText(swap.before), hashText(swap.after)]) }]
  const paths = toolName === 'apply_patch' ? patchPaths(toolInput) : path === null ? [] : [path]
  return paths.flatMap((target) => {
    const absolute = resolve(cwd, target)
    if (absolute !== resolve(cwd) && !absolute.startsWith(resolve(cwd) + sep)) return []
    try {
      if (statSync(absolute).size > MAX_EDIT_FILE_BYTES) return []
      return [{ path: target, states: [hashText(readFileSync(absolute, 'utf8'))] }]
    } catch {
      return []
    }
  })
}

function readNewLines(cursor: Cursor): string[] {
  let size: number
  try {
    size = statSync(cursor.path).size
  } catch {
    return []
  }
  if (size < cursor.offset) cursor.offset = 0
  if (size === cursor.offset) return []
  const buffer = Buffer.alloc(size - cursor.offset)
  const fd = openSync(cursor.path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, cursor.offset)
  } finally {
    closeSync(fd)
  }
  const complete = buffer.lastIndexOf(0x0a) + 1
  if (complete === 0) return []
  cursor.offset += complete
  return buffer.subarray(0, complete).toString('utf8').split('\n').filter((line) => line.trim() !== '')
}

const defaultWatch: Watcher = (dir, listener) => {
  try {
    const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => listener(filename === null ? null : String(filename)))
    watcher.on('error', () => {})
    return () => watcher.close()
  } catch {
    return null
  }
}

function summary(toolName: string, toolInput: unknown): string {
  const command = isRecord(toolInput) ? str(toolInput.command) : null
  const text = command ?? str(isRecord(toolInput) ? (toolInput.file_path ?? toolInput.path) : null) ?? JSON.stringify(toolInput) ?? ''
  return `${toolName} ${text.length > 200 ? `${text.slice(0, 200)}...` : text}`.trim()
}

/**
 * The session-record check (R-40, R-41, R-42). Every 15 s it tails each supervised session's
 * transcript, fingerprints each tool call, tells the gate what it saw, and triages calls that
 * have no receipt: one the fixed rules would allow is only logged, anything else steps the
 * worker in through its terminal. Codex hosted tools are logged and the brain is woken to judge
 * them. It also watches the files that control an agent's hooks and re-runs the gate check when
 * one changes.
 */
export function createRecords(app: AvatarApp, deps: RecordsDeps): Records {
  const cursors = new Map<string, Cursor>()
  const pending: Pending[] = []
  const watchers = new Map<string, () => void>()
  const syncedWorktrees = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const checking = new Map<string, Promise<void>>()
  let stopped = false
  const watch = deps.watch ?? defaultWatch
  const env = deps.env ?? process.env
  const call = <T>(method: string, params: Record<string, unknown>): Promise<T> => app.context.call(method, params) as Promise<T>
  const graceMs = (): number => deps.graceMs ?? (app.settings().judgmentTimeoutSeconds + 15) * 1000

  function saveCursor(sessionId: string, cursor: Cursor): void {
    if (stopped || !cursor.dirty) return
    try {
      app.store.recordCursors.put({
        sessionId, worktreeId: cursor.worktreeId, path: cursor.path, readOffset: cursor.offset,
        pending: pending.filter((item) => item.sessionId === sessionId).map(({ worktreeId, sessionId, ...call }) => call),
        updatedAt: app.now()
      })
      cursor.dirty = false
    } catch (error) {
      app.context.log(`avatar record cursor for ${sessionId} could not be saved: ${message(error)}`)
    }
  }

  function restoreCursor(worktreeId: string, session: SessionRead, handedOffAt: number): Cursor {
    let row: RecordCursor | null = null
    try {
      row = app.store.recordCursors.get(session.sessionId)
    } catch (error) {
      app.context.log(`avatar record cursor for ${session.sessionId} could not be read: ${message(error)}`)
    }
    const waiting = row?.pending.filter((item) => item.at >= handedOffAt) ?? []
    for (const item of waiting) pending.push({ ...item, worktreeId, sessionId: session.sessionId })
    return {
      worktreeId, path: session.transcriptPath as string,
      offset: row?.path === session.transcriptPath ? row.readOffset : 0,
      dirty: row === null || row.path !== session.transcriptPath || row.worktreeId !== worktreeId || waiting.length !== row.pending.length
    }
  }

  function pruneCursors(liveSessions: Set<string | null>): void {
    let rows: RecordCursor[]
    try {
      rows = app.store.recordCursors.list()
    } catch (error) {
      app.context.log(`avatar record cursor for all sessions could not be read: ${message(error)}`)
      return
    }
    for (const row of rows) {
      if (liveSessions.has(row.sessionId)) continue
      try {
        app.store.recordCursors.delete(row.sessionId)
      } catch (error) {
        app.context.log(`avatar record cursor for ${row.sessionId} could not be saved: ${message(error)}`)
      }
    }
  }

  async function readSession(sessionId: string): Promise<SessionRead | null> {
    try {
      const session = await call<Record<string, unknown>>('quirky.session/get', { session: sessionId })
      const provider = isRecord(session.providerSession) ? session.providerSession : null
      return {
        sessionId,
        agent: str(session.agent) ?? '',
        cwd: str(session.cwd) ?? '',
        createdAt: typeof session.createdAt === 'number' ? session.createdAt : null,
        transcriptPath: str(provider?.transcriptPath)
      }
    } catch {
      return null
    }
  }

  function noteEdits(worktreeId: string, cwd: string, observed: Observed & { at: number }): void {
    if (!EDIT_TOOLS.has(observed.toolName)) return
    for (const { path, states } of editStates(cwd, observed.toolName, observed.toolInput)) {
      for (const contentHash of states) {
        if (deps.evidence.lastHash(worktreeId, path) === contentHash) continue
        deps.evidence.noteEdit(worktreeId, { path, contentHash, at: observed.at })
      }
    }
  }

  function observe(worktreeId: string, session: SessionRead, handedOffAt: number, line: string, cursor: Cursor): void {
    for (const observed of callsOnLine(session.agent, line)) {
      if (observed.at === null && session.createdAt !== null && session.createdAt < handedOffAt) continue
      if (observed.at !== null && observed.at < handedOffAt) continue
      const at = observed.at ?? app.now()
      const seen = { ...observed, at }
      deps.evidence.noteActivity(worktreeId, at)
      if (seen.hosted) {
        app.journal(worktreeId, 'skipped-call', { hosted: true, wouldHaveStopped: false, outcome: 'hosted', agent: session.agent, sessionId: session.sessionId, toolName: seen.toolName, toolInput: bounded(seen.toolInput) })
        app.services.brain.wake()
        continue
      }
      const fingerprint = callFingerprint(session.agent, worktreeId, seen.toolName, seen.toolInput)
      deps.evidence.noteCall(worktreeId, { fingerprint, toolName: seen.toolName, at })
      noteEdits(worktreeId, session.cwd, seen)
      app.services.gate.noteObservedCall(session.sessionId, fingerprint, at)
      if (!app.services.gate.hasReceipt(session.sessionId, fingerprint, at, RECEIPT_WINDOW_MS)) {
        pending.push({ worktreeId, sessionId: session.sessionId, agent: session.agent, cwd: session.cwd, toolName: seen.toolName, toolInput: seen.toolInput, at, fingerprint })
        cursor.dirty = true
      }
    }
  }

  async function classifyContext(worktreeId: string, cwd: string, mandate: Mandate, handedOffPaths: string[]): Promise<ClassifyContext | null> {
    const [head, compare] = await Promise.all([readHead(app, worktreeId).catch(() => null), readCompare(app, worktreeId).catch(() => null)])
    if (stopped) return null
    const settings = app.settings()
    return {
      worktreePath: cwd,
      handedOffPaths,
      defaultBranch: compare?.base != null ? branchName(compare.base) : 'main',
      ownBranch: head?.branch ?? '',
      home: app.context.home,
      allowCommands: settings.allowCommands,
      denyCommands: settings.denyCommands,
      deployCommands: settings.deployCommands
    }
  }

  async function triage(item: Pending, handedOffPaths: string[]): Promise<void> {
    const mandate = app.store.mandates.get(item.worktreeId)
    if (mandate === null || !AGENTS.includes(item.agent)) return
    const toolCall: ToolCall = {
      agent: item.agent as AgentKind,
      sessionId: item.sessionId,
      worktreeId: item.worktreeId,
      cwd: item.cwd,
      toolName: item.toolName,
      toolInput: item.toolInput,
      event: 'PreToolUse'
    }
    const ctx = await classifyContext(item.worktreeId, item.cwd, mandate, handedOffPaths)
    if (stopped || ctx === null) return
    const classes = classifyCall(toolCall, ctx)
    const decision = decide({ call: toolCall, classes, mandate, switches: mandate.switches, level: mandate.level, ctx })
    const base = {
      agent: item.agent,
      sessionId: item.sessionId,
      fingerprint: item.fingerprint,
      toolName: item.toolName,
      toolInput: bounded(item.toolInput),
      classes,
      outcome: decision.outcome,
      reason: decision.reason,
      reliedOn: decision.reliedOn,
      trace: decision.trace
    }
    if (decision.outcome === 'allow') {
      app.journal(item.worktreeId, 'skipped-call', { ...base, wouldHaveStopped: false })
      return
    }
    app.journal(item.worktreeId, 'skipped-call', { ...base, wouldHaveStopped: true, top: true })
    const stepped = await app.services.supervisor.stepIn(
      item.worktreeId,
      `The avatar stopped you: ${summary(item.toolName, item.toolInput)} ran without passing the gate, and it would not have been allowed (${decision.reason}). Do not repeat it. Say what you were trying to do and find another way.`
    )
    if (stopped) return
    if (!stepped.sent) app.journal(item.worktreeId, 'event', { type: 'step-in-refused', reason: stepped.reason ?? 'not sent', fingerprint: item.fingerprint })
  }

  async function settlePending(handedOffPaths: string[]): Promise<void> {
    for (let index = 0; index < pending.length;) {
      if (stopped) return
      const item = pending[index]
      const matched = app.services.gate.hasReceipt(item.sessionId, item.fingerprint, item.at, RECEIPT_WINDOW_MS)
      if (!matched && app.now() - item.at < graceMs()) {
        index++
        continue
      }
      if (!matched) {
        try {
          await triage(item, handedOffPaths)
        } catch (error) {
          if (stopped) return
          app.journal(item.worktreeId, 'event', { type: 'skipped-call-error', error: message(error), fingerprint: item.fingerprint })
        }
        if (stopped) return
      }
      pending.splice(index, 1)
      const cursor = cursors.get(item.sessionId)
      if (cursor !== undefined) {
        cursor.dirty = true
        saveCursor(item.sessionId, cursor)
      }
    }
  }

  function configDirs(agent: string, cwd: string): { dir: string; files: string[] | null }[] {
    const home = app.context.home
    const codexHome = env.CODEX_HOME && env.CODEX_HOME !== '' ? env.CODEX_HOME : join(home, '.codex')
    if (agent === 'claude') return [{ dir: join(cwd, '.claude'), files: ['settings.json', 'settings.local.json'] }]
    if (agent === 'codex') return [{ dir: codexHome, files: ['hooks.json'] }, { dir: join(cwd, '.codex'), files: null }]
    if (agent === 'pi' || agent === 'omp') {
      const agentDir = env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR !== '' ? env.PI_CODING_AGENT_DIR : join(home, agent === 'pi' ? '.pi' : '.omp', 'agent')
      return [{ dir: join(agentDir, 'extensions'), files: null }, { dir: join(cwd, agent === 'pi' ? '.pi' : '.omp', 'extensions'), files: null }]
    }
    return []
  }

  function syncWatchers(worktreeId: string, agent: string, cwd: string): void {
    if (cwd === '') return
    const first = !syncedWorktrees.has(worktreeId)
    syncedWorktrees.add(worktreeId)
    for (const { dir, files } of configDirs(agent, cwd)) {
      const key = `${worktreeId}\0${dir}`
      if (watchers.has(key) || !existsSync(dir)) continue
      const stop = watch(dir, (filename) => {
        if (files !== null && filename !== null && !files.includes(filename)) return
        scheduleConfigCheck(worktreeId)
      })
      if (stop === null) continue
      watchers.set(key, stop)
      if (!first) scheduleConfigCheck(worktreeId)
    }
  }

  function scheduleConfigCheck(worktreeId: string): void {
    clearTimeout(timers.get(worktreeId))
    timers.set(
      worktreeId,
      setTimeout(() => {
        timers.delete(worktreeId)
        void records.configChanged(worktreeId).catch((error) => app.journal(worktreeId, 'event', { type: 'gate-check-error', error: message(error) }))
      }, deps.debounceMs ?? 500)
    )
  }

  function dropWatchers(activeIds: Set<string>): void {
    for (const [key, stop] of [...watchers]) {
      if (activeIds.has(key.split('\0')[0])) continue
      stop()
      watchers.delete(key)
    }
    for (const worktreeId of [...syncedWorktrees]) if (!activeIds.has(worktreeId)) syncedWorktrees.delete(worktreeId)
  }

  async function checkSession(worktreeId: string, sessionId: string, handedOffAt: number): Promise<SessionRead | null> {
    const session = await readSession(sessionId)
    if (stopped || session === null) return null
    syncWatchers(worktreeId, session.agent, session.cwd)
    if (session.transcriptPath === null) return session
    let cursor = cursors.get(sessionId)
    if (cursor === undefined) {
      cursor = restoreCursor(worktreeId, session, handedOffAt)
      cursors.set(sessionId, cursor)
    } else if (cursor.path !== session.transcriptPath) {
      cursor.path = session.transcriptPath
      cursor.offset = 0
      cursor.dirty = true
    }
    const previousOffset = cursor.offset
    for (const line of readNewLines(cursor)) observe(worktreeId, session, handedOffAt, line, cursor)
    if (cursor.offset !== previousOffset) cursor.dirty = true
    saveCursor(sessionId, cursor)
    return session
  }

  const records: Records = {
    async check() {
      if (stopped) return
      const active = app.services.handoff.active().filter((entry) => entry.sessionId !== null)
      const paths: string[] = []
      for (const entry of active) {
        if (stopped) return
        const handedOffAt = app.store.handoffs.get(entry.worktreeId)?.handedOffAt ?? 0
        try {
          const session = await checkSession(entry.worktreeId, entry.sessionId as string, handedOffAt)
          if (stopped) return
          if (session !== null && session.cwd !== '') paths.push(session.cwd)
        } catch (error) {
          app.context.log(`avatar records check failed for ${entry.worktreeId}: ${message(error)}`)
        }
      }
      if (stopped) return
      const liveSessions = new Set(active.map((entry) => entry.sessionId))
      for (const sessionId of [...cursors.keys()]) if (!liveSessions.has(sessionId)) cursors.delete(sessionId)
      pruneCursors(liveSessions)
      dropWatchers(new Set(active.map((entry) => entry.worktreeId)))
      await settlePending(paths)
    },

    configChanged(worktreeId) {
      if (stopped) return Promise.resolve()
      const running = checking.get(worktreeId)
      if (running !== undefined) return running
      const run = (async () => {
        const result = await app.services.gate.gateCheck(worktreeId)
        if (stopped) return
        if (result.ok) return
        const entry = app.services.handoff.active().find((candidate) => candidate.worktreeId === worktreeId)
        if (entry !== undefined && entry.state !== 'gate-failed') app.services.handoff.setState(worktreeId, 'gate-failed', result.reason)
        if (app.needs.list({ worktreeId, open: true }).every((need) => need.kind !== 'gate-failed')) {
          app.needs.add({ worktreeId, kind: 'gate-failed', title: `The gate no longer reaches the worker: ${result.reason}`, detail: { reason: result.reason }, actions: ['restart-to-handoff', 'take-back'] })
        }
        await app.services.supervisor.stepIn(worktreeId, `The avatar stopped you: a file that controls this agent's hooks changed and the gate check now fails (${result.reason}). Wait to be restarted.`)
      })().finally(() => void checking.delete(worktreeId))
      checking.set(worktreeId, run)
      return run
    },

    dispose() {
      stopped = true
      for (const stop of watchers.values()) stop()
      watchers.clear()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }
  return records
}
