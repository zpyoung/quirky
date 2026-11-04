import type { AvatarApp } from './contracts'
import {
  claudeVersionAtLeast, codexHooksInstalled, hasMarkerFile, launchHasGateHook, piExtensionMtimeMs, removeMarkerFile, type AgentEnv
} from './hooks/install'

const STARTED_BEFORE_HOOK = "started before the avatar's hook was installed"
const NOT_REACHING_GATE = 'tool calls are not reaching the gate'
const RECEIPT_WINDOW_MS = 60_000

export type GateCheckResult = { ok: boolean; reason: string }

export type GateCheckDeps = {
  app: AvatarApp
  agentEnv: AgentEnv
  /** The installed Claude's `--version` output, or null when it can't be read. */
  claudeVersion(): Promise<string | null>
  /** How long an observed call may go without a receipt before the check fails; 10 s unless a test shortens it. */
  graceMs?: number
}

type Observed = { fingerprint: string; at: number }
type SessionRecord = { agent?: unknown; createdAt?: unknown; launch?: { args?: unknown; env?: unknown } | null }

/** The gate check for supervised worktrees (R-9, R-41): proves an agent's tool calls reach the gate before and while it is supervised. */
export type GateChecker = {
  /** Runs both steps for the worktree's current session; calls for one worktree share a run while one is pending. */
  check(worktreeId: string): Promise<GateCheckResult>
  /** Tells waiting checks that `sessionId` just produced a receipt. */
  noteReceipt(sessionId: string): void
  /** Tells waiting checks the session record showed a tool call the gate may not have seen. */
  noteObserved(sessionId: string, fingerprint: string, at: number): void
  /** Ends any waiting check for the worktree without failing it, because it was handed back. */
  cancel(worktreeId: string): void
}

/**
 * Builds the checker. The static step is per agent: Claude's launch args hold the avatar's
 * `--settings` hook and Claude is new enough to fail closed, Codex's `hooks.json` holds both
 * entries, and pi and omp have the extension file installed before the session started. The
 * dynamic step passes on the first receipt from the session after hand-off and fails when a call
 * seen in the session record has no receipt after the grace period. A failure removes the marker,
 * sets `gate-failed` and queues `restart-to-handoff`; a pass moves `checking` to `briefing`.
 */
