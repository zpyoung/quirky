import { useSyncExternalStore, type ReactNode } from 'react'
import type { AgentListing, PermissionMode } from '../core/types'
import { Badge, Button, EmptyState, SectionHeader, ToolPanelFrame } from '@quirky/ui'
import { AgentRow } from './AgentRow'
import { Segmented, Switch } from './controls'
import { MODE_LABEL, startable, type AgentsStore } from './model'
import { s } from './styles'

const TRUST_TITLE = 'Trust the folder when Quirky starts an agent'
const MODES: PermissionMode[] = ['manual', 'auto', 'yolo']

function Section({ title, hint, badge, action, children }: { title: string; hint?: string; badge?: string; action?: ReactNode; children: ReactNode }) {
  const actions = badge !== undefined || action !== undefined ? (
    <div style={s.headActions}>
      {badge !== undefined && <Badge>{badge}</Badge>}
      {action}
    </div>
  ) : undefined
  return (
    <section style={s.section}>
      <SectionHeader title={title} actions={actions} />
      {hint !== undefined && <p style={s.sectionHint}>{hint}</p>}
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
    <Button
      key={value}
      type="button"
      variant={listing.defaultAgent === value ? 'primary' : 'secondary'}
      aria-pressed={listing.defaultAgent === value}
      onClick={() => void store.setDefault(value)}
    >
      {label}
    </Button>
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
      <Segmented
        value={summary === 'mixed' ? null : summary}
        options={MODES.map((value) => ({ value, label: MODE_LABEL[value] }))}
        label="Agent permissions"
        onChange={(mode) => mode !== summary && void store.setPermissions(mode)}
      />
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
          <Button type="button" disabled={refreshing} onClick={() => void store.refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        {installed.length === 0 ? <EmptyState message="No agents detected. Install one below, then Refresh." /> : rows(installed)}
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
    <div className="agents-ui" style={s.page}>
      <ToolPanelFrame title="Agents">
        <div style={s.column}>
          <p style={s.intro}>Manage AI agents, set a default, and customize commands.</p>
          {status === 'loading' && <p className="ui-help-text" role="status">Loading agents…</p>}
          {status === 'error' && (
            <div role="alert">
              <p className="ui-error-text">{error}</p>
              <Button type="button" onClick={() => store.retry()}>
                Try again
              </Button>
            </div>
          )}
          {listing && (
            <>
              <DefaultAgent listing={listing} store={store} />
              <Permissions listing={listing} store={store} />
              <Listing listing={listing} store={store} refreshing={refreshing} />
              <Section title="This Mac">
                <Switch checked={listing.workspaceTrust} label={TRUST_TITLE} onChange={(value) => void store.setTrust(value)} />
              </Section>
            </>
          )}
        </div>
      </ToolPanelFrame>
    </div>
  )
}
