import type { AvatarApp, NeedKind, NeedsYouItem, WorktreeState } from './contracts'
import { isActiveWork } from './report'

const NOTIFICATION_KEY = 'quirky.avatar/needs-you'
const OPEN_REPORT_COMMAND = 'command:quirky.avatar/open-report'
const WAITING_STATES: ReadonlySet<WorktreeState> = new Set(['waiting-on-you', 'parked', 'gate-failed'])

const NEED_PHRASES: Record<NeedKind, [one: string, many: string]> = {
  'held-call': ['held call', 'held calls'],
  question: ['question', 'questions'],
  guess: ['guess to confirm', 'guesses to confirm'],
  'mandate-edit': ['mandate edit', 'mandate edits'],
  parked: ['parked worktree', 'parked worktrees'],
  'gate-failed': ['failed gate check', 'failed gate checks'],
  'brain-error': ['brain error', 'brain errors'],
  'merge-blocked': ['blocked merge', 'blocked merges']
}

type Handoff = ReturnType<AvatarApp['services']['handoff']['active']>[number]

function blockedOnYou(active: Handoff[], open: NeedsYouItem[]): boolean {
  if (active.length === 0) return false
  const hasNeed = (handoff: Handoff) => open.some((need) => need.worktreeId === handoff.worktreeId)
  if (active.every((handoff) => WAITING_STATES.has(handoff.state) || hasNeed(handoff))) return true
  // a held call is the only way forward once nothing else has agent work in flight
  return open.some((need) => need.kind === 'held-call') && active.every((handoff) => hasNeed(handoff) || !isActiveWork(handoff.state))
}

function countsOf(active: Handoff[], open: NeedsYouItem[]): string {
  const parts: string[] = []
  for (const kind of Object.keys(NEED_PHRASES) as NeedKind[]) {
    const count = open.filter((need) => need.kind === kind).length
    if (count > 0) parts.push(`${count} ${NEED_PHRASES[kind][count === 1 ? 0 : 1]}`)
  }
  if (parts.length > 0) return parts.join(', ')
  return `${active.length} waiting on you`
}

/**
 * Sends the avatar's only notification: one "Avatar needs you" when every handed-off worktree is
 * waiting on you, or a held call is the only way forward. It stays quiet until that condition has
 * turned false and true again. Returns its disposer.
 */
export function register(app: AvatarApp): () => void {
  let notified = false

  return app.on((event) => {
    if (event.type !== 'needs-changed' && event.type !== 'state-changed' && event.type !== 'handoffs-changed') return
    const active = app.services.handoff.active()
    const open = app.needs.list({ open: true })
    if (!blockedOnYou(active, open)) {
      notified = false
      return
    }
    if (notified) return
    notified = true
    const title = 'Avatar needs you'
    const body = `All ${active.length} handed-off worktrees are waiting on you: ${countsOf(active, open)}.`
    app.context.notify({ title, body, actions: [{ label: 'Open report', command: OPEN_REPORT_COMMAND }], key: NOTIFICATION_KEY })
    app.journal(null, 'notify', { title, body })
  })
}
