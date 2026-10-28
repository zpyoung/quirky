import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { MobileConnectionState, MobilePageBridge, MobileRoute, PageAppProps } from '../contracts'
import { PanelApp, isPanelRoute } from '../panels'
import { DirectNotifications } from '../panels/activity'
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

function routeWorktreeId(route: MobileRoute): string | undefined {
  return 'worktreeId' in route && typeof route.worktreeId === 'string' ? route.worktreeId : undefined
}

function boundedWorktreeId(value: string | undefined): string | undefined {
  return value && value.length > 0 && value.length <= 1024 && !value.includes('\0') ? value : undefined
}

function initialPanelReturnRoute(route: MobileRoute): MobileRoute {
  if (route.kind === 'session') return route
  if (route.kind === 'terminal-artifacts' || route.kind === 'terminal-artifact') {
    return { kind: 'session', worktreeId: route.worktreeId, sessionId: route.sessionId }
  }
  const worktreeId = routeWorktreeId(route)
  return isPanelRoute(route) && worktreeId ? { kind: 'session', worktreeId } : { kind: 'workspaces' }
}

function panelTitle(route: MobileRoute): string {
  switch (route.kind) {
    case 'source-control': return 'Source control'
    case 'review': return 'Review'
    case 'files': return 'Files'
    case 'file-preview': return 'File preview'
    case 'terminal-artifacts': return 'Terminal artifacts'
    case 'terminal-artifact': return 'Terminal artifact'
    case 'tasks': return 'Tasks'
    case 'accounts': return 'Accounts'
    case 'agent-history': return 'Agent history'
    case 'notifications': return 'Notifications'
    case 'workspaces': return 'Workspaces'
    case 'session': return 'Session'
  }
}

export function PageApp({ bridge }: PageAppProps) {
  const [route, setRoute] = useState<MobileRoute>(bridge.init.route)
  const routeRef = useRef(route)
  routeRef.current = route
  const panelReturnRouteRef = useRef<MobileRoute | null>(null)
  if (panelReturnRouteRef.current === null) panelReturnRouteRef.current = initialPanelReturnRoute(route)
  const [connection, setConnection] = useState<MobileConnectionState>(bridge.state)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const [workspaceLayout, setWorkspaceLayout] = useState<Record<string, unknown> | null>(null)
  const [sessionLayout, setSessionLayout] = useState<Record<string, unknown> | null>(null)
  const [lastWorktreeId, setLastWorktreeId] = useState(() =>
    boundedWorktreeId(routeWorktreeId(route)) ?? boundedWorktreeId(bridge.init.host.lastWorktree)
  )
  const connected = connection.phase === 'connected'
  const active = connected && visible
  const rpcGranted = bridge.init.grants.includes('rpc')

  useEffect(() => {
    const initialRoute = bridge.init.route
    setRoute(initialRoute)
    routeRef.current = initialRoute
    panelReturnRouteRef.current = initialPanelReturnRoute(initialRoute)
    setLastWorktreeId(boundedWorktreeId(routeWorktreeId(initialRoute)) ?? boundedWorktreeId(bridge.init.host.lastWorktree))
    setConnection(bridge.state)
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
  const navigationGuardRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerNavigationGuard = useCallback((guard: () => Promise<boolean>) => {
    navigationGuardRef.current = guard
    return () => {
      if (navigationGuardRef.current === guard) navigationGuardRef.current = null
    }
  }, [])

  const navigate = useCallback(async (next: MobileRoute | { kind: 'home' }) => {
    const previous = routeRef.current
    if (navigationGuardRef.current && !(await navigationGuardRef.current())) return
    await bridge.navigate(next)
    if (next.kind === 'home') return
    if (isPanelRoute(next)) {
      if (!isPanelRoute(previous)) panelReturnRouteRef.current = previous
    } else {
      panelReturnRouteRef.current = initialPanelReturnRoute(next)
    }
    routeRef.current = next
    setRoute(next)
    const worktreeId = boundedWorktreeId(routeWorktreeId(next))
    if (worktreeId) setLastWorktreeId(worktreeId)
  }, [bridge])

  const routingBridge = useMemo<MobilePageBridge>(() => ({
    ...bridge,
    get state() { return bridge.state },
    navigate
  }), [bridge, navigate])

  useEffect(() => {
    const layout = route.kind === 'workspaces' ? workspaceLayout : route.kind === 'session' ? sessionLayout : undefined
    if (layout === null) return
    const state: Record<string, unknown> = { route: route.kind, connectionPhase: connection.phase, stale: !active }
    if (route.kind === 'workspaces') {
      Object.assign(state, workspaceLayout)
    } else if (route.kind === 'session') {
      Object.assign(state, sessionLayout)
      state.worktreeId = route.worktreeId
      if (route.sessionId !== undefined) state.sessionId = route.sessionId
    } else {
      const worktreeId = routeWorktreeId(route) ??
        (route.kind === 'notifications' ? boundedWorktreeId(lastWorktreeId) : undefined)
      if (worktreeId !== undefined) state.worktreeId = worktreeId
      if (route.kind === 'source-control' && route.tab !== undefined) state.tab = route.tab
      if ((route.kind === 'review' || route.kind === 'files' || route.kind === 'file-preview') && route.path !== undefined) state.path = route.path
      if (route.kind === 'terminal-artifacts' || route.kind === 'terminal-artifact') state.sessionId = route.sessionId
      if (route.kind === 'terminal-artifact') state.artifactId = route.artifactId
    }
    bridge.report(state)
  }, [bridge, route, connection.phase, active, workspaceLayout, sessionLayout, lastWorktreeId])

  const safeAreaStyle = {
    '--safe-top': `${Math.max(0, bridge.init.safeArea.top)}px`,
    '--safe-bottom': `${Math.max(0, bridge.init.safeArea.bottom)}px`
  } as CSSProperties
  const warning = connectionLabel(connection)
  const panelReturnRoute = panelReturnRouteRef.current!
  const panelBackLabel = panelReturnRoute.kind === 'session' ? 'Back to session' : 'Back to workspaces'
  const lastWorktree = boundedWorktreeId(lastWorktreeId) ?? boundedWorktreeId(bridge.init.host.lastWorktree)

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
        <WorkspacesPage bridge={routingBridge} connected={active} onNavigate={navigate} onReport={reportWorkspaceLayout} />
      ) : route.kind === 'session' ? (
        <SessionPage bridge={routingBridge} route={route} connected={active} onNavigate={navigate} onReport={reportSessionLayout} />
      ) : isPanelRoute(route) ? (
        <>
          <header className="qp-topbar">
            <button className="qp-button qp-button--quiet" type="button" aria-label={panelBackLabel} onClick={() => void navigate(panelReturnRoute)}>
              {panelBackLabel}
            </button>
            <div className="qp-topbar__titles">
              <h1>{panelTitle(route)}</h1>
              <p>{bridge.init.host.personalName || bridge.init.host.name}</p>
            </div>
          </header>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
            <PanelApp bridge={routingBridge} route={route} connected={active} onRegisterNavigationGuard={registerNavigationGuard} />
          </div>
        </>
      ) : null}
      {rpcGranted && active ? (
        <DirectNotifications bridge={routingBridge} viewedWorktree={routeWorktreeId(route) ?? lastWorktree} />
      ) : null}
    </div>
  )
}

