import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolGateDecision, ToolGateProvider, ToolGateRequest } from '@quirky/protocol'
import type {
  AgentKind, AvatarApp, ClassifyContext, GateOutcome, GateService, Level, Mandate, Receipt, RuleDecision, StepId, ToolCall
} from '../contracts'
import { callFingerprint } from '../fingerprint'
import { createGateChecker, type GateChecker } from '../gatecheck'
import { encodeDecision } from '../hooks/encode'
import {
  cachedClaudeVersion, clearMarkerFiles, createGateLaunchHook, hasMarkerFile, installCodexHooks, installPiExtensions, isRealHomeInTest,
  processAgentEnv, readMarkerFile, removeCodexHooks, removeMarkerFile, writeMarkerFile, type AgentEnv
} from '../hooks/install'
import { classifyCall } from './classify'
import { decide } from './decide'

const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'pi', 'omp']
const TOOL_EVENTS: readonly ToolCall['event'][] = ['PreToolUse', 'PermissionRequest', 'tool_call']
const BRAIN_MARGIN_MS = 5_000
const WORKTREE_TTL_MS = 5_000
const PERMISSION_RECEIPT_WINDOW_MS = 5 * 60_000

const RETRY_REASON = "The avatar hasn't decided yet; try the same call again shortly."
const SHADOW_REASON = 'Shadow: the avatar only logs what it would have decided.'
const UNCONFIRMED_WORKTREE_REASON = "Quirky's avatar gate couldn't confirm the worktree; try again shortly."
const UNREADABLE_REASON = "The avatar couldn't read this tool call, so it was refused."
const heldReason = (why: string): string => `Held for the user to decide: ${why}. Carry on with anything else, and don't retry this call until you're told.`

type Trace = RuleDecision['trace']
type Result = { outcome: GateOutcome; reason: string; encoded: string }
type Verdict = { outcome: GateOutcome; reason: string; reliedOn: string; trace: Trace; step: StepId | null; pending?: boolean }
type Active = { worktreeId: string; sessionId: string | null; mandate: Mandate }
type BrainAnswer = { decision: 'allow' | 'deny' | 'held'; reliedOn: string; reason: string }
type WorktreeInfo = { id: string; path: string; branch: string | null; repoId: string; isMain: boolean }
type InFlight = { call: ToolCall; fingerprint: string; receipt: Receipt; cancelled: boolean; settle(result: Result): void }

