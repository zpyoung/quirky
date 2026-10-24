import { useAppState } from '../context'

export function ConnectionBanner() {
  const { connection } = useAppState()
  if (connection === 'unreachable') {
    return <div className="banner banner-warn">Quirky's daemon isn't running</div>
  }
  if (connection === 'reconnecting') return <div className="banner banner-warn">Reconnecting…</div>
  if (connection === 'connecting') return <div className="banner">Connecting…</div>
  return null
}
