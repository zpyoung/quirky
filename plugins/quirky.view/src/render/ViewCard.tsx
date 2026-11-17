import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, Dialog, EmptyState, InlineError, NoticeLine } from '@quirky/ui'
import { RpcErrorCode, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import type { ViewPlacement, ViewRecord } from '../core/contract'
import { RenderNode } from './RenderNode'
import { RuntimeContext, type ViewRuntime } from './runtime'
import { ACTION_COMMAND_ID, CONTROL_COMMAND_ID, MOVE_COMMAND_ID, runViewUiCommand, type ViewUiInstance } from '../control'
import { COLUMN, MONO, MUTED, ROW } from './styles'

export const RENDER_VIEW_ID = 'view:quirky.view/render'

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The `data` of a daemon event of `type`, or undefined for any other event. */
export function eventData(event: QuirkyEvent, type: string): Record<string, unknown> | undefined {
  if (event.type !== type || !('data' in event)) return undefined
  const data = event.data as unknown
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
}

/** The agent that runs `sessionId`, for the "by <agent>" tag; undefined until it is known or when the session is gone. */
export function useAgent(context: UiPluginContext, sessionId: string | undefined): string | undefined {
  const [agent, setAgent] = useState<{ sessionId: string; agent: string } | undefined>()
  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    void (async () => {
      try {
        const session = (await context.call('quirky.session/get', { session: sessionId })) as { agent?: unknown } | null
        if (alive && typeof session?.agent === 'string') setAgent({ sessionId, agent: session.agent })
      } catch (error) {
        context.log(`could not read session ${sessionId}: ${errorText(error)}`)
      }
    })()
    return () => {
      alive = false
    }
  }, [context, sessionId])
  return agent !== undefined && agent.sessionId === sessionId ? agent.agent : undefined
}

