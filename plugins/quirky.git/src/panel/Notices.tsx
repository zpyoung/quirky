import { Toast } from '@quirky/ui'
import { useEffect, useState } from 'react'

/** A button on a notice. After `expiresMs` it is withdrawn and only Dismiss remains. */
export type NoticeAction = { label: string; run(): void; expiresMs?: number }

/**
 * A toast for a failed row action, with a Retry button that expires. Showing a notice whose `id`
 * is already shown replaces it; `worktree` is the one it is about.
 */
export type Notice = {
  id: string
  worktree: string
  title: string
  body?: string
  actions: NoticeAction[]
}

type Shown = Notice & { seq: number }

/** A notice leaves on its own once its Retry has had time to expire. */
const NOTICE_MS = 12_000

function NoticeCard({ notice, away, onDismiss }: { notice: Shown; away: boolean; onDismiss(): void }) {
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const timers = notice.actions.flatMap((action) =>
      action.expiresMs === undefined
        ? []
        : [setTimeout(() => setExpired((prev) => new Set(prev).add(action.label)), action.expiresMs)]
    )
    return () => timers.forEach(clearTimeout)
  }, [notice])
  const action = notice.actions.find((candidate) => !expired.has(candidate.label))
  const status = notice.title.startsWith('Failed') ? 'failing' : 'needs-you'
  return (
    <Toast
      title={away ? `${notice.title} in ${notice.worktree}` : notice.title}
      description={notice.body}
      status={status}
      durationMs={NOTICE_MS}
      action={!away && action !== undefined ? { label: action.label, onAction: action.run } : undefined}
      onDismiss={onDismiss}
    />
  )
}

/** The notices on show, newest last. A notice for a worktree other than `current` loses its buttons. */
export function Notices({ notices, current, onDismiss }: { notices: Shown[]; current: string | null; onDismiss(id: string): void }) {
  if (notices.length === 0) return null
  return (
    <div
      className="ui-stack"
      role="region"
      aria-label="Source control notices"
      style={{ position: 'absolute', insetBlockEnd: 0, insetInlineEnd: 0, maxWidth: '100%', maxHeight: '100%', overflowY: 'auto', zIndex: 1 }}
    >
      {notices.map((notice) => (
        <NoticeCard key={notice.seq} notice={notice} away={notice.worktree !== current} onDismiss={() => onDismiss(notice.id)} />
      ))}
    </div>
  )
}

/** The notice list with replace-by-id semantics. */
export function addNotice(list: Shown[], notice: Notice, seq: number): Shown[] {
  return [...list.filter((n) => n.id !== notice.id), { ...notice, seq }]
}

export type { Shown as ShownNotice }
