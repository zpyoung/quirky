import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AffixInput, Badge, Button, Checkbox, ControlIcon, Dialog, DisclosureButton, Kbd, LinkButton, ProjectTile, ReachMeter, SegmentedControl, SelectField, StatusDot, TagButton, TextField, type ChoiceOption } from '@quirky/ui'
import { agentLabel } from '../agent-label'
import type { AvatarSettings, AvatarUiProps, Level, Mandate, SheetRow, SwitchId, Switches } from '../contracts'
import {
  applyLevel, applySharedGoal, applySwitches, buildHandoffInputs, commonLevel, detachSharedGoal, draftFromMandate, effectiveDoneWhenKind, errorSummary,
  groupRows, isSelectable, newDraft, patchDraft, projectSharesOneGoal, rowLabels, scopeState, sharedFollowers, submitLabel, summarizeHandoff,
  toggleRow, toggleScope, validateDrafts, type DraftErrors, type RowDraft, type SheetDefaults, type SortKey, type SummaryEntry
} from './sheet-model'

const LEVELS: { id: Level; label: string; note: string; title: string }[] = [
  { id: 'shadow', label: 'Shadow', note: 'Logs what it would do, acts on nothing', title: 'Shadow: logs what it would do, acts on nothing' },
  { id: 'local', label: 'Local', note: 'Nothing leaves this Mac', title: 'Local: nothing leaves this Mac' },
  { id: 'own-branch', label: 'Own branch', note: 'Can push and open draft PRs', title: 'Own branch: can push and open draft PRs' },
  { id: 'full', label: 'Full', note: 'Anything the mandate allows, merge included', title: 'Full: anything the mandate allows, merge included' }
]
const ROW_LEVEL_OPTIONS: ChoiceOption[] = LEVELS.map((level) => ({ value: level.id, label: level.label, title: level.title, caution: level.id === 'full' }))
const BULK_LEVEL_OPTIONS: ChoiceOption[] = LEVELS.map((level) => (
  level.id === 'full'
    ? { value: level.id, label: 'Full…', title: 'Anything the mandate allows, merge included; asks you to confirm', caution: true }
    : { value: level.id, label: level.label, title: level.note }
))
const SWITCHES: { id: SwitchId; label: string }[] = [
  { id: 'messaging', label: 'Message people' },
  { id: 'historyRewrite', label: 'Rewrite history' },
  { id: 'deploys', label: 'Deploy / migrate' }
]
const NO_SWITCHES: Switches = { messaging: false, historyRewrite: false, deploys: false }
// agents the permission gate can hook; others can't be supervised, so the sheet never offers them
const HOOKABLE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'pi', 'omp'])
const COMMAND_TITLE = 'It runs this command and stops when it passes'
const PROSE_TITLE = 'It reads the result and judges whether this is true'
const GOAL_PLACEHOLDER = 'e.g. Add pagination to the ledger…'
const CHECK_PLACEHOLDER = 'e.g. bun test passes…'

/** Drops the machine code prefix (`not-eligible: `, `invalid: `) from a handoff error so users read only the reason. */
const displayError = (error: string): string => error.replace(/^(?:not-eligible|invalid): /, '')

const rowBorder = 'var(--ui-border-width) solid var(--ui-border)'
const gap: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--ui-space-8)' }
const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)' }
const tight: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-6)', minWidth: 0 }
const meta: CSSProperties = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' }
const oneLine: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const table: CSSProperties = { display: 'grid', gridTemplateColumns: '2.5rem 13rem minmax(0, 1fr) 15rem 2.5rem', columnGap: 'var(--ui-space-12)' }
const rowGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'subgrid', gridColumn: '1 / -1', alignItems: 'start' }
const bandRow: CSSProperties = { ...rowGrid, padding: 'var(--ui-space-8) 0', borderTop: rowBorder, background: 'color-mix(in srgb, var(--ui-text) 3%, var(--ui-surface))' }
const headerRow: CSSProperties = { ...rowGrid, alignItems: 'center', padding: 'var(--ui-space-8) 0 var(--ui-space-4)', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-section)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }
const scopeRow: CSSProperties = { ...rowGrid, alignItems: 'center', paddingTop: 'var(--ui-space-12)' }
const scopeTitle: CSSProperties = { gridColumn: '2 / -1', display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)', fontSize: 'var(--ui-font-body)' }
const tabular: CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const barStyle: CSSProperties = { ...gap, padding: 'var(--ui-space-8) var(--ui-space-12)', border: rowBorder, borderRadius: 'var(--ui-radius-control)', background: 'color-mix(in srgb, var(--ui-accent) 6%, var(--ui-surface))' }
const bareFieldset: CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 }
const mono: CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'var(--ui-font-mono)' }

