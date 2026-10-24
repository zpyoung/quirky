import { useAppState } from '../context'

export function ConnectionBanner() {
  const { connection } = useAppState()
  if (connection === 'reconnecting') return <div className="banner banner-warn">Reconnecting…</div>
  if (connection === 'connecting') return <div className="banner">Connecting…</div>
  return null
}
