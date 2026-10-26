import { useEffect, useRef, useState, type FormEvent } from 'react'
import { RpcErrorCode, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { MessageRow } from './MessageRow'
import { mergeMessages, visibleMessages } from './transcript'

const NO_MESSAGES: StructuredMessage[] = []

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Transcript of a structured (no PTY) session with an input box for follow-up turns. */
export function StructuredView({ context, session }: { context: UiPluginContext; session: Session }) {
  const [stored, setStored] = useState<StructuredMessage[]>(NO_MESSAGES)
  const [off, setOff] = useState(false)
  const [text, setText] = useState('')
  const [showAll, setShowAll] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
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

  if (off) return <p className="muted pad">Structured sessions are off</p>

  const exited = session.status === 'exited'

  return (
    <div className="structured">
      <div className="transcript-bar">
        <label>
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          Show all events
        </label>
      </div>
      <div className="transcript" ref={scroller}>
        {messages.length === 0 && <p className="muted pad">No messages yet.</p>}
        {messages.map((message) => (
          <MessageRow key={message.seq} message={message} />
        ))}
      </div>
      {exited ? (
        <div className="session-ended">session ended</div>
      ) : (
        <form
          className="structured-input"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            void send()
          }}
        >
          <textarea
            rows={2}
            value={text}
            placeholder="Message (Enter to send, Shift+Enter for a new line)"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button type="submit" className="primary" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  )
}
