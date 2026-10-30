import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Badge, Button, EmptyState, TextField } from '@quirky/ui'
import { isRecord as record } from './loop-status'
import { currentWindowId } from './actions'

type HostRow = { id: string; runtimeId: string; name: string; connected: boolean; error: string | null }
type WorkspaceRow = { id: string; hostId: string; name: string; connected: boolean }


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

  return <section aria-label="Remote workspaces" className="ui-panel-content">
    <Button type="button" disabled={busy} onClick={() => context.openView('view:quirky.worktree/environments')}>VM environments</Button>
    <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void run(register) }}>
      <TextField label="Saved owner runtime" value={runtime} disabled={busy} onChange={(event) => setRuntime(event.currentTarget.value)} placeholder="runtime ID or name" />
      <label className="ui-checkbox-label">
        <input type="checkbox" disabled={busy} checked={replace} onChange={(event) => setReplace(event.currentTarget.checked)} />
        <span>Replace a changed owner identity or grant</span>
      </label>
      <Button type="submit" variant="primary" disabled={busy || runtime.trim() === ''}>Register host</Button>
    </form>
    {error && <p className="ui-error-text" role="alert">{error}</p>}
    {hosts.length === 0 ? <EmptyState message="No owner hosts registered." /> : hosts.map((host) => {
      const hostWorkspaces = workspaces.filter((workspace) => workspace.hostId === host.id)
      return <section key={host.id} aria-label={host.name} className="ui-stack">
        <div className="ui-cluster">
          <strong className="ui-text-mono" title={host.name}>{host.name}</strong>
          <Badge tone={host.connected ? 'working' : 'needs-you'}>{host.connected ? 'Connected' : 'Unavailable'}</Badge>
          <Button type="button" disabled={busy} onClick={() => { void run(async () => { await context.call('quirky.worktree/remoteRefresh', { host: host.id }) }) }}>Refresh</Button>
          {!host.connected && <Button type="button" disabled={busy} onClick={() => { void run(async () => {
            const accepted = await context.confirm({ title: 'Re-register owner host?', body: 'Accept the current authenticated host generation. Old workspace selections remain invalid.', confirmLabel: 'Re-register' })
            if (!accepted) return
            const registered = await context.call('quirky.worktree/remoteHostRegister', { runtime: host.runtimeId, replace: true })
            if (!record(registered) || typeof registered.id !== 'string') throw new Error('Invalid owner registration.')
            await context.call('quirky.worktree/remoteRefresh', { host: registered.id })
          }) }}>Re-register</Button>}
        </div>
        {host.error && <p role="status" className="ui-error-text">{host.error}</p>}
        {hostWorkspaces.length > 0 && (
          <div className="ui-option-list" role="group" aria-label={`Workspaces on ${host.name}`}>
            {hostWorkspaces.map((workspace) => <Button
              key={workspace.id}
              type="button"
              title={workspace.name}
              disabled={busy || !host.connected || !workspace.connected}
              onClick={() => { void run(() => navigate(workspace.id)) }}
            >
              <span>{workspace.name}</span>
              {!workspace.connected && <Badge tone="needs-you">Unavailable</Badge>}
            </Button>)}
          </div>
        )}
      </section>
    })}
  </section>
}
