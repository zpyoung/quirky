import { Badge, IconButton, StatusDot } from '@quirky/ui'
import { createRoot } from 'react-dom/client'
import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import { isPlainRecord } from './daemon/state'
import type { DirtyResult } from './daemon/dirty'

const SLOT_ID = 'activity-item:quirky.sidebar-extras/source-control'
const PANEL_ID = 'panel:quirky.git/source-control'
const STOCK_TITLE = 'Source Control'
const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
const STRUCTURED_VIEW_ID = 'view:quirky.session/structured'
const STRUCTURED_TARGET_PREFIX = 'session:'
const REFRESH_EVENTS: Readonly<Partial<Record<string, true>>> = {
  'ui.state.changed': true,
  'quirky.git/changed': true,
  'quirky.worktree/changed': true,
  'quirky.repo/changed': true,
  'quirky.session/changed': true,
  'quirky.session/removed': true,
  'quirky.agent-status/changed': true,
  'quirky.structured/message': true,
  'setting.changed': true
}

function layoutWorktree(layout: UiLayout): string | null {
  const view = layout.view
  if (view?.id === WORKTREE_VIEW_ID && isPlainRecord(view.input)) {
    const worktree = view.input.worktree
    return typeof worktree === 'string' && worktree.length > 0 ? worktree : null
  }
  if (view?.id === STRUCTURED_VIEW_ID && isPlainRecord(view.input)) {
    const session = view.input.session
    return typeof session === 'string' && session.length > 0 ? `${STRUCTURED_TARGET_PREFIX}${session}` : null
  }
  return null
}

