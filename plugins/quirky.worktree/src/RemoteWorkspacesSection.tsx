import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Checkbox, ContextMenu, EmptyState, IconButton, ListRow, SectionHeader, StatusDot, TextField, type ContextMenuItem } from '@quirky/ui'
import { isRecord as record } from './loop-status'
import { currentWindowId } from './actions'

type HostRow = { id: string; runtimeId: string; name: string; connected: boolean; error: string | null }
type WorkspaceRow = { id: string; hostId: string; name: string; connected: boolean }
type OpenMenu = { x: number; y: number; label: string; items: ContextMenuItem[]; returnFocusTo?: HTMLElement }

function readHosts(value: unknown): HostRow[] {
  if (!record(value) || !Array.isArray(value.hosts)) throw new Error('Invalid registered host inventory.')
  return value.hosts.map((host: unknown) => {
    if (!record(host) || typeof host.id !== 'string' || !record(host.runtime) || typeof host.runtime.id !== 'string' || typeof host.runtime.name !== 'string' ||
      typeof host.connected !== 'boolean' || (host.error !== null && typeof host.error !== 'string')) {
      throw new Error('Invalid registered host identity or connectivity.')
    }
    return { id: host.id, runtimeId: host.runtime.id, name: host.runtime.name, connected: host.connected, error: host.error }
  })
}

function readWorkspaces(value: unknown): WorkspaceRow[] {
  if (!record(value) || !Array.isArray(value.workspaces)) throw new Error('Invalid remote workspace inventory.')
  return value.workspaces.map((workspace: unknown) => {
    if (!record(workspace) || typeof workspace.id !== 'string' || typeof workspace.hostId !== 'string' ||
      !record(workspace.worktree) || typeof workspace.worktree.name !== 'string' || typeof workspace.connected !== 'boolean') {
      throw new Error('Invalid remote workspace binding.')
    }
    return { id: workspace.id, hostId: workspace.hostId, name: workspace.worktree.name, connected: workspace.connected }
  })
}

