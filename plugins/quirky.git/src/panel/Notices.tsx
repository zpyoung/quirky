import { Toast } from '@quirky/ui'
import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { newGitUiGeneration, requestGitUiControl, useGitUiControl } from '../ui-control'
import { PANEL_ID } from '../shared/view-input'
import { messageOf } from './format'

/** A button on a notice. After `expiresMs` it is withdrawn and only Dismiss remains. */
export type NoticeAction = { label: string; run(): void; expiresMs?: number; available?(): boolean }

/**
 * A toast for a failed row action, with a Retry button that expires. Showing a notice whose `id`
 * is already shown replaces it; `worktree` is the one it is about.
 */
export type Notice = {
  id: string
  worktree: string
  title: string
  body?: string
  status?: 'failing' | 'needs-you'
  actions: NoticeAction[]
}

type Shown = Notice & { seq: number; createdAt: number; expiresAt: number }

/** A notice leaves on its own once its Retry has had time to expire. */
const NOTICE_MS = 12_000

function NoticeCard({ context, notice, current, remove }: { context: UiPluginContext; notice: Shown; current: string | null; remove(): void }) {
  const [generation] = useState(newGitUiGeneration)
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set())
  const alive = useRef(true)
  const consumed = useRef(false)
  const skipAutomaticDismiss = useRef(false)
  const ownership = useRef({ worktree: current, epoch: 0 })
  if (ownership.current.worktree !== current) ownership.current = { worktree: current, epoch: ownership.current.epoch + 1 }
  const away = notice.worktree !== current
  const live = useRef({ notice, away, remove })
  live.current = { notice, away, remove }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    const timers = notice.actions.flatMap((action) => action.expiresMs === undefined
      ? []
      : [setTimeout(() => setExpired((prev) => new Set(prev).add(action.label)), action.expiresMs)])
    return () => timers.forEach(clearTimeout)
  }, [notice])
  const target = `notice:${notice.id}`
  function available(action: NoticeAction): boolean {
    return (action.expiresMs === undefined || Date.now() < notice.createdAt + action.expiresMs) && action.available?.() !== false
  }
  function currentNotice(): boolean {
    return alive.current && !consumed.current && Date.now() < notice.expiresAt
  }
  const action = notice.actions.find((candidate) => !expired.has(candidate.label) && available(candidate))
  const actions = ['dismiss', ...(!away && action ? ['run'] : [])]
  useGitUiControl(context, { surface: PANEL_ID, target, generation, actions }, (control) => {
    if (!currentNotice()) return false
    const data = control.data ?? {}
    if (control.action === 'dismiss') {
      if (Object.keys(data).length !== 0) return false
      consumed.current = true
      live.current.remove()
      return true
    }
    if (control.action !== 'run' || live.current.away || typeof data.label !== 'string' || Object.keys(data).some((key) => key !== 'label')) return false
    const chosen = live.current.notice.actions.find((candidate) => candidate.label === data.label && available(candidate))
    if (!chosen || expired.has(chosen.label)) return false
    consumed.current = true
    live.current.remove()
    chosen.run()
    return true
  })
  function postNoticeControl(action: string, data?: Record<string, unknown>): void {
    const owner = ownership.current
    void requestGitUiControl(context, { surface: PANEL_ID, target, generation, action, ...(data === undefined ? {} : { data }) })
      .then((result) => {
        if (!result.delivered) throw new Error('The source control action is no longer available.')
      })
      .catch((error: unknown) => {
        if (ownership.current === owner && currentNotice()) context.toast('Could not run Source Control action', messageOf(error), { kind: 'error' })
      })
  }
  function runNoticeAction(label: string): void {
    skipAutomaticDismiss.current = true
    postNoticeControl('run', { label })
  }
  function dismissNotice(): void {
    if (skipAutomaticDismiss.current) {
      skipAutomaticDismiss.current = false
      return
    }
    if (!alive.current || consumed.current) return
    if (Date.now() >= notice.expiresAt) {
      consumed.current = true
      live.current.remove()
    } else postNoticeControl('dismiss')
  }
  return (
    <Toast
      title={away ? `${notice.title} in ${notice.worktree}` : notice.title}
      description={notice.body}
      status={notice.status ?? 'needs-you'}
      durationMs={NOTICE_MS}
      action={!away && action !== undefined ? { label: action.label, onAction: () => runNoticeAction(action.label) } : undefined}
      onDismiss={dismissNotice}
    />
  )
}

/** The notices on show, newest last. A notice for a worktree other than `current` loses its buttons. */
export function Notices({ context, notices, current, remove }: { context: UiPluginContext; notices: Shown[]; current: string | null; remove(id: string, seq: number): void }) {
  if (notices.length === 0) return null
  return (
    <div
      className="ui-stack"
      role="region"
      aria-label="Source control notices"
      style={{ position: 'absolute', insetBlockEnd: 0, insetInlineEnd: 0, maxWidth: '100%', maxHeight: '100%', overflowY: 'auto', zIndex: 1 }}
    >
      {notices.map((notice) => (
        <NoticeCard key={notice.seq} context={context} notice={notice} current={current} remove={() => remove(notice.id, notice.seq)} />
      ))}
    </div>
  )
}

/** The notice list with replace-by-id semantics. */
export function addNotice(list: Shown[], notice: Notice, seq: number): Shown[] {
  const createdAt = Date.now()
  return [...list.filter((n) => n.id !== notice.id), { ...notice, seq, createdAt, expiresAt: createdAt + NOTICE_MS }]
}

export type { Shown as ShownNotice }
