import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AvatarApp, HandoffInput, HandoffRow, HandoffService, Mandate, NeedAction, NeedsYouItem, SheetRow, WorktreeState } from './contracts'
import { agentLabel } from './agent-label'
import { HOOKED_AGENTS, NO_HOOKED_AGENT_REASON, resolveHookedAgent } from './agents'
import { applyMandatePatch, normalizeHandoffInput, type MandatePatch } from './mandate'

const MIN_CLAUDE_VERSION: readonly number[] = [2, 1, 295]
const VERSION_TTL_MS = 60_000
const CODEX_UNGATED_NOTE = "Codex's hosted tools (web search, image generation) aren't gated"

type WorktreeInfo = { id: string; name: string; displayName?: string | null; repoId: string; path: string; kind: string; hostId?: unknown; remote?: unknown }
type RepoInfo = { id: string; name: string; displayName?: string | null; groupId?: string | null }
type GroupInfo = { id: string; name: string }
type SessionInfo = { id: string; kind?: string; agent: string; worktreeId: string; status: string; lastActivityAt?: number; agentStatus?: { state?: string } | null }
type Snapshot = { rows: SheetRow[]; byId: Map<string, SheetRow>; sessions: Map<string, SessionInfo> }
type GateCheckResult = { ok: boolean; reason: string }
type ReasonScope = { proof: Set<string>; brief: Set<string>; errors: Set<string> }
type Continuation = {
  generation: number
  worktreeId: string
  sessionId: string | null
  launching: boolean
  launchSettled: Set<string>
  agent: string
  mandate: Mandate
  updated: boolean
  shadow: boolean
  ready: boolean
  readyFromSettlement: boolean
  proofAccepted: boolean
  proofSending: boolean
  probeNotified: boolean
  proofSettledDuringSend: boolean
  checkState: 'pending' | 'passed' | 'failed' | 'error'
  checkStarted: boolean
  briefSending: boolean
  briefSettledDuringSend: boolean
  briefSent: boolean
  shadowBriefAttempted: boolean
  reasons: ReasonScope
}

const PROOF_PROMPT = 'The Avatar is checking its permission hook. Run only `pwd` once, then stop and wait for your mandate. Do not start work.'
const PROOF_NEED_PREFIX = 'Gate proof not sent: '
const CHECK_ERROR_NEED_PREFIX = 'Gate check could not finish: '

/** Test seam: how the installed Claude's version is read. */
export type HandoffDeps = { claudeVersion?: () => Promise<string | null> }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function versionAtLeast(output: string, minimum: readonly number[]): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (match === null) return true
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i]! !== minimum[i]!) return parts[i]! > minimum[i]!
  }
  return true
}

function cachedClaudeVersion(): () => Promise<string | null> {
  let cached: { at: number; value: string | null } | null = null
  return async () => {
    if (cached !== null && Date.now() - cached.at < VERSION_TTL_MS) return cached.value
    let value: string | null = null
    try {
      const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => proc.kill(), 5_000)
      value = (await new Response(proc.stdout).text()).trim() || null
      clearTimeout(timer)
    } catch {
      value = null
    }
    cached = { at: Date.now(), value }
    return value
  }
}

const UNGATED_TERMINAL_REASON = "Can't hand off: an agent is running in a terminal the avatar can't gate; start it from New agent"

const isLiveAgentStatus = (session: SessionInfo): boolean => session.agentStatus != null && session.agentStatus.state !== 'done'


function briefText(mandate: Mandate, updated: boolean): string {
  const lines = [
    updated
      ? 'Your mandate from the user was updated. Work to this version from now on.'
      : 'The user has handed this worktree to the Avatar. It answers routine permission prompts for you within this mandate, so keep working without waiting on the user.',
    '',
    `Goal: ${mandate.goal}`,
    `Done when (${mandate.doneWhenKind === 'command' ? 'this command passes' : 'this is true'}): ${mandate.doneWhen}`
  ]
  if (mandate.guidelines.length > 0) lines.push('Guidelines:', ...mandate.guidelines.map((guideline) => `- ${guideline}`))
  if (mandate.notes !== '') lines.push(`Notes: ${mandate.notes}`)
  lines.push(`Level: ${mandate.level}`, '', 'When the work meets the done-when, say so plainly and stop.')
  return lines.join('\n')
}

/**
 * Installs `app.services.handoff`: which worktrees can be handed off, hand-off and take-back with
 * their briefing, and the one-click answers to the needs-you queue. Its disposer stops the settled
 * listener and prevents gate-check failures from being journaled after shutdown; it does not take
 * worktrees back or resolve in-flight gate requests.
 */
