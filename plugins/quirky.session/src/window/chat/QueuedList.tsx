import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { AgentCapabilities, QueuedMessage, Session, UiPluginContext } from '@quirky/protocol'
import { Button, IconButton, ControlIcon, ListRow } from '@quirky/ui'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A message the user steered: handed to the agent, shown until it appears in the transcript. */
export type SteeredMessage = { id: string; text: string }

/** The session's queued messages, oldest first, kept live by `queueChanged`. */
export function useQueue(context: UiPluginContext, session: string): QueuedMessage[] {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  useEffect(() => {
    let cancelled = false
    let latest = 0
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.structured/queue', { session })
        .then((loaded) => {
          if (!cancelled && attempt === latest) setQueue(loaded as QueuedMessage[])
        })
        .catch(() => {})
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.structured/queueChanged') return
      const data = event.data as { sessionId?: string; queue?: QueuedMessage[] } | undefined
      if (data?.sessionId !== session || !Array.isArray(data.queue) || cancelled) return
      latest++
      setQueue(data.queue)
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    setQueue([])
    load()
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, session])
  return queue
}

const list = {
  display: 'flex',
  flexDirection: 'column',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderBottom: 'none',
  borderRadius: 'var(--ui-radius-window) var(--ui-radius-window) 0 0',
  background: 'var(--ui-selected)',
  overflow: 'hidden'
} satisfies CSSProperties

const item = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-4)', paddingInline: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const grow = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const handle = { color: 'var(--ui-muted)', cursor: 'grab', background: 'none', border: 'none', padding: 0, letterSpacing: 'calc(-1 * var(--ui-space-2))' } satisfies CSSProperties
const pending = { color: 'var(--ui-accent)', whiteSpace: 'nowrap' } satisfies CSSProperties
const note = { color: 'var(--ui-muted)', whiteSpace: 'nowrap' } satisfies CSSProperties
const actions = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)' } satisfies CSSProperties

type Props = {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  queue: QueuedMessage[]
  steered?: SteeredMessage[]
  working: boolean
  /** An ended session's leftover messages: shown with Delete only. */
  readOnly?: boolean
  /** Moves a queued message back into the editor. */
  onEdit?: (entry: QueuedMessage) => void
  /** Called once a queued message was handed to the agent by Steer now. */
  onSteered?: (entry: QueuedMessage) => void
  onError: (message: string) => void
}

/**
 * The rows attached above the composer card. While the agent works a row offers Steer now, Edit and
 * Delete and can be dragged to reorder; once it is idle the row offers Send next instead. An ended
 * session's rows are read-only. Steer is disabled with the capability's reason when unsupported.
 */
export function QueuedList({ context, session, capabilities, queue, steered = [], working, readOnly = false, onEdit, onSteered, onError }: Props) {
  const [dragging, setDragging] = useState<string | null>(null)

  const act = async (request: () => Promise<unknown>) => {
    try {
      await request()
    } catch (error) {
      onError(`Could not update the queue: ${messageOf(error)}`)
    }
  }

  const reorder = (id: string, target: number) => {
    const ids = queue.map((entry) => entry.id)
    const from = ids.indexOf(id)
    if (from < 0 || target < 0 || target >= ids.length || from === target) return
    ids.splice(from, 1)
    ids.splice(target, 0, id)
    void act(() => context.call('quirky.structured/reorderQueued', { session: session.id, ids }))
  }

  const onHandleKey = (event: KeyboardEvent, id: string, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    reorder(id, index + (event.key === 'ArrowUp' ? -1 : 1))
  }

  if (queue.length === 0 && steered.length === 0) return null

  const steer = capabilities?.steer
  const steerReason = steer === undefined ? 'Loading capabilities' : steer.ok ? undefined : steer.reason
  const remove = (entry: QueuedMessage) => act(() => context.call('quirky.structured/dequeue', { session: session.id, id: entry.id }))

  return (
    <ul style={list} aria-label="Queued messages">
      {steered.map((entry) => (
        <li key={entry.id} style={item} data-steered="">
          <span style={grow}>
            <ListRow compact title={entry.text} trailing={<span style={pending}>Steering · waiting for next tool call</span>} />
          </span>
        </li>
      ))}
      {queue.map((entry, index) => (
        <li
          key={entry.id}
          style={{ ...item, opacity: dragging === entry.id ? 0.5 : undefined }}
          draggable={!readOnly}
          onDragStart={(event) => {
            setDragging(entry.id)
            event.dataTransfer?.setData('text/plain', entry.id)
          }}
          onDragOver={(event) => {
            if (dragging !== null) event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            if (dragging !== null) reorder(dragging, index)
            setDragging(null)
          }}
          onDragEnd={() => setDragging(null)}
        >
          {!readOnly && (
            <button type="button" style={handle} aria-label="Reorder queued message (drag, or Up and Down arrows)" title="Drag to reorder" onKeyDown={(event) => onHandleKey(event, entry.id, index)}>
              ⋮⋮
            </button>
          )}
          <span style={grow}>
            <ListRow
              compact
              title={entry.text}
              trailing={
                <span style={actions}>
                  {readOnly ? (
                    <span style={note}>Queued · runs on Resume</span>
                  ) : (
                    <>
                      {working ? (
                        <Button
                          disabled={steerReason !== undefined}
                          title={steerReason}
                          onClick={() => void act(() => context.call('quirky.structured/steer', { session: session.id, id: entry.id }).then(() => onSteered?.(entry)))}
                        >
                          Steer now
                        </Button>
                      ) : (
                        <Button onClick={() => void act(() => context.call('quirky.structured/sendQueued', { session: session.id, id: entry.id }))}>Send next</Button>
                      )}
                      <Button aria-label="Edit queued message" onClick={() => onEdit?.(entry)}>Edit</Button>
                    </>
                  )}
                  <IconButton label="Delete queued message" onClick={() => void remove(entry)}>
                    <ControlIcon name="x" />
                  </IconButton>
                </span>
              }
            />
          </span>
        </li>
      ))}
    </ul>
  )
}