/** Separate owner-qualified projections; never ordinary local path rows. */
export function RemoteWorkspacesSection({ context }: { context: UiPluginContext }) {
  const [hosts, setHosts] = useState<HostRow[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [runtime, setRuntime] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const mounted = useRef(false)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    const [hostResult, workspaceResult] = await Promise.all([
      context.call('quirky.worktree/remoteHostList'),
      context.call('quirky.worktree/remoteList')
    ])
    const nextHosts = readHosts(hostResult)
    const nextWorkspaces = readWorkspaces(workspaceResult)
    if (mounted.current) {
      setHosts(nextHosts)
      setWorkspaces(nextWorkspaces)
    }
  }, [context])

  useEffect(() => {
    mounted.current = true
    void load().catch((failure: unknown) => {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { mounted.current = false }
  }, [load])

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function register() {
    const saved = runtime.trim()
    if (saved === '') throw new Error('Select a saved owner runtime.')
    if (replace && !await context.confirm({
      title: 'Replace the registered owner identity?',
      body: `Accept the authenticated host and grant of ${saved}. Prior workspace selections will remain invalid.`,
      confirmLabel: 'Replace owner identity'
    })) return
    const host = await context.call('quirky.worktree/remoteHostRegister', { runtime: saved, replace })
    if (!record(host) || typeof host.id !== 'string') throw new Error('The owner registration returned no identity.')
    await context.call('quirky.worktree/remoteRefresh', { host: host.id })
    if (mounted.current) { setRuntime(''); setReplace(false) }
  }

  async function navigate(workspace: string) {
    await context.call('quirky.worktree/remoteNavigate', { workspace, window: await currentWindowId(context) })
  }

  function openWorkspaceMenu(workspace: WorkspaceRow, x: number, y: number, returnFocusTo: HTMLElement) {
    setMenu({
      x, y, returnFocusTo,
      label: `Actions for ${workspace.name}`,
      items: [{ id: 'open', label: 'Open workspace', onSelect: () => { void run(() => navigate(workspace.id)) } }]
    })
  }

  return <section aria-label="Remote workspaces" className="ui-panel-content remote-workspaces">
    <Button type="button" disabled={busy} onClick={() => context.openView('view:quirky.worktree/environments')}>VM environments</Button>
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void run(register) }}>
      <TextField id="remote-owner-runtime" label="Saved owner runtime" value={runtime} disabled={busy} onChange={(event) => setRuntime(event.currentTarget.value)} placeholder="runtime ID or name" />
      <fieldset className="remote-replace" disabled={busy}>
        <Checkbox checked={replace} label="Replace a changed owner identity or grant" onChange={setReplace} />
      </fieldset>
      <Button type="submit" variant="primary" disabled={busy || runtime.trim() === ''}>Register host</Button>
    </form>
    {error && <p className="ui-error-text" role="alert">{error}</p>}
    {hosts.length === 0
      ? <EmptyState message="No owner hosts registered" action={{ label: 'Register host', onAction: () => document.getElementById('remote-owner-runtime')?.focus() }} />
      : hosts.map((host) => {
        const hostWorkspaces = workspaces.filter((workspace) => workspace.hostId === host.id)
        const hostState = host.connected ? 'Connected' : 'Unavailable'
        return <section key={host.id} aria-label={host.name} className="remote-host">
          <SectionHeader
            className="remote-host-header"
            title={<>
              <StatusDot status={host.connected ? 'working' : 'needs-you'} />
              <span className="remote-host-name" title={host.name}>{host.name}</span>
            </>}
            actions={<span className="ui-cluster remote-host-actions">
              <span className="remote-fact">{hostState}</span>
              <Button type="button" disabled={busy} onClick={() => { void run(async () => { await context.call('quirky.worktree/remoteRefresh', { host: host.id }) }) }}>Refresh</Button>
              {!host.connected && <Button type="button" disabled={busy} onClick={() => { void run(async () => {
                const accepted = await context.confirm({ title: 'Re-register owner host?', body: 'Accept the current authenticated host generation. Old workspace selections remain invalid.', confirmLabel: 'Re-register' })
                if (!accepted) return
                const registered = await context.call('quirky.worktree/remoteHostRegister', { runtime: host.runtimeId, replace: true })
                if (!record(registered) || typeof registered.id !== 'string') throw new Error('Invalid owner registration.')
                await context.call('quirky.worktree/remoteRefresh', { host: registered.id })
              }) }}>Re-register</Button>}
            </span>}
          />
          {host.error && <p role="status" className="ui-error-text">{host.error}</p>}
          {hostWorkspaces.length > 0 && (
            <ul className="remote-rows" aria-label={`Workspaces on ${host.name}`}>
              {hostWorkspaces.map((workspace) => {
                const unavailable = busy || !host.connected || !workspace.connected
                return <li key={workspace.id} className="remote-row">
                  <ListRow
                    title={<span className="ui-text-ellipsis">{workspace.name}</span>}
                    status={workspace.connected ? 'working' : 'needs-you'}
                    statusLabel={workspace.connected ? 'Connected' : 'Unavailable'}
                    mainTitle={workspace.name}
                    disabled={unavailable}
                    onClick={() => { void run(() => navigate(workspace.id)) }}
                    trailing={<span className="ui-cluster">
                      {!workspace.connected && <span className="remote-fact">Unavailable</span>}
                      <span className="remote-reveal">
                        <IconButton
                          label={`Actions for ${workspace.name}`}
                          aria-haspopup="menu"
                          disabled={unavailable}
                          onClick={(event) => {
                            const box = event.currentTarget.getBoundingClientRect()
                            openWorkspaceMenu(workspace, box.left, box.bottom, event.currentTarget)
                          }}
                        >
                          ⋯
                        </IconButton>
                      </span>
                    </span>}
                  />
                </li>
              })}
            </ul>
          )}
        </section>
      })}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
  </section>
}
