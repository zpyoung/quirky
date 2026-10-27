import { useEffect, useState } from 'react'

/** A button on a notice. After `expiresMs` it is withdrawn and only Dismiss remains. */
export type NoticeAction = { label: string; run(): void; expiresMs?: number }

/**
 * A message pinned to the bottom of the panel. Showing a notice whose `id` is already shown
 * replaces it; `worktree` is the one it is about.
 */
export type Notice = {
  id: string
  worktree: string
  title: string
  body?: string
  actions: NoticeAction[]
}

type Shown = Notice & { seq: number }

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
  return (
    <div className="notice" role="status">
      <p className="notice-text">
        <strong>{away ? `${notice.title} in ${notice.worktree}` : notice.title}</strong>
        {notice.body ? ` ${notice.body}` : ''}
      </p>
      <div className="notice-actions">
        {!away &&
          notice.actions
            .filter((action) => !expired.has(action.label))
            .map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  onDismiss()
                  action.run()
                }}
              >
                {action.label}
              </button>
            ))}
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** The notices of the panel, newest last. A notice for a worktree other than `current` loses its buttons. */
export function Notices({ notices, current, onDismiss }: { notices: Shown[]; current: string | null; onDismiss(id: string): void }) {
  if (notices.length === 0) return null
  return (
    <div className="notices">
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
