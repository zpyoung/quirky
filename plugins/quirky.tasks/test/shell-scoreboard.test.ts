import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { CoverageFile, Evidence, Inventory, PluginInventory } from '../../../scripts/ui-scoreboard/contracts'
import { parseItem } from '../src/list/model'

const ROOT = 'plugins/quirky.tasks/'
const FRAGMENT = `${ROOT}ui-scoreboard/shell.json`
const OWNED = ['ui.tsx', 'list/CompactTasks.tsx', 'list/WorkspaceComposer.tsx', 'issue/NewIssueDialog.tsx', 'list/model.ts', 'list/row-menu.ts'].map((file) => `${ROOT}src/${file}`)
const REMAINING = ['list/TasksList.tsx', 'list/PrDetail.tsx', 'issue/IssueSurface.tsx', 'issue/Markdown.tsx', 'projects/ProjectsSurface.tsx'].map((file) => `${ROOT}src/${file}`)
const PASS: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
let inventory: Inventory
let plugin: PluginInventory

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.tasks')!
  expect(plugin).toBeDefined()
})

function fragment(): CoverageFile {
  const source = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(source).toBeDefined()
  return parseCoverage(source!.content)
}

function failures(subject = plugin): Evidence[] {
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence).filter((entry) => !PASS[entry.code])
}

test('shell coverage includes every owned candidate and leaves only the named follow-up files', () => {
  const coverage = fragment()
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toHaveLength(23)
  expect(graph.files).toContain(`${ROOT}src/list/row-menu.ts`)
  const candidates = discoverCandidates(plugin, graph.files)
  expect(candidates.filter((entry) => OWNED.includes(entry.file) && ['unresolved-assignment', 'unresolved-spread'].includes(entry.kind))).toEqual([])
  const issues = failures()
  expect(issues.filter((entry) => OWNED.includes(entry.source?.file ?? '') || entry.source?.file === `${ROOT}src/list/useCompactList.ts` || entry.coverageFile === FRAGMENT)).toEqual([])
  expect(issues.length).toBeGreaterThan(0)
  expect(issues.filter((entry) => entry.code !== 'coverage-missing' || !REMAINING.includes(entry.source?.file ?? ''))).toEqual([])
  expect(Object.keys(coverage.surfaces).sort()).toEqual([...plugin.targets].sort())
  for (const [surface, states] of Object.entries(coverage.surfaces)) {
    for (const [state, decision] of Object.entries(states)) {
      if (decision.applicable) expect(coverage.states.some((entry) => entry.surface === surface && entry.state === state)).toBe(true)
    }
  }
  expect(coverage.surfaces['view:quirky.tasks/tasks']).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  expect(coverage.surfaces['view:quirky.tasks/settings']!.empty.applicable).toBe(false)
  expect(coverage.surfaces['sidebar-section:quirky.tasks/tasks']).toEqual({ loading: { applicable: true }, empty: { applicable: true }, error: { applicable: true } })
  expect(coverage.surfaces['overlay:quirky.tasks/workspace-composer']!.loading.applicable).toBe(false)
  expect(coverage.surfaces['overlay:quirky.tasks/workspace-composer']!.empty.applicable).toBe(false)
})

test('changing a state witness reports evidence missing in the fragment', () => {
  const coverage = fragment()
  coverage.states[0]!.site.quote = `x${coverage.states[0]!.site.quote.slice(1)}`
  const changed = {
    ...plugin,
    coverageFragments: plugin.coverageFragments!.map((source) => source.file === FRAGMENT ? { ...source, content: JSON.stringify(coverage) } : source),
  }
  expect(failures(changed).some((entry) => entry.code === 'evidence-missing' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('a new raw alert in the sidebar return is an uncovered state', () => {
  fragment()
  const file = `${ROOT}src/list/CompactTasks.tsx`
  const source = plugin.sources.find((entry) => entry.file === file)!
  const parsed = ts.createSourceFile(file, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'CompactTasks')!
  const returned = component.body!.statements.findLast((node): node is ts.ReturnStatement => ts.isReturnStatement(node))!
  let expression = returned.expression!
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  expect(ts.isJsxElement(expression)).toBe(true)
  const insertion = (expression as ts.JsxElement).closingElement.getStart(parsed)
  const content = `${source.content.slice(0, insertion)}<p role="alert">x</p>${source.content.slice(insertion)}`
  const changed = { ...plugin, sources: plugin.sources.map((entry) => entry.file === file ? { ...entry, content } : entry) }
  expect(failures(changed).some((entry) => entry.code === 'coverage-missing' && entry.source?.file === file)).toBe(true)
})

test('parseItem keeps valid optional fields and omits invalid optional fields', () => {
  const item = parseItem({ kind: 'pullRequest', number: 274, title: 'Ship', body: '', url: 'https://github.com/acme/quirky/pull/274', worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', state: 'open', headRefName: 'feat', mergeStateStatus: 7, additions: 3, deletions: -1, changedFiles: 1.5 })
  expect(item).not.toBeNull()
  expect(item!.headRefName).toBe('feat')
  expect(item!.additions).toBe(3)
  for (const key of ['mergeStateStatus', 'deletions', 'changedFiles']) expect(Object.hasOwn(item!, key)).toBe(false)
})
