import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState, InlineError, NoticeLine, IconButton, ControlIcon, Tabs, ToolPanelFrame } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ViewRecord } from './core/contract'
import { CONTROL_COMMAND_ID, type ViewUiInstance } from './control'
import { ViewCard, errorText, eventData, useAgent } from './render/ViewCard'

export const PANE_VIEW_ID = 'view:quirky.view/pane'

/** The pane's input, untrusted until it has a `session`. */
export function parsePaneInput(input: unknown): { session: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { session } = input as { session?: unknown }
  return typeof session === 'string' && session !== '' ? { session } : null
}

function openViews(records: ViewRecord[], dismissed: Record<string, string>): ViewRecord[] {
  return records.filter((record) => record.placement === 'pane' && !record.closed && dismissed[record.viewId] !== record.updatedAt)
}

/** The Views pane of one session: a tab for each view the agent or the person put in the pane. */
export function ViewsPane({ context, session, instance }: { context: UiPluginContext; session: string; instance: ViewUiInstance }) {
  const [records, setRecords] = useState<ViewRecord[]>([])
  const recordsRef = useRef<ViewRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  const dismissedRef = useRef<Record<string, string>>({})
  const alive = useRef(true)
  const requestId = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const phase = useRef<'loading' | 'ready' | 'failed'>('loading')

  const publish = useCallback(
    (nextRecords: ViewRecord[], nextDismissed: Record<string, string>, selectedId: string | null, phase: 'loading' | 'ready' | 'failed') => {
      const open = openViews(nextRecords, nextDismissed)
      const active = open.find((record) => record.viewId === selectedId) ?? open[0]
      instance.update({
        phase,
        tabs: open.map((record) => ({ viewId: record.viewId, title: record.title })),
        activeViewId: active?.viewId ?? null
      })
    },
    [instance]
  )

  const load = useCallback(async () => {
    const request = ++requestId.current
    try {
      const next = (await context.call('quirky.view/list', { session })) as ViewRecord[]
      if (!alive.current || request !== requestId.current) return
      const previousOpen = openViews(recordsRef.current, dismissedRef.current)
      const previousActive = previousOpen.find((record) => record.viewId === activeIdRef.current) ?? previousOpen[0]
      const updatedActive = next.find((record) => record.viewId === previousActive?.viewId)
      if (JSON.stringify(previousActive?.spec) !== JSON.stringify(updatedActive?.spec)) instance.update({ pendingLink: null })
      phase.current = 'ready'
      recordsRef.current = next
      setRecords(next)
      setLoaded(true)
      setFailure(null)
      publish(next, dismissedRef.current, activeIdRef.current, phase.current)
    } catch (error) {
      if (alive.current && request === requestId.current) {
        phase.current = 'failed'
        setLoaded(true)
        setFailure(errorText(error))
        instance.update({ phase: phase.current })
      }
      throw error
    }
  }, [context, instance, publish, session])

  const selectTab = useCallback(
    (viewId: string) => {
      const open = openViews(recordsRef.current, dismissedRef.current)
      if (!open.some((record) => record.viewId === viewId)) throw new Error('View is not an open pane tab.')
      activeIdRef.current = viewId
      setActiveId(viewId)
      instance.update({ activeViewId: viewId })
    },
    [instance]
  )

  const dismissTab = useCallback(
    (viewId: string) => {
      const open = openViews(recordsRef.current, dismissedRef.current)
      const record = open.find((candidate) => candidate.viewId === viewId)
      if (!record) throw new Error('View is not an open pane tab.')
      const nextDismissed = { ...dismissedRef.current, [viewId]: record.updatedAt }
      dismissedRef.current = nextDismissed
      setDismissed(nextDismissed)
      publish(recordsRef.current, nextDismissed, activeIdRef.current, phase.current)
    },
    [publish]
  )

  useEffect(() => {
    alive.current = true
    recordsRef.current = []
    activeIdRef.current = null
    dismissedRef.current = {}
    phase.current = 'loading'
    setRecords([])
    setActiveId(null)
    setDismissed({})
    setLoaded(false)
    setFailure(null)
    setLink(null)
    instance.update({ phase: 'loading', activeViewId: null, tabs: [], pendingLink: null })
    instance.setHandlers({ refresh: load, selectTab, dismissTab, previewLink: setLink, cancelLink: () => setLink(null) })
    void load().catch(() => {})
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (eventData(event, 'quirky.view/changed')?.sessionId === session) void load().catch(() => {})
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load().catch(() => {})
    })
    return () => {
      alive.current = false
      ++requestId.current
      instance.clearHandlers('refresh', 'selectTab', 'dismissTab', 'previewLink', 'cancelLink')
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, dismissTab, instance, load, selectTab, session])

  const open = openViews(records, dismissed)
  const active = open.find((record) => record.viewId === activeId) ?? open[0]
  const agent = useAgent(context, active?.sessionId)
  const retry = () => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'refresh' }, { activateOwner: false }).catch(() => {})
  }

  const runControl = (action: 'select-tab' | 'dismiss-tab', viewId: string): void => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action, viewId }, { activateOwner: false }).catch((error: unknown) => {
      context.log(`could not ${action === 'select-tab' ? 'select' : 'dismiss'} view tab: ${errorText(error)}`)
    })
  }

  return (
    <ToolPanelFrame
      title="Views"
      tabs={active && <Tabs label="Views" items={open.map((record) => ({ id: record.viewId, label: record.title }))} value={active.viewId} onChange={(viewId) => runControl('select-tab', viewId)} />}
      actions={active && (
        <IconButton label={`Close ${active.title}`} onClick={() => runControl('dismiss-tab', active.viewId)}>
          <ControlIcon name="x" />
        </IconButton>
      )}
    >
      {!loaded && <NoticeLine>Loading views…</NoticeLine>}
      {failure !== null && <InlineError message={`Could not load views: ${failure}`} action={{ label: 'Retry', onAction: retry }} />}
      {loaded && failure === null && !active && <EmptyState message="No views in the pane." />}
      {active && <ViewCard key={active.viewId} context={context} instance={instance} record={active} link={link} agent={agent} framed={false} inPane />}
    </ToolPanelFrame>
  )
}
