import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { HostOutcome, SearchStatus } from '../types'
import { HISTORY_PANEL_ID } from './model'
import { injectVaultStyles } from './styles'

type SettingsState = {
  status: SearchStatus | null
  hosts: HostOutcome[]
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
  const [state, setState] = useState<SettingsState>({ status: null, hosts: [], loading: true, busy: false, error: null, scopeStatusError: null })

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
      setState((current) => ({ ...current, hosts: mergeHostOutcomes(current.hosts, outcomes, true), scopeStatusError: null }))
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
    const indexing = state.status?.enabled === true && (state.status.phase === 'indexing' || (state.status.phase === 'degraded' && state.status.filesDue > 0))
    const interval = indexing ? 2000 : 10_000
    const timer = window.setInterval(() => void refresh(), interval)
    return () => window.clearInterval(timer)
  }, [state.status?.phase, state.status?.filesDue, context])

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
      failedHosts: state.hosts.filter((host) => host.kind !== 'ok').map((host) => host.hostId),
      busy: state.busy,
      error: state.error
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

  const enableAll = async () => {
    const hosts = state.hosts.filter((host) => host.hostId !== 'local' && host.kind === 'ok')
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
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: `Could not enable local search. ${errorText(error)}` }))
      return
    }
    for (const host of hosts) {
      try {
        const response = await context.call('quirky.vault/setSearchEnabled', { enabled: true, host: host.hostId })
        if (!searchStatus(response)?.enabled) throw new Error('The host did not confirm its enabled state.')
      } catch (error) {
        failures.push(`${host.label}: ${errorText(error)}`)
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
      await context.call('quirky.vault/setView', { focusedSearch: true })
      context.togglePanel(HISTORY_PANEL_ID, true)
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
  const indexing = status?.enabled === true && (status.phase === 'indexing' || (status.phase === 'degraded' && status.filesDue > 0))
  const total = (status?.filesIndexed ?? 0) + (status?.filesDue ?? 0)
  const remoteCount = state.hosts.filter((host) => host.hostId !== 'local' && host.kind === 'ok').length

  return (
    <section className={`qvh-root qvh-settings${embedded ? ' qvh-embedded' : ''}`} data-vault-settings data-vault-search-status={status?.phase ?? 'unavailable'}>
      {!embedded ? <>
        <h2 className="qvh-settings-heading">Agent Session Search</h2>
        <p className="qvh-settings-description">Search everything your agents have said and done on this computer and other available hosts.</p>
      </> : null}
      <div className="qvh-settings-card">
        <h3>Search inside sessions</h3>
        <p className="qvh-settings-description">{disclosure}</p>
        <div className="qvh-settings-row">
          <div className="qvh-settings-copy">
            <strong>Local Mac</strong>
            <p>{status?.enabled ? (indexing ? `${status.filesIndexed} of ${total} sessions indexed · ${status.messagesIndexed.toLocaleString()} messages searchable` : `${sessions} sessions · ${status.messagesIndexed.toLocaleString()} messages searchable`) : state.loading ? 'Checking search status…' : 'Transcript search is off. Only titles are filtered until enabled.'}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label="Enable local Agent Session Search"
            data-vault-search-enabled
            checked={status?.enabled ?? false}
            disabled={state.busy || !status}
            onChange={(event) => void setEnabled(event.currentTarget.checked)}
          />
        </div>
        {state.error ? <div className="qvh-error-inline" role="alert">{state.error}</div> : null}
        {state.scopeStatusError ? <div className="qvh-tip" role="status">{state.scopeStatusError}</div> : null}
        {state.hosts.filter((host) => host.kind !== 'ok').map((host) => <div className="qvh-degraded" role="status" key={host.hostId}>{host.label}: {host.reason ?? 'This host is unavailable.'}</div>)}
        {status && (status.filesFailed > 0 || status.degradedRoots.length > 0) ? (
          <div className="qvh-degraded" role="status">
            {status.filesFailed > 0 ? `${status.filesFailed} session files could not be read and will be retried. ` : ''}
            {status.degradedRoots.length > 0 ? `${status.degradedRoots.length} session roots could not be checked.` : ''}
          </div>
        ) : null}
        {indexing ? <div className="qvh-progress" aria-label="Indexing sessions"><span /></div> : null}
        {remoteCount > 0 ? <div className="qvh-settings-row"><div className="qvh-settings-copy"><strong>Enable on all available hosts</strong><p>Enables the local index first, then enables each available host separately.</p></div><button type="button" className="qvh-button" data-vault-enable-all disabled={state.busy} onClick={() => void enableAll()}>Enable all</button></div> : null}
      </div>
      <div className="qvh-settings-card">
        <h3>Open in the sidebar</h3>
        <div className="qvh-settings-row">
          <div className="qvh-settings-copy"><strong>Agent Session History</strong><p>Type what you remember, or inspect a previous session and continue it.</p></div>
          <button type="button" className="qvh-button" data-vault-open-sidebar disabled={state.busy} onClick={() => void openSidebar()}>Open</button>
        </div>
      </div>
      <details className="qvh-settings-card qvh-settings-advanced">
        <summary>Advanced</summary>
        <div className="qvh-settings-row">
          <div className="qvh-settings-copy"><strong>Clear search data</strong><p>Turns off search first, then removes only the searchable copy from this computer. Agent transcripts are not affected.</p></div>
          <button type="button" className="qvh-button qvh-danger" data-vault-clear-search disabled={state.busy || !status} onClick={() => void clear()}>Clear</button>
        </div>
      </details>
      {status ? <div className="qvh-status-grid" aria-label="Search index counts">
        <div className="qvh-status-cell"><strong>{sessions.toLocaleString()}</strong><span>searchable sessions</span></div>
        <div className="qvh-status-cell"><strong>{status.messagesIndexed.toLocaleString()}</strong><span>searchable messages</span></div>
        <div className="qvh-status-cell"><strong>{status.filesFailed.toLocaleString()}</strong><span>files needing retry</span></div>
        <div className="qvh-status-cell"><strong>{status.degradedRoots.length.toLocaleString()}</strong><span>unchecked roots</span></div>
      </div> : null}
    </section>
  )
}

export function mountSearchSettings(context: UiPluginContext, element: HTMLElement, props: { report?(state: unknown): void }): () => void {
  injectVaultStyles(element.ownerDocument)
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0' })
  const root = createRoot(element)
  root.render(<SearchSettings context={context} report={props.report} embedded />)
  return () => root.unmount()
}

export function mountSearchSettingsView(context: UiPluginContext, element: HTMLElement, props: { report?(state: unknown): void }): () => void {
  injectVaultStyles(element.ownerDocument)
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', minWidth: '0' })
  const root = createRoot(element)
  root.render(<SearchSettings context={context} report={props.report} />)
  return () => root.unmount()
}
