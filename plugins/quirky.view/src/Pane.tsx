import { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton, ControlIcon, Tabs, ToolPanelFrame } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ViewRecord } from './core/contract'
import { CONTROL_COMMAND_ID, runViewUiCommand, type ViewUiInstance } from './control'
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
  const phase = useRef<'loading' | 'ready' | 'failed'>('loading')

  const publish = useCallback(
    (nextRecords: ViewRecord[], nextDismissed: Record<string, string>, selectedId: string | null, phase: 'ready' | 'failed') => {
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
    try {
      const next = (await context.call('quirky.view/list', { session })) as ViewRecord[]
      if (alive.current) {
        phase.current = 'ready'
        recordsRef.current = next
        setRecords(next)
        publish(next, dismissedRef.current, activeIdRef.current, phase.current)
      }
    } catch (error) {
      if (alive.current) {
        phase.current = 'failed'
        instance.update({ phase: phase.current })
      }
      context.log(`could not load the views of session ${session}: ${errorText(error)}`)
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
    instance.setHandlers({ refresh: load, selectTab, dismissTab })
    void load()
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (eventData(event, 'quirky.view/changed')?.sessionId === session) void load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load()
    })
    return () => {
      alive.current = false
      instance.clearHandlers('refresh', 'selectTab', 'dismissTab')
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, dismissTab, instance, load, selectTab, session])

  const open = openViews(records, dismissed)
  const active = open.find((record) => record.viewId === activeId) ?? open[0]
  const agent = useAgent(context, active?.sessionId)
  if (!active) return null

  const runControl = (action: 'select-tab' | 'dismiss-tab', viewId: string): void => {
    void runViewUiCommand(context, CONTROL_COMMAND_ID, { instance: instance.id, action, viewId }).catch((error: unknown) => {
      context.log(`could not ${action === 'select-tab' ? 'select' : 'dismiss'} view tab: ${errorText(error)}`)
    })
  }

  return (
    <ToolPanelFrame
      title="Views"
      tabs={<Tabs label="Views" items={open.map((record) => ({ id: record.viewId, label: record.title }))} value={active.viewId} onChange={(viewId) => runControl('select-tab', viewId)} />}
      actions={
        <IconButton label={`Close ${active.title}`} onClick={() => runControl('dismiss-tab', active.viewId)}>
          <ControlIcon name="x" />
        </IconButton>
      }
    >
      <ViewCard key={active.viewId} context={context} instance={instance} record={active} agent={agent} framed={false} inPane />
    </ToolPanelFrame>
  )
}
