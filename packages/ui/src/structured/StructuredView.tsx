import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session, StructuredMessage } from '@quirky/protocol'
import { useAppState, useConnection, useDispatch } from '../context'
import { MessageRow } from './MessageRow'

const NO_MESSAGES: StructuredMessage[] = []

/** Transcript of a structured (no PTY) session with an input box for follow-up turns. */
export function StructuredView({ session }: { session: Session }) {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const messages = state.structured[session.id] ?? NO_MESSAGES

  useEffect(() => {
    let cancelled = false
    connection
      .call('structured.messages', { sessionId: session.id })
      .then((loaded) => {
        if (!cancelled) dispatch({ type: 'structured', sessionId: session.id, messages: loaded })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [connection, dispatch, session.id, state.epoch])

  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages.length])

  const send = async () => {
    const value = text.trim()
    if (!value) return
    setText('')
    const result = await connection.attempt('structured.send', { sessionId: session.id, text: value }, 'Could not send')
    if (!result) setText(value)
  }

  const exited = session.status === 'exited'

  return (
    <div className="structured">
      <div className="transcript" ref={scroller}>
        {messages.length === 0 && <p className="muted pad">No messages yet.</p>}
        {messages.map((message) => (
          <MessageRow key={message.seq} message={message} />
        ))}
      </div>
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
          disabled={exited}
          placeholder={exited ? 'Session has ended' : 'Message (Enter to send, Shift+Enter for a new line)'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button type="submit" className="primary" disabled={exited || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
