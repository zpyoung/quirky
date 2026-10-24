import type { Session } from '@quirky/protocol'
import { useAppState, useConnection } from '../context'
import { StructuredView } from '../structured/StructuredView'
import { ExitedBar } from '../terminal/ExitedBar'
import { TerminalPane } from '../terminal/TerminalPane'

const DEFAULT_SCROLLBACK = 2000

export function SessionView({ session }: { session: Session }) {
  const state = useAppState()
  const connection = useConnection()

  if (session.kind === 'structured') return <StructuredView session={session} />

  return (
    <div className="session-view">
      {state.connection === 'connected' && (
        <TerminalPane
          key={session.id}
          connection={connection}
          sessionId={session.id}
          scrollback={state.settings?.terminalScrollback ?? DEFAULT_SCROLLBACK}
          epoch={state.epoch}
          interactive={session.status !== 'exited'}
        />
      )}
      {session.status === 'exited' && <ExitedBar session={session} />}
    </div>
  )
}
