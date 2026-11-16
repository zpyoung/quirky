import { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton, ControlIcon, Tabs, ToolPanelFrame } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ViewRecord } from './core/catalog'
import { ViewCard, errorText, eventData, useAgent } from './render/ViewCard'

export const PANE_VIEW_ID = 'view:quirky.view/pane'

/** The pane's input, untrusted until it has a `session`. */
export function parsePaneInput(input: unknown): { session: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { session } = input as { session?: unknown }
  return typeof session === 'string' && session !== '' ? { session } : null
}

/**
 * The Views pane of one session: a tab for each view the agent or the person put in the pane.
 * Close hides a tab until the view changes again, and with no tabs the pane draws nothing.
 */
export function ViewsPane({ context, session }: { context: UiPluginContext; session: string }) {
  const [records, setRecords] = useState<ViewRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = (await context.call('quirky.view/list', { session })) as ViewRecord[]
      if (alive.current) setRecords(next)
    } catch (error) {
      context.log(`could not load the views of session ${session}: ${errorText(error)}`)
    }
  }, [context, session])

  useEffect(() => {
    alive.current = true
    void load()
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (eventData(event, 'quirky.view/changed')?.sessionId === session) void load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load()
    })
    return () => {
      alive.current = false
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, session, load])

  const open = records.filter((record) => record.placement === 'pane' && !record.closed && dismissed[record.viewId] !== record.updatedAt)
  const active = open.find((record) => record.viewId === activeId) ?? open[0]
  const agent = useAgent(context, active?.sessionId)
  if (!active) return null

  return (
    <ToolPanelFrame
      title="Views"
      tabs={<Tabs label="Views" items={open.map((record) => ({ id: record.viewId, label: record.title }))} value={active.viewId} onChange={setActiveId} />}
      actions={
        <IconButton label={`Close ${active.title}`} onClick={() => setDismissed({ ...dismissed, [active.viewId]: active.updatedAt })}>
          <ControlIcon name="x" />
        </IconButton>
      }
    >
      <ViewCard key={active.viewId} context={context} record={active} agent={agent} framed={false} inPane />
    </ToolPanelFrame>
  )
}
