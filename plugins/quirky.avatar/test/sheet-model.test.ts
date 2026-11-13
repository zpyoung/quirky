import { describe, expect, test } from 'bun:test'
import type { Mandate, SheetRow, Switches } from '../src/contracts'
import {
  applyLevel, applySharedGoal, applySwitches, buildHandoffInputs, commonLevel, detachSharedGoal, draftFromMandate, effectiveDoneWhenKind, errorSummary,
  groupRows, inferDoneWhenKind, projectSharesOneGoal, sharedFollowers, summarizeHandoff,
  isSelectable, newDraft, patchDraft, rowLabels, scopeState, splitLines, submitLabel, toggleRow, toggleScope, validateDrafts,
  type RowDraft, type SheetDefaults
} from '../src/ui/sheet-model'

const NONE: Switches = { messaging: false, historyRewrite: false, deploys: false }
const DEFAULTS: SheetDefaults = { level: 'full', switches: NONE, agent: null }

const GOAL_ERROR = 'Write a goal so the avatar knows what to do.'
const CHECK_ERROR = 'Add a check so it knows when to stop.'

function row(worktreeId: string, over: Partial<SheetRow> = {}): SheetRow {
  return {
    worktreeId, name: worktreeId, projectId: 'quirky', projectName: 'quirky', groupId: 'desktop', groupName: 'Desktop',
    agent: 'claude', running: true, handedOff: false, eligible: true, reason: null, ungatedNote: null, ...over
  }
}

const rows: SheetRow[] = [
  row('provider-host', { agent: 'codex' }),
  row('fix-desktop'),
  row('sa-browser'),
  row('agent-tabs', { projectId: 'orca', projectName: 'orca' }),
  row('main', { projectId: 'orca', projectName: 'orca', running: false, agent: null, eligible: false, reason: "Can't hand off: a Heimdall watcher supervises it" }),
  row('kestrel-main', { projectId: 'kestrel', projectName: 'kestrel', groupId: null, groupName: null, agent: 'gemini', eligible: false, reason: "Can't hand off: Gemini has no permission hook" })
]

function drafts(over: Record<string, Partial<RowDraft>> = {}): Record<string, RowDraft> {
  const out: Record<string, RowDraft> = {}
  for (const r of rows) out[r.worktreeId] = patchDraft(newDraft(DEFAULTS), over[r.worktreeId] ?? {})
  return out
}

describe('groupRows', () => {
  test('groups by group then project, ungrouped last, in first-seen order', () => {
    const groups = groupRows(rows, { filter: '', sort: 'name', onlyRunning: false })
    expect(groups.map((g) => g.name)).toEqual(['Desktop', 'Ungrouped'])
    expect(groups[0].projects.map((p) => p.name)).toEqual(['quirky', 'orca'])
    expect(groups[0].projects[0].rows.map((r) => r.name)).toEqual(['fix-desktop', 'provider-host', 'sa-browser'])
    expect(groups[1].id).toBeNull()
  })

  test('filter matches name, project, group and agent', () => {
    const names = (filter: string) => groupRows(rows, { filter, sort: 'name', onlyRunning: false }).flatMap((g) => g.rows.map((r) => r.name))
    expect(names('codex')).toEqual(['provider-host'])
    expect(names('ORCA')).toEqual(['agent-tabs', 'main'])
    expect(names('desktop sa')).toEqual(['sa-browser'])
    expect(names('nothing-here')).toEqual([])
  })

  test('only-with-running-agent drops idle rows and empty projects', () => {
    const groups = groupRows(rows, { filter: '', sort: 'name', onlyRunning: true })
    expect(groups.flatMap((g) => g.rows.map((r) => r.name))).not.toContain('main')
    expect(groups[0].projects.find((p) => p.name === 'orca')?.rows.map((r) => r.name)).toEqual(['agent-tabs'])
  })

  test('sorts by project name and by state', () => {
    const byProject = groupRows(rows, { filter: '', sort: 'project', onlyRunning: false })
    expect(byProject[0].projects.map((p) => p.name)).toEqual(['orca', 'quirky'])
    const byState = groupRows(rows, { filter: '', sort: 'state', onlyRunning: false })
    const orca = byState[0].projects.find((p) => p.name === 'orca')
    expect(orca?.rows.map((r) => r.name)).toEqual(['agent-tabs', 'main'])
  })
})