type AgentOption = { id: string; label: string }
type PowerState = { onBattery?: boolean; externalDisplay?: boolean | null }
type Loaded = { rows: SheetRow[]; drafts: Record<string, RowDraft>; agents: AgentOption[]; defaultAgent: string | null; defaultAgentLabel: string; defaultLevel: Level; power: PowerState | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRows(value: unknown): SheetRow[] {
  return Array.isArray(value) ? value.filter((row): row is SheetRow => isRecord(row) && typeof row.worktreeId === 'string') : []
}

function asAgents(value: unknown): { agents: AgentOption[]; defaultAgent: string | null; defaultAgentLabel: string } {
  if (!isRecord(value) || !Array.isArray(value.agents)) return { agents: [], defaultAgent: null, defaultAgentLabel: 'auto' }
  const agents = value.agents
    .filter((agent): agent is Record<string, unknown> => isRecord(agent) && typeof agent.id === 'string' && HOOKABLE_AGENTS.has(agent.id) && agent.installed !== false && agent.enabled !== false)
    .map((agent) => ({ id: agent.id as string, label: typeof agent.label === 'string' ? agent.label : (agent.id as string) }))
  const configured = typeof value.defaultAgent === 'string' ? value.defaultAgent : 'auto'
  const match = agents.find((agent) => agent.id === configured)
  const fallback = match ? match.label : agents.length > 0 ? agents[0].label : 'none installed'
  return { agents, defaultAgent: match ? match.id : null, defaultAgentLabel: fallback }
}

function asDefaults(value: unknown): Pick<SheetDefaults, 'level' | 'switches'> {
  if (!isRecord(value)) return { level: 'full', switches: NO_SWITCHES }
  const settings = value as Partial<AvatarSettings>
  const level = LEVELS.some((entry) => entry.id === settings.defaultLevel) ? (settings.defaultLevel as Level) : 'full'
  return { level, switches: { ...NO_SWITCHES, ...(isRecord(settings.switches) ? settings.switches : {}) } }
}

function asPower(value: unknown): PowerState | null {
  if (!isRecord(value) || !isRecord(value.powerState)) return null
  const power = value.powerState
  return {
    onBattery: typeof power.onBattery === 'boolean' ? power.onBattery : undefined,
    externalDisplay: typeof power.externalDisplay === 'boolean' ? power.externalDisplay : null
  }
}

async function attempt<T>(work: Promise<unknown>, read: (value: unknown) => T, fallback: T): Promise<T> {
  try {
    return read(await work)
  } catch {
    return fallback
  }
}

async function loadSheet(context: AvatarUiProps['context']): Promise<Loaded> {
  const [rows, defaults, listing, power] = await Promise.all([
    context.call('quirky.avatar/eligibility', {}).then(asRows),
    attempt(context.call('quirky.avatar/settings', {}), asDefaults, asDefaults(null)),
    attempt(context.call('quirky.agents/list', {}), asAgents, asAgents(null)),
    attempt(context.call('quirky.avatar/status', {}), asPower, null)
  ])
  const base: SheetDefaults = { ...defaults, agent: listing.defaultAgent }
  const drafts: Record<string, RowDraft> = {}
  await Promise.all(rows.map(async (row) => {
    drafts[row.worktreeId] = newDraft(base)
    // a taken-back row keeps its mandate, so every row is asked, not just handed-off ones
    const mandate = await attempt(context.call('quirky.avatar/mandate', { worktreeId: row.worktreeId }), (value) => (isRecord(value) ? (value as Mandate) : null), null)
    if (mandate) drafts[row.worktreeId] = draftFromMandate(mandate)
  }))
  return { rows, drafts, agents: listing.agents, defaultAgent: listing.defaultAgent, defaultAgentLabel: listing.defaultAgentLabel, defaultLevel: defaults.level, power }
}

function preselectedIds(input: unknown, rows: SheetRow[]): string[] {
  const wanted = isRecord(input) && Array.isArray(input.worktreeIds) ? input.worktreeIds.filter((id): id is string => typeof id === 'string') : []
  return rows.filter((row) => isSelectable(row) && wanted.includes(row.worktreeId)).map((row) => row.worktreeId)
}

function powerWarning(power: PowerState | null): string | null {
  if (!power) return null
  if (power.onBattery === true) return 'On battery: macOS will sleep anyway, which pauses the avatar. Plug in to keep it working.'
  if (power.externalDisplay === false) return 'Closing the lid without an external display puts the Mac to sleep, which pauses the avatar.'
  return null
}

function newSharedId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `shared-${Date.now().toString(36)}`
}

