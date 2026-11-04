import type { HandoffInput, Level, Mandate, SheetRow, Switches } from '../contracts'

export type SortKey = 'name' | 'project' | 'state'
export type SheetView = { filter: string; sort: SortKey; onlyRunning: boolean }
export type SheetProject = { id: string; name: string; rows: SheetRow[] }
export type SheetGroup = { id: string | null; name: string; projects: SheetProject[]; rows: SheetRow[] }

/** The values a new row starts from: Settings defaults plus the agent preselected in the sheet. */
export type SheetDefaults = { level: Level; switches: Switches; agent: string | null }

/** One row's editable mandate fields; `guidelines` stays as text, one per line, until it is built into a hand-off. */
export type RowDraft = {
  goal: string
  doneWhen: string
  doneWhenKind: 'auto' | 'command' | 'prose'
  guidelines: string
  level: Level
  switches: Switches
  agent: string | null
  notes: string
  allowSplit: boolean
  sharedGoal: { id: string; goal: string } | null
}

export type DraftErrors = { goal?: string; doneWhen?: string }
export type ScopeState = { state: 'none' | 'some' | 'all'; selected: number; total: number }

const COMMAND_STARTS = new Set([
  'bun', 'bunx', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'deno', 'python', 'python3', 'pytest', 'poetry', 'uv', 'make', 'cargo', 'go',
  'git', 'gh', 'glab', 'docker', 'just', 'tsc', 'eslint', 'oxlint', 'sh', 'bash', 'zsh', 'test'
])

/** Lines of `text` with surrounding whitespace removed and blank lines dropped. */
export function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Whether a done-when reads as a shell command the avatar can run, or as prose it must judge. */
export function inferDoneWhenKind(text: string): 'command' | 'prose' {
  const trimmed = text.trim().replace(/^\$\s+/, '')
  if (trimmed === '') return 'prose'
  if (/^(\.{1,2}\/|\/)\S/.test(trimmed) || trimmed.includes('&&')) return 'command'
  return COMMAND_STARTS.has(trimmed.split(/\s+/)[0]) ? 'command' : 'prose'
}

/** Whether a row can be ticked; ineligible rows stay visible but are never selected by any control. */
export function isSelectable(row: SheetRow): boolean {
  return row.eligible
}