describe('selection', () => {
  test('a row is selectable only when eligible', () => {
    expect(isSelectable(rows[0])).toBe(true)
    expect(isSelectable(rows[4])).toBe(false)
    expect([...toggleRow(new Set(), rows[4])]).toEqual([])
  })

  test('SC-2: project select takes every eligible row and skips ineligible ones', () => {
    const orca = rows.filter((r) => r.projectId === 'orca')
    const picked = toggleScope(new Set(), orca)
    expect([...picked]).toEqual(['agent-tabs'])
    expect(scopeState(orca, picked)).toEqual({ state: 'all', selected: 1, total: 1 })
    expect(toggleScope(picked, orca).size).toBe(0)
  })

  test('scope state is partial when some eligible rows are selected', () => {
    const quirky = rows.filter((r) => r.projectId === 'quirky')
    const picked = toggleRow(new Set(), quirky[0])
    expect(scopeState(quirky, picked)).toEqual({ state: 'some', selected: 1, total: 3 })
    expect(toggleScope(picked, quirky).size).toBe(3)
  })
})

describe('validation', () => {
  test('goal and done when are required for each selected row only', () => {
    const selected = new Set(['fix-desktop', 'sa-browser'])
    const d = drafts({ 'fix-desktop': { goal: 'Badges', doneWhen: 'bun test' }, 'agent-tabs': {} })
    expect(validateDrafts(rows, selected, d)).toEqual({ 'sa-browser': { goal: GOAL_ERROR, doneWhen: CHECK_ERROR } })
  })

  test('whitespace-only text is empty', () => {
    const d = drafts({ 'fix-desktop': { goal: '  ', doneWhen: 'x' } })
    expect(validateDrafts(rows, new Set(['fix-desktop']), d)).toEqual({ 'fix-desktop': { goal: GOAL_ERROR } })
  })
})

describe('bulk edits', () => {
  test('level and switches apply to the selected rows only', () => {
    let d = drafts()
    d = applyLevel(d, ['fix-desktop', 'sa-browser'], 'local')
    d = applySwitches(d, ['sa-browser'], { messaging: true })
    expect(d['fix-desktop'].level).toBe('local')
    expect(d['sa-browser'].switches).toEqual({ messaging: true, historyRewrite: false, deploys: false })
    expect(d['provider-host'].level).toBe('full')
    expect(d['fix-desktop'].switches).toEqual(NONE)
  })

  test('a shared goal sets goal, done when and the shared link on the selection', () => {
    const d = applySharedGoal(drafts(), ['fix-desktop', 'agent-tabs'], { id: 'sg-1', goal: 'Ship badges', doneWhen: 'bun test badges' })
    expect(d['fix-desktop']).toMatchObject({ goal: 'Ship badges', doneWhen: 'bun test badges', sharedGoal: { id: 'sg-1', goal: 'Ship badges' } })
    expect(d['sa-browser'].sharedGoal).toBeNull()
  })

  test('editing a shared row goal detaches it from the shared goal', () => {
    let d = applySharedGoal(drafts(), ['fix-desktop'], { id: 'sg-1', goal: 'Ship badges', doneWhen: '' })
    d = { ...d, 'fix-desktop': patchDraft(d['fix-desktop'], { goal: 'Own goal' }) }
    expect(d['fix-desktop'].sharedGoal).toBeNull()
  })
})

describe('buildHandoffInputs', () => {
  test('SC-1: tick a project, set one row to own-branch, fill goals gives three inputs', () => {
    const quirky = rows.filter((r) => r.projectId === 'quirky')
    const selected = toggleScope(new Set(), quirky)
    let d = drafts({
      'provider-host': { goal: 'Finish restart handling', doneWhen: 'bun scripts/suite.ts plugins/quirky.agents' },
      'fix-desktop': { goal: 'Show command badges on tabs', doneWhen: 'tab badges render' },
      'sa-browser': { goal: 'Fix the 2 failing checks', doneWhen: 'CI green on the PR' }
    })
    d = applyLevel(d, ['sa-browser'], 'own-branch')
    expect(validateDrafts(rows, selected, d)).toEqual({})
    const inputs = buildHandoffInputs(rows, selected, d)
    expect(inputs.map((i) => [i.worktreeId, i.level])).toEqual([['provider-host', 'full'], ['fix-desktop', 'full'], ['sa-browser', 'own-branch']])
    expect(inputs[0]).toMatchObject({ doneWhenKind: 'command', guidelines: [], switches: NONE, agent: null, notes: '', allowSplit: false })
    expect(inputs[2].doneWhenKind).toBe('prose')
    expect(inputs.every((i) => !('sharedGoal' in i))).toBe(true)
  })

  test('ignores selected rows that are not selectable and includes the shared goal', () => {
    let d = drafts({ 'agent-tabs': { notes: 'merges first' } })
    d = applySharedGoal(d, ['agent-tabs'], { id: 'sg-1', goal: 'Ship badges', doneWhen: 'bun test' })
    const inputs = buildHandoffInputs(rows, new Set(['agent-tabs', 'main']), d)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ worktreeId: 'agent-tabs', goal: 'Ship badges', sharedGoal: { id: 'sg-1', goal: 'Ship badges' }, notes: 'merges first' })
  })

  test('guidelines split one per line and an explicit kind wins over inference', () => {
    const d = drafts({ 'fix-desktop': { goal: 'g', doneWhen: 'bun test', doneWhenKind: 'prose', guidelines: 'Keep API\n\n  Rebase on main  \n', agent: 'codex' } })
    const [input] = buildHandoffInputs(rows, new Set(['fix-desktop']), d)
    expect(input).toMatchObject({ guidelines: ['Keep API', 'Rebase on main'], doneWhenKind: 'prose', agent: 'codex' })
  })
})

