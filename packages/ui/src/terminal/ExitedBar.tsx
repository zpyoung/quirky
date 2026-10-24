import type { Session } from '@quirky/protocol'
import { closeSession } from '../actions'
import { useConnection } from '../context'

export function ExitedBar({ session }: { session: Session }) {
  const connection = useConnection()
  return (
    <div className="exited-bar">
      <span>exited (code {session.exitCode ?? '?'})</span>
      <button onClick={() => void closeSession(connection, session)}>Close</button>
    </div>
  )
}
