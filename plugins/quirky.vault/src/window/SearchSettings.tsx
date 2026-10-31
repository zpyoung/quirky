import { useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { Badge, Button, FormRow, ListRow, SectionHeader } from '@quirky/ui'
import type { HostOutcome, SearchStatus } from '../types'
import { HISTORY_PANEL_ID } from './model'

type RemoteSearchStatus = { status: SearchStatus | null; error: string | null }

type SettingsState = {
  status: SearchStatus | null
  hosts: HostOutcome[]
  remoteStatuses: Record<string, RemoteSearchStatus>
  loading: boolean
  busy: boolean
  error: string | null
  scopeStatusError: string | null
}

type SearchSettingsProps = {
  context: UiPluginContext
  report?(state: unknown): void
  embedded?: boolean
}

const disclosure = 'Search stores full, unredacted agent conversations on this computer, including up to 3,072 characters from each tool output. Authenticated clients can search this local index through the daemon.'
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const countSessions = (status: SearchStatus): number => Object.values(status.sessionsByAgent).reduce((sum, value) => sum + value, 0)

function searchStatus(value: unknown): SearchStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  const status = envelope.status && typeof envelope.status === 'object' && !Array.isArray(envelope.status) ? envelope.status as Record<string, unknown> : null
  if (!status || !Array.isArray(envelope.hosts) || typeof status.enabled !== 'boolean' || !['closed', 'idle', 'indexing', 'current', 'degraded'].includes(String(status.phase))) return null
  return status as unknown as SearchStatus
}

function hostOutcomes(value: unknown): HostOutcome[] {
  if (!value || typeof value !== 'object' || !('hosts' in value) || !Array.isArray(value.hosts)) return []
  return value.hosts.filter((row): row is HostOutcome => Boolean(row && typeof row === 'object' && 'hostId' in row && typeof row.hostId === 'string'))
}

function mergeHostOutcomes(current: HostOutcome[], incoming: HostOutcome[], replace = false): HostOutcome[] {
  const merged = new Map<string, HostOutcome>()
  if (!replace) for (const host of current) merged.set(host.hostId, host)
  for (const host of incoming) merged.set(host.hostId, host)
  return [...merged.values()]
}

