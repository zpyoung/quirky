import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { discoverCandidates } from './audit-discovery'
import { createEvidenceResolver, parseCoverage, selectCandidate } from './audit-evidence'
import type { CoverageFile, PluginInventory, StateKind } from './contracts'

type Scenario = { plugin: string; source: string; fragment: string; text: string; state: StateKind; guard?: string; metric?: string }
const scenarios: Scenario[] = [
  { plugin: 'editor', source: 'window/ExplorerPanel.tsx', fragment: 'explorer-and-overlays', text: 'Git status unavailable:', state: 'error', guard: 'gitError' },
  { plugin: 'terminal', source: 'window/EmulatorView.tsx', fragment: 'panels', text: 'The selected simulator is no longer available.', state: 'error', guard: 'selected && !device && !loading' },
  { plugin: 'terminal', source: 'window/EmulatorView.tsx', fragment: 'panels', text: 'Start this exact device in Simulator, then Refresh.', state: 'error' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading…', state: 'loading', guard: "row.lastRunRead === 'loading'" },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'History unavailable', state: 'error', guard: "row.lastRunRead === 'unavailable'" },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading run usage…', state: 'loading', guard: "row.lastRunRead === 'loading'" },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Usage unavailable', state: 'error', guard: "row.lastRunRead === 'unavailable'" },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Run history unavailable', state: 'error', guard: 'usageUnavailable' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'status unavailable', state: 'error', guard: 'definition.lastRunAt !== undefined' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading…', state: 'loading', guard: 'usageLoading', metric: 'Last run' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading…', state: 'loading', guard: 'usageLoading', metric: 'Est. spend' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading…', state: 'loading', guard: 'usageLoading', metric: 'Tokens' },
  { plugin: 'automations', source: 'list/AutomationsPage.tsx', fragment: 'list', text: 'Loading run history…', state: 'loading', guard: 'usageLoading', metric: 'Usage coverage' },
  { plugin: 'worktree', source: 'CreateDialog.tsx', fragment: 'project-dialogs', text: 'Remote host discovery is unavailable:', state: 'error', guard: 'hostError' },
  { plugin: 'worktree', source: 'RemoteWorkspace.tsx', fragment: 'remote-and-dialogs', text: 'Remote changes are unavailable.', state: 'error', guard: 'files.length === 0 && !connected' },
  { plugin: 'worktree', source: 'Tree.tsx', fragment: 'tree-and-menus', text: 'Automation no longer available.', state: 'error', guard: "definitionStatus === 'missing'" },
  { plugin: 'worktree', source: 'Tree.tsx', fragment: 'tree-and-menus', text: 'Run history no longer available.', state: 'error', guard: "runHistoryStatus === 'missing'" },
  { plugin: 'worktree', source: 'Tree.tsx', fragment: 'tree-and-menus', text: 'Automations plugin unavailable.', state: 'error', guard: "definitionStatus === 'unavailable' || runHistoryStatus === 'unavailable'" },
  { plugin: 'vault', source: 'window/HistoryPanel.tsx', fragment: 'history', text: 'host.label', state: 'error' },
  { plugin: 'vault', source: 'window/HistoryPanel.tsx', fragment: 'history', text: 'issue.reason', state: 'error' },
  { plugin: 'vault', source: 'window/HistoryPanel.tsx', fragment: 'history', text: 'searchMessage.message', state: 'error' },
  { plugin: 'vault', source: 'window/SearchSettings.tsx', fragment: 'search-settings', text: 'session files could not be read and will be retried.', state: 'error' },
  { plugin: 'tasks', source: 'list/TasksList.tsx', fragment: 'list', text: 'selected source read', state: 'error', guard: '!noGitHubRemote && !allUnavailable && partialFailureCount > 0' },
  { plugin: 'tasks', source: 'list/TasksList.tsx', fragment: 'list', text: 'No GitHub source detected for', state: 'error' },
  { plugin: 'tasks', source: 'list/TasksList.tsx', fragment: 'list', text: "Couldn't refresh GitHub tasks.", state: 'error', guard: 'listError && rows.length > 0' },
  { plugin: 'tasks', source: 'list/TasksList.tsx', fragment: 'list', text: 'Repository labels and assignees could not be loaded.', state: 'error', guard: "filterOptions.status === 'failed'" },
]