function NameList({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <Fragment key={`${name}-${index}`}>
          {index > 0 && (index === names.length - 1 ? ' and ' : ', ')}
          <span translate="no">{name}</span>
        </Fragment>
      ))}
    </>
  )
}

function SummaryList({ entries }: { entries: SummaryEntry[] }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: 'var(--ui-space-2) var(--ui-space-12)', fontSize: 'var(--ui-font-body)' }}>
      {entries.map((entry) => (
        <Fragment key={entry.key}>
          <dt style={{ color: entry.tone === 'needs-you' ? 'var(--ui-needs-you)' : 'var(--ui-text)' }}>{entry.term}</dt>
          <dd style={{ margin: 0, color: 'var(--ui-muted)' }}>
            {entry.text !== null ? entry.text : <>{entry.preposition} <NameList names={entry.names} /></>}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

function RowDetails({ row, label, draft, agents, defaultAgentLabel, agentName, onPatch }: {
  row: SheetRow
  label: string
  draft: RowDraft
  agents: AgentOption[]
  defaultAgentLabel: string
  agentName: string
  onPatch: (patch: Partial<RowDraft>) => void
}) {
  const guidelinesId = useId()
  const notesId = useId()
  const fieldLabel: CSSProperties = { color: 'var(--ui-text)', fontSize: 'var(--ui-font-label)', fontWeight: 600 }
  return (
    <div data-avatar-details={row.worktreeId} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--ui-space-12) var(--ui-space-24)', marginTop: 'var(--ui-space-8)', paddingTop: 'var(--ui-space-12)', borderTop: rowBorder }}>
      <fieldset aria-label={`Also allow for ${label}`} style={{ ...bareFieldset, gridColumn: '1 / -1' }}>
        <legend style={{ ...fieldLabel, padding: 0, marginBottom: 'var(--ui-space-4)' }}>Also allow <span style={meta}>· these go past the level</span></legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--ui-space-8)' }}>
          {SWITCHES.map((entry) => (
            <Checkbox
              key={entry.id}
              aria-label={`${entry.label} (${label})`}
              tone={draft.switches[entry.id] ? 'needs-you' : undefined}
              checked={draft.switches[entry.id]}
              onChange={(event) => onPatch({ switches: { ...draft.switches, [entry.id]: event.target.checked } })}
            >{entry.label}</Checkbox>
          ))}
        </div>
      </fieldset>
      <div style={tight}>
        <label htmlFor={guidelinesId} style={fieldLabel}>Guidelines <span style={meta}>· one per line</span></label>
        <textarea
          id={guidelinesId}
          className="ui-text-field__input ui-text-area"
          aria-label={`Guidelines for ${label}`}
          name={`guidelines-${row.worktreeId}`}
          rows={3}
          value={draft.guidelines}
          onChange={(event) => onPatch({ guidelines: event.target.value })}
        />
      </div>
      <div style={tight}>
        <label htmlFor={notesId} style={fieldLabel}>Notes</label>
        <input
          id={notesId}
          className="ui-text-field__input"
          aria-label={`Notes for ${label}`}
          name={`notes-${row.worktreeId}`}
          autoComplete="off"
          placeholder="e.g. The CSV must open in Excel…"
          value={draft.notes}
          onChange={(event) => onPatch({ notes: event.target.value })}
        />
        <Checkbox aria-label={`Let it split work into new worktrees (${label})`} checked={draft.allowSplit} onChange={(event) => onPatch({ allowSplit: event.target.checked })}>Let it split work into new worktrees</Checkbox>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        {row.running ? (
          <span style={meta}>{`Keeps running ${agentName}; the avatar briefs it at its next idle prompt.`}</span>
        ) : (
          <SelectField label={`Agent to start for ${label}`} value={draft.agent ?? ''} onChange={(event) => onPatch({ agent: event.target.value === '' ? null : event.target.value })}>
            <option value="">{`Default (${defaultAgentLabel})`}</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
          </SelectField>
        )}
      </div>
    </div>
  )
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return <span id={id} className="ui-error-text">{children}</span>
}

function SheetRowView({ row, label, draft, errors, open, follower, agents, defaultAgent, defaultAgentLabel, defaultLevel, labelOf, selected, onSelect, onToggle, onPatch, onDetach }: {
  row: SheetRow
  label: string
  draft: RowDraft
  errors: DraftErrors | undefined
  open: boolean
  follower: string | null
  agents: AgentOption[]
  defaultAgent: string
  defaultAgentLabel: string
  defaultLevel: Level
  labelOf: (id: string) => string
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onPatch: (patch: Partial<RowDraft>) => void
  onDetach: () => void
}) {
  const id = useId()
  const kind = effectiveDoneWhenKind(draft)
  const isCommand = kind === 'command'
  const running = row.running
  const agentName = row.agent ? labelOf(row.agent) : null
  const startName = draft.agent ? labelOf(draft.agent) : defaultAgent
  const level = LEVELS.find((entry) => entry.id === draft.level) ?? LEVELS[0]
  const enabledSwitches = SWITCHES.filter((entry) => draft.switches[entry.id])
  return (
    <div role="row" data-avatar-row={row.worktreeId} style={bandRow}>
      <div role="cell" style={{ justifySelf: 'center' }}>
        <Checkbox aria-label={`Select ${label}`} checked={selected} onChange={onSelect} />
      </div>
      <div role="cell" style={{ ...tight, gap: 'var(--ui-space-4)', paddingTop: 'var(--ui-space-6)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-6)', minWidth: 0 }}>
          <span translate="no" title={row.name} style={{ ...oneLine, fontWeight: 500 }}>{row.name}</span>
          {row.handedOff && <Badge>Updating</Badge>}
        </span>
        {agentName ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-6)', fontSize: 'var(--ui-font-label)' }}>
            <StatusDot status={running ? 'working' : 'idle'} />
            {`${agentName}, ${running ? 'running' : 'idle'}`}
          </span>
        ) : (
          <>
            <span style={meta}>No agent yet</span>
            <span style={meta}>{`Starts ${startName} when handed off`}</span>
          </>
        )}
        {agentName && row.handedOff && running && <span style={meta}>{`Re-briefs ${agentName} at its next idle prompt`}</span>}
        {enabledSwitches.length > 0 && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4)' }}>
            {enabledSwitches.map((entry) => <Badge key={entry.id} tone="needs-you">{`+ ${entry.label}`}</Badge>)}
          </span>
        )}
        {row.ungatedNote && <span className="ui-help-text">{row.ungatedNote}</span>}
      </div>
      <div role="cell" style={tight}>
        {follower !== null ? (
          <div style={{ ...gap, minHeight: '2rem', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-body)' }}>
            <span>Same goal and done-when as <strong translate="no" style={{ color: 'var(--ui-text)', fontWeight: 500 }}>{follower}</strong></span>
            <LinkButton onClick={onDetach}>Write its own</LinkButton>
          </div>
        ) : (
          <>
            <input
              className="ui-text-field__input"
              style={{ fontWeight: 500 }}
              name={`goal-${row.worktreeId}`}
              autoComplete="off"
              aria-label={`Goal for ${label}`}
              aria-invalid={errors?.goal ? true : undefined}
              aria-describedby={errors?.goal ? `${id}-goal` : undefined}
              data-avatar-field={`${row.worktreeId}:goal`}
              placeholder={GOAL_PLACEHOLDER}
              value={draft.goal}
              onChange={(event) => onPatch({ goal: event.target.value })}
            />
            {errors?.goal && <FieldError id={`${id}-goal`}>{errors.goal}</FieldError>}
            <AffixInput
              prefixText="Done when"
              mono={isCommand}
              name={`done-${row.worktreeId}`}
              autoComplete="off"
              spellCheck={isCommand ? false : undefined}
              translate={isCommand ? 'no' : undefined}
              aria-label={`Done when for ${label}`}
              aria-invalid={errors?.doneWhen ? true : undefined}
              aria-describedby={[`${id}-kind`, errors?.doneWhen ? `${id}-done` : null].filter(Boolean).join(' ')}
              data-avatar-field={`${row.worktreeId}:doneWhen`}
              placeholder={CHECK_PLACEHOLDER}
              value={draft.doneWhen}
              onChange={(event) => onPatch({ doneWhen: event.target.value })}
              suffix={
                <TagButton
                  id={`${id}-kind`}
                  title={isCommand ? COMMAND_TITLE : PROSE_TITLE}
                  aria-label={`Done when for ${label} is checked by ${isCommand ? 'running it' : 'judging it'}; press to switch`}
                  onClick={() => onPatch({ doneWhenKind: isCommand ? 'prose' : 'command' })}
                >{isCommand ? 'runs it' : 'judges it'}</TagButton>
              }
            />
            {errors?.doneWhen && <FieldError id={`${id}-done`}>{errors.doneWhen}</FieldError>}
          </>
        )}
        {open && <RowDetails row={row} label={label} draft={draft} agents={agents} defaultAgentLabel={defaultAgentLabel} agentName={agentName ?? startName} onPatch={onPatch} />}
      </div>
      <div role="cell" style={tight}>
        <ReachMeter label={`Level for ${label}`} options={ROW_LEVEL_OPTIONS} value={draft.level} onChange={(value) => onPatch({ level: value as Level })} />
        <span style={meta}>{level.note}{draft.level === defaultLevel && <> · <span style={{ color: 'var(--ui-text)' }}>your default</span></>}</span>
      </div>
      <div role="cell">
        <DisclosureButton label={`${open ? 'Hide' : 'Show'} details for ${label}`} expanded={open} onClick={onToggle} />
      </div>
    </div>
  )
}

