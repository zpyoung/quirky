import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { MobileConnectionState, MobilePageBridge, MobileRoute, PageAppProps } from '../contracts'
import { SessionPage } from './SessionPage'
import { PAGE_CSS } from './styles'
import { WorkspacesPage } from './WorkspacesPage'

function connectionLabel(state: MobileConnectionState): { title: string; detail: string } {
  switch (state.phase) {
    case 'connected': return { title: 'Connected', detail: 'Live workspace data is available.' }
    case 'connecting': return { title: 'Connecting to desktop', detail: 'Workspace actions are paused until the connection is ready.' }
    case 'reconnecting': return { title: 'Reconnecting to desktop', detail: state.attempts > 0 ? `Attempt ${state.attempts}. Workspace actions are paused.` : 'Workspace actions are paused until the connection is ready.' }
    case 'unreachable': return { title: 'Desktop unreachable', detail: 'Showing any data already loaded. It may be stale; actions are paused.' }
    case 'auth-failed': return { title: 'Pairing invalid', detail: 'Re-pair this phone with the desktop before continuing.' }
    case 'credential-missing': return { title: 'Pairing invalid', detail: 'The saved phone credential is missing. Re-pair with the desktop.' }
    case 'credential-unavailable': return { title: 'Credential temporarily unavailable', detail: 'Unlock the device or retry from the host screen. Actions are paused.' }
    case 'disconnected': return { title: 'Disconnected', detail: 'Showing any data already loaded. It may be stale; actions are paused.' }
  }
}

export function PageApp({ bridge }: PageAppProps) {
  const [route, setRoute] = useState<MobileRoute>(bridge.init.route)
  const [connection, setConnection] = useState<MobileConnectionState>(bridge.state ?? bridge.init.connectionState)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const [workspaceLayout, setWorkspaceLayout] = useState<Record<string, unknown>>({})
  const [sessionLayout, setSessionLayout] = useState<Record<string, unknown>>({})
  const connected = connection.phase === 'connected'
  const active = connected && visible
  const rpcGranted = bridge.init.grants.includes('rpc')
  useEffect(() => {
    setRoute(bridge.init.route)
    setConnection(bridge.state ?? bridge.init.connectionState)
    const stop = bridge.onState((next) => setConnection(next))
    return stop
  }, [bridge])
  useEffect(() => {
    const updateVisibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  const reportWorkspaceLayout = useCallback((state: Record<string, unknown>) => setWorkspaceLayout(state), [])
  const reportSessionLayout = useCallback((state: Record<string, unknown>) => setSessionLayout(state), [])

  useEffect(() => {
    const state: Record<string, unknown> = { route: route.kind, connectionPhase: connection.phase, stale: !active }
    Object.assign(state, route.kind === 'workspaces' ? workspaceLayout : sessionLayout)
    if (route.kind === 'session') {
      state.worktreeId = route.worktreeId
      if (route.sessionId !== undefined) state.sessionId = route.sessionId
    }
    bridge.report(state)
  }, [bridge, route, connection.phase, active, workspaceLayout, sessionLayout])

  const navigate = useCallback(async (next: MobileRoute | { kind: 'home' }) => {
    await bridge.navigate(next)
    if (next.kind !== 'home') setRoute(next)
  }, [bridge])

  const safeAreaStyle = {
    '--safe-top': `${Math.max(0, bridge.init.safeArea.top)}px`,
    '--safe-bottom': `${Math.max(0, bridge.init.safeArea.bottom)}px`
  } as CSSProperties
  const warning = connectionLabel(connection)

  return (
    <div className="qp-page" style={safeAreaStyle} data-connection={connection.phase}>
      <style>{PAGE_CSS}</style>
      {!connected && (
        <div className="qp-connection" role="status" aria-live="polite">
          <span className="qp-status-dot qp-status-dot--stale" aria-hidden="true" />
          <div className="qp-connection__text">
            <strong>{warning.title}</strong>
            <p>{warning.detail}</p>
          </div>
          <button className="qp-button qp-button--quiet" type="button" onClick={() => void navigate({ kind: 'home' })}>
            Hosts
          </button>
        </div>
      )}
      {!rpcGranted ? (
        <div className="qp-content"><div className="qp-error" role="alert">This page bundle does not have the required workspace RPC grant. Update the desktop page bundle to continue.</div></div>
      ) : route.kind === 'workspaces' ? (
        <WorkspacesPage bridge={bridge} connected={active} onNavigate={navigate} onReport={reportWorkspaceLayout} />
      ) : (
        <SessionPage bridge={bridge} route={route} connected={active} onNavigate={navigate} onReport={reportSessionLayout} />
      )}
    </div>
  )
}

