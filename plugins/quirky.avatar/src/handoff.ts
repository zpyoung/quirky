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
type Brief = { sessionId: string; text: string }

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
 * their briefing, and the one-click answers to the needs-you queue. Returns a disposer that stops
 * the settled listener and ends every gate check still running for a handed-off worktree; after it
 * runs, a gate check's failure is dropped instead of journaled, because the store may be closed.
 */
export function register(app: AvatarApp, deps: HandoffDeps = {}): () => void {
  const claudeVersion = deps.claudeVersion ?? cachedClaudeVersion()
  const pendingBriefs = new Map<string, Brief>()
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

  function writeState(worktreeId: string, state: WorktreeState, note: string): void {
    const row = activeRow(worktreeId)
    if (row === null) return
    app.store.transaction(() => {
      app.store.handoffs.put({ ...row, state })
      app.journal(worktreeId, 'event', { type: 'state', from: row.state, state, note })
    })
    app.emit({ type: 'state-changed', worktreeId, state })
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

  async function sendBrief(worktreeId: string, brief: Brief): Promise<void> {
    try {
      await call('quirky.agent-status/send', { session: brief.sessionId, text: brief.text })
      pendingBriefs.delete(worktreeId)
    } catch (error) {
      const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
      if (reason === 'agent-blocked') {
        pendingBriefs.set(worktreeId, brief)
        return
      }
      pendingBriefs.delete(worktreeId)
      app.journal(worktreeId, 'event', { type: 'brief-not-sent', reason: typeof reason === 'string' ? reason : errorText(error) })
    }
  }

  async function deliverBrief(worktreeId: string, session: SessionInfo, text: string): Promise<void> {
    const brief = { sessionId: session.id, text }
    if (session.agentStatus?.state === 'working' || session.status === 'working') {
      pendingBriefs.set(worktreeId, brief)
      return
    }
    await sendBrief(worktreeId, brief)
  }

  const offSettled = app.context.subscribe((event) => {
    if (event.type !== 'quirky.agent-status/settled') return
    const data = event.data as { worktreeId?: unknown } | null
    if (typeof data?.worktreeId !== 'string') return
    const brief = pendingBriefs.get(data.worktreeId)
    if (brief === undefined) return
    const sessionId = (data as { sessionId?: unknown }).sessionId
    if (sessionId !== brief.sessionId) return
    pendingBriefs.delete(data.worktreeId)
    return sendBrief(data.worktreeId, brief)
  })

  function startGateCheck(worktreeId: string): void {
    app.services.gate.gateCheck(worktreeId).catch((error) => {
      if (disposed) return
      try {
        app.journal(worktreeId, 'event', { type: 'gate-check-error', error: errorText(error) })
      } catch {
        return
      }
    })
  }

  type Prepared = { mandate: Mandate; session: SessionInfo | undefined; isNew: boolean }

  async function handoff(items: HandoffInput[]): ReturnType<HandoffService['handoff']> {
    let snap: Snapshot
    try {
      snap = await snapshot()
    } catch (error) {
      return items.map((item) => ({ worktreeId: String((item as { worktreeId?: unknown } | null)?.worktreeId ?? ''), ok: false, error: `unavailable: ${errorText(error)}` }))
    }
    const outcomes: ({ worktreeId: string; ok: boolean; error?: string } | Prepared)[] = []
    let startAgent: string | null | undefined
    for (const raw of items) {
      outcomes.push(await prepare(raw))
    }
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
      if (session === undefined && fields.agent === null) {
        startAgent ??= await resolveHookedAgent(call)
        if (startAgent === null) return { worktreeId: fields.worktreeId, ok: false, error: `not-eligible: ${NO_HOOKED_AGENT_REASON}` }
        fields.agent = startAgent
      }
      try {
        const mandate = app.store.transaction(() => {
          const before = app.store.mandates.get(fields.worktreeId)
          const sharedGoalId = sharedGoal === undefined ? null : upsertSharedGoal(fields.worktreeId, sharedGoal)
          if (before?.sharedGoalId && before.sharedGoalId !== sharedGoalId) leaveSharedGoal(fields.worktreeId, before.sharedGoalId)
          const stored: Mandate = { ...fields, sharedGoalId, updatedAt: app.now() }
          app.store.mandates.put(stored)
          app.store.handoffs.put(
            previous !== null
              ? { ...previous, state: 'checking', sessionId: session?.id ?? previous.sessionId }
              : { worktreeId: fields.worktreeId, state: 'checking', sessionId: session?.id ?? null, active: true, handedOffAt: app.now(), takenBackAt: null }
          )
          app.journal(fields.worktreeId, 'handoff', { updated: previous !== null, mandate: stored })
          return stored
        })
        return { mandate, session, isNew: previous === null }
      } catch (error) {
        return { worktreeId: fields.worktreeId, ok: false, error: `unavailable: ${errorText(error)}` }
      }
    }
    if (outcomes.some((outcome) => 'mandate' in outcome)) app.emit({ type: 'handoffs-changed' })

    return Promise.all(
      outcomes.map(async (outcome) => {
        if (!('mandate' in outcome)) return outcome
        const { mandate, session, isNew } = outcome
        const id = mandate.worktreeId
        app.emit({ type: 'state-changed', worktreeId: id, state: 'checking' })
        if (session !== undefined) {
          app.services.gate.writeMarker(session.id, id, mandate.level)
          await deliverBrief(id, session, briefText(mandate, !isNew))
        } else {
          const started = await app.services.supervisor.startSession(id, briefText(mandate, false)).catch((error) => ({ sessionId: null, error: errorText(error) }))
          if (started.sessionId === null) {
            const row = app.store.handoffs.get(id)
            app.store.transaction(() => {
              if (row !== null) app.store.handoffs.put({ ...row, active: false, takenBackAt: app.now() })
              app.journal(id, 'event', { type: 'start-failed', error: started.error ?? 'no session' })
            })
            app.emit({ type: 'handoffs-changed' })
            return { worktreeId: id, ok: false, error: `couldn't start the agent: ${started.error ?? 'no session started'}` }
          }
          const row = app.store.handoffs.get(id)
          if (row !== null) app.store.handoffs.put({ ...row, sessionId: started.sessionId })
          app.services.gate.writeMarker(started.sessionId, id, mandate.level)
        }
        startGateCheck(id)
        return { worktreeId: id, ok: true }
      })
    )
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
        app.store.handoffs.put({ ...row, active: false, takenBackAt: app.now() })
        const titles = open.map((need) => need.title)
        app.journal(worktreeId, 'take-back', { handedBackWith: titles, cancelledOutbox: cancelled, state: row.state })
        return titles
      })
      pendingBriefs.delete(worktreeId)
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

  async function resolveNeed(needId: string, action: NeedAction, text?: string): ReturnType<HandoffService['resolveNeed']> {
    const need = app.store.needs.get(needId)
    if (need === null) return { ok: false, error: 'unknown need' }
    if (need.resolvedAt !== null) return { ok: false, error: 'need already resolved' }
    if (!need.actions.includes(action)) return { ok: false, error: `action not allowed for this need: ${action}` }
    const worktreeId = need.worktreeId
    const answer = text?.trim() ?? ''

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
          closeNeed(need, action, 'accepted', { patch: { goal, doneWhen, guidelines, notes } }, 'mandate-proposal')
        })
        app.services.brain.wake()
        return { ok: true }
      }
      case 'review-reject':
        closeNeed(need, action, 'rejected', {}, 'mandate-proposal')
        return { ok: true }
      case 'answer': {
        if (answer === '') return { ok: false, error: 'an answer needs text' }
        closeNeed(need, action, 'answered', { text: answer }, 'ask')
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
        const result = await app.services.supervisor.restartWorker(worktreeId, answer === '' ? 'restarted so the gate can be checked again' : answer)
        if (result.sessionId === null) return { ok: false, error: result.error ?? 'could not restart the worker' }
        const row = activeRow(worktreeId)
        const mandate = app.store.mandates.get(worktreeId)
        if (row !== null) app.store.handoffs.put({ ...row, sessionId: result.sessionId })
        if (mandate !== null) app.services.gate.writeMarker(result.sessionId, worktreeId, mandate.level)
        closeNeed(need, action, 'restarted')
        writeState(worktreeId, 'checking', 'restarted to re-check the gate')
        startGateCheck(worktreeId)
        return { ok: true }
      }
    }
  }

  app.services.handoff = {
    handoff,
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
    offSettled()
    try {
      for (const row of app.store.handoffs.list({ active: true })) app.services.gate.resolveInFlight(row.worktreeId, 'passthrough')
    } catch {
      return
    }
  }
}
