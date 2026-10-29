import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { RpcErrorCode, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { Button, EmptyState, FormRow, SectionHeader } from '@quirky/ui'
import { MessageRow } from './MessageRow'
import { mergeMessages, visibleMessages } from './transcript'

const NO_MESSAGES: StructuredMessage[] = []

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layout = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties

const transcript = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  padding: 'var(--ui-space-8)'
} satisfies CSSProperties

const form = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 'var(--ui-space-8)',
  minWidth: 0,
  padding: 'var(--ui-space-8)',
  borderTop: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties

const field = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const textarea = { fontFamily: 'var(--ui-font-body)', resize: 'vertical' } satisfies CSSProperties
const ended = { padding: 'var(--ui-space-8)', color: 'var(--ui-muted)', borderTop: 'var(--ui-border-width) solid var(--ui-border)' } satisfies CSSProperties

/** Transcript of a structured (no PTY) session with an input box for follow-up turns. */
export function StructuredView({ context, session }: { context: UiPluginContext; session: Session }) {
  const [stored, setStored] = useState<StructuredMessage[]>(NO_MESSAGES)
  const [off, setOff] = useState(false)
  const [text, setText] = useState('')
  const [showAll, setShowAll] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const showAllId = useId()
  const messageId = useId()
  const messages = visibleMessages(stored, showAll)

  useEffect(() => {
    let cancelled = false
    let latest = 0
    const add = (incoming: StructuredMessage[]) => setStored((current) => mergeMessages(current, incoming))
    // the daemon answers MethodNotFound while quirky.structured is off, so each load re-derives `off`
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.structured/messages', { session: session.id })
        .then((loaded) => {
          if (cancelled || attempt !== latest) return
          setOff(false)
          add(loaded as StructuredMessage[])
        })
        .catch((error: { code?: unknown }) => {
          if (!cancelled && attempt === latest && error?.code === RpcErrorCode.MethodNotFound) setOff(true)
        })
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'plugin.changed') {
        load()
        return
      }
      if (event.type !== 'quirky.structured/message') return
      const message = (event.data as { message?: StructuredMessage } | undefined)?.message
      if (message && message.sessionId === session.id && !cancelled) add([message])
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    load()
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, session.id])

  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages.length])

  const send = async () => {
    const value = text.trim()
    if (!value) return
    setText('')
    try {
      await context.call('quirky.structured/send', { session: session.id, text: value })
    } catch (error) {
      context.toast('Could not send', messageOf(error))
      setText(value)
    }
  }

  if (off) return <EmptyState message="Structured sessions are off" />

  const exited = session.status === 'exited'

  return (
    <div style={layout}>
      <SectionHeader
        title="Transcript"
        actions={
          <FormRow label="Show all events" htmlFor={showAllId}>
            <input
              id={showAllId}
              type="checkbox"
              checked={showAll}
              style={{ accentColor: 'var(--ui-accent)' }}
              onChange={(event) => setShowAll(event.target.checked)}
            />
          </FormRow>
        }
      />
      <div style={transcript} ref={scroller} role="log" aria-live="polite">
        {messages.length === 0 && <EmptyState message="No messages yet." />}
        {messages.map((message) => (
          <MessageRow key={message.seq} message={message} />
        ))}
      </div>
      {exited ? (
        <div style={ended} role="status">session ended</div>
      ) : (
        <form
          style={form}
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            void send()
          }}
        >
          <div style={field}>
            <FormRow label="Message" htmlFor={messageId}>
              <textarea
                id={messageId}
                rows={2}
                value={text}
                placeholder="Message (Enter to send, Shift+Enter for a new line)"
                className="ui-text-field__input"
                style={textarea}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
            </FormRow>
          </div>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  )
}