function stateRank(row: SheetRow): number {
  if (!row.eligible) return 3
  if (row.handedOff) return 0
  return row.running ? 1 : 2
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

function matchesFilter(row: SheetRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = [row.name, row.projectName, row.groupName ?? '', row.agent ?? ''].join(' ').toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function sortRows(rows: SheetRow[], sort: SortKey): SheetRow[] {
  const sorted = [...rows]
  if (sort === 'state') return sorted.sort((a, b) => stateRank(a) - stateRank(b) || compareText(a.name, b.name))
  return sorted.sort((a, b) => compareText(a.name, b.name))
}

/**
 * Rows grouped by group, then project, after the filter and the running-only toggle, with rows
 * sorted inside each project. Groups and projects keep first-seen order, ungrouped last, except
 * under the `project` sort, which orders both alphabetically.
 */
export function groupRows(rows: SheetRow[], view: SheetView): SheetGroup[] {
  const tokens = view.filter.toLowerCase().split(/\s+/).filter((token) => token !== '')
  const visible = rows.filter((row) => matchesFilter(row, tokens) && (!view.onlyRunning || row.running))
  const groups = new Map<string | null, { name: string; projects: Map<string, { name: string; rows: SheetRow[] }> }>()
  for (const row of visible) {
    let group = groups.get(row.groupId)
    if (!group) {
      group = { name: row.groupName ?? 'Ungrouped', projects: new Map() }
      groups.set(row.groupId, group)
    }
    let project = group.projects.get(row.projectId)
    if (!project) {
      project = { name: row.projectName, rows: [] }
      group.projects.set(row.projectId, project)
    }
    project.rows.push(row)
  }
  const built: SheetGroup[] = [...groups.entries()].map(([id, group]) => {
    const projects: SheetProject[] = [...group.projects.entries()].map(([projectId, project]) => ({
      id: projectId, name: project.name, rows: sortRows(project.rows, view.sort)
    }))
    if (view.sort === 'project') projects.sort((a, b) => compareText(a.name, b.name))
    return { id, name: group.name, projects, rows: projects.flatMap((project) => project.rows) }
  })
  if (view.sort === 'project') built.sort((a, b) => compareText(a.name, b.name))
  return [...built.filter((group) => group.id !== null), ...built.filter((group) => group.id === null)]
}

/** Selection after ticking or unticking one row; an ineligible row leaves it unchanged. */
export function toggleRow(selected: ReadonlySet<string>, row: SheetRow): Set<string> {
  const next = new Set(selected)
  if (!isSelectable(row)) return next
  if (next.has(row.worktreeId)) next.delete(row.worktreeId)
  else next.add(row.worktreeId)
  return next
}

/** How many of the eligible rows in `rows` are selected; ineligible rows are not counted. */
export function scopeState(rows: SheetRow[], selected: ReadonlySet<string>): ScopeState {
  const eligible = rows.filter(isSelectable)
  const count = eligible.filter((row) => selected.has(row.worktreeId)).length
  const state = count === 0 ? 'none' : count === eligible.length ? 'all' : 'some'
  return { state, selected: count, total: eligible.length }
}

/** Selection after a group or project checkbox: every eligible row beneath it is selected, or unselected when all already were. */
export function toggleScope(selected: ReadonlySet<string>, rows: SheetRow[]): Set<string> {
  const next = new Set(selected)
  const eligible = rows.filter(isSelectable)
  const clear = scopeState(rows, selected).state === 'all'
  for (const row of eligible) {
    if (clear) next.delete(row.worktreeId)
    else next.add(row.worktreeId)
  }
  return next
}

/** A blank draft carrying the defaults every new hand-off starts from. */
export function newDraft(defaults: SheetDefaults): RowDraft {
  return {
    goal: '', doneWhen: '', doneWhenKind: 'auto', guidelines: '', level: defaults.level, switches: { ...defaults.switches },
    agent: defaults.agent, notes: '', allowSplit: false, sharedGoal: null
  }
}

/** The draft for editing an already handed-off worktree's stored mandate. */
export function draftFromMandate(mandate: Mandate): RowDraft {
  return {
    goal: mandate.goal, doneWhen: mandate.doneWhen, doneWhenKind: mandate.doneWhenKind, guidelines: mandate.guidelines.join('\n'),
    level: mandate.level, switches: { ...mandate.switches }, agent: mandate.agent, notes: mandate.notes, allowSplit: mandate.allowSplit,
    sharedGoal: mandate.sharedGoalId === null ? null : { id: mandate.sharedGoalId, goal: mandate.goal }
  }
}

/** `draft` with `patch` applied; editing the goal of a row on a shared goal detaches it from that goal. */
export function patchDraft(draft: RowDraft, patch: Partial<RowDraft>): RowDraft {
  const next = { ...draft, ...patch }
  if (patch.goal !== undefined && next.sharedGoal !== null && patch.goal !== next.sharedGoal.goal && !('sharedGoal' in patch)) next.sharedGoal = null
  return next
}

function mapDrafts(drafts: Record<string, RowDraft>, ids: readonly string[], change: (draft: RowDraft) => RowDraft): Record<string, RowDraft> {
  const next = { ...drafts }
  for (const id of ids) if (next[id]) next[id] = change(next[id])
  return next
}

/** Sets one level on every listed row. */
export function applyLevel(drafts: Record<string, RowDraft>, ids: readonly string[], level: Level): Record<string, RowDraft> {
  return mapDrafts(drafts, ids, (draft) => ({ ...draft, level }))
}

/** Sets the given floor switches on every listed row; switches not named keep their value. */
export function applySwitches(drafts: Record<string, RowDraft>, ids: readonly string[], switches: Partial<Switches>): Record<string, RowDraft> {
  return mapDrafts(drafts, ids, (draft) => ({ ...draft, switches: { ...draft.switches, ...switches } }))
}

/** Gives every listed row one shared goal; an empty `doneWhen` leaves each row's own check in place. */
export function applySharedGoal(
  drafts: Record<string, RowDraft>,
  ids: readonly string[],
  shared: { id: string; goal: string; doneWhen: string }
): Record<string, RowDraft> {
  return mapDrafts(drafts, ids, (draft) => ({
    ...draft,
    goal: shared.goal,
    doneWhen: shared.doneWhen.trim() === '' ? draft.doneWhen : shared.doneWhen,
    sharedGoal: { id: shared.id, goal: shared.goal }
  }))
}

function selectedRows(rows: SheetRow[], selected: ReadonlySet<string>): SheetRow[] {
  return rows.filter((row) => isSelectable(row) && selected.has(row.worktreeId))
}

/** Per-row errors for every selected row missing a goal or a done-when; an empty result means the sheet can hand off. */
export function validateDrafts(rows: SheetRow[], selected: ReadonlySet<string>, drafts: Record<string, RowDraft>): Record<string, DraftErrors> {
  const errors: Record<string, DraftErrors> = {}
  for (const row of selectedRows(rows, selected)) {
    const draft = drafts[row.worktreeId]
    const found: DraftErrors = {}
    if (!draft || draft.goal.trim() === '') found.goal = 'Goal is required'
    if (!draft || draft.doneWhen.trim() === '') found.doneWhen = 'Done when is required'
    if (found.goal || found.doneWhen) errors[row.worktreeId] = found
  }
  return errors
}

/** The `quirky.avatar/handoff` items for the selected eligible rows, in the order of `rows`. Call after `validateDrafts` is clean. */
export function buildHandoffInputs(rows: SheetRow[], selected: ReadonlySet<string>, drafts: Record<string, RowDraft>): HandoffInput[] {
  const inputs: HandoffInput[] = []
  for (const row of selectedRows(rows, selected)) {
    const draft = drafts[row.worktreeId]
    if (!draft) continue
    const doneWhen = draft.doneWhen.trim()
    const input: HandoffInput = {
      worktreeId: row.worktreeId,
      goal: draft.goal.trim(),
      doneWhen,
      doneWhenKind: draft.doneWhenKind === 'auto' ? inferDoneWhenKind(doneWhen) : draft.doneWhenKind,
      guidelines: splitLines(draft.guidelines),
      level: draft.level,
      switches: { ...draft.switches },
      agent: draft.agent,
      notes: draft.notes.trim(),
      allowSplit: draft.allowSplit
    }
    if (draft.sharedGoal) input.sharedGoal = { id: draft.sharedGoal.id, goal: draft.sharedGoal.goal }
    inputs.push(input)
  }
  return inputs
}