function HeldBack({ rows, labels }: { rows: SheetRow[]; labels: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false)
  const reasons = new Set(rows.map((row) => row.reason ?? "Can't hand off"))
  const sharedReason = reasons.size === 1 ? [...reasons][0] : null
  const names = rows.map((row) => labels.get(row.worktreeId) ?? row.name)
  return (
    <>
      <div role="row" data-avatar-held-back style={{ ...rowGrid, alignItems: 'center', padding: 'var(--ui-space-12) 0', marginTop: 'var(--ui-space-12)', borderTop: rowBorder }}>
        <span role="cell" aria-hidden="true" style={{ justifySelf: 'center', color: 'var(--ui-needs-you)', display: 'inline-flex' }}>
          <svg viewBox="0 0 14 14" style={{ width: '0.875rem', height: '0.875rem' }}><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" fill="none" /><path d="M7 4v3.5M7 9.8v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </span>
        <div role="cell" style={{ gridColumn: '2 / 4', ...tight, gap: 'var(--ui-space-2)' }}>
          <span style={{ fontSize: 'var(--ui-font-body)' }}>
            <strong>{`${rows.length} ${rows.length === 1 ? 'worktree' : 'worktrees'} held back`}</strong>
            <span style={{ color: 'var(--ui-muted)' }}>: <NameList names={names} /></span>
          </span>
          {sharedReason !== null && <span style={meta}>{sharedReason}</span>}
        </div>
        <div role="cell" style={{ gridColumn: '4 / -1', justifySelf: 'end' }}>
          <Button aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide' : `Show ${rows.length}`}</Button>
        </div>
      </div>
      {open && rows.map((row, index) => (
        <div key={row.worktreeId} role="row" aria-disabled="true" data-avatar-row={row.worktreeId} style={{ ...rowGrid, padding: 'var(--ui-space-4) 0', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-body)' }}>
          <span role="cell" />
          <span role="cell" translate="no" title={row.name} style={{ ...oneLine, color: 'var(--ui-text)' }}>{names[index]}</span>
          <span role="cell" style={{ gridColumn: '3 / -1' }}>{row.reason ?? "Can't hand off"}</span>
        </div>
      ))}
    </>
  )
}

/**
 * The hand-off sheet. It lists every local worktree grouped by group then project, lets the person
 * fill a mandate per row or one shared goal for a selection, and on Hand off sends the batch to
 * `quirky.avatar/handoff` and closes without waiting. `input.worktreeIds` preselects rows.
 */
export default function Sheet({ context, input, onClose }: AvatarUiProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [sharedOpen, setSharedOpen] = useState(false)
  const [sharedGoal, setSharedGoal] = useState('')
  const [sharedDoneWhen, setSharedDoneWhen] = useState('')
  const [confirmFull, setConfirmFull] = useState(false)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const cancelFull = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    loadSheet(context).then(
      (result) => {
        if (cancelled) return
        const picked = preselectedIds(input, result.rows)
        setLoaded(result)
        setDrafts(result.drafts)
        setSelected(new Set(picked))
        setExpanded(new Set(picked.length === 1 ? picked : []))
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      }
    )
    return () => { cancelled = true }
  }, [context, input])

  const rows = loaded?.rows ?? []
  const labels = useMemo(() => rowLabels(rows), [rows])
  const groups = useMemo(() => groupRows(rows, { filter, sort, onlyRunning }), [rows, filter, sort, onlyRunning])
  const errors = useMemo(() => validateDrafts(rows, selected, drafts), [rows, selected, drafts])
  const selectedIds = rows.filter((row) => isSelectable(row) && selected.has(row.worktreeId)).map((row) => row.worktreeId)
  const warning = powerWarning(loaded?.power ?? null)
  const visibleRows = groups.flatMap((group) => group.rows)
  const heldBack = visibleRows.filter((row) => !isSelectable(row))
  const followers = useMemo(() => {
    const found = new Map<string, string>()
    for (const group of groups) for (const project of group.projects) for (const [id, leader] of sharedFollowers(project.rows.filter(isSelectable), drafts)) found.set(id, leader)
    return found
  }, [groups, drafts])
  const followersRef = useRef(followers)
  followersRef.current = followers
  const labelOf = (id: string) => loaded?.agents.find((agent) => agent.id === id)?.label ?? agentLabel(id)
  const defaultLabel = loaded?.defaultAgentLabel ?? 'auto'
  const defaultAgent = defaultLabel === 'auto' || defaultLabel === 'none installed' ? 'the default agent' : defaultLabel
  const summary = useMemo(() => summarizeHandoff(rows, selectedIds, drafts, labels), [rows, selectedIds.join('\n'), drafts, labels])
  const problem = showErrors ? errorSummary(errors) : null

  const patchRow = (id: string, patch: Partial<RowDraft>) => setDrafts((current) => {
    const next = { ...current, [id]: patchDraft(current[id], patch) }
    if ('doneWhen' in patch || 'doneWhenKind' in patch) {
      for (const [follower, leader] of followersRef.current) {
        if (leader === id) next[follower] = { ...next[follower], doneWhen: next[id].doneWhen, doneWhenKind: next[id].doneWhenKind }
      }
    }
    return next
  })
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const focusField = (key: string) => {
    const field = [...(root.current?.querySelectorAll<HTMLElement>('[data-avatar-field]') ?? [])].find((element) => element.dataset.avatarField === key)
    field?.focus()
    return field !== undefined
  }
  useEffect(() => {
    if (pendingFocus !== null && focusField(pendingFocus)) setPendingFocus(null)
  }, [pendingFocus])
  useEffect(() => {
    if (confirmFull) cancelFull.current?.focus()
  }, [confirmFull])

  const goToFirstInvalid = () => {
    const order = visibleRows.filter(isSelectable).map((row) => row.worktreeId)
    const id = order.find((candidate) => errors[candidate]) ?? Object.keys(errors)[0]
    if (id === undefined) return
    if (!order.includes(id)) {
      setFilter('')
      setOnlyRunning(false)
    }
    setPendingFocus(`${id}:${errors[id].goal ? 'goal' : 'doneWhen'}`)
  }

  const submit = () => {
    if (selectedIds.length === 0) return
    const items = buildHandoffInputs(rows, selected, drafts)
    if (items.length === 0 || Object.keys(errors).length > 0) {
      setShowErrors(true)
      goToFirstInvalid()
      return
    }
    const names = new Map(rows.map((row) => [row.worktreeId, row.name]))
    context.call('quirky.avatar/handoff', { items }).then(
      (result) => {
        const results = isRecord(result) && Array.isArray(result.results) ? result.results : []
        for (const entry of results) {
          if (!isRecord(entry) || entry.ok !== false) continue
          const id = String(entry.worktreeId)
          context.toast(`Could not hand off ${names.get(id) ?? id}`, typeof entry.error === 'string' ? displayError(entry.error) : 'The avatar refused it.', { kind: 'warning' })
        }
      },
      (error: unknown) => context.toast('Hand-off failed', error instanceof Error ? error.message : String(error), { kind: 'error' })
    )
    onClose?.()
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      event.preventDefault()
      submitRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const applyShared = () => {
    if (sharedGoal.trim() === '') return
    setDrafts((current) => applySharedGoal(current, selectedIds, { id: newSharedId(), goal: sharedGoal.trim(), doneWhen: sharedDoneWhen }))
    setSharedOpen(false)
    setSharedGoal('')
    setSharedDoneWhen('')
  }

  const chooseBulkLevel = (value: string) => {
    if (value === 'full') {
      setConfirmFull(true)
      return
    }
    setConfirmFull(false)
    setDrafts((current) => applyLevel(current, selectedIds, value as Level))
  }

  const countLabel = submitLabel(rows, selectedIds)
  const actions = (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 'var(--ui-space-24)', alignItems: 'end', flex: '1 1 100%' }}>
      <div style={tight}>
        {summary.length > 0 && (
          <>
            <h3 style={{ margin: 0, fontSize: 'var(--ui-font-body)', fontWeight: 600 }}>While you’re away, the avatar may</h3>
            <SummaryList entries={summary} />
          </>
        )}
        <span className="ui-help-text">House rules from Settings apply to all.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--ui-space-8)' }}>
        <span aria-live="polite">
          {problem !== null && <LinkButton tone="failing" onClick={goToFirstInvalid}>{`${problem} · Go to it`}</LinkButton>}
        </span>
        <div style={{ display: 'flex', gap: 'var(--ui-space-8)' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={selectedIds.length === 0} aria-keyshortcuts="Meta+Enter Control+Enter" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-8)' }} onClick={submit}>
            {countLabel}
            <Kbd aria-hidden="true">⌘ ↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )

  const everySelectedHas = (id: SwitchId) => selectedIds.length > 0 && selectedIds.every((worktreeId) => drafts[worktreeId]?.switches[id])

  return (
    <Dialog
      open
      title="Hand off to avatar"
      description="It works these worktrees while you’re away. Each level sets how far it may reach; anything past that waits for you. Take any of them back from the Avatar pill."
      size="xwide"
      scrollBody
      onClose={onClose}
      actions={actions}
    >
      <div ref={root} style={stack} data-avatar-ui="sheet">
        {failure !== null && <span role="alert">{`Could not load worktrees: ${failure}`}</span>}
        {failure === null && loaded === null && <span>Loading worktrees…</span>}
        {warning && <span role="status">{warning}</span>}
        {loaded !== null && (
          <>
            <div style={gap}>
              <div style={{ position: 'relative', flex: '1 1 21rem', display: 'flex', alignItems: 'center' }}>
                <span aria-hidden="true" style={{ position: 'absolute', insetInlineStart: 'var(--ui-space-8)', color: 'var(--ui-muted)', display: 'inline-flex', pointerEvents: 'none' }}><ControlIcon name="magnifying-glass" size={14} /></span>
                <input
                  className="ui-text-field__input"
                  style={{ paddingInlineStart: '1.75rem' }}
                  type="text"
                  name="filter"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Filter"
                  placeholder="Filter worktrees, branches, agents…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              <label htmlFor="avatar-sheet-sort" style={meta}>Sort</label>
              <select id="avatar-sheet-sort" name="sort" className="ui-text-field__input ui-select-field" style={{ width: '7rem' }} value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                <option value="name">Name</option>
                <option value="project">Project</option>
                <option value="state">State</option>
              </select>
              <Checkbox checked={onlyRunning} onChange={(event) => setOnlyRunning(event.target.checked)}>Only with a running agent</Checkbox>
            </div>
            {selectedIds.length > 0 && (
              <div style={stack}>
                <div style={barStyle} role="group" aria-label="Bulk edit">
                  <b aria-live="polite" style={{ ...tabular, fontSize: 'var(--ui-font-body)' }}>{`${selectedIds.length} selected`}</b>
                  <span style={meta}>Set level</span>
                  <SegmentedControl label="Set level for all selected" options={BULK_LEVEL_OPTIONS} value={confirmFull ? 'full' : commonLevel(drafts, selectedIds)} onChange={chooseBulkLevel} />
                  <fieldset aria-label="Also allow for all selected" style={{ ...bareFieldset, ...gap, gap: 0 }}>
                    <legend style={{ position: 'absolute', width: '0.0625rem', height: '0.0625rem', overflow: 'hidden', clipPath: 'inset(50%)' }}>Also allow for all selected</legend>
                    <span aria-hidden="true" style={meta}>Also allow</span>
                    {SWITCHES.map((entry) => (
                      <Checkbox
                        key={entry.id}
                        tone={everySelectedHas(entry.id) ? 'needs-you' : undefined}
                        checked={everySelectedHas(entry.id)}
                        onChange={(event) => setDrafts((current) => applySwitches(current, selectedIds, { [entry.id]: event.target.checked }))}
                      >{entry.label}</Checkbox>
                    ))}
                  </fieldset>
                  <Button onClick={() => setSharedOpen((open) => !open)}>Give one shared goal…</Button>
                  <Button onClick={() => { setSelected(new Set()); setConfirmFull(false) }}>Clear</Button>
                </div>
                {confirmFull && (
                  <div role="group" aria-label="Confirm Full for all selected" style={{ ...barStyle, borderColor: 'var(--ui-needs-you)' }}>
                    <span style={{ fontSize: 'var(--ui-font-body)', flex: '1 1 20rem' }}>{`Full lets the avatar merge and do anything each mandate allows, on ${selectedIds.length} ${selectedIds.length === 1 ? 'worktree' : 'worktrees'}.`}</span>
                    <Button variant="primary" onClick={() => { setDrafts((current) => applyLevel(current, selectedIds, 'full')); setConfirmFull(false) }}>Set Full</Button>
                    <Button ref={cancelFull} onClick={() => setConfirmFull(false)}>Cancel</Button>
                  </div>
                )}
                {sharedOpen && (
                  <div style={gap}>
                    <TextField label="Shared goal" value={sharedGoal} onChange={(event) => setSharedGoal(event.target.value)} />
                    <TextField label="Shared done when" value={sharedDoneWhen} onChange={(event) => setSharedDoneWhen(event.target.value)} />
                    <Button variant="primary" disabled={sharedGoal.trim() === ''} onClick={applyShared}>Apply shared goal</Button>
                  </div>
                )}
              </div>
            )}
            {groups.length === 0 ? (
              <span>{rows.length === 0 ? 'No worktrees to hand off.' : 'No worktrees match.'}</span>
            ) : (
              <div role="table" aria-label="Worktrees to hand off" style={table}>
                <div role="row" style={headerRow}>
                  <span role="columnheader" aria-label="Select" />
                  <span role="columnheader">Worktree</span>
                  <span role="columnheader">Mandate</span>
                  <span role="columnheader">Level</span>
                  <span role="columnheader" aria-label="Details" />
                </div>
                {groups.map((group) => {
                  const groupScope = scopeState(group.rows, selected)
                  return (
                    <Fragment key={group.id ?? 'ungrouped'}>
                      {groupScope.total > 0 && (
                        <div role="row" data-avatar-group={group.id ?? 'ungrouped'} style={scopeRow}>
                          <div role="cell" style={{ justifySelf: 'center' }}>
                            <Checkbox aria-label={`Select group ${group.name}`} checked={groupScope.state === 'all'} indeterminate={groupScope.state === 'some'} onChange={() => setSelected((current) => toggleScope(current, group.rows))} />
                          </div>
                          <span role="rowheader" style={scopeTitle}><b>{group.name}</b><span style={{ ...meta, ...tabular }}>{`${groupScope.selected} of ${groupScope.total} selected`}</span></span>
                        </div>
                      )}
                      {group.projects.map((project) => {
                        const scope = scopeState(project.rows, selected)
                        if (scope.total === 0) return null
                        return (
                          <Fragment key={project.id}>
                            <div role="row" data-avatar-project={project.id} style={scopeRow}>
                              <div role="cell" style={{ justifySelf: 'center' }}>
                                <Checkbox aria-label={`Select project ${project.name}`} checked={scope.state === 'all'} indeterminate={scope.state === 'some'} onChange={() => setSelected((current) => toggleScope(current, project.rows))} />
                              </div>
                              <span role="rowheader" style={scopeTitle}>
                                <ProjectTile name={project.name} size={18} />
                                <strong translate="no">{project.name}</strong>
                                <span style={{ ...meta, ...tabular }}>{`${scope.selected} of ${scope.total}`}</span>
                                {projectSharesOneGoal(project.rows, selected, drafts) && <Badge tone="accent">One shared goal</Badge>}
                              </span>
                            </div>
                            {project.rows.filter(isSelectable).map((row) => {
                              const leader = followers.get(row.worktreeId)
                              return (
                                <SheetRowView
                                  key={row.worktreeId}
                                  row={row}
                                  label={labels.get(row.worktreeId) ?? row.name}
                                  draft={drafts[row.worktreeId]}
                                  errors={showErrors ? errors[row.worktreeId] : undefined}
                                  open={expanded.has(row.worktreeId)}
                                  follower={leader === undefined ? null : labels.get(leader) ?? leader}
                                  agents={loaded.agents}
                                  defaultAgent={defaultAgent}
                                  defaultAgentLabel={defaultLabel}
                                  defaultLevel={loaded.defaultLevel}
                                  labelOf={labelOf}
                                  selected={selected.has(row.worktreeId)}
                                  onSelect={() => setSelected((current) => toggleRow(current, row))}
                                  onToggle={() => toggleExpanded(row.worktreeId)}
                                  onPatch={(patch) => patchRow(row.worktreeId, patch)}
                                  onDetach={() => {
                                    setDrafts((current) => detachSharedGoal(current, row.worktreeId))
                                    setPendingFocus(`${row.worktreeId}:goal`)
                                  }}
                                />
                              )
                            })}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  )
                })}
                {heldBack.length > 0 && <HeldBack rows={heldBack} labels={labels} />}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