function parseDirtyResult(value: unknown): DirtyResult {
  if (!isPlainRecord(value) ||
    (value.worktreeId !== null && typeof value.worktreeId !== 'string') ||
    !Number.isSafeInteger(value.count) || (value.count as number) < 0 ||
    typeof value.capped !== 'boolean' || typeof value.title !== 'string' ||
    typeof value.dirty !== 'boolean' || typeof value.available !== 'boolean' ||
    (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('sidebar-extras returned an invalid dirty status')
  }
  return value as unknown as DirtyResult
}

function reportValue(status: DirtyResult): Record<string, unknown> {
  return {
    worktreeId: status.worktreeId,
    count: status.count,
    capped: status.capped,
    title: status.title,
    dirty: status.dirty,
    available: status.available,
    ...(status.error === undefined ? {} : { error: status.error })
  }
}

function unavailable(worktreeId: string | null, error: unknown): DirtyResult {
  return {
    worktreeId,
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    dirty: false,
    available: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

function BranchIcon() {
  return createElement(
    'svg',
    { width: '1em', height: '1em', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    createElement('path', {
      d: 'M5 3.5v8.9M5 7.8h4.2a2.3 2.3 0 0 0 2.3-2.3V3.5',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round'
    }),
    createElement('circle', { cx: 5, cy: 3.5, r: 1.7, stroke: 'currentColor', strokeWidth: 1.3 }),
    createElement('circle', { cx: 5, cy: 12.5, r: 1.7, stroke: 'currentColor', strokeWidth: 1.3 }),
    createElement('circle', { cx: 11.5, cy: 3.5, r: 1.7, stroke: 'currentColor', strokeWidth: 1.3 })
  )
}

function ActivityButton({ context, status }: { context: UiPluginContext; status: DirtyResult | null }) {
  const title = status?.title ?? STOCK_TITLE
  const label = status?.available === false && status.error
    ? `${title} — status unavailable: ${status.error}`
    : title
  const statusKind = status === null || (status.available && status.worktreeId === null)
    ? 'idle'
    : !status.available
      ? 'failing'
      : status.dirty
        ? 'needs-you'
        : 'done'
  const statusLabel = status === null
    ? 'Source Control status loading'
    : !status.available
      ? 'Source Control status unavailable'
      : status.worktreeId === null
        ? 'No active worktree'
        : status.dirty
          ? 'Uncommitted changes are present'
          : 'No uncommitted changes'
  const count = status?.capped ? `${status.count}+` : String(status?.count ?? 0)
  return createElement(
    IconButton,
    {
      title,
      label,
      'data-available': status === null ? 'unknown' : String(status.available),
      'data-dirty': status?.available && status.dirty ? 'true' : 'false',
      onClick: () => context.togglePanel(PANEL_ID)
    },
    createElement(
      'span',
      { className: 'ui-cluster' },
      createElement(BranchIcon),
      createElement(StatusDot, { status: statusKind, label: statusLabel }),
      status?.available && status.dirty
        ? createElement(Badge, { tone: 'needs-you' }, count)
        : null
    )
  )
}

function ActivityItem({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const [status, setStatus] = useState<DirtyResult | null>(null)

  useEffect(() => {
    let disposed = false
    let latestTicket = 0
    let observedWorktree: string | null | undefined
    let queued = false
    let queuedForce = false
    let inFlight: { worktree: string | null; ticket: number } | null = null
    let pendingRefresh = false
    let pendingForce = false
    let activation: { worktree: string | null; promise: Promise<unknown> } | null = null
    let activeId: string | null = null

    const publish = (next: DirtyResult | null) => {
      if (disposed) return
      setStatus(next)
      report?.(next === null ? null : reportValue(next))
    }

    const stillCurrent = (ticket: number, worktree: string | null) =>
      !disposed && ticket === latestTicket && layoutWorktree(context.getLayout()) === worktree

    const launch = (worktree: string | null, forceActivation: boolean) => {
      const ticket = ++latestTicket
      const knownActivation = activation
      if (forceActivation || knownActivation === null || knownActivation.worktree !== worktree) {
        const promise = Promise.resolve().then(async () => {
          let selector = worktree
          if (selector?.startsWith(STRUCTURED_TARGET_PREFIX)) {
            const session = await context.call('quirky.session/get', {
              session: selector.slice(STRUCTURED_TARGET_PREFIX.length)
            })
            if (!isPlainRecord(session) || typeof session.worktreeId !== 'string') {
              throw new Error('quirky.session/get returned no canonical workspace identity')
            }
            selector = `id:${session.worktreeId}`
          }
          return context.call('quirky.sidebar-extras/activate', { worktree: selector })
        })
        activation = { worktree, promise }
      }
      const activePromise = activation!.promise
      const flight = { worktree, ticket }
      inFlight = flight

      void (async () => {
        try {
          const state = await activePromise
          if (!stillCurrent(ticket, worktree)) return
          if (!isPlainRecord(state)) throw new Error('sidebar-extras returned an invalid activation state')
          const current = state.active
          if (current === null) activeId = null
          else if (isPlainRecord(current) && typeof current.worktreeId === 'string') activeId = current.worktreeId
          else throw new Error('sidebar-extras returned an invalid active workspace')
          if (worktree !== null && activeId === null) throw new Error('sidebar-extras did not activate the layout workspace')

          const result = parseDirtyResult(await context.call('quirky.sidebar-extras/dirty'))
          if (!stillCurrent(ticket, worktree)) return
          if (result.worktreeId !== activeId) {
            publish(unavailable(activeId, new Error('daemon layout and activation identity disagree')))
            return
          }
          publish(result)
        } catch (error) {
          if (!stillCurrent(ticket, worktree)) return
          if (activation?.worktree === worktree && activation.promise === activePromise) activation = null
          publish(unavailable(activeId, error))
        } finally {
          if (inFlight === flight) {
            inFlight = null
            if (pendingRefresh) {
              const force = pendingForce
              pendingRefresh = false
              pendingForce = false
              schedule(force)
            }
          }
        }
      })()
    }

    function schedule(forceActivation = false): void {
      if (disposed) return
      queuedForce ||= forceActivation
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (disposed) return
        const force = queuedForce
        queuedForce = false
        const worktree = layoutWorktree(context.getLayout())
        const changed = observedWorktree === undefined || observedWorktree !== worktree
        if (changed) {
          observedWorktree = worktree
          activeId = null
          publish(null)
        }
        const needsActivation = force || changed
        if (inFlight?.worktree === worktree) {
          pendingRefresh = true
          pendingForce ||= needsActivation
          return
        }
        launch(worktree, needsActivation)
      })
    }

    const removeEvents = context.subscribe((event: QuirkyEvent) => {
      if (!REFRESH_EVENTS[event.type]) return
      const force = event.type === 'quirky.worktree/changed'
      if (force) {
        latestTicket += 1
        activeId = null
        publish(null)
      }
      schedule(force)
    })
    const removeLayout = context.onLayout((layout) => {
      if (observedWorktree === undefined || observedWorktree !== layoutWorktree(layout)) schedule(true)
    })
    const removeConnection = context.onConnection((connection) => {
      schedule(connection === 'connected')
    })
    const timer = setInterval(() => schedule(false), 3_000)
    schedule(true)

    return () => {
      disposed = true
      latestTicket += 1
      clearInterval(timer)
      removeEvents()
      removeLayout()
      removeConnection()
    }
  }, [context, report])

  return createElement(ActivityButton, { context, status })
}

const activeMounts = new Set<() => void>()

export function activate(context: UiPluginContext): void {
  const mount: MountFunction = (element, props) => {
    const root = createRoot(element)
    let mounted = true
    const cleanup = () => {
      if (!mounted) return
      mounted = false
      activeMounts.delete(cleanup)
      root.unmount()
    }
    activeMounts.add(cleanup)
    root.render(createElement(ActivityItem, { context, report: props.report }))
    return cleanup
  }
  context.provide(SLOT_ID, mount)
}

export function deactivate(): void {
  for (const cleanup of [...activeMounts]) cleanup()
}
