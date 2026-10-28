import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { ExitedBar } from './ExitedBar'
import { StructuredView } from './StructuredView'
import { TerminalPane } from './TerminalPane'

const DEFAULT_SCROLLBACK = 2000
const SCROLLBACK_SETTING = 'setting:quirky.terminal/scrollback'

/** The terminal's scrollback setting, or the default when `quirky.terminal` is off. */
function scrollbackOf(context: UiPluginContext): number {
  try {
    const value = context.getSetting(SCROLLBACK_SETTING)
    return typeof value === 'number' ? value : DEFAULT_SCROLLBACK
  } catch {
    return DEFAULT_SCROLLBACK
  }
}

/** The scrollback setting's current value, following `setting.changed` while mounted. */
function useScrollback(context: UiPluginContext): number {
  const [scrollback, setScrollback] = useState(() => scrollbackOf(context))
  useEffect(
    () =>
      context.subscribe((event) => {
        if (event.type !== 'setting.changed' || event.id !== SCROLLBACK_SETTING) return
        setScrollback(typeof event.value === 'number' ? event.value : DEFAULT_SCROLLBACK)
      }),
    [context]
  )
  return scrollback
}

type Props = {
  context: UiPluginContext
  themeSource: Element
  session: Session
  connected: boolean
  onClose: () => void
}

/**
 * Counts up each time the session turns `exited` and restorable while shown, so the pane remounts
 * and its attach restores the session. A session that is already lost when shown needs no
 * remount: the first attach restores it.
 */
function useRestoreAttempt(session: Session): number {
  const [attempt, setAttempt] = useState(0)
  const previous = useRef({ id: session.id, status: session.status })
  useEffect(() => {
    const before = previous.current
    previous.current = { id: session.id, status: session.status }
    if (before.id === session.id && before.status !== 'exited' && session.status === 'exited' && session.restorable) {
      setAttempt((count) => count + 1)
    }
  }, [session.id, session.status, session.restorable])
  return attempt
}

const sessionLayout = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties

export function SessionView({ context, themeSource, session, connected, onClose }: Props) {
  const scrollback = useScrollback(context)
  const attempt = useRestoreAttempt(session)
  if (session.kind === 'structured') return <StructuredView context={context} session={session} />

  return (
    <div style={sessionLayout}>
      {connected && (
        <TerminalPane
          key={`${session.id}:${attempt}`}
          context={context}
          themeSource={themeSource}
          sessionId={session.id}
          scrollback={scrollback}
          interactive={session.status !== 'exited'}
        />
      )}
      {session.status === 'exited' && <ExitedBar session={session} onClose={onClose} />}
    </div>
  )
}