describe('drafts and text helpers', () => {
  test('a stored mandate fills the draft for editing', () => {
    const mandate: Mandate = {
      worktreeId: 'sa-browser', goal: 'Fix checks', doneWhen: 'CI green', doneWhenKind: 'prose', guidelines: ['No snapshots', 'Small commits'],
      level: 'own-branch', switches: { messaging: true, historyRewrite: false, deploys: false }, agent: 'claude', sharedGoalId: null,
      notes: 'n', allowSplit: true, updatedAt: 1
    }
    expect(draftFromMandate(mandate)).toMatchObject({
      goal: 'Fix checks', doneWhen: 'CI green', doneWhenKind: 'prose', guidelines: 'No snapshots\nSmall commits', level: 'own-branch',
      agent: 'claude', notes: 'n', allowSplit: true, sharedGoal: null
    })
  })

  test('a mandate with a shared goal keeps its id so the link survives an edit', () => {
    const mandate = { worktreeId: 'a', goal: 'Shared text', doneWhen: 'x', doneWhenKind: 'command', guidelines: [], level: 'full', switches: NONE, agent: null, sharedGoalId: 'sg-9', notes: '', allowSplit: false, updatedAt: 1 } satisfies Mandate
    expect(draftFromMandate(mandate).sharedGoal).toEqual({ id: 'sg-9', goal: 'Shared text' })
  })

  test('done-when kind is inferred from the text', () => {
    expect(inferDoneWhenKind('bun test packages/ui')).toBe('command')
    expect(inferDoneWhenKind('pnpm lint && pnpm test')).toBe('command')
    expect(inferDoneWhenKind('CI green on the PR')).toBe('prose')
    expect(inferDoneWhenKind('')).toBe('prose')
  })

  test('splitLines trims and drops empties', () => {
    expect(splitLines(' a \n\n b\r\n')).toEqual(['a', 'b'])
  })
})

describe('rowLabels', () => {
  test('adds the project only when a worktree name repeats', () => {
    const list = [row('a', { name: 'main', projectName: 'harbor' }), row('b', { name: 'main', projectName: 'orca' }), row('c', { name: 'fix' })]
    const labels = rowLabels(list)
    expect(labels.get('a')).toBe('main (harbor)')
    expect(labels.get('b')).toBe('main (orca)')
    expect(labels.get('c')).toBe('fix')
  })
})

describe('submitLabel', () => {
  const list = [row('new1'), row('new2'), row('old1', { handedOff: true }), row('old2', { handedOff: true })]
  test('hand off for new rows, update for handed-off rows, both for a mix', () => {
    expect(submitLabel(list, ['new1'])).toBe('Hand off 1 worktree')
    expect(submitLabel(list, ['new1', 'new2'])).toBe('Hand off 2 worktrees')
    expect(submitLabel(list, ['old1'])).toBe('Update 1 mandate')
    expect(submitLabel(list, ['old1', 'old2'])).toBe('Update 2 mandates')
    expect(submitLabel(list, ['new1', 'old1'])).toBe('Hand off 2 worktrees (1 update)')
    expect(submitLabel(list, [])).toBe('Hand off 0 worktrees')
  })
})

describe('done-when kind', () => {
  test('auto resolves from the text and an explicit kind wins', () => {
    expect(effectiveDoneWhenKind(patchDraft(newDraft(DEFAULTS), { doneWhen: 'bun test passes' }))).toBe('command')
    expect(effectiveDoneWhenKind(patchDraft(newDraft(DEFAULTS), { doneWhen: 'CI is green' }))).toBe('prose')
    expect(effectiveDoneWhenKind(patchDraft(newDraft(DEFAULTS), { doneWhen: 'bun test', doneWhenKind: 'prose' }))).toBe('prose')
  })
})