export function register(app: AvatarApp, deps: HandoffDeps = {}): () => void {
  const claudeVersion = deps.claudeVersion ?? cachedClaudeVersion()
  const continuations = new Map<string, Continuation>()
  const resolvingNeeds = new Set<string>()
  let nextGeneration = 0
  let disposed = false
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => app.context.call(method, params) as Promise<T>

  const activeRow = (worktreeId: string): HandoffRow | null => {
    const row = app.store.handoffs.get(worktreeId)
    return row !== null && row.active ? row : null
  }

  async function watchedPaths(): Promise<Set<string>> {
    const watched = new Set<string>()
    let entries: unknown[] = []
    try {
      entries = await call<unknown[]>('quirky.heimdall/inspect', {})
    } catch {
      return watched
    }
    for (const entry of entries) {
      const enrollment = (entry as { enrollment?: { workspacePath?: unknown; terminalAtMs?: unknown; enabled?: unknown } } | null)?.enrollment
      if (enrollment && typeof enrollment.workspacePath === 'string' && enrollment.terminalAtMs === null && enrollment.enabled === true) {
        watched.add(realPath(enrollment.workspacePath))
      }
    }
    return watched
  }

  async function snapshot(): Promise<Snapshot> {
    const [worktrees, repos, groups, sessionList, watched] = await Promise.all([
      call<WorktreeInfo[]>('quirky.worktree/list', {}),
      call<RepoInfo[]>('quirky.repo/list', {}),
      call<GroupInfo[]>('quirky.repo/groupList', {}),
      call<SessionInfo[]>('quirky.session/list', {}),
      watchedPaths()
    ])
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const groupById = new Map(groups.map((group) => [group.id, group]))
    const sessions = new Map<string, SessionInfo>()
    const ungatedTerminals = new Set<string>()
    for (const session of sessionList) {
      if (session.status === 'exited') continue
      if (session.agent === 'shell') {
        if (isLiveAgentStatus(session)) ungatedTerminals.add(session.worktreeId)
        continue
      }
      const known = sessions.get(session.worktreeId)
      if (known === undefined || (session.lastActivityAt ?? 0) >= (known.lastActivityAt ?? 0)) sessions.set(session.worktreeId, session)
    }
    const needsVersion = [...sessions.values()].some((session) => session.agent === 'claude')
    const version = needsVersion ? await claudeVersion().catch(() => null) : null

    const rows: SheetRow[] = worktrees.map((worktree) => {
      let project: { id: string; name: string }
      let group: GroupInfo | null
      if (worktree.repoId.startsWith('group:')) {
        group = groupById.get(worktree.repoId.slice('group:'.length)) ?? { id: worktree.repoId.slice('group:'.length), name: worktree.name }
        project = { id: worktree.repoId, name: group.name }
      } else {
        const repo = repoById.get(worktree.repoId)
        group = repo?.groupId ? (groupById.get(repo.groupId) ?? null) : null
        project = { id: worktree.repoId, name: repo?.displayName || repo?.name || worktree.repoId }
      }
      const session = sessions.get(worktree.id)
      const handedOff = activeRow(worktree.id) !== null
      let reason: string | null = null
      if (!handedOff) {
        if (watched.has(realPath(worktree.path))) reason = "Can't hand off: a Heimdall watcher supervises it"
        else if (ungatedTerminals.has(worktree.id)) reason = UNGATED_TERMINAL_REASON
        else if (session !== undefined && !HOOKED_AGENTS.has(session.agent)) reason = `Can't hand off: ${agentLabel(session.agent)} has no permission hook`
        else if (worktree.kind !== 'git') reason = "Can't hand off: not a git worktree"
        else if (worktree.remote === true || (typeof worktree.hostId === 'string' && worktree.hostId !== '')) reason = "Can't hand off: it lives on another machine"
        else if (session?.agent === 'claude' && version !== null && !versionAtLeast(version, MIN_CLAUDE_VERSION)) reason = 'Claude is too old to fail closed; update Claude'
      }
      return {
        worktreeId: worktree.id,
        name: worktree.displayName || worktree.name,
        projectId: project.id,
        projectName: project.name,
        groupId: group?.id ?? null,
        groupName: group?.name ?? null,
        agent: session?.agent ?? null,
        running: session !== undefined || ungatedTerminals.has(worktree.id),
        handedOff,
        eligible: reason === null,
        reason,
        ungatedNote: session?.agent === 'codex' ? CODEX_UNGATED_NOTE : null
      }
    })
    return { rows, byId: new Map(rows.map((row) => [row.worktreeId, row])), sessions }
  }

  function writeStateRaw(worktreeId: string, state: WorktreeState, note: string): void {
    const row = activeRow(worktreeId)
    if (row === null) return
    app.store.transaction(() => {
      app.store.handoffs.put({ ...row, state })
      app.journal(worktreeId, 'event', { type: 'state', from: row.state, state, note })
    })
    app.emit({ type: 'state-changed', worktreeId, state })
  }

  function writeState(worktreeId: string, state: WorktreeState, note: string): void {
    const row = activeRow(worktreeId)
    if (row === null) return
    if (['checking', 'briefing', 'gate-failed', 'parked'].includes(row.state) && !['checking', 'briefing', 'gate-failed', 'parked'].includes(state)) return
    const previous = row.state
    if (state === 'parked') continuations.delete(worktreeId)
    writeStateRaw(worktreeId, state, note)
    if (state === 'checking' && previous !== 'checking') resumeBrief(worktreeId)
  }

  function upsertSharedGoal(worktreeId: string, shared: NonNullable<HandoffInput['sharedGoal']>): string {
    const goals = app.store.sharedGoals.list()
    const existing = (shared.id !== undefined ? goals.find((goal) => goal.id === shared.id) : undefined) ?? (shared.id === undefined ? goals.find((goal) => goal.goal === shared.goal) : undefined)
    const base = existing ?? { id: shared.id ?? randomUUID(), goal: shared.goal, worktreeIds: [], mergeOrder: [] }
    const add = (ids: string[]) => (ids.includes(worktreeId) ? ids : [...ids, worktreeId])
    app.store.sharedGoals.put({ ...base, goal: shared.id !== undefined ? shared.goal : base.goal, worktreeIds: add(base.worktreeIds), mergeOrder: add(base.mergeOrder) })
    return base.id
  }

  function leaveSharedGoal(worktreeId: string, sharedGoalId: string | null): void {
    if (sharedGoalId === null) return
    const goal = app.store.sharedGoals.get(sharedGoalId)
    if (goal === null) return
    const worktreeIds = goal.worktreeIds.filter((id) => id !== worktreeId)
    if (worktreeIds.length === 0) app.store.sharedGoals.delete(goal.id)
    else app.store.sharedGoals.put({ ...goal, worktreeIds, mergeOrder: goal.mergeOrder.filter((id) => id !== worktreeId) })
  }

  function current(runtime: Continuation): boolean {
    const row = app.store.handoffs.get(runtime.worktreeId)
    return !disposed &&
      continuations.get(runtime.worktreeId) === runtime &&
      row !== null &&
      row.active &&
      (runtime.launching || row.sessionId === runtime.sessionId) &&
      app.store.mandates.get(runtime.worktreeId) !== null
  }

  function latestHandoffSeq(worktreeId: string): number {
    let seq = 0
    for (const entry of app.store.journalSince(0)) {
      if (entry.worktreeId === worktreeId && entry.kind === 'handoff') seq = entry.seq
    }
    return seq
  }

  function reasonScope(worktreeId: string, afterSeq = latestHandoffSeq(worktreeId)): ReasonScope {
    const scope: ReasonScope = { proof: new Set(), brief: new Set(), errors: new Set() }
    for (const entry of app.store.journalSince(afterSeq)) {
      if (entry.worktreeId !== worktreeId || entry.kind !== 'event') continue
      const { type, reason, error } = entry.data
      if (type === 'proof-not-sent' && typeof reason === 'string') scope.proof.add(reason)
      else if (type === 'brief-not-sent' && typeof reason === 'string') scope.brief.add(reason)
      else if (type === 'gate-check-error' && typeof error === 'string') scope.errors.add(error)
    }
    return scope
  }

  function continuation(
    worktreeId: string,
    sessionId: string | null,
    mandate: Mandate,
    updated: boolean,
    agent: string,
    options: { session?: SessionInfo; launching?: boolean; handoffSeq?: number } = {}
  ): Continuation {
    const busy = options.session?.status === 'working' || options.session?.agentStatus?.state === 'working'
    const runtime: Continuation = {
      generation: ++nextGeneration,
      worktreeId,
      sessionId,
      launching: options.launching ?? false,
      launchSettled: new Set(),
      agent,
      mandate,
      updated,
      shadow: mandate.level === 'shadow',
      ready: options.session !== undefined && !busy,
      readyFromSettlement: false,
      proofAccepted: false,
      proofSending: false,
      probeNotified: false,
      proofSettledDuringSend: false,
      checkState: 'pending',
      checkStarted: false,
      briefSending: false,
      briefSettledDuringSend: false,
      briefSent: false,
      shadowBriefAttempted: false,
      reasons: reasonScope(worktreeId, options.handoffSeq)
    }
    continuations.set(worktreeId, runtime)
    return runtime
  }

  function flowNeeds(runtime: Continuation, prefix: string): NeedsYouItem[] {
    return app.needs.list({ worktreeId: runtime.worktreeId, open: true }).filter((need) =>
      need.kind === 'gate-failed' &&
      need.title.startsWith(prefix) &&
      need.detail.sessionId === runtime.sessionId
    )
  }

  function upsertFlowNeed(
    runtime: Continuation,
    prefix: string,
    title: string,
    detail: Record<string, unknown>,
    actions: NeedAction[]
  ): void {
    const row = activeRow(runtime.worktreeId)
    if (row === null || row.state !== 'checking' || row.sessionId !== runtime.sessionId || !current(runtime)) return
    const [existing, ...duplicates] = flowNeeds(runtime, prefix)
    for (const duplicate of duplicates) app.needs.close(duplicate.id, 'superseded')
    if (existing === undefined) {
      app.needs.add({ worktreeId: runtime.worktreeId, kind: 'gate-failed', title, detail, actions })
      return
    }
    if (existing.title === title && JSON.stringify(existing.detail) === JSON.stringify(detail) && JSON.stringify(existing.actions) === JSON.stringify(actions)) return
    app.store.needs.put({ ...existing, title, detail, actions })
    app.emit({ type: 'needs-changed' })
  }

  function closeFlowNeeds(runtime: Continuation, prefix: string, resolution: string): void {
    for (const need of flowNeeds(runtime, prefix)) app.needs.close(need.id, resolution)
  }

  function recordReason(runtime: Continuation, bucket: keyof ReasonScope, reason: string, data: Record<string, unknown>): void {
    const seen = runtime.reasons[bucket]
    if (seen.has(reason)) return
    seen.add(reason)
    app.journal(runtime.worktreeId, 'event', data)
  }

  async function refreshReadiness(runtime: Continuation): Promise<boolean> {
    if (!current(runtime)) return false
    if (runtime.readyFromSettlement) return true
    if (runtime.sessionId === null) {
      runtime.ready = false
      return false
    }
    let session: SessionInfo | null = null
    try {
      session = await call<SessionInfo | null>('quirky.session/get', { session: runtime.sessionId })
    } catch {
      session = null
    }
    if (!current(runtime)) return false
    if (runtime.readyFromSettlement) return true
    if (typeof session?.agent === 'string') runtime.agent = session.agent
    runtime.ready = session === null || (session.status !== 'working' && session.agentStatus?.state !== 'working')
    return runtime.ready
  }

  function signalProbeSettled(runtime: Continuation): void {
    if (!current(runtime) || runtime.shadow || runtime.sessionId === null || runtime.checkState !== 'pending' || !runtime.proofAccepted || runtime.probeNotified) return
    runtime.probeNotified = true
    app.services.gate.noteProbeSettled(runtime.worktreeId, runtime.sessionId)
  }

  function gatePassed(runtime: Continuation): boolean {
    return runtime.checkState === 'passed'
  }

  async function attemptProof(runtime: Continuation): Promise<void> {
    if (!current(runtime) || runtime.shadow || runtime.checkState !== 'pending' || runtime.proofAccepted || runtime.proofSending) return
    const row = activeRow(runtime.worktreeId)
    if (row === null || row.state !== 'checking' || row.sessionId !== runtime.sessionId) return
    if (!runtime.ready && !(await refreshReadiness(runtime))) return
    if (!current(runtime)) return
    runtime.proofSending = true
    runtime.proofSettledDuringSend = false
    runtime.ready = false
    runtime.readyFromSettlement = false
    const result = await app.services.supervisor.send(runtime.worktreeId, PROOF_PROMPT).catch((error) => ({ sent: false, reason: errorText(error) }))
    if (!current(runtime)) {
      runtime.proofSending = false
      return
    }
    runtime.proofSending = false
    const settledDuringSend = runtime.proofSettledDuringSend
    runtime.proofSettledDuringSend = false
    if (result.sent) {
      runtime.proofAccepted = true
      runtime.probeNotified = false
      closeFlowNeeds(runtime, PROOF_NEED_PREFIX, 'proof-prompt-sent')
      if (settledDuringSend) {
        runtime.ready = true
        runtime.readyFromSettlement = true
        signalProbeSettled(runtime)
      } else {
        await refreshReadiness(runtime)
      }
      if (gatePassed(runtime)) await attemptBrief(runtime)
      return
    }
    const reason = result.reason ?? 'not sent'
    recordReason(runtime, 'proof', reason, { type: 'proof-not-sent', reason })
    upsertFlowNeed(runtime, PROOF_NEED_PREFIX, `${PROOF_NEED_PREFIX}${reason}`, { reason, agent: runtime.agent, sessionId: runtime.sessionId }, ['restart-to-handoff', 'take-back'])
    if (gatePassed(runtime)) {
      closeFlowNeeds(runtime, PROOF_NEED_PREFIX, 'gate-proved')
      await attemptBrief(runtime)
    }
  }

  async function attemptBrief(runtime: Continuation): Promise<void> {
    if (!current(runtime) || !gatePassed(runtime) || runtime.briefSent || runtime.briefSending || runtime.proofSending) return
    const row = activeRow(runtime.worktreeId)
    if (row === null || row.state !== 'briefing' || row.sessionId !== runtime.sessionId) return
    if (runtime.shadow && runtime.shadowBriefAttempted) return
    if (!runtime.readyFromSettlement && !(await refreshReadiness(runtime))) return
    if (!current(runtime)) return
    const mandate = app.store.mandates.get(runtime.worktreeId)
    if (mandate === null) return
    const text = briefText(mandate, runtime.updated)
    runtime.briefSending = true
    runtime.briefSettledDuringSend = false
    runtime.ready = false
    runtime.readyFromSettlement = false
    if (runtime.shadow) runtime.shadowBriefAttempted = true
    const result = await app.services.supervisor.send(runtime.worktreeId, text).catch((error) => ({ sent: false, reason: errorText(error) }))
    if (!current(runtime)) {
      runtime.briefSending = false
      return
    }
    runtime.briefSending = false
    const settledDuringSend = runtime.briefSettledDuringSend
    runtime.briefSettledDuringSend = false
    if (!result.sent) {
      const reason = result.reason ?? 'not sent'
      recordReason(runtime, 'brief', reason, { type: 'brief-not-sent', reason })
      if (settledDuringSend) {
        runtime.ready = true
        runtime.readyFromSettlement = true
        if (!runtime.shadow) await attemptBrief(runtime)
      }
      return
    }
    const currentRow = activeRow(runtime.worktreeId)
    const currentMandate = app.store.mandates.get(runtime.worktreeId)
    if (currentRow === null || currentRow.sessionId !== runtime.sessionId || currentRow.state !== 'briefing' || currentMandate === null) return
    if (briefText(currentMandate, runtime.updated) !== text) {
      if (settledDuringSend) {
        runtime.ready = true
        runtime.readyFromSettlement = true
      }
      return
    }
    runtime.briefSent = true
    writeStateRaw(runtime.worktreeId, 'working', 'the mandate brief was sent')
  }

  function failedGateCheck(runtime: Continuation, error: unknown): void {
    if (!current(runtime)) return
    const row = app.store.handoffs.get(runtime.worktreeId)
    if (row === null || row.state !== 'checking' || row.sessionId !== runtime.sessionId) return
    runtime.checkState = 'error'
    const reason = errorText(error)
    try {
      recordReason(runtime, 'errors', reason, { type: 'gate-check-error', error: reason })
      upsertFlowNeed(runtime, CHECK_ERROR_NEED_PREFIX, `${CHECK_ERROR_NEED_PREFIX}${reason}`, { reason, agent: runtime.agent, sessionId: runtime.sessionId }, ['restart-to-handoff', 'take-back'])
    } catch {
      return
    }
  }

  function finishedGateCheck(runtime: Continuation, result: GateCheckResult): void {
    if (!current(runtime)) return
    const row = app.store.handoffs.get(runtime.worktreeId)
    if (row === null || row.sessionId !== runtime.sessionId) return
    if (!result.ok) {
      runtime.checkState = 'failed'
      if (row.state !== 'gate-failed') return
      const pending = flowNeeds(runtime, PROOF_NEED_PREFIX)[0]
      if (pending !== undefined) {
        const title = `The avatar can't confirm it gates ${agentLabel(runtime.agent)}`
        const detail = { reason: result.reason, agent: runtime.agent, sessionId: runtime.sessionId }
        if (pending.title !== title || JSON.stringify(pending.detail) !== JSON.stringify(detail) || JSON.stringify(pending.actions) !== JSON.stringify(['restart-to-handoff'])) {
          app.store.needs.put({ ...pending, title, detail, actions: ['restart-to-handoff'] })
          app.emit({ type: 'needs-changed' })
        }
      }
      return
    }
    if (row.state === 'parked' || row.state === 'gate-failed') return
    runtime.checkState = 'passed'
    if (row.state === 'checking') writeStateRaw(runtime.worktreeId, 'briefing', 'the gate check passed')
    else if (row.state !== 'briefing') return
    closeFlowNeeds(runtime, PROOF_NEED_PREFIX, 'gate-proved')
    closeFlowNeeds(runtime, CHECK_ERROR_NEED_PREFIX, 'gate-proved')
    void attemptBrief(runtime)
  }

  function startGateCheck(runtime: Continuation): void {
    if (!current(runtime) || runtime.checkStarted) return
    runtime.checkStarted = true
    let check: Promise<GateCheckResult>
    try {
      check = app.services.gate.gateCheck(runtime.worktreeId)
    } catch (error) {
      failedGateCheck(runtime, error)
      return
    }
    void check.then((result) => finishedGateCheck(runtime, result), (error) => failedGateCheck(runtime, error))
  }

  function advanceRuntime(runtime: Continuation): void {
    if (!current(runtime) || runtime.sessionId === null || runtime.shadow) return
    if (runtime.proofAccepted) {
      if (!runtime.readyFromSettlement) void refreshReadiness(runtime)
      return
    }
    if (runtime.ready) {
      void attemptProof(runtime)
      return
    }
    void refreshReadiness(runtime).then((ready) => {
      if (ready && current(runtime) && runtime.checkState === 'pending' && !runtime.proofAccepted) return attemptProof(runtime)
    })
  }

  async function settled(runtime: Continuation, sessionId: string): Promise<void> {
    if (runtime.launching && runtime.sessionId === null) {
      runtime.launchSettled.add(sessionId)
      return
    }
    if (!current(runtime) || sessionId !== runtime.sessionId) return
    runtime.ready = true
    runtime.readyFromSettlement = true
    if (runtime.proofSending) {
      runtime.proofSettledDuringSend = true
      return
    }
    if (runtime.briefSending) {
      runtime.briefSettledDuringSend = true
      return
    }
    if (runtime.checkState === 'pending' && !runtime.shadow && runtime.proofAccepted) signalProbeSettled(runtime)
    if (gatePassed(runtime)) await attemptBrief(runtime)
    else if (runtime.checkState === 'pending' && !runtime.shadow && !runtime.proofAccepted) await attemptProof(runtime)
  }

  const offSettled = app.context.subscribe((event) => {
    if (event.type !== 'quirky.agent-status/settled') return
    const data = event.data as { worktreeId?: unknown; sessionId?: unknown } | null
    if (typeof data?.worktreeId !== 'string' || typeof data.sessionId !== 'string') return
    const runtime = continuations.get(data.worktreeId)
    if (runtime === undefined) return
    return settled(runtime, data.sessionId)
  })

  /** Clears decisions that no longer belong to this hand-off or mandate. */
  function forgetDecisions(worktreeId: string, approvals: boolean): void {
    for (const answer of app.store.lateAnswers.list({ worktreeId })) app.store.lateAnswers.delete(answer.fingerprint)
    if (approvals) {
      for (const approval of app.store.approvals.list({ worktreeId, usedAt: null })) app.store.approvals.delete(approval.id)
    }
  }

  type Prepared = { mandate: Mandate; session: SessionInfo | undefined; isNew: boolean; handoffSeq: number }

  async function handoff(items: HandoffInput[]): ReturnType<HandoffService['handoff']> {
    let snap: Snapshot
    try {
      snap = await snapshot()
    } catch (error) {
      return items.map((item) => ({ worktreeId: String((item as { worktreeId?: unknown } | null)?.worktreeId ?? ''), ok: false, error: `unavailable: ${errorText(error)}` }))
    }
    const outcomes: ({ worktreeId: string; ok: boolean; error?: string } | Prepared)[] = []
    let startAgent: string | null | undefined
    for (const raw of items) outcomes.push(await prepare(raw))

    async function prepare(raw: HandoffInput): Promise<{ worktreeId: string; ok: boolean; error?: string } | Prepared> {
      const normalized = normalizeHandoffInput(raw, app.settings())
      const fallbackId = String((raw as { worktreeId?: unknown } | null)?.worktreeId ?? '')
      if (!normalized.ok) return { worktreeId: fallbackId, ok: false, error: normalized.error }
      const { sharedGoal, ...fields } = normalized.value
      if (fields.agent !== null && !HOOKED_AGENTS.has(fields.agent)) return { worktreeId: fields.worktreeId, ok: false, error: `invalid: agent ${fields.agent} has no permission hook` }
      const sheet = snap.byId.get(fields.worktreeId)
      if (sheet === undefined) return { worktreeId: fields.worktreeId, ok: false, error: 'not-eligible: unknown worktree' }
      if (!sheet.eligible) return { worktreeId: fields.worktreeId, ok: false, error: `not-eligible: ${sheet.reason}` }
      const previous = activeRow(fields.worktreeId)
      const session = snap.sessions.get(fields.worktreeId)
      if (fields.level === 'shadow' && session === undefined) return { worktreeId: fields.worktreeId, ok: false, error: 'not-eligible: Shadow needs a running agent' }
      if (session === undefined && fields.agent === null) {
        startAgent ??= await resolveHookedAgent(call)
        if (startAgent === null) return { worktreeId: fields.worktreeId, ok: false, error: `not-eligible: ${NO_HOOKED_AGENT_REASON}` }
        fields.agent = startAgent
      }
      try {
        const prepared = app.store.transaction(() => {
          const before = app.store.mandates.get(fields.worktreeId)
          const sharedGoalId = sharedGoal === undefined ? null : upsertSharedGoal(fields.worktreeId, sharedGoal)
          if (before?.sharedGoalId && before.sharedGoalId !== sharedGoalId) leaveSharedGoal(fields.worktreeId, before.sharedGoalId)
          const stored: Mandate = { ...fields, sharedGoalId, updatedAt: app.now() }
          app.store.mandates.put(stored)
          forgetDecisions(fields.worktreeId, previous === null)
          app.store.handoffs.put(
            previous !== null
              ? { ...previous, state: 'checking', sessionId: session?.id ?? previous.sessionId }
              : { worktreeId: fields.worktreeId, state: 'checking', sessionId: session?.id ?? null, active: true, handedOffAt: app.now(), takenBackAt: null }
          )
          const journal = app.journal(fields.worktreeId, 'handoff', { updated: previous !== null, mandate: stored })
          return { mandate: stored, handoffSeq: journal.seq }
        })
        continuations.delete(fields.worktreeId)
        return { ...prepared, session, isNew: previous === null }
      } catch (error) {
        return { worktreeId: fields.worktreeId, ok: false, error: `unavailable: ${errorText(error)}` }
      }
    }
    if (outcomes.some((outcome) => 'mandate' in outcome)) app.emit({ type: 'handoffs-changed' })

    return Promise.all(
      outcomes.map(async (outcome) => {
        if (!('mandate' in outcome)) return outcome
        const { mandate, session, isNew, handoffSeq } = outcome
        const id = mandate.worktreeId
        app.emit({ type: 'state-changed', worktreeId: id, state: 'checking' })
        if (session !== undefined) {
          const runtime = continuation(id, session.id, mandate, !isNew, session.agent, { session, handoffSeq })
          app.services.gate.writeMarker(session.id, id, mandate.level)
          resumeBrief(id)
          return { worktreeId: id, ok: true }
        }

        const runtime = continuation(id, null, mandate, !isNew, mandate.agent ?? '', { launching: true, handoffSeq })
        const started = await app.services.supervisor.startSession(id, PROOF_PROMPT).catch((error) => ({ sessionId: null, error: errorText(error) }))
        if (started.sessionId === null) {
          if (!current(runtime)) return { worktreeId: id, ok: true }
          continuations.delete(id)
          const row = app.store.handoffs.get(id)
          app.store.transaction(() => {
            if (row !== null) app.store.handoffs.put({ ...row, active: false, takenBackAt: app.now() })
            app.journal(id, 'event', { type: 'start-failed', error: started.error ?? 'no session' })
          })
          app.emit({ type: 'handoffs-changed' })
          return { worktreeId: id, ok: false, error: `couldn't start the agent: ${started.error ?? 'no session started'}` }
        }
        if (!current(runtime)) return { worktreeId: id, ok: true }
        const row = app.store.handoffs.get(id)
        if (row === null || !row.active) return { worktreeId: id, ok: true }
        app.store.handoffs.put({ ...row, sessionId: started.sessionId })
        runtime.sessionId = started.sessionId
        runtime.launching = false
        runtime.proofAccepted = true
        app.services.gate.writeMarker(started.sessionId, id, mandate.level)
        const settledDuringLaunch = runtime.launchSettled.delete(started.sessionId)
        if (settledDuringLaunch) {
          runtime.ready = true
          runtime.readyFromSettlement = true
        }
        resumeBrief(id)
        if (settledDuringLaunch) signalProbeSettled(runtime)
        return { worktreeId: id, ok: true }
      })
    )
  }

  function resumeBrief(worktreeId: string): void {
    const row = activeRow(worktreeId)
    const mandate = app.store.mandates.get(worktreeId)
    if (row === null || mandate === null || (row.state !== 'checking' && row.state !== 'briefing')) return
    const existing = continuations.get(worktreeId)
    if (existing !== undefined && current(existing)) {
      if (existing.checkStarted && (existing.checkState === 'pending' || existing.checkState === 'passed')) return
      if (!existing.checkStarted && existing.checkState === 'pending') {
        startGateCheck(existing)
        advanceRuntime(existing)
        return
      }
    }
    continuations.delete(worktreeId)
    if (row.state === 'briefing') writeStateRaw(worktreeId, 'checking', 'rechecking before the mandate brief')
    const runtime = continuation(worktreeId, row.sessionId, mandate, true, mandate.agent ?? '')
    startGateCheck(runtime)
    advanceRuntime(runtime)
  }

  async function liveAgentSessionIds(worktreeId: string): Promise<string[]> {
    try {
      const sessions = await call<SessionInfo[]>('quirky.session/list', { worktree: worktreeId })
      return sessions.filter((session) => session.worktreeId === worktreeId && session.agent !== 'shell' && session.status !== 'exited').map((session) => session.id)
    } catch {
      return []
    }
  }

  async function takeBack(selection: { worktreeIds: string[] } | { all: true }): ReturnType<HandoffService['takeBack']> {
    const ids = 'all' in selection ? app.store.handoffs.list({ active: true }).map((row) => row.worktreeId) : [...new Set(selection.worktreeIds)]
    const results: { worktreeId: string; ok: boolean; handedBackWith: string[] }[] = []
    for (const worktreeId of ids) {
      const row = activeRow(worktreeId)
      if (row === null) continue
      const handedBackWith = app.store.transaction(() => {
        const open = app.needs.list({ worktreeId, open: true })
        for (const need of open) app.needs.close(need.id, 'handed-back')
        const cancelled = app.services.shipping.cancelOutbox(worktreeId)
        continuations.delete(worktreeId)
        app.store.handoffs.put({ ...row, active: false, takenBackAt: app.now() })
        forgetDecisions(worktreeId, true)
        const titles = open.map((need) => need.title)
        app.journal(worktreeId, 'take-back', { handedBackWith: titles, cancelledOutbox: cancelled, state: row.state })
        return titles
      })
      const sessionIds = new Set(await liveAgentSessionIds(worktreeId))
      if (row.sessionId !== null) sessionIds.add(row.sessionId)
      for (const sessionId of sessionIds) app.services.gate.removeMarker(sessionId)
      app.services.gate.resolveInFlight(worktreeId, 'passthrough')
      results.push({ worktreeId, ok: true, handedBackWith })
    }
    if (results.length > 0) app.emit({ type: 'handoffs-changed' })
    return results
  }

  function closeNeed(need: NeedsYouItem, action: NeedAction, resolution: string, extra: Record<string, unknown> = {}, kind: 'event' | 'ask' | 'guess' | 'mandate-proposal' = 'event'): void {
    app.store.transaction(() => {
      app.needs.close(need.id, resolution)
      app.journal(need.worktreeId, kind, { type: 'need-resolved', needId: need.id, action, resolution, ...extra })
    })
  }

  async function sendToWorker(worktreeId: string, text: string): Promise<void> {
    const sent = await app.services.supervisor.send(worktreeId, text).catch((error) => ({ sent: false, reason: errorText(error) }))
    if (!sent.sent) app.journal(worktreeId, 'event', { type: 'send-failed', reason: sent.reason ?? 'not sent' })
  }

  function guessFor(need: NeedsYouItem) {
    const id = need.detail.guessId
    if (typeof id === 'string') return app.store.guesses.get(id)
    return app.store.guesses.list({ worktreeId: need.worktreeId }).filter((guess) => guess.confirmedAt === null && guess.redoneAt === null).at(-1) ?? null
  }

  async function resolveNeed(needId: string, action: NeedAction, text?: string, answers?: Record<string, unknown>): ReturnType<HandoffService['resolveNeed']> {
    const need = app.store.needs.get(needId)
    if (need === null) return { ok: false, error: 'unknown need' }
    if (need.resolvedAt !== null || resolvingNeeds.has(needId)) return { ok: false, error: 'need already resolved' }
    if (!need.actions.includes(action)) return { ok: false, error: `action not allowed for this need: ${action}` }
    const worktreeId = need.worktreeId
    const answer = text?.trim() ?? ''
    resolvingNeeds.add(needId)
    try {
      switch (action) {
        case 'allow-once': {
          app.services.gate.approveOnce(need.id)
          closeNeed(need, action, 'allowed-once')
          await sendToWorker(worktreeId, 'Your held call is approved once; retry it now.')
          return { ok: true }
        }
        case 'deny': {
          closeNeed(need, action, 'denied')
          await sendToWorker(worktreeId, 'Held call denied; find another way.')
          return { ok: true }
        }
        case 'confirm':
        case 'redo': {
          const guess = guessFor(need)
          if (guess === null) return { ok: false, error: 'unknown guess' }
          app.store.transaction(() => {
            app.store.guesses.put(action === 'confirm' ? { ...guess, confirmedAt: app.now() } : { ...guess, redoneAt: app.now() })
            closeNeed(need, action, action === 'confirm' ? 'confirmed' : 'redone', { guessId: guess.id, ...(answer === '' ? {} : { text: answer }) }, 'guess')
          })
          app.services.brain.wake()
          return { ok: true }
        }
        case 'review-accept': {
          const mandate = app.store.mandates.get(worktreeId)
          if (mandate === null) return { ok: false, error: 'no mandate' }
          const patch = need.detail.patch
          if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ok: false, error: 'invalid: patch' }
          const { goal, doneWhen, guidelines, notes } = patch as MandatePatch
          const applied = applyMandatePatch(mandate, { goal, doneWhen, guidelines, notes }, app.now())
          if (!applied.ok) return { ok: false, error: applied.error }
          app.store.transaction(() => {
            app.store.mandates.put(applied.value)
            forgetDecisions(worktreeId, false)
            closeNeed(need, action, 'accepted', { patch: { goal, doneWhen, guidelines, notes } }, 'mandate-proposal')
          })
          app.services.brain.wake()
          return { ok: true }
        }
        case 'review-reject':
          closeNeed(need, action, 'rejected', {}, 'mandate-proposal')
          return { ok: true }
        case 'answer': {
          const hasAnswers = answers !== undefined && Object.keys(answers).length > 0
          if (!hasAnswers && answer === '') return { ok: false, error: 'an answer needs text' }
          const askId = typeof need.detail.askId === 'string' && need.detail.askId.trim() !== '' ? need.detail.askId.trim() : null
          if (askId !== null) {
            const firstQuestion = Array.isArray(need.detail.questions) ? need.detail.questions[0] as { id?: unknown } | undefined : undefined
            const firstQuestionId = typeof firstQuestion?.id === 'string' && firstQuestion.id.trim() !== '' ? firstQuestion.id : 'q1'
            const payloadAnswers: Record<string, unknown> = hasAnswers
              ? answers!
              : { [firstQuestionId]: { value: answer, source: 'input' } }
            try {
              const envelope = (await app.context.call('quirky.ask/answer', { askId, answers: payloadAnswers })) as { status?: unknown } | undefined
              app.needs.close(need.id, typeof envelope?.status === 'string' ? envelope.status : 'answered')
              return { ok: true }
            } catch (cause) {
              const message = errorText(cause)
              const already = /^ask .+ is already (answered|partial|declined|timed_out|unavailable)$/.exec(message)
              if (already !== null) app.needs.close(need.id, already[1]!)
              else if (/^no such ask:/i.test(message)) app.needs.close(need.id, 'unavailable')
              return { ok: false, error: message }
            }
          }
          closeNeed(need, action, 'answered', { text: answer, ...(hasAnswers ? { answers } : {}) }, 'ask')
          app.services.brain.wake()
          return { ok: true }
        }
        case 'restart': {
          const result = await app.services.supervisor.restartWorker(worktreeId, answer === '' ? 'restarted by you' : answer)
          if (result.sessionId === null) return { ok: false, error: result.error ?? 'could not restart the worker' }
          closeNeed(need, action, 'restarted')
          return { ok: true }
        }
        case 'take-back': {
          await takeBack({ worktreeIds: [worktreeId] })
          if (app.store.needs.get(need.id)?.resolvedAt === null) closeNeed(need, action, 'handed-back')
          return { ok: true }
        }
        case 'restart-to-handoff': {
        const row = activeRow(worktreeId)
        const mandate = app.store.mandates.get(worktreeId)
        if (row === null || mandate === null) return { ok: false, error: 'no active hand-off' }
        if (mandate.level === 'shadow') return { ok: false, error: 'Shadow cannot restart a worker for gate proof' }
        const runtime = continuation(worktreeId, null, mandate, true, mandate.agent ?? '', { launching: true })
        const result = await app.services.supervisor.restartWorker(worktreeId, PROOF_PROMPT)
        if (result.sessionId === null) {
          if (continuations.get(worktreeId) === runtime) continuations.delete(worktreeId)
          return { ok: false, error: result.error ?? 'could not restart the worker' }
        }
        if (!current(runtime)) return { ok: false, error: 'hand-off changed while restarting' }
        const currentRow = activeRow(worktreeId)
        const currentMandate = app.store.mandates.get(worktreeId)
        if (currentRow === null || currentMandate === null) return { ok: false, error: 'hand-off changed while restarting' }
        app.store.handoffs.put({ ...currentRow, sessionId: result.sessionId })
        runtime.sessionId = result.sessionId
        runtime.launching = false
        runtime.proofAccepted = true
        runtime.agent = currentMandate.agent ?? runtime.agent
        app.services.gate.writeMarker(result.sessionId, worktreeId, currentMandate.level)
        closeNeed(need, action, 'restarted', answer === '' ? {} : { text: answer })
        if (currentRow.state !== 'checking') writeStateRaw(worktreeId, 'checking', 'restarted to re-check the gate')
        const settledDuringLaunch = runtime.launchSettled.delete(result.sessionId)
        if (settledDuringLaunch) {
          runtime.ready = true
          runtime.readyFromSettlement = true
        }
        resumeBrief(worktreeId)
        if (settledDuringLaunch) signalProbeSettled(runtime)
        return { ok: true }
      }
      }
    } finally {
      resolvingNeeds.delete(needId)
    }
  }

  app.services.handoff = {
    handoff,
    resumeBrief,
    takeBack,
    eligibility: async () => (await snapshot()).rows,
    mandate: (worktreeId) => app.store.mandates.get(worktreeId),
    active() {
      const active: ReturnType<HandoffService['active']> = []
      for (const row of app.store.handoffs.list({ active: true })) {
        const mandate = app.store.mandates.get(row.worktreeId)
        if (mandate !== null) active.push({ worktreeId: row.worktreeId, sessionId: row.sessionId, state: row.state, mandate })
      }
      return active
    },
    setState: writeState,
    resolveNeed
  }
  return () => {
    disposed = true
    continuations.clear()
    offSettled()
  }
}
