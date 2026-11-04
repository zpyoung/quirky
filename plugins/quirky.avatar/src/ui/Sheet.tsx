import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, Dialog, SelectField, TextArea, TextField } from '@quirky/ui'
import type { AvatarSettings, AvatarUiProps, Level, Mandate, SheetRow, SwitchId, Switches } from '../contracts'
import {
  applyLevel, applySharedGoal, applySwitches, buildHandoffInputs, draftFromMandate, groupRows, isSelectable, newDraft, patchDraft,
  scopeState, toggleRow, toggleScope, validateDrafts, type RowDraft, type SheetDefaults, type SortKey
} from './sheet-model'

const LEVELS: { id: Level; label: string }[] = [
  { id: 'shadow', label: 'Shadow' },
  { id: 'local', label: 'Local' },
  { id: 'own-branch', label: 'Own branch' },
  { id: 'full', label: 'Full' }
]
const SWITCHES: { id: SwitchId; label: string }[] = [
  { id: 'messaging', label: 'Message people' },
  { id: 'historyRewrite', label: 'Rewrite history' },
  { id: 'deploys', label: 'Deploy / migrate' }
]
const NO_SWITCHES: Switches = { messaging: false, historyRewrite: false, deploys: false }
const COLUMNS = 7

const gap: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--ui-space-8)' }
const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)' }
const cell: CSSProperties = { padding: 'var(--ui-space-4)', verticalAlign: 'top', textAlign: 'start' }
const fullWidth: CSSProperties = { width: '100%' }

type AgentOption = { id: string; label: string }
type PowerState = { onBattery?: boolean; externalDisplay?: boolean | null }
type Loaded = { rows: SheetRow[]; drafts: Record<string, RowDraft>; agents: AgentOption[]; defaultAgent: string | null; defaultAgentLabel: string; power: PowerState | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRows(value: unknown): SheetRow[] {
  return Array.isArray(value) ? value.filter((row): row is SheetRow => isRecord(row) && typeof row.worktreeId === 'string') : []
}

function asAgents(value: unknown): { agents: AgentOption[]; defaultAgent: string | null; defaultAgentLabel: string } {
  if (!isRecord(value) || !Array.isArray(value.agents)) return { agents: [], defaultAgent: null, defaultAgentLabel: 'auto' }
  const agents = value.agents
    .filter((agent): agent is Record<string, unknown> => isRecord(agent) && typeof agent.id === 'string' && agent.installed !== false && agent.enabled !== false)
    .map((agent) => ({ id: agent.id as string, label: typeof agent.label === 'string' ? agent.label : (agent.id as string) }))
  const configured = typeof value.defaultAgent === 'string' ? value.defaultAgent : 'auto'
  const match = agents.find((agent) => agent.id === configured)
  return { agents, defaultAgent: match ? match.id : null, defaultAgentLabel: match ? match.label : configured }
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
    if (!row.handedOff) return
    const mandate = await attempt(context.call('quirky.avatar/mandate', { worktreeId: row.worktreeId }), (value) => (isRecord(value) ? (value as Mandate) : null), null)
    if (mandate) drafts[row.worktreeId] = draftFromMandate(mandate)
  }))
  return { rows, drafts, agents: listing.agents, defaultAgent: listing.defaultAgent, defaultAgentLabel: listing.defaultAgentLabel, power }
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