describe('shared goal runs', () => {
  const shared = { id: 's1', goal: 'Ship it' }
  const withShared = (ids: string[], doneWhen = 'bun test') => Object.fromEntries(ids.map((id) => [id, { goal: 'Ship it', doneWhen, sharedGoal: shared }]))
  const eligible = rows.filter(isSelectable)

  test('rows after the first of a run map to it, in row order', () => {
    const d = drafts(withShared(['provider-host', 'fix-desktop', 'sa-browser']))
    expect([...sharedFollowers(eligible, d)]).toEqual([['fix-desktop', 'provider-host'], ['sa-browser', 'provider-host']])
  })

  test('a row in between with another goal ends the run', () => {
    const d = drafts({ ...withShared(['provider-host', 'sa-browser']) })
    expect(sharedFollowers(eligible, d).size).toBe(0)
  })

  test('a row whose done-when differs, or is blank, stays editable', () => {
    const differs = drafts({ ...withShared(['provider-host']), 'fix-desktop': { goal: 'Ship it', doneWhen: 'other', sharedGoal: shared } })
    expect(sharedFollowers(eligible, differs).size).toBe(0)
    expect(sharedFollowers(eligible, drafts(withShared(['provider-host', 'fix-desktop'], ''))).size).toBe(0)
  })

  test('detaching drops the shared id and keeps the text', () => {
    const d = detachSharedGoal(drafts(withShared(['fix-desktop'])), 'fix-desktop')
    expect(d['fix-desktop']).toMatchObject({ sharedGoal: null, goal: 'Ship it', doneWhen: 'bun test' })
  })

  test('the project badge needs two or more selected rows on one id', () => {
    const d = drafts(withShared(['provider-host', 'fix-desktop']))
    expect(projectSharesOneGoal(rows, new Set(['provider-host', 'fix-desktop']), d)).toBe(true)
    expect(projectSharesOneGoal(rows, new Set(['provider-host']), d)).toBe(false)
    expect(projectSharesOneGoal(rows, new Set(['provider-host', 'sa-browser']), d)).toBe(false)
  })
})

describe('bulk and footer helpers', () => {
  test('commonLevel is the shared level or null', () => {
    const d = drafts({ 'fix-desktop': { level: 'local' }, 'sa-browser': { level: 'local' } })
    expect(commonLevel(d, ['fix-desktop', 'sa-browser'])).toBe('local')
    expect(commonLevel(d, ['fix-desktop', 'provider-host'])).toBeNull()
    expect(commonLevel(d, [])).toBeNull()
  })

  test('errorSummary counts rows and names what is missing', () => {
    expect(errorSummary({})).toBeNull()
    expect(errorSummary({ a: { goal: 'x' } })).toBe('1 worktree needs a goal')
    expect(errorSummary({ a: { doneWhen: 'x' }, b: { doneWhen: 'x' } })).toBe('2 worktrees need a check')
    expect(errorSummary({ a: { goal: 'x' }, b: { doneWhen: 'x' } })).toBe('2 worktrees need a goal or a check')
    expect(errorSummary({ a: { goal: 'x', doneWhen: 'y' } })).toBe('1 worktree needs a goal')
  })

  test('summarizeHandoff lists levels widest first, then switches, then what never happens', () => {
    const d = drafts({
      'fix-desktop': { level: 'own-branch', switches: { ...NONE, messaging: true } },
      'sa-browser': { level: 'shadow' },
      'provider-host': { level: 'own-branch' }
    })
    const labels = rowLabels(rows)
    const entries = summarizeHandoff(rows, ['fix-desktop', 'sa-browser', 'provider-host'], d, labels)
    expect(entries.map((entry) => [entry.term, entry.preposition, entry.names, entry.tone])).toEqual([
      ['Push, draft PRs', 'on', ['provider-host', 'fix-desktop'], 'plain'],
      ['Only log', 'on', ['sa-browser'], 'plain'],
      ['Message people', 'for', ['fix-desktop'], 'needs-you'],
      ['Never', null, [], 'plain']
    ])
    expect(entries.at(-1)?.text).toBe('merge, deploy, touch anything outside these worktrees, or use credentials')
  })

  test('Full and deploys drop merge and deploy from the never line', () => {
    const d = drafts({ 'fix-desktop': { level: 'full', switches: { ...NONE, deploys: true } } })
    const entries = summarizeHandoff(rows, ['fix-desktop'], d, rowLabels(rows))
    expect(entries.map((entry) => entry.term)).toEqual(['Push, open PRs, merge', 'Deploy / migrate', 'Never'])
    expect(entries.at(-1)?.text).toBe('touch anything outside these worktrees, or use credentials')
  })

  test('uses the project-qualified label and is empty with no selection', () => {
    const dup = [row('main'), row('main', { worktreeId: 'other', projectId: 'p2', projectName: 'harbor-api' })]
    const d = Object.fromEntries(dup.map((r) => [r.worktreeId, newDraft(DEFAULTS)]))
    expect(summarizeHandoff(dup, ['other'], d, rowLabels(dup))[0].names).toEqual(['main (harbor-api)'])
    expect(summarizeHandoff(dup, [], d, rowLabels(dup))).toEqual([])
  })
})