/** Test seams: where agent config lives, how Claude's version is read, and how long a gate check waits on an unseen call. */
export type GateDeps = { agentEnv?: AgentEnv; claudeVersion?: () => Promise<string | null>; graceMs?: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function describeCall(toolName: string, toolInput: unknown): string {
  const input = isRecord(toolInput) ? toolInput : {}
  const detail = [input.command, input.file_path, input.path, input.url, input.pattern].find((value) => typeof value === 'string')
  const text = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : ''
  if (text === '') return toolName
  return `${toolName}: ${text.length > 100 ? `${text.slice(0, 100)}...` : text}`
}

function toolEvent(agent: AgentKind, request: ToolGateRequest): ToolCall['event'] | null {
  const allowed: readonly string[] = agent === 'pi' || agent === 'omp' ? ['tool_call'] : ['PreToolUse', 'PermissionRequest']
  const named = isRecord(request.payload) ? request.payload.hook_event_name : undefined
  const found = [request.event, named].find((value): value is ToolCall['event'] => typeof value === 'string' && allowed.includes(value) && TOOL_EVENTS.includes(value as ToolCall['event']))
  return found ?? null
}

/** A tool input as the session record shows it: a JSON string is parsed, anything else is kept. */
function recordedInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function readPayload(payload: unknown): { toolName: string; toolInput: unknown; cwd: string | null } | null {
  if (!isRecord(payload)) return null
  const toolName = payload.tool_name ?? payload.toolName
  if (typeof toolName !== 'string' || toolName === '') return null
  const toolInput = 'tool_input' in payload ? payload.tool_input : payload.input
  return { toolName, toolInput: recordedInput(toolInput ?? {}), cwd: typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : null }
}

/**
 * Installs the real `app.services.gate` and provides the `tool-gate` and `launch-hook`
 * contributions. Each request resolves its supervised worktree from the session, records a
 * receipt, spends an allow-once approval or a remembered late answer if one matches, and otherwise
 * runs `decide()` and, only when nothing decided, the brain's judgment with a deadline. Nothing
 * that fails, times out or is unavailable is ever allowed. At Shadow the gate answers passthrough
 * and journals what it would have done, without making the worker wait on the brain.
 *
 * Also installs the Codex hook entries and the pi/omp extension file at activation. The returned
 * disposer removes every supervision marker, passes in-flight requests through and removes the
 * Codex entries; the extension stays, because it does nothing without a marker and its file time
 * is what the gate check compares with a session's start.
 */
export function register(app: AvatarApp, deps: GateDeps = {}): () => void {
  const agentEnv = deps.agentEnv ?? processAgentEnv()
  const quirkyHome = app.context.home
  const claudeVersion = deps.claudeVersion ?? cachedClaudeVersion()
  const checker: GateChecker = createGateChecker({ app, agentEnv, claudeVersion, graceMs: deps.graceMs })
  const inFlight = new Set<InFlight>()
  let worktreeCache: { at: number; list: WorktreeInfo[] } | null = null

  async function worktrees(): Promise<WorktreeInfo[]> {
    if (worktreeCache !== null && app.now() - worktreeCache.at < WORKTREE_TTL_MS) return worktreeCache.list
    try {
      const raw = await app.context.call('quirky.worktree/list', {})
      const list = (Array.isArray(raw) ? raw : []).filter(isRecord).flatMap((entry): WorktreeInfo[] =>
        typeof entry.id === 'string' && typeof entry.path === 'string'
          ? [{ id: entry.id, path: entry.path, branch: typeof entry.branch === 'string' ? entry.branch : null, repoId: String(entry.repoId ?? ''), isMain: entry.isMain === true }]
          : []
      )
      worktreeCache = { at: app.now(), list }
      return list
    } catch {
      return worktreeCache?.list ?? []
    }
  }

  /** Null when the call's worktree can't be resolved to a real path; the call's own cwd is never trusted as the root. */
  async function classifyContext(call: ToolCall): Promise<ClassifyContext | null> {
    const list = await worktrees()
    const self = list.find((entry) => entry.id === call.worktreeId)
    if (self === undefined) return null
    const settings = app.settings()
    const others = app.services.handoff
      .active()
      .filter((row) => row.worktreeId !== call.worktreeId)
      .flatMap((row) => list.filter((entry) => entry.id === row.worktreeId).flatMap((entry) => [entry.path, realPath(entry.path)]))
    return {
      worktreePath: realPath(self.path),
      handedOffPaths: [...new Set([self.path, ...others])],
      defaultBranch: list.find((entry) => entry.repoId === self.repoId && entry.isMain)?.branch ?? 'main',
      ownBranch: self.branch ?? 'HEAD',
      home: agentEnv.home,
      allowCommands: settings.allowCommands,
      denyCommands: settings.denyCommands,
      deployCommands: settings.deployCommands
    }
  }

  function supervised(sessionId: string): Active | null {
    if (!hasMarkerFile(quirkyHome, sessionId)) return null
    const rows = app.services.handoff.active()
    const direct = rows.find((row) => row.sessionId === sessionId)
    if (direct !== undefined) return direct
    const marker = readMarkerFile(quirkyHome, sessionId)
    return marker === null ? null : (rows.find((row) => row.worktreeId === marker.worktreeId) ?? null)
  }

  const finish = (call: ToolCall, outcome: GateOutcome, reason: string): Result => ({ outcome, reason, encoded: encodeDecision(call.agent, call.event, { outcome, reason }) })

  function gateData(call: ToolCall, fingerprint: string, verdict: Verdict, actual: GateOutcome, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      outcome: actual,
      agent: call.agent,
      event: call.event,
      toolName: call.toolName,
      toolInput: call.toolInput,
      trace: verdict.trace,
      step: verdict.step,
      reliedOn: verdict.reliedOn,
      reason: actual === verdict.outcome ? verdict.reason : SHADOW_REASON,
      sawWorkerExplanation: false,
      fingerprint,
      ...extra
    }
  }

  function ensureHeldNeed(call: ToolCall, fingerprint: string, verdict: Verdict): void {
    const open = app.needs.list({ worktreeId: call.worktreeId, open: true })
    if (open.some((need) => need.kind === 'held-call' && need.detail.fingerprint === fingerprint)) return
    app.needs.add({
      worktreeId: call.worktreeId,
      kind: 'held-call',
      title: `Held: ${describeCall(call.toolName, call.toolInput)}`,
      detail: { fingerprint, agent: call.agent, toolName: call.toolName, toolInput: call.toolInput, reason: verdict.reason, trace: verdict.trace },
      actions: ['allow-once', 'deny']
    })
  }

  function recordDenial(worktreeId: string, countsAsDenial: boolean): void {
    try {
      app.services.supervisor.recordDenial(worktreeId, countsAsDenial)
    } catch (error) {
      app.context.log(`avatar gate: recordDenial failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Writes the receipt and journal entry together, then acts on the verdict. */
  function conclude(entry: InFlight, mandate: Mandate, verdict: Verdict): Result {
    const { call, fingerprint } = entry
    const shadow = mandate.level === 'shadow'
    const actual: GateOutcome = shadow ? 'passthrough' : verdict.outcome
    if (!entry.cancelled) {
      app.store.transaction(() => {
        app.store.receipts.put({ ...entry.receipt, outcome: actual, step: verdict.step })
        const extra: Record<string, unknown> = {}
        if (shadow) extra.wouldHave = { outcome: verdict.outcome, reason: verdict.reason, reliedOn: verdict.reliedOn }
        if (verdict.pending === true) extra.pending = true
        app.journal(call.worktreeId, 'gate', gateData(call, fingerprint, verdict, actual, extra))
        if (!shadow && verdict.outcome === 'held') ensureHeldNeed(call, fingerprint, verdict)
      })
      checker.noteReceipt(call.sessionId)
      if (!shadow && (verdict.outcome === 'deny' || verdict.outcome === 'held')) recordDenial(call.worktreeId, true)
      if (!shadow && verdict.outcome === 'retry') recordDenial(call.worktreeId, false)
    }
    return finish(call, actual, shadow ? SHADOW_REASON : verdict.reason)
  }

  async function judge(call: ToolCall, mandate: Mandate, budgetMs: number, signal: AbortSignal): Promise<BrainAnswer | 'timeout' | 'unavailable'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<'timeout'>((settle) => {
      timer = setTimeout(() => settle('timeout'), budgetMs + 500)
      signal.addEventListener('abort', () => settle('timeout'), { once: true })
    })
    try {
      const answer = await Promise.race([app.services.brain.judge(call, mandate, budgetMs).catch(() => 'unavailable' as const), limit])
      if (answer === 'timeout' || answer === 'unavailable') return answer
      const decision = (answer as { decision?: unknown } | null)?.decision
      return decision === 'allow' || decision === 'deny' || decision === 'held' ? answer : 'unavailable'
    } finally {
      clearTimeout(timer)
    }
  }

  const judgmentVerdict = (answer: BrainAnswer, trace: Trace): Verdict => ({
    outcome: answer.decision,
    reason: answer.decision === 'held' ? heldReason(answer.reason) : answer.reason,
    reliedOn: answer.reliedOn,
    trace: [...trace, { step: 'judgment', result: answer.decision, note: answer.reason }],
    step: 'judgment'
  })

  function judgmentFailure(answer: 'timeout' | 'unavailable', trace: Trace): Verdict {
    const timedOut = answer === 'timeout'
    return {
      outcome: 'retry',
      reason: RETRY_REASON,
      reliedOn: 'no answer from the brain',
      trace: [...trace, { step: 'judgment', result: 'deny', note: timedOut ? 'the brain did not answer in time; retry' : 'the brain is unavailable; retry' }],
      step: 'judgment',
      ...(timedOut ? { pending: true } : {})
    }
  }

  async function run(entry: InFlight, mandate: Mandate, deadlineMs: number, signal: AbortSignal): Promise<Result> {
    const { call, fingerprint } = entry
    const shadow = mandate.level === 'shadow'

    if (!shadow) {
      const approval = app.store.approvals.list({ worktreeId: call.worktreeId, fingerprint }).find((candidate) => candidate.usedAt === null)
      if (approval !== undefined) {
        app.store.approvals.put({ ...approval, usedAt: app.now() })
        return conclude(entry, mandate, { outcome: 'allow', reason: 'Allowed once by the user.', reliedOn: 'allow-once approval', trace: [], step: null })
      }
      const late = app.store.lateAnswers.get(fingerprint)
      if (late !== null && late.usedAt === null) {
        app.store.lateAnswers.put({ ...late, usedAt: app.now() })
        const outcome: GateOutcome = late.decision === 'allow' ? 'allow' : 'deny'
        return conclude(entry, mandate, { outcome, reason: late.reason, reliedOn: "the brain's earlier answer to this call", trace: [], step: 'judgment' })
      }
    }

    let rule: RuleDecision
    try {
      const ctx = await classifyContext(call)
      if (ctx === null) {
        const trace: Trace = [{ step: 'floor-core', result: 'deny', note: 'the worktree could not be confirmed; retry' }]
        return conclude(entry, mandate, { outcome: 'retry', reason: UNCONFIRMED_WORKTREE_REASON, reliedOn: 'an unconfirmed worktree', trace, step: null })
      }
      rule = decide({ call, classes: classifyCall(call, ctx), mandate, switches: mandate.switches, level: mandate.level, ctx })
    } catch (error) {
      const reason = `The avatar couldn't classify this call: ${error instanceof Error ? error.message : String(error)}`
      return conclude(entry, mandate, { outcome: 'deny', reason, reliedOn: 'a classification error', trace: [], step: null })
    }

    if (rule.outcome !== 'judgment') {
      const outcome: GateOutcome = rule.outcome
      const reason = outcome === 'held' ? heldReason(rule.reason) : rule.reason
      return conclude(entry, mandate, { outcome, reason, reliedOn: rule.reliedOn, trace: rule.trace, step: rule.step })
    }

    const budgetMs = Math.max(1_000, deadlineMs - BRAIN_MARGIN_MS)
    if (shadow) {
      app.store.receipts.put({ ...entry.receipt, outcome: 'passthrough', step: 'judgment' })
      checker.noteReceipt(call.sessionId)
      void judge(call, mandate, budgetMs, signal).then((answer) => {
        const verdict = typeof answer === 'string' ? judgmentFailure(answer, rule.trace) : judgmentVerdict(answer, rule.trace)
        app.journal(call.worktreeId, 'gate', gateData(call, fingerprint, verdict, 'passthrough', { wouldHave: { outcome: verdict.outcome, reason: verdict.reason, reliedOn: verdict.reliedOn } }))
      }).catch(() => {})
      return finish(call, 'passthrough', SHADOW_REASON)
    }

    const answer = await judge(call, mandate, budgetMs, signal)
    if (typeof answer === 'string') return conclude(entry, mandate, judgmentFailure(answer, rule.trace))
    return conclude(entry, mandate, judgmentVerdict(answer, rule.trace))
  }

  async function decideCall(call: ToolCall, deadlineMs: number, signal: AbortSignal): Promise<Result> {
    const active = app.services.handoff.active().find((row) => row.worktreeId === call.worktreeId)
    if (active === undefined) return finish(call, 'passthrough', 'This worktree is not handed off.')
    const fingerprint = callFingerprint(call.agent, call.worktreeId, call.toolName, call.toolInput)

    if (call.event === 'PermissionRequest') {
      const earlier = app.store.receipts
        .list({ sessionId: call.sessionId, fingerprint })
        .filter((receipt) => app.now() - receipt.at <= PERMISSION_RECEIPT_WINDOW_MS)
        .at(-1)
      if (earlier !== undefined) {
        if (earlier.outcome === 'allow' || earlier.outcome === 'passthrough') return finish(call, earlier.outcome, 'Decided when the call was first checked.')
        return finish(call, 'deny', 'The avatar refused this call when it was first checked.')
      }
    }

    const receipt: Receipt = { id: randomUUID(), fingerprint, sessionId: call.sessionId, toolName: call.toolName, at: app.now(), outcome: 'retry', step: null }
    app.store.receipts.put(receipt)
    checker.noteReceipt(call.sessionId)

    let settle: (result: Result) => void = () => {}
    const handedBack = new Promise<Result>((done) => {
      settle = done
    })
    const entry: InFlight = { call, fingerprint, receipt, cancelled: false, settle }
    inFlight.add(entry)
    try {
      return await Promise.race([run(entry, active.mandate, deadlineMs, signal), handedBack])
    } finally {
      inFlight.delete(entry)
    }
  }

  function passInFlight(entry: InFlight): void {
    if (entry.cancelled) return
    entry.cancelled = true
    const reason = 'Handed back to the user, so the call is not gated.'
    app.store.transaction(() => {
      app.store.receipts.put({ ...entry.receipt, outcome: 'passthrough', step: null })
      app.journal(
        entry.call.worktreeId,
        'gate',
        gateData(entry.call, entry.fingerprint, { outcome: 'passthrough', reason, reliedOn: 'take-back', trace: [], step: null }, 'passthrough')
      )
    })
    entry.settle(finish(entry.call, 'passthrough', reason))
  }

  const service: GateService = {
    decideCall,
    writeMarker(sessionId: string, worktreeId: string, level: Level) {
      writeMarkerFile(quirkyHome, sessionId, { worktreeId, level })
    },
    removeMarker(sessionId) {
      removeMarkerFile(quirkyHome, sessionId)
    },
    gateCheck: (worktreeId) => checker.check(worktreeId),
    approveOnce(needId) {
      const need = app.store.needs.get(needId)
      const fingerprint = need?.detail.fingerprint
      if (need === null || typeof fingerprint !== 'string' || app.store.approvals.get(needId) !== null) return
      app.store.approvals.put({ id: needId, worktreeId: need.worktreeId, fingerprint, usedAt: null })
    },
    resolveInFlight(worktreeId, _outcome) {
      for (const entry of [...inFlight]) if (entry.call.worktreeId === worktreeId) passInFlight(entry)
      checker.cancel(worktreeId)
    },
    noteObservedCall: (sessionId, fingerprint, at) => checker.noteObserved(sessionId, fingerprint, at),
    hasReceipt: (sessionId, fingerprint, aroundMs, windowMs) =>
      app.store.receipts.list({ sessionId, fingerprint }).some((receipt) => Math.abs(receipt.at - aroundMs) <= windowMs)
  }
  app.services.gate = service

  const provider: ToolGateProvider = async (request, signal): Promise<ToolGateDecision> => {
    const agent = AGENTS.find((candidate) => candidate === request.agent)
    if (agent === undefined) return { decision: 'unavailable', reason: `the avatar does not gate ${request.agent}`, encoded: null }
    const event = toolEvent(agent, request)
    const row = supervised(request.sessionId)
    if (row === null || event === null) {
      return { decision: 'passthrough', reason: row === null ? 'not supervised' : 'not a tool call', encoded: encodeDecision(agent, event ?? 'PreToolUse', { outcome: 'passthrough', reason: '' }) }
    }
    const payload = readPayload(request.payload)
    if (payload === null) {
      app.journal(row.worktreeId, 'gate', {
        outcome: 'deny', agent, event, toolName: null, toolInput: request.payload, trace: [], step: null, reliedOn: 'an unreadable call',
        reason: UNREADABLE_REASON, sawWorkerExplanation: false, fingerprint: null
      })
      return { decision: 'deny', reason: UNREADABLE_REASON, encoded: encodeDecision(agent, event, { outcome: 'deny', reason: UNREADABLE_REASON }) }
    }
    const worktree = (await worktrees()).find((entry) => entry.id === row.worktreeId)
    const call: ToolCall = {
      agent,
      sessionId: request.sessionId,
      worktreeId: row.worktreeId,
      cwd: payload.cwd ?? worktree?.path ?? '',
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      event
    }
    const result = await service.decideCall(call, request.deadlineMs, signal)
    return {
      decision: result.outcome === 'allow' ? 'allow' : result.outcome === 'passthrough' ? 'passthrough' : 'deny',
      reason: result.reason,
      encoded: result.encoded,
      exitCode: 0
    }
  }

  app.context.provide('tool-gate:quirky.avatar/gate', provider)
  app.context.provide(
    'launch-hook:quirky.avatar/gate-hooks',
    createGateLaunchHook({ judgmentTimeoutSeconds: () => app.settings().judgmentTimeoutSeconds, claudeVersion })
  )

  const guarded = !isRealHomeInTest(agentEnv)
  if (guarded) {
    const attempt = (what: string, work: () => unknown) => {
      try {
        work()
      } catch (error) {
        app.context.log(`avatar gate: could not install the ${what}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    attempt("Codex hooks", () => installCodexHooks(agentEnv, app.settings().judgmentTimeoutSeconds))
    attempt('pi and omp extension', () => installPiExtensions(agentEnv))
  }

  return () => {
    for (const entry of [...inFlight]) passInFlight(entry)
    clearMarkerFiles(quirkyHome)
    if (guarded) {
      try {
        removeCodexHooks(agentEnv)
      } catch (error) {
        app.context.log(`avatar gate: could not remove the Codex hooks: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