/** "updated N times · HH:MM" for an updated view; the time is local. */
export function updatedLabel(record: Pick<ViewRecord, 'updates' | 'updatedAt'>): string | undefined {
  if (record.updates <= 0) return undefined
  const at = new Date(record.updatedAt)
  const clock = Number.isNaN(at.getTime()) ? '' : ` · ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `updated ${record.updates} ${record.updates === 1 ? 'time' : 'times'}${clock}`
}

const FRAME: CSSProperties = {
  ...COLUMN,
  padding: 'var(--ui-space-12)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)'
}

const TITLE: CSSProperties = { margin: 0, fontSize: 'var(--ui-font-body)', fontWeight: 600, overflowWrap: 'anywhere' }

const RECORD: CSSProperties = { ...MUTED, margin: 0, padding: 'var(--ui-space-6) var(--ui-space-12)', overflowWrap: 'anywhere' }

type Props = {
  context: UiPluginContext
  instance: ViewUiInstance
  record: ViewRecord
  agent?: string
  /** Draws the card's own border; the pane already has a frame. */
  framed?: boolean
  /** True inside the Views pane, where a pane view shows its content. */
  inPane?: boolean
}

/**
 * One view: its title, the "by <agent>" tag, the content, and the control that moves it between
 * the transcript and the Views pane. Buttons and fields send actions to the agent, and a markdown
 * link asks before it opens.
 */
export function ViewCard({ context, instance, record, agent, framed = true, inPane = false }: Props) {
  const { viewId } = record
  const [link, setLink] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const cardIdentity = `${viewId}\u0000${record.placement}\u0000${record.closed}\u0000${JSON.stringify(record.spec)}`
  const cardIdentityRef = useRef(cardIdentity)

  useEffect(() => {
    if (!record.closed && (record.placement !== 'pane' || inPane)) {
      instance.setHandlers({ previewLink: setLink, cancelLink: () => setLink(null) })
    }
    return () => {
      instance.clearHandlers('previewLink', 'cancelLink')
      instance.update({ pendingLink: null })
    }
  }, [inPane, instance, record.closed, record.placement])

  useEffect(() => {
    if (cardIdentityRef.current !== cardIdentity) {
      cardIdentityRef.current = cardIdentity
      setLink(null)
      instance.update({ pendingLink: null })
    }
  }, [cardIdentity, instance])

  const runtime = useMemo<ViewRuntime>(
    () => ({
      send: async (name, source, data) => {
        try {
          await runViewUiCommand(context, ACTION_COMMAND_ID, { viewId, name, source, ...(data === undefined ? {} : { data }) })
          return true
        } catch (error) {
          context.toast('Could not send the action', errorText(error))
          return false
        }
      },
      openLink: (href) => {
        void runViewUiCommand(context, CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-preview', viewId, href }).catch((error: unknown) => {
          context.toast('Could not open link', errorText(error))
        })
      }
    }),
    [context, instance, viewId]
  )

  const target: ViewPlacement = record.placement === 'pane' ? 'inline' : 'pane'
  const move = async () => {
    setMoving(true)
    try {
      await runViewUiCommand(context, MOVE_COMMAND_ID, { viewId, placement: target })
    } catch (error) {
      context.toast('Could not move the view', errorText(error))
    } finally {
      setMoving(false)
    }
  }

  const cancelLink = () => {
    void runViewUiCommand(context, CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-cancel', viewId }).catch((error: unknown) => {
      context.toast('Could not open link', errorText(error))
    })
  }

  const confirmLink = async () => {
    try {
      await runViewUiCommand(context, CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-confirm', viewId })
    } catch (error) {
      context.toast('Could not open link', errorText(error))
    }
  }

  if (record.closed) {
    return <div data-view-record={viewId} role="status" style={RECORD}><NoticeLine>{record.title} closed</NoticeLine></div>
  }

  if (record.placement === 'pane' && !inPane) {
    return (
      <div data-view-record={viewId} role="status" style={RECORD}>
        <NoticeLine actions={[{ label: 'Move inline', disabled: moving, onAction: () => void move() }]}>
          {record.title} is in the Views pane
        </NoticeLine>
      </div>
    )
  }

  const updated = updatedLabel(record)
  return (
    <article data-view-card={viewId} aria-label={record.title} style={framed ? FRAME : COLUMN}>
      <header style={{ ...ROW, justifyContent: 'space-between' }}>
        <div style={ROW}>
          <h3 style={TITLE}>{record.title}</h3>
          {agent !== undefined && <Badge>by {agent}</Badge>}
        </div>
        <div style={ROW}>
          {updated !== undefined && <span data-view-updated style={MUTED}>{updated}</span>}
          <Button disabled={moving} onClick={() => void move()}>{target === 'pane' ? 'Move to pane' : 'Move inline'}</Button>
        </div>
      </header>
      <RuntimeContext.Provider value={runtime}>
        <RenderNode node={record.spec.root} />
      </RuntimeContext.Provider>
      <Dialog
        open={link !== null}
        title="Open this link?"
        onClose={cancelLink}
        actions={
          <>
            <Button onClick={cancelLink}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmLink()}>Open link</Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>This view links to a page outside Quirky. It opens in your browser.</p>
        <p style={{ ...MONO, overflowWrap: 'anywhere' }}>{link}</p>
      </Dialog>
    </article>
  )
}

/** Loads the view `viewId` and keeps it fresh: reloaded when the daemon reports a change to it and when the connection returns. */
export function ViewCardView({ context, instance, viewId }: { context: UiPluginContext; instance: ViewUiInstance; viewId: string }) {
  const [record, setRecord] = useState<ViewRecord | null>(null)
  const recordRef = useRef<ViewRecord | null>(null)
  const alive = useRef(true)
  const requestId = useRef(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'missing'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(async () => {
    const request = ++requestId.current
    try {
      const next = (await context.call('quirky.view/get', { viewId })) as ViewRecord | null | undefined
      if (!alive.current || request !== requestId.current) return
      recordRef.current = next ?? null
      setRecord(next ?? null)
      setFailure(null)
      const nextPhase = next ? 'ready' : 'missing'
      setPhase(nextPhase)
      instance.update({ phase: nextPhase, activeViewId: next?.viewId ?? null })
    } catch (error) {
      if (!alive.current || request !== requestId.current) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.NotFound) {
        recordRef.current = null
        setRecord(null)
        setFailure(null)
        setPhase('missing')
        instance.update({ phase: 'missing', activeViewId: null })
        return
      }
      setPhase('failed')
      setFailure(errorText(error))
      instance.update({ phase: 'failed', activeViewId: recordRef.current?.viewId ?? null })
      throw error
    }
  }, [context, instance, viewId])

  useEffect(() => {
    alive.current = true
    recordRef.current = null
    setRecord(null)
    setPhase('loading')
    setFailure(null)
    instance.update({ phase: 'loading', activeViewId: null, tabs: [], pendingLink: null })
    instance.setHandlers({ refresh: load })
    void load().catch(() => {})
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (eventData(event, 'quirky.view/changed')?.viewId === viewId) void load().catch(() => {})
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load().catch(() => {})
    })
    return () => {
      alive.current = false
      ++requestId.current
      instance.clearHandlers('refresh')
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, instance, viewId, load])

  const agent = useAgent(context, record?.sessionId)
  const retry = () => {
    void runViewUiCommand(context, CONTROL_COMMAND_ID, { instance: instance.id, action: 'refresh' }).catch(() => {})
  }
  if (phase === 'loading') return <NoticeLine>Loading view…</NoticeLine>
  if (phase === 'missing') return <EmptyState message="This view is no longer available." />
  return (
    <>
      {failure !== null && <InlineError message={`Could not load view: ${failure}`} action={{ label: 'Retry', onAction: retry }} />}
      {record && <ViewCard context={context} instance={instance} record={record} agent={agent} />}
    </>
  )
}

/** Reads the view input, which is untrusted until it has a `viewId`. */
export function parseRenderInput(input: unknown): { viewId: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { viewId } = input as { viewId?: unknown }
  return typeof viewId === 'string' && viewId !== '' ? { viewId } : null
}
