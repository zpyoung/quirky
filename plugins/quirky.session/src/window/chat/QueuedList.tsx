import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentCapabilities, QueuedMessage, Session, UiPluginContext } from '@quirky/protocol'
import { Button } from '@quirky/ui'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const list = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-4)',
  margin: 0,
  padding: 0,
  listStyle: 'none'
} satisfies CSSProperties

const item = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  border: 'var(--ui-border-width) dashed var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-selected)'
} satisfies CSSProperties

const body = { flex: '1 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } satisfies CSSProperties
const editor = { ...body, fontFamily: 'var(--ui-font-body)', resize: 'vertical' } satisfies CSSProperties
const actions = { display: 'flex', gap: 'var(--ui-space-4)' } satisfies CSSProperties

/**
 * The messages waiting for the agent's current turn to end, kept live by `queueChanged`. Each can be
 * edited, deleted or steered in; Steer now is disabled with the capability's reason when unsupported.
 */
export function QueuedList({ context, session, capabilities }: { context: UiPluginContext; session: Session; capabilities: AgentCapabilities | null }) {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    let latest = 0
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.structured/queue', { session: session.id })
        .then((loaded) => {
          if (!cancelled && attempt === latest) setQueue(loaded as QueuedMessage[])
        })
        .catch(() => {})
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.structured/queueChanged') return
      const data = event.data as { sessionId?: string; queue?: QueuedMessage[] } | undefined
      if (data?.sessionId !== session.id || !Array.isArray(data.queue) || cancelled) return
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
  }, [context, session.id])

  const act = async (request: () => Promise<unknown>) => {
    try {
      await request()
    } catch (error) {
      context.toast('Could not update the queue', messageOf(error))
    }
  }

  const onCancelEdit = () => setEditing(null)
  const onEdit = (entry: QueuedMessage) => setEditing({ id: entry.id, text: entry.text })

  if (queue.length === 0) return null

  const steer = capabilities?.steer
  const steerReason = steer === undefined ? 'Loading capabilities' : steer.ok ? undefined : steer.reason

  return (
    <ul style={list} aria-label="Queued messages">
      {queue.map((entry) => (
        <li key={entry.id} style={item}>
          {editing?.id === entry.id ? (
            <>
              <textarea
                aria-label="Edit queued message text"
                rows={2}
                className="ui-text-field__input"
                style={editor}
                value={editing.text}
                onChange={(event) => setEditing({ id: entry.id, text: event.target.value })}
              />
              <div style={actions}>
                <Button
                  variant="primary"
                  disabled={!editing.text.trim()}
                  onClick={() => {
                    const text = editing.text.trim()
                    setEditing(null)
                    void act(() => context.call('quirky.structured/editQueued', { session: session.id, id: entry.id, text }))
                  }}
                >
                  Save
                </Button>
                <Button onClick={onCancelEdit}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <span style={body}>{entry.text}</span>
              <div style={actions}>
                <Button aria-label="Edit queued message" onClick={() => onEdit(entry)}>Edit</Button>
                <Button aria-label="Delete queued message" onClick={() => void act(() => context.call('quirky.structured/dequeue', { session: session.id, id: entry.id }))}>Delete</Button>
                <Button
                  disabled={steerReason !== undefined}
                  title={steerReason}
                  onClick={() => void act(() => context.call('quirky.structured/steer', { session: session.id, id: entry.id }))}
                >
                  Steer now
                </Button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