export function createGateChecker(deps: GateCheckDeps): GateChecker {
  const { app, agentEnv } = deps
  const graceMs = deps.graceMs ?? 10_000
  const running = new Map<string, Promise<GateCheckResult>>()
  const waiters = new Map<string, Set<() => void>>()
  const cancels = new Map<string, Set<() => void>>()
  const observed = new Map<string, Observed[]>()

  const hasReceiptNear = (sessionId: string, fingerprint: string, at: number): boolean =>
    app.store.receipts.list({ sessionId, fingerprint }).some((receipt) => Math.abs(receipt.at - at) <= RECEIPT_WINDOW_MS)

  async function staticStep(sessionId: string): Promise<GateCheckResult & { agent: string }> {
    let session: SessionRecord
    try {
      session = (await app.context.call('quirky.session/get', { session: sessionId })) as SessionRecord
    } catch (error) {
      return { ok: false, agent: '', reason: `could not read the session: ${error instanceof Error ? error.message : String(error)}` }
    }
    const agent = typeof session?.agent === 'string' ? session.agent : ''
    const result = checkAgent(agent, session)
    return { ...(await result), agent }
  }

  async function checkAgent(agent: string, session: SessionRecord): Promise<GateCheckResult> {
    if (agent === 'claude') {
      if (!claudeVersionAtLeast(await deps.claudeVersion().catch(() => null))) return { ok: false, reason: 'Claude is too old to fail closed; update Claude' }
      const args = Array.isArray(session.launch?.args) ? (session.launch.args as unknown[]) : []
      return launchHasGateHook(args) ? { ok: true, reason: '' } : { ok: false, reason: STARTED_BEFORE_HOOK }
    }
    if (agent === 'codex') {
      return codexHooksInstalled(agentEnv) ? { ok: true, reason: '' } : { ok: false, reason: "the avatar's entries are missing from Codex's hooks.json" }
    }
    if (agent === 'pi' || agent === 'omp') {
      const launchEnv = session.launch?.env
      const env = { ...agentEnv.env, ...(typeof launchEnv === 'object' && launchEnv !== null ? (launchEnv as Record<string, string>) : {}) }
      const mtime = piExtensionMtimeMs(agent, { home: agentEnv.home, env })
      if (mtime === null) return { ok: false, reason: `the avatar's extension is not installed for ${agent}` }
      const startedAt = typeof session.createdAt === 'number' ? session.createdAt : Number.POSITIVE_INFINITY
      return mtime < startedAt ? { ok: true, reason: '' } : { ok: false, reason: STARTED_BEFORE_HOOK }
    }
    return { ok: false, reason: `${agent || 'this agent'} has no permission hook` }
  }

  function dynamicStep(worktreeId: string, sessionId: string, since: number): Promise<GateCheckResult & { cancelled?: boolean }> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (result: GateCheckResult & { cancelled?: boolean }) => {
        if (timer !== null) clearTimeout(timer)
        waiters.get(sessionId)?.delete(evaluate)
        cancels.get(worktreeId)?.delete(cancel)
        resolve(result)
      }
      const cancel = () => finish({ ok: false, reason: 'no longer supervised', cancelled: true })
      function evaluate() {
        const row = app.store.handoffs.get(worktreeId)
        if (row === null || !row.active || row.sessionId !== sessionId || !hasMarkerFile(app.context.home, sessionId)) return cancel()
        if (app.store.receipts.list({ sessionId }).some((receipt) => receipt.at >= since)) return finish({ ok: true, reason: '' })
        const unseen = (observed.get(sessionId) ?? []).find((call) => !hasReceiptNear(sessionId, call.fingerprint, call.at))
        if (unseen === undefined) return
        const due = unseen.at + graceMs
        if (app.now() >= due) return finish({ ok: false, reason: NOT_REACHING_GATE })
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(evaluate, Math.max(1, due - app.now()))
      }
      const set = waiters.get(sessionId) ?? new Set<() => void>()
      set.add(evaluate)
      waiters.set(sessionId, set)
      const cancelSet = cancels.get(worktreeId) ?? new Set<() => void>()
      cancelSet.add(cancel)
      cancels.set(worktreeId, cancelSet)
      evaluate()
    })
  }

  function fail(worktreeId: string, sessionId: string, agent: string, reason: string): GateCheckResult {
    removeMarkerFile(app.context.home, sessionId)
    app.store.transaction(() => {
      app.journal(worktreeId, 'event', { type: 'gate-check', ok: false, agent, reason })
      if (!app.needs.list({ worktreeId, open: true }).some((need) => need.kind === 'gate-failed')) {
        app.needs.add({
          worktreeId,
          kind: 'gate-failed',
          title: `The avatar can't confirm it gates ${agent || 'this agent'}`,
          detail: { reason, agent, sessionId },
          actions: ['restart-to-handoff']
        })
      }
    })
    app.services.handoff.setState(worktreeId, 'gate-failed', reason)
    return { ok: false, reason }
  }

  async function run(worktreeId: string): Promise<GateCheckResult> {
    const row = app.store.handoffs.get(worktreeId)
    if (row === null || !row.active) return { ok: false, reason: 'not handed off' }
    if (row.sessionId === null) return fail(worktreeId, '', '', 'there is no session to check')
    const sessionId = row.sessionId
    const { agent, ...stepOne } = await staticStep(sessionId)
    if (!stepOne.ok) return fail(worktreeId, sessionId, agent, stepOne.reason)
    const stepTwo = await dynamicStep(worktreeId, sessionId, row.handedOffAt)
    if (stepTwo.cancelled) return { ok: false, reason: stepTwo.reason }
    if (!stepTwo.ok) return fail(worktreeId, sessionId, agent, stepTwo.reason)
    app.journal(worktreeId, 'event', { type: 'gate-check', ok: true, agent })
    if (app.store.handoffs.get(worktreeId)?.state === 'checking') app.services.handoff.setState(worktreeId, 'briefing', 'the gate check passed')
    return { ok: true, reason: '' }
  }

  return {
    check(worktreeId) {
      const existing = running.get(worktreeId)
      if (existing !== undefined) return existing
      const started = run(worktreeId).finally(() => running.delete(worktreeId))
      running.set(worktreeId, started)
      return started
    },
    noteReceipt(sessionId) {
      for (const evaluate of [...(waiters.get(sessionId) ?? [])]) evaluate()
    },
    noteObserved(sessionId, fingerprint, at) {
      const list = observed.get(sessionId) ?? []
      list.push({ fingerprint, at })
      if (list.length > 50) list.shift()
      observed.set(sessionId, list)
      for (const evaluate of [...(waiters.get(sessionId) ?? [])]) evaluate()
    },
    cancel(worktreeId) {
      for (const cancel of [...(cancels.get(worktreeId) ?? [])]) cancel()
    }
  }
}