function Check({ label, checked, indeterminate = false, disabled = false, onChange }: { label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="ui-checkbox-label">
      <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}

function SwitchCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="ui-checkbox-label">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

function RowDetails({ row, draft, agents, defaultAgentLabel, onPatch }: {
  row: SheetRow
  draft: RowDraft
  agents: AgentOption[]
  defaultAgentLabel: string
  onPatch: (patch: Partial<RowDraft>) => void
}) {
  return (
    <div style={stack}>
      <TextArea
        label={`Guidelines for ${row.name}`}
        help="One per line."
        rows={3}
        value={draft.guidelines}
        onChange={(event) => onPatch({ guidelines: event.target.value })}
      />
      <div style={gap}>
        <span>Switches</span>
        {SWITCHES.map((entry) => (
          <SwitchCheck
            key={entry.id}
            label={`${entry.label} (${row.name})`}
            checked={draft.switches[entry.id]}
            onChange={(on) => onPatch({ switches: { ...draft.switches, [entry.id]: on } })}
          />
        ))}
      </div>
      {row.running ? (
        <span>Keeps running {row.agent ?? 'its agent'}; the avatar briefs it at its next idle prompt.</span>
      ) : (
        <SelectField label={`Agent to start for ${row.name}`} value={draft.agent ?? ''} onChange={(event) => onPatch({ agent: event.target.value === '' ? null : event.target.value })}>
          <option value="">{`Default (${defaultAgentLabel})`}</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
        </SelectField>
      )}
      <SelectField label={`Done when is, for ${row.name}`} value={draft.doneWhenKind} onChange={(event) => onPatch({ doneWhenKind: event.target.value as RowDraft['doneWhenKind'] })}>
        <option value="auto">Detect from the text</option>
        <option value="command">A command the avatar runs</option>
        <option value="prose">A description the avatar judges</option>
      </SelectField>
      <TextField label={`Notes for ${row.name}`} value={draft.notes} onChange={(event) => onPatch({ notes: event.target.value })} />
      <SwitchCheck label={`Allow the avatar to split work into new worktrees (${row.name})`} checked={draft.allowSplit} onChange={(on) => onPatch({ allowSplit: on })} />
    </div>
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
  const groups = useMemo(() => groupRows(rows, { filter, sort, onlyRunning }), [rows, filter, sort, onlyRunning])
  const errors = useMemo(() => validateDrafts(rows, selected, drafts), [rows, selected, drafts])
  const selectedIds = rows.filter((row) => isSelectable(row) && selected.has(row.worktreeId)).map((row) => row.worktreeId)
  const warning = powerWarning(loaded?.power ?? null)

  const patchRow = (id: string, patch: Partial<RowDraft>) => setDrafts((current) => ({ ...current, [id]: patchDraft(current[id], patch) }))
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const submit = () => {
    const items = buildHandoffInputs(rows, selected, drafts)
    if (items.length === 0 || Object.keys(errors).length > 0) {
      setShowErrors(true)
      return
    }
    const names = new Map(rows.map((row) => [row.worktreeId, row.name]))
    context.call('quirky.avatar/handoff', { items }).then(
      (result) => {
        const results = isRecord(result) && Array.isArray(result.results) ? result.results : []
        for (const entry of results) {
          if (!isRecord(entry) || entry.ok !== false) continue
          const id = String(entry.worktreeId)
          context.toast(`Could not hand off ${names.get(id) ?? id}`, typeof entry.error === 'string' ? entry.error : 'The avatar refused it.', { kind: 'warning' })
        }
      },
      (error: unknown) => context.toast('Hand-off failed', error instanceof Error ? error.message : String(error), { kind: 'error' })
    )
    onClose?.()
  }

  const applyShared = () => {
    if (sharedGoal.trim() === '') return
    setDrafts((current) => applySharedGoal(current, selectedIds, { id: newSharedId(), goal: sharedGoal.trim(), doneWhen: sharedDoneWhen }))
    setSharedOpen(false)
    setSharedGoal('')
    setSharedDoneWhen('')
  }

  const countLabel = `Hand off ${selectedIds.length} ${selectedIds.length === 1 ? 'worktree' : 'worktrees'}`
  const actions = (
    <>
      <span>House rules from Settings apply to all. Always held: anything outside these worktrees, and credentials.</span>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={selectedIds.length === 0} onClick={submit}>{countLabel}</Button>
    </>
  )

  const renderRow = (row: SheetRow) => {
    const draft = drafts[row.worktreeId]
    const rowErrors = showErrors ? errors[row.worktreeId] : undefined
    const open = expanded.has(row.worktreeId)
    const agentText = row.agent ? `${row.agent}${row.running ? ' · running' : ' · idle'}` : 'No agent'
    if (!isSelectable(row)) {
      return (
        <tr key={row.worktreeId} aria-disabled="true" data-avatar-row={row.worktreeId}>
          <td style={cell}><Check label={`Select ${row.name}`} checked={false} disabled onChange={() => {}} /></td>
          <td style={cell}>{row.name}</td>
          <td style={cell}>{agentText}</td>
          <td style={cell} colSpan={COLUMNS - 3}>{row.reason ?? "Can't hand off"}</td>
        </tr>
      )
    }
    return (
      <Fragment key={row.worktreeId}>
        <tr data-avatar-row={row.worktreeId}>
          <td style={cell}><Check label={`Select ${row.name}`} checked={selected.has(row.worktreeId)} onChange={() => setSelected((current) => toggleRow(current, row))} /></td>
          <td style={cell}>
            <div style={stack}>
              <span>{row.name}</span>
              {row.handedOff && <Badge tone="accent">Handed off</Badge>}
              {row.ungatedNote && <span className="ui-help-text">{row.ungatedNote}</span>}
            </div>
          </td>
          <td style={cell}>{agentText}</td>
          <td style={cell}>
            <input
              className="ui-text-field__input"
              style={fullWidth}
              aria-label={`Goal for ${row.name}`}
              aria-invalid={rowErrors?.goal ? true : undefined}
              value={draft.goal}
              onChange={(event) => patchRow(row.worktreeId, { goal: event.target.value })}
            />
            {draft.sharedGoal && <Badge tone="accent">Shared goal</Badge>}
            {rowErrors?.goal && <span className="ui-error-text" role="alert">{rowErrors.goal}</span>}
          </td>
          <td style={cell}>
            <input
              className="ui-text-field__input"
              style={fullWidth}
              aria-label={`Done when for ${row.name}`}
              aria-invalid={rowErrors?.doneWhen ? true : undefined}
              value={draft.doneWhen}
              onChange={(event) => patchRow(row.worktreeId, { doneWhen: event.target.value })}
            />
            {rowErrors?.doneWhen && <span className="ui-error-text" role="alert">{rowErrors.doneWhen}</span>}
          </td>
          <td style={cell}>
            <select className="ui-text-field__input ui-select-field" aria-label={`Level for ${row.name}`} value={draft.level} onChange={(event) => patchRow(row.worktreeId, { level: event.target.value as Level })}>
              {LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
            </select>
          </td>
          <td style={cell}>
            <Button aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`} aria-expanded={open} onClick={() => toggleExpanded(row.worktreeId)}>{open ? '▾' : '▸'}</Button>
          </td>
        </tr>
        {open && (
          <tr data-avatar-details={row.worktreeId}>
            <td />
            <td style={cell} colSpan={COLUMNS - 1}>
              <RowDetails row={row} draft={draft} agents={loaded?.agents ?? []} defaultAgentLabel={loaded?.defaultAgentLabel ?? 'auto'} onPatch={(patch) => patchRow(row.worktreeId, patch)} />
            </td>
          </tr>
        )}
      </Fragment>
    )
  }

  const everySelectedHas = (id: SwitchId) => selectedIds.length > 0 && selectedIds.every((worktreeId) => drafts[worktreeId]?.switches[id])

  return (
    <Dialog open title="Hand off to avatar" size="wide" scrollBody onClose={onClose} actions={actions}>
      <div style={stack} data-avatar-ui="sheet">
        {failure !== null && <span role="alert">{`Could not load worktrees: ${failure}`}</span>}
        {failure === null && loaded === null && <span>Loading worktrees…</span>}
        {warning && <span role="status">{warning}</span>}
        {loaded !== null && (
          <>
            <div style={gap}>
              <TextField label="Filter" placeholder="Filter worktrees, branches, agents…" value={filter} onChange={(event) => setFilter(event.target.value)} />
              <SelectField label="Sort" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                <option value="name">Name</option>
                <option value="project">Project</option>
                <option value="state">State</option>
              </SelectField>
              <SwitchCheck label="Only with a running agent" checked={onlyRunning} onChange={setOnlyRunning} />
            </div>
            {selectedIds.length > 0 && (
              <div style={stack} role="group" aria-label="Bulk edit">
                <div style={gap}>
                  <b>{`${selectedIds.length} selected`}</b>
                  <SelectField label="Set level" value="" onChange={(event) => event.target.value !== '' && setDrafts((current) => applyLevel(current, selectedIds, event.target.value as Level))}>
                    <option value="">Set level…</option>
                    {LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                  </SelectField>
                  {SWITCHES.map((entry) => (
                    <SwitchCheck
                      key={entry.id}
                      label={`${entry.label} for all selected`}
                      checked={everySelectedHas(entry.id)}
                      onChange={(on) => setDrafts((current) => applySwitches(current, selectedIds, { [entry.id]: on }))}
                    />
                  ))}
                  <Button onClick={() => setSharedOpen((open) => !open)}>Give one shared goal…</Button>
                  <Button onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
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
              <table style={fullWidth}>
                <thead>
                  <tr>
                    <th style={cell} />
                    <th style={cell}>Worktree</th>
                    <th style={cell}>Agent</th>
                    <th style={cell}>Goal</th>
                    <th style={cell}>Done when</th>
                    <th style={cell}>Level</th>
                    <th style={cell} />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => {
                    const groupScope = scopeState(group.rows, selected)
                    return (
                      <Fragment key={group.id ?? 'ungrouped'}>
                        <tr data-avatar-group={group.id ?? 'ungrouped'}>
                          <td style={cell}><Check label={`Select group ${group.name}`} checked={groupScope.state === 'all'} indeterminate={groupScope.state === 'some'} disabled={groupScope.total === 0} onChange={() => setSelected((current) => toggleScope(current, group.rows))} /></td>
                          <td style={cell} colSpan={COLUMNS - 1}><b>{group.name}</b> {`${groupScope.selected} of ${groupScope.total} selected`}</td>
                        </tr>
                        {group.projects.map((project) => {
                          const scope = scopeState(project.rows, selected)
                          return (
                            <Fragment key={project.id}>
                              <tr data-avatar-project={project.id}>
                                <td style={cell}><Check label={`Select project ${project.name}`} checked={scope.state === 'all'} indeterminate={scope.state === 'some'} disabled={scope.total === 0} onChange={() => setSelected((current) => toggleScope(current, project.rows))} /></td>
                                <td style={cell} colSpan={COLUMNS - 1}>{project.name} {`${scope.selected} of ${scope.total}`}</td>
                              </tr>
                              {project.rows.map(renderRow)}
                            </Fragment>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
