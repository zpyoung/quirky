import type { AvatarApp, WorktreeState } from './contracts'

const RESTING: ReadonlySet<WorktreeState> = new Set(['parked', 'done', 'merged', 'pr-ready', 'committed', 'gate-failed'])
const HOLD_REASON = 'avatar: handed-off work'

/**
 * Keeps the machine awake while any handed-off worktree is doing or waiting on work, and journals
 * every host sleep that happens while the avatar has hand-offs. Returns a disposer that releases
 * the hold and stops listening.
 */
export function register(app: AvatarApp): () => void {
  let release: (() => void) | null = null
  let suspendedAt: number | null = null
  let hadHandoffs = false

  const evaluate = (): void => {
    const needed = app.services.handoff.active().some((handoff) => !RESTING.has(handoff.state))
    if (needed && release === null) release = app.context.hostPower.keepAwake(HOLD_REASON)
    else if (!needed && release !== null) {
      release()
      release = null
    }
  }

  const offBus = app.on((event) => {
    if (event.type === 'state-changed' || event.type === 'handoffs-changed') evaluate()
  })
  const offPower = app.context.hostPower.subscribe({
    suspend() {
      suspendedAt = app.now()
      hadHandoffs = app.services.handoff.active().length > 0
    },
    resume() {
      if (suspendedAt === null) return
      const at = suspendedAt
      suspendedAt = null
      if (hadHandoffs) app.journal(null, 'sleep', { at, durationMs: Math.max(0, app.now() - at), keptAwake: release !== null })
    }
  })
  evaluate()

  return () => {
    offBus()
    offPower()
    release?.()
    release = null
  }
}