function SearchSettings({ context, report, embedded = false }: SearchSettingsProps) {
  const idPrefix = useId()
  const [state, setState] = useState<SettingsState>({ status: null, hosts: [], remoteStatuses: {}, loading: true, busy: false, error: null, scopeStatusError: null })
  const localIndexing = state.status?.enabled === true && (state.status.phase === 'indexing' || (state.status.phase === 'degraded' && state.status.filesDue > 0))
  const indexing = localIndexing || Object.values(state.remoteStatuses).some(({ status }) => status?.enabled === true && (status.phase === 'indexing' || (status.phase === 'degraded' && status.filesDue > 0)))
  const pollIntervalMs = indexing ? 2000 : 10_000

  const refresh = async () => {
    try {
      const response = await context.call('quirky.vault/searchStatus', { host: 'local' })
      const status = searchStatus(response)
      if (!status) throw new Error('The local search status response was invalid.')
      const outcomes = hostOutcomes(response)
      setState((current) => ({ ...current, status, hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts, loading: false, error: null }))
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: `Could not read local search status. ${errorText(error)}` }))
    }
    try {
      const allStatus = await context.call('quirky.vault/searchStatus', { host: 'all' })
      if (!searchStatus(allStatus)) throw new Error('The all-host search status response was invalid.')
      const outcomes = hostOutcomes(allStatus)
      const remoteStatuses: Record<string, RemoteSearchStatus> = {}
      for (const host of outcomes) {
        if (host.hostId === 'local' || host.hostId === 'all') continue
        if (host.kind !== 'ok') {
          remoteStatuses[host.hostId] = { status: null, error: host.reason ?? 'This host could not be reached.' }
          continue
        }
        try {
          const remote = searchStatus(await context.call('quirky.vault/searchStatus', { host: host.hostId }))
          if (!remote) throw new Error('The host search status response was invalid.')
          remoteStatuses[host.hostId] = { status: remote, error: null }
        } catch (error) {
          remoteStatuses[host.hostId] = { status: null, error: errorText(error) }
        }
      }
      setState((current) => ({
        ...current,
        hosts: mergeHostOutcomes(current.hosts, outcomes, true),
        remoteStatuses,
        scopeStatusError: null
      }))
    } catch (error) {
      setState((current) => ({ ...current, scopeStatusError: `Could not check other hosts. ${errorText(error)}` }))
    }
  }

  useEffect(() => {
    let active = true
    const poll = async () => {
      if (!active) return
      await refresh()
    }
    void poll()
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.vault/searchStatus') return
      const data = event.data
      const status = searchStatus(data)
      if (status) {
        const outcomes = hostOutcomes(data)
        setState((current) => ({ ...current, status, hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts, loading: false }))
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [context])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [pollIntervalMs, context])

  useEffect(() => {
    report?.({
      enabled: state.status?.enabled ?? false,
      phase: state.status?.phase ?? 'unavailable',
      filesIndexed: state.status?.filesIndexed ?? 0,
      filesDue: state.status?.filesDue ?? 0,
      filesFailed: state.status?.filesFailed ?? 0,
      messagesIndexed: state.status?.messagesIndexed ?? 0,
      searchableSessions: state.status ? countSessions(state.status) : 0,
      degradedRoots: state.status?.degradedRoots.length ?? 0,
      lastReconcileAt: state.status?.lastReconcileAt ?? null,
      generation: state.status?.generation ?? 0,
      failedHosts: state.hosts.filter((host) => host.kind !== 'ok').map((host) => host.hostId),
      busy: state.busy,
      error: state.error,
      pollIntervalMs,
    })
  }, [state, report])

  const setEnabled = async (enabled: boolean) => {
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      const response = await context.call('quirky.vault/setSearchEnabled', { enabled, host: 'local' })
      const status = searchStatus(response)
      if (!status || status.enabled !== enabled) throw new Error('The local search policy did not reach the requested state.')
      const outcomes = hostOutcomes(response)
      setState((current) => ({ ...current, status, hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts, busy: false, error: null }))

    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Could not ${enabled ? 'enable' : 'disable'} search. Try again. ${errorText(error)}` }))
    }
  }
  const setRemoteEnabled = async (host: HostOutcome, enabled: boolean) => {
    const prior = state.remoteStatuses[host.hostId]?.status ?? null
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      const response = await context.call('quirky.vault/setSearchEnabled', { enabled, host: host.hostId })
      const status = searchStatus(response)
      if (!status || status.enabled !== enabled) throw new Error(`The host did not confirm that search was ${enabled ? 'enabled' : 'disabled'}.`)
      const outcomes = hostOutcomes(response)
      setState((current) => ({
        ...current,
        hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts,
        remoteStatuses: { ...current.remoteStatuses, [host.hostId]: { status, error: null } },
        busy: false,
        error: null
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        remoteStatuses: { ...current.remoteStatuses, [host.hostId]: { status: prior, error: errorText(error) } },
        busy: false
      }))
    }
  }

  const enableAll = async () => {
    const hosts = state.hosts.filter((host) => host.hostId !== 'local' && host.hostId !== 'all' && host.kind === 'ok')
    if (hosts.length === 0) {
      setState((current) => ({ ...current, error: 'No available remote hosts can enable Agent Session Search.' }))
      return
    }
    setState((current) => ({ ...current, busy: true, error: null }))
    const failures: string[] = []
    try {
      const response = await context.call('quirky.vault/setSearchEnabled', { enabled: true, host: 'local' })
      const localStatus = searchStatus(response)
      if (!localStatus?.enabled) throw new Error('Local search did not become enabled.')
      const outcomes = hostOutcomes(response)
      setState((current) => ({
        ...current,
        status: localStatus,
        hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts
      }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Could not enable local search. ${errorText(error)}` }))
      return
    }
    for (const host of hosts) {
      try {
        const response = await context.call('quirky.vault/setSearchEnabled', { enabled: true, host: host.hostId })
        const status = searchStatus(response)
        if (!status?.enabled) throw new Error('The host did not confirm its enabled state.')
        const outcomes = hostOutcomes(response)
        setState((current) => ({
          ...current,
          hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts,
          remoteStatuses: { ...current.remoteStatuses, [host.hostId]: { status, error: null } }
        }))
      } catch (error) {
        failures.push(`${host.label}: ${errorText(error)}`)
        setState((current) => ({
          ...current,
          remoteStatuses: { ...current.remoteStatuses, [host.hostId]: { status: current.remoteStatuses[host.hostId]?.status ?? null, error: errorText(error) } }
        }))
      }
    }
    try {
      const response = await context.call('quirky.vault/searchStatus', { host: 'local' })
      const status = searchStatus(response)
      if (!status) throw new Error('The local search status response was invalid.')
      const outcomes = hostOutcomes(response)
      setState((current) => ({
        ...current,
        status,
        hosts: outcomes.length ? mergeHostOutcomes(current.hosts, outcomes) : current.hosts,
        busy: false,
        error: failures.length ? `Local search is enabled. Some hosts could not be enabled: ${failures.join('; ')}` : null
      }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Local search was enabled, but status could not be refreshed. ${errorText(error)}` }))
    }
  }

  const openSidebar = async () => {
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      context.togglePanel(HISTORY_PANEL_ID, true)
      await context.call('quirky.vault/setView', { focusedSearch: true })
      setState((current) => ({ ...current, busy: false }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Could not open Agent Session History. ${errorText(error)}` }))
    }
  }

  const clear = async () => {
    const accepted = await context.confirm({
      title: 'Clear search data on this computer?',
      body: 'This removes the derived searchable copy. Original agent sessions are not changed. If search is enabled, it will be turned off before the index is removed.',
      confirmLabel: 'Clear'
    })
    if (!accepted) return
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      if (state.status?.enabled) await context.call('quirky.vault/setSearchEnabled', { enabled: false, host: 'local' })
      const result = await context.call('quirky.vault/clearSearchIndex', { yes: true })
      if (!result || typeof result !== 'object' || !('cleared' in result) || result.cleared !== true) {
        const reason = result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string' ? result.reason : 'The search data was not cleared.'
        throw new Error(reason)
      }
      const status = searchStatus(result)
      if (!status) throw new Error('The local search status response was invalid.')
      const outcomes = hostOutcomes(result)
      setState((current) => ({ ...current, status, hosts: outcomes.length ? outcomes : current.hosts, busy: false, error: null }))
      context.toast('Search data cleared', 'Your agent sessions were not affected.')
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Could not clear search data. ${errorText(error)}` }))
    }
  }

  const status = state.status
  const sessions = status ? countSessions(status) : 0
  const enableableHostCount = state.hosts.filter((host) => host.hostId !== 'local' && host.hostId !== 'all' && host.kind === 'ok' && state.remoteStatuses[host.hostId]?.status?.enabled !== true).length

  return (
    <section className={`qvh-root qvh-settings${embedded ? ' qvh-embedded' : ''}`} data-vault-settings data-vault-search-status={status?.phase ?? 'unavailable'} data-vault-poll-ms={pollIntervalMs} data-vault-search-generation={status?.generation ?? 0} data-vault-last-reconcile-at={status?.lastReconcileAt ?? ''}>
      {!embedded ? <div className="qvh-settings-heading">
        <SectionHeader title="Agent Session Search" />
        <p className="qvh-settings-description">Search everything your agents have said and done on this computer and other available hosts.</p>
      </div> : null}
      <section className="qvh-settings-card">
        <SectionHeader title="Search inside sessions" actions={<Badge tone={!status ? (state.loading ? 'neutral' : 'failing') : status.phase === 'degraded' ? 'needs-you' : status.enabled ? 'working' : 'neutral'}>{!status ? (state.loading ? 'Checking status' : 'Unavailable') : status.enabled ? (localIndexing ? 'Indexing' : 'Enabled') : 'Disabled'}</Badge>} />
        <p className="qvh-settings-description">{disclosure}</p>
        <div className="qvh-settings-host-row" data-vault-host-row data-vault-host-id="local" data-vault-host-status={status?.phase ?? 'checking'}>
          <ListRow
            title="Local Mac"
            description={<span data-vault-status-summary>{status?.enabled ? (localIndexing ? `${status.filesIndexed.toLocaleString()} files indexed · ${status.filesDue.toLocaleString()} files owed · ${status.messagesIndexed.toLocaleString()} messages searchable` : `${sessions.toLocaleString()} sessions · ${status.messagesIndexed.toLocaleString()} messages searchable`) : state.loading ? 'Checking search status…' : 'Transcript search is off. Only titles are filtered until enabled.'}</span>}
            trailing={<Badge tone={!status ? (state.loading ? 'neutral' : 'failing') : status.phase === 'degraded' ? 'needs-you' : status.enabled ? 'working' : 'neutral'}>{!status ? (state.loading ? 'Checking' : 'Unavailable') : status.enabled ? (localIndexing ? 'Indexing' : 'Enabled') : 'Disabled'}</Badge>}
          />
          <FormRow label="Enable local Agent Session Search" htmlFor={`${idPrefix}-local-search`}>
            <input
              id={`${idPrefix}-local-search`}
              type="checkbox"
              role="switch"
              aria-label="Enable local Agent Session Search"
              data-vault-search-enabled
              checked={status?.enabled ?? false}
              disabled={state.busy || !status}
              onChange={(event) => void setEnabled(event.currentTarget.checked)}
            />
          </FormRow>
        </div>
        {state.hosts.filter((host) => host.hostId !== 'local' && host.hostId !== 'all').map((host, index) => {
          const remote = state.remoteStatuses[host.hostId]
          const remoteStatus = remote?.status ?? null
          const hostFailure = host.kind !== 'ok' || Boolean(remote?.error)
          const description = host.kind !== 'ok'
            ? host.reason ?? (host.kind === 'unavailable' ? 'This host does not provide history search.' : 'This host could not be reached.')
            : remote?.error
              ? `Could not read host search status. ${remote.error}`
              : !remoteStatus
                ? 'Checking search status…'
                : remoteStatus.enabled
                  ? remoteStatus.phase === 'indexing' || (remoteStatus.phase === 'degraded' && remoteStatus.filesDue > 0)
                    ? `${remoteStatus.filesIndexed.toLocaleString()} files indexed · ${remoteStatus.filesDue.toLocaleString()} files owed · ${remoteStatus.messagesIndexed.toLocaleString()} messages searchable`
                    : `${countSessions(remoteStatus).toLocaleString()} sessions · ${remoteStatus.messagesIndexed.toLocaleString()} messages searchable`
                  : 'Transcript search is off on this host.'
          const switchId = `${idPrefix}-host-${index}`
          return <div className="qvh-settings-host-row" data-vault-host-row data-vault-host-id={host.hostId} data-vault-host-status={host.kind !== 'ok' ? host.kind : remoteStatus?.phase ?? (remote?.error ? 'error' : 'checking')} data-vault-host-outcome={host.kind} key={host.hostId}>
            <ListRow
              title={host.label}
              description={description}
              trailing={<Badge tone={hostFailure ? 'failing' : remoteStatus?.phase === 'degraded' ? 'needs-you' : remoteStatus?.enabled ? 'working' : 'neutral'}>{hostFailure ? 'Unavailable' : !remoteStatus ? 'Checking' : remoteStatus.enabled ? (remoteStatus.phase === 'indexing' || (remoteStatus.phase === 'degraded' && remoteStatus.filesDue > 0) ? 'Indexing' : 'Enabled') : 'Disabled'}</Badge>}
            />
            {host.kind === 'ok' && remoteStatus
              ? <FormRow label={`Enable Agent Session Search on ${host.label}`} htmlFor={switchId}><input id={switchId} type="checkbox" role="switch" aria-label={`Enable Agent Session Search on ${host.label}`} data-vault-host-switch checked={remoteStatus.enabled} disabled={state.busy} onChange={(event) => void setRemoteEnabled(host, event.currentTarget.checked)} /></FormRow>
              : <Button data-vault-retry-host disabled={state.busy} onClick={() => void refresh()}>Retry</Button>}
            {hostFailure && host.kind === 'ok' ? <span className="qvh-error-inline" role="status">Unavailable</span> : null}
          </div>
        })}
        {state.error ? <div className="qvh-error-inline" role="alert">{state.error}</div> : null}
        {state.scopeStatusError ? <div className="qvh-tip" role="status">{state.scopeStatusError}</div> : null}

        {status && (status.filesFailed > 0 || status.degradedRoots.length > 0) ? (
          <div className="qvh-degraded" role="status"><Badge tone="needs-you">Attention</Badge>
            {status.filesFailed > 0 ? `${status.filesFailed} session files could not be read and will be retried. ` : ''}
            {status.degradedRoots.length > 0 ? `${status.degradedRoots.length} session roots could not be checked.` : ''}
          </div>
        ) : null}
        {localIndexing ? <div className="qvh-progress" aria-label="Indexing local sessions"><span /></div> : null}
        {enableableHostCount > 0 ? <ListRow title="Enable on all available hosts" description="Enables the local index first, then enables each available host separately." trailing={<Button data-vault-enable-all disabled={state.busy} onClick={() => void enableAll()}>Enable all</Button>} /> : null}
      </section>
      <section className="qvh-settings-card">
        <SectionHeader title="Open in the sidebar" />
        <ListRow title="Agent Session History" description="Type what you remember, or inspect a previous session and continue it." trailing={<Button data-vault-open-sidebar disabled={state.busy} onClick={() => void openSidebar()}>Open</Button>} />
      </section>
      <details className="qvh-settings-card qvh-settings-advanced">
        <summary><SectionHeader title="Advanced" /></summary>
        <ListRow title="Clear search data" description="Turns off search first, then removes only the searchable copy from this computer. Agent transcripts are not affected." trailing={<Button variant="destructive" data-vault-clear-search disabled={state.busy || !status} onClick={() => void clear()}>Clear</Button>} />
        {status ? <div className="qvh-status-grid" aria-label="Search index counts">
          <div className="qvh-status-cell" data-vault-status-sessions><strong>{sessions.toLocaleString()}</strong><span>searchable sessions</span></div>
          <div className="qvh-status-cell" data-vault-status-messages><strong>{status.messagesIndexed.toLocaleString()}</strong><span>searchable messages</span></div>
          <div className="qvh-status-cell" data-vault-status-owed><strong>{status.filesDue.toLocaleString()}</strong><span>files still owed</span></div>
          <div className="qvh-status-cell" data-vault-status-failed><strong>{status.filesFailed.toLocaleString()}</strong><span>files needing retry</span></div>
          <div className="qvh-status-cell" data-vault-status-roots><strong>{status.degradedRoots.length.toLocaleString()}</strong><span>unchecked roots</span></div>
        </div> : null}
      </details>
    </section>
  )
}

export function mountSearchSettings(context: UiPluginContext, element: HTMLElement, props: { report?(state: unknown): void }): () => void {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0' })
  const root = createRoot(element)
  root.render(<SearchSettings context={context} report={props.report} embedded />)
  return () => root.unmount()
}

export function mountSearchSettingsView(context: UiPluginContext, element: HTMLElement, props: { report?(state: unknown): void }): () => void {
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0' })
  const root = createRoot(element)
  root.render(<SearchSettings context={context} report={props.report} />)
  return () => root.unmount()
}
