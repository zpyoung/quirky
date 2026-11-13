import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import { RpcErrorCode, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { Button, EmptyState, FormRow, InlineError, NoticeLine, SectionHeader } from '@quirky/ui'
import { MessageRow } from './MessageRow'
import { mergeMessages, visibleMessages } from './transcript'
import { rememberShowAllEvents, showAllEventsFor, subscribeShowAllEvents, SHOW_ALL_EVENTS_COMMAND } from './model'

const NO_MESSAGES: StructuredMessage[] = []
type MessagePhase = { status: 'loading' } | { status: 'ready' } | { status: 'off' } | { status: 'failed'; message: string }

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
  paddingInlineEnd: 'calc(2.5rem + var(--ui-space-16))',
  borderTop: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties

const field = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const textarea = { fontFamily: 'var(--ui-font-body)', resize: 'vertical' } satisfies CSSProperties
const ended = { padding: 'var(--ui-space-8)', color: 'var(--ui-muted)', borderTop: 'var(--ui-border-width) solid var(--ui-border)' } satisfies CSSProperties

/** Transcript of a structured (no PTY) session with an input box for follow-up turns. */
export function StructuredView({ context, session }: { context: UiPluginContext; session: Session }) {
  const [stored, setStored] = useState<StructuredMessage[]>(NO_MESSAGES)
  const [phase, setPhase] = useState<MessagePhase>({ status: 'loading' })
  const [text, setText] = useState('')
  const showAll = useSyncExternalStore(
    subscribeShowAllEvents,
    () => showAllEventsFor(session),
    () => showAllEventsFor(session)
  )
  const scroller = useRef<HTMLDivElement>(null)
  const latest = useRef(0)
  const cancelled = useRef(false)
  const loadedOnce = useRef(false)
  const showAllId = useId()
  const messageId = useId()
  const messages = visibleMessages(stored, showAll)

  const add = (incoming: StructuredMessage[]) => setStored((current) => mergeMessages(current, incoming))

  function load(): void {
    const attempt = ++latest.current
    if (!loadedOnce.current) setPhase({ status: 'loading' })
    void context
      .call('quirky.structured/messages', { session: session.id })
      .then((loaded) => {
        if (cancelled.current || attempt !== latest.current) return
        loadedOnce.current = true
        setPhase({ status: 'ready' })
        add(loaded as StructuredMessage[])
      })
      .catch((error: { code?: unknown }) => {
        if (cancelled.current || attempt !== latest.current) return
        if (error?.code === RpcErrorCode.MethodNotFound) {
          loadedOnce.current = false
          setPhase({ status: 'off' })
        } else if (!loadedOnce.current) {
          setPhase({ status: 'failed', message: messageOf(error) })
        }
      })
  }

  useEffect(() => {
    cancelled.current = false
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'plugin.changed') {
        load()
        return
      }
      if (event.type !== 'quirky.structured/message') return
      const message = (event.data as { message?: StructuredMessage } | undefined)?.message
      if (message && message.sessionId === session.id && !cancelled.current) {
        loadedOnce.current = true
        setPhase({ status: 'ready' })
        add([message])
      }
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    load()
    return () => {
      cancelled.current = true
      latest.current++
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

  if (phase.status === 'off') return <EmptyState message="Structured sessions are off" />

  const exited = session.status === 'exited'

  return (
    <div style={layout}>
      <SectionHeader
        title="Transcript"
        style={{ paddingInline: 'var(--ui-space-8)' }}
        actions={
          <label className="ui-checkbox-label" htmlFor={showAllId}>
            <input
              id={showAllId}
              type="checkbox"
              checked={showAll}
              onChange={(event) => {
                const enabled = event.target.checked
                rememberShowAllEvents(session, enabled)
                void context.executeCommand(SHOW_ALL_EVENTS_COMMAND, { session: session.id, enabled })
              }}
            />
            <span>Show all events</span>
          </label>
        }
      />
      <div style={transcript} ref={scroller} role="log" aria-live="polite">
        {phase.status === 'loading' && messages.length === 0 && <NoticeLine>Loading messages…</NoticeLine>}
        {phase.status === 'failed' && (
          <InlineError message={`Could not load messages: ${phase.message}`} action={{ label: 'Retry', onAction: load }} />
        )}
        {phase.status === 'ready' && messages.length === 0 && <EmptyState message="No messages yet." />}
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
