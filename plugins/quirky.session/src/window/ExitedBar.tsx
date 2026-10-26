import type { Session } from '@quirky/protocol'

export function ExitedBar({ session, onClose }: { session: Session; onClose: () => void }) {
  return (
    <div className="exited-bar">
      <span>exited (code {session.exitCode ?? '?'})</span>
      <button onClick={onClose}>Close</button>
    </div>
  )
}