function assertShared(scenario: Scenario, content?: string, changedCoverage?: CoverageFile): void {
  const directory = `plugins/quirky.${scenario.plugin}`
  const file = `${directory}/src/${scenario.source}`
  const text = content ?? readFileSync(file, 'utf8')
  const coverage = changedCoverage ?? parseCoverage(readFileSync(`${directory}/ui-scoreboard/${scenario.fragment}.json`, 'utf8'))
  const plugin: PluginInventory = { id: `quirky.${scenario.plugin}`, directory, hasUi: true, targets: [], sources: [{ file, content: text }] }
  const resolver = createEvidenceResolver(plugin, [file])
  const candidates = discoverCandidates(plugin, [file])
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const notices: ts.JsxElement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'NoticeLine'
      && node.children.some((child) => child.getText().includes(scenario.text))) notices.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  let guardAnchor: { start: number; end: number } | undefined
  const notice = notices.find((node) => {
    if (scenario.metric) {
      let owner: ts.Node | undefined = node.parent
      while (owner && !(ts.isJsxElement(owner) && owner.openingElement.tagName.getText() === 'div'
        && owner.children.some((child) => ts.isJsxElement(child) && child.openingElement.tagName.getText() === 'strong' && child.children.map((part) => part.getText()).join('') === scenario.metric))) owner = owner.parent
      if (!owner) return false
    }
    if (!scenario.guard) return true
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      const condition = ts.isConditionalExpression(ancestor) ? ancestor.condition
        : ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? ancestor.left : undefined
      if (condition?.getText().replace(/^\((.*)\)$/s, '$1') === scenario.guard) {
        guardAnchor = { start: condition.getStart(), end: ts.isConditionalExpression(ancestor) ? ancestor.questionToken.end : ts.isBinaryExpression(ancestor) ? ancestor.operatorToken.end : ancestor.end }
        return true
      }
    }
    return false
  })
  expect(notice, `${scenario.plugin}: shared descendant for ${scenario.text}`).toBeDefined()
  if (!notice) return
  const matches = coverage.states.filter((entry) => {
    if (entry.state !== scenario.state || entry.render.component !== 'NoticeLine') return false
    const render = resolver.resolveRef(entry.render.element)
    if ('code' in render) return false
    const elements: ts.Node[] = []
    const collect = (node: ts.Node): void => {
      if (node.end < render.start || node.getStart() > render.end) return
      if (node.getStart() >= render.start && node.end <= render.end && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
        elements.push(node)
        return
      }
      ts.forEachChild(node, collect)
    }
    collect(parsed)
    return elements.length === 1 && elements[0] === notice
  })
  expect(matches.length, `${scenario.plugin}: ${scenario.state} witness for ${scenario.text}`).toBeGreaterThan(0)
  for (const entry of matches) {
    const site = resolver.resolveRef(entry.site)
    expect('code' in site).toBe(false)
    if ('code' in site) continue
    const candidate = selectCandidate(site, candidates, 'state', entry.anchor)
    expect('code' in candidate).toBe(false)
    if ('code' in candidate) continue
    let linked = notice.getStart() <= candidate.anchorStart && notice.end >= candidate.anchorEnd
    const findController = (node: ts.Node): void => {
      const controlled = ts.isConditionalExpression(node) && node.condition.getStart() === candidate.anchorStart && node.questionToken.end === candidate.anchorEnd ? [node.whenTrue, node.whenFalse]
        : ts.isBinaryExpression(node) && node.left.getStart() === candidate.anchorStart && node.operatorToken.end === candidate.anchorEnd ? [node.right]
          : ts.isIfStatement(node) && node.getStart() === candidate.anchorStart ? [node.thenStatement, ...(node.elseStatement ? [node.elseStatement] : [])] : []
      if (controlled.some((branch) => branch.getStart() <= notice.getStart() && branch.end >= notice.end)) linked = true
      ts.forEachChild(node, findController)
    }
    findController(parsed)
    expect(linked, 'The classified site must control the actual shared child').toBe(true)
    for (const excluded of coverage.notState) {
      const resolved = resolver.resolveRef(excluded.site)
      if ('code' in resolved) continue
      const excludedCandidate = selectCandidate(resolved, candidates, 'state', excluded.anchor)
      if ('code' in excludedCandidate) continue
      expect([excludedCandidate.anchorStart, excludedCandidate.anchorEnd]).not.toEqual([candidate.anchorStart, candidate.anchorEnd])
      if (guardAnchor) {
        expect([excludedCandidate.anchorStart, excludedCandidate.anchorEnd]).not.toEqual([guardAnchor.start, guardAnchor.end])
      }
    }
  }
}

for (const scenario of scenarios) {
  test(`${scenario.plugin}: ${scenario.metric ? `${scenario.metric}: ` : ''}${scenario.text} is shared and classified as ${scenario.state}`, () => assertShared(scenario))
}

const explorer = scenarios[0]!
test('rejects restoring a bare paragraph even with a nearby shared notice', () => {
  const file = 'plugins/quirky.editor/src/window/ExplorerPanel.tsx'
  const content = readFileSync(file, 'utf8')
  const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let target: ts.JsxElement | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'NoticeLine' && node.getText().includes('Git status unavailable:')) target = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(target).toBeDefined()
  if (!target) return
  const mutation = content.slice(0, target.getStart()) + '<p>Git status unavailable: {gitError}</p>' + content.slice(target.end) + '\nconst unrelated = <NoticeLine>Git status unavailable: unrelated</NoticeLine>\n'
  expect(() => assertShared(explorer, mutation)).toThrow()
})

test('rejects reintroducing a notState exemption for the classified failure', () => {
  const coverage = parseCoverage(readFileSync('plugins/quirky.editor/ui-scoreboard/explorer-and-overlays.json', 'utf8'))
  const state = coverage.states.find((entry) => entry.state === 'error' && entry.render.component === 'NoticeLine' && entry.render.element.quote.includes('Git status unavailable:'))
  expect(state).toBeDefined()
  if (!state) return
  coverage.notState.push({ site: state.site, anchor: state.anchor, reason: 'The rest of the tree remains usable.' })
  expect(() => assertShared(explorer, undefined, coverage)).toThrow()
})
