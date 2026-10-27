import { useSyncExternalStore, type ReactNode } from 'react'
import type { AgentListing, PermissionMode } from '../core/types'
import { AgentRow } from './AgentRow'
import { Segmented, Switch } from './controls'
import { MODE_LABEL, startable, type AgentsStore } from './model'
import { s } from './styles'

const TRUST_TITLE = 'Trust the folder when Quirky starts an agent'
const MODES: PermissionMode[] = ['manual', 'auto', 'yolo']

function Section({ title, hint, badge, action, children }: { title: string; hint?: string; badge?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={s.section}>
      <div style={s.headRow}>
        <div>
          <div style={s.headRow}>
            <h2 style={s.sectionTitle}>{title}</h2>
            {badge !== undefined && (
              <span className="badge" style={{ margin: 0 }}>
                {badge}
              </span>
            )}
          </div>
          {hint !== undefined && <p style={s.hint}>{hint}</p>}
        </div>
        {action !== undefined && <div style={s.spacer}>{action}</div>}
      </div>
      {children}
    </section>
  )
}

function permissionsHint({ summary, nonAuto }: AgentListing['permissions']): string {
  if (summary === 'auto') return 'Supported agents approve safe actions on their own.'
  if (summary !== 'mixed') return 'How much agents can do without asking you. Agents with custom launch arguments keep them.'
  return nonAuto === 'mixed'
    ? 'Agents use different settings. Choosing a mode applies to all.'
    : `Most agents use ${MODE_LABEL[nonAuto]}. Choosing a mode resets the marked exceptions, except custom arguments.`
}

function DefaultAgent({ listing, store }: { listing: AgentListing; store: AgentsStore }) {
  const choice = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={listing.defaultAgent === value}
      className={listing.defaultAgent === value ? 'active' : undefined}
      onClick={() => void store.setDefault(value)}
    >
      {label}
    </button>
  )
  return (
    <Section title="Default Agent" hint="Defaults for new agents.">
      <div role="group" aria-label="Default agent" style={s.choices}>
        {choice('auto', 'Auto')}
        {startable(listing.agents).map((agent) => choice(agent.id, agent.label))}
        {choice('shell', 'Blank Terminal')}
      </div>
    </Section>
  )
}

function Permissions({ listing, store }: { listing: AgentListing; store: AgentsStore }) {
  const { summary } = listing.permissions
  return (
    <Section title="Agent Permissions" hint={permissionsHint(listing.permissions)}>
      <div>
        <Segmented
          value={summary === 'mixed' ? null : summary}
          options={MODES.map((value) => ({ value, label: MODE_LABEL[value] }))}
          label="Agent permissions"
          onChange={(mode) => mode !== summary && void store.setPermissions(mode)}
        />
      </div>
    </Section>
  )
}

function Listing({ listing, store, refreshing }: { listing: AgentListing; store: AgentsStore; refreshing: boolean }) {
  const installed = listing.agents.filter((agent) => agent.installed)
  const available = listing.agents.filter((agent) => !agent.installed)
  const rows = (agents: typeof installed) => (
    <ul style={s.list}>
      {agents.map((agent) => (
        <AgentRow key={agent.id} info={agent} listing={listing} store={store} />
      ))}
    </ul>
  )
  return (
    <>
      <Section
        title="Installed"
        badge={`${installed.length} detected`}
        action={
          <button type="button" disabled={refreshing} onClick={() => void store.refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      >
        {installed.length === 0 ? <p className="muted">No agents detected. Install one below, then Refresh.</p> : rows(installed)}
      </Section>
      {available.length > 0 && (
        <Section title="Available to install" badge={`${available.length} agents`}>
          {rows(available)}
        </Section>
      )}
    </>
  )
}

/** The Agents view: default agent, permissions, installed and installable agents, and the workspace-trust switch. */
export function AgentsView({ store }: { store: AgentsStore }) {
  const { status, listing, error, refreshing } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <div style={s.page}>
      <div style={s.column}>
        <header>
          <h1 style={s.title}>Agents</h1>
          <p style={s.hint}>Manage AI agents, set a default, and customize commands.</p>
        </header>
        {status === 'loading' && <p className="muted">Loading agents…</p>}
        {status === 'error' && (
          <div>
            <p className="form-error" role="alert">
              {error}
            </p>
            <button type="button" onClick={() => store.retry()}>
              Try again
            </button>
          </div>
        )}
        {listing && (
          <>
            <DefaultAgent listing={listing} store={store} />
            <Permissions listing={listing} store={store} />
            <Listing listing={listing} store={store} refreshing={refreshing} />
            <Section title="This Mac">
              <div style={s.inline}>
                <Switch checked={listing.workspaceTrust} label={TRUST_TITLE} onChange={(value) => void store.setTrust(value)} />
                <span>{TRUST_TITLE}</span>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
