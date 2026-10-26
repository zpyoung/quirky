import { useEffect, useState } from 'react'
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

export function SessionView({ context, themeSource, session, connected, onClose }: Props) {
  const scrollback = useScrollback(context)
  if (session.kind === 'structured') return <StructuredView context={context} session={session} />

  return (
    <div className="session-view">
      {connected && (
        <TerminalPane
          key={session.id}
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
