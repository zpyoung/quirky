import { useEffect, useState } from 'react'
import type { GitStatus, UiPluginContext } from '@quirky/protocol'
import { StatusBarItem, ToolIcon, CONTEXT_MENU_SEPARATOR, type PopupItem } from '@quirky/ui'
import { PANEL_ID } from './shared/view-input'
import { worktreeOf } from './scm'

/** The longest the status bar waits between reads of `quirky.git/status` while it is mounted. */
export const STATUS_BAR_POLL_MS = 10_000

const plural = (count: number) => `${count} commit${count === 1 ? '' : 's'}`

/** The branch's upstream tracking for `worktree`, null while unread or when it has no upstream. */
function useTracking(context: UiPluginContext, worktree: string | null): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  useEffect(() => {
    setStatus(null)
    if (worktree === null) return
    let alive = true
    let ticket = 0
    let reading = false
    let again = false
    const read = async () => {
      if (reading) {
        again = true
        return
      }
      reading = true
      const mine = ++ticket
      try {
        const next = (await context.call('quirky.git/status', { worktree })) as GitStatus
        if (alive && mine === ticket) setStatus(next.upstream ? next : null)
      } catch {
        if (alive && mine === ticket) setStatus(null)
      } finally {
        reading = false
        if (again && alive) {
          again = false
          void read()
        }
      }
    }
    void read()
    const timer = setInterval(() => void read(), STATUS_BAR_POLL_MS)
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.git/changed') return
      const id = (event.data as { worktreeId?: unknown } | undefined)?.worktreeId
      if (typeof id !== 'string' || id === worktree) void read()
    })
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [context, worktree])
  return status
}

/** "↑N ↓M" for the selected worktree's branch against its upstream; absent without an upstream. */
export function AheadBehind({ context }: { context: UiPluginContext }) {
  const [layout, setLayout] = useState(() => context.getLayout())
  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])
  const status = useTracking(context, worktreeOf(layout))
  if (!status?.upstream) return null

  const open = () => context.togglePanel(PANEL_ID, true)
  const items: PopupItem[] = [
    { label: 'Ahead', subtitle: `${plural(status.ahead)} to push to ${status.upstream}`, onSelect: open },
    { label: 'Behind', subtitle: `${plural(status.behind)} to pull from ${status.upstream}`, onSelect: open },
    CONTEXT_MENU_SEPARATOR,
    { label: 'Open the Changes panel', lead: <ToolIcon name="git-diff" hue="azure" />, onSelect: open }
  ]
  return (
    <StatusBarItem label={`${plural(status.ahead)} ahead, ${plural(status.behind)} behind`} popupTitle={status.branch ?? 'Detached HEAD'} items={items}>
      <span>↑{status.ahead} ↓{status.behind}</span>
    </StatusBarItem>
  )
}
