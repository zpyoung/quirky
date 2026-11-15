import { beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { resolve } from 'node:path'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { createEvidenceResolver, parseCoverage, selectCandidate } from '../../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../../scripts/ui-scoreboard/tokens'
import { checkRatchet, parseRatchetConfig } from '../../../../scripts/ui-scoreboard/ratchet'
import type { CoverageFile, Inventory, PluginInventory, StaticCheckId } from '../../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.terminal/'
const FRAGMENT = `${ROOT}ui-scoreboard/workspace-views.json`
const FLOATING = 'overlay:quirky.terminal/floating'
const VIEW = `${ROOT}src/window/workspace/WorkspaceView.tsx`
const PANE = `${ROOT}src/window/workspace/PaneLayer.tsx`
const ACTION = 'command:quirky.terminal/workspace-view-action'
const OWNED = ['PaneLayer.tsx', 'Overlays.tsx', 'CloseDialogs.tsx', 'PromptDialog.tsx', 'WorkspaceView.tsx', 'TabIcon.tsx', 'mount.tsx', 'StatusGlyph.tsx', 'Dialog.tsx', 'view-actions.ts'].map((file) => `${ROOT}src/window/workspace/${file}`)
const CHECKS: StaticCheckId[] = ['commands', 'compatibility-tokens', 'empty', 'error', 'loading']
let inventory: Inventory
let plugin: PluginInventory
let coverage: CoverageFile

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.terminal')!
  const fragment = plugin.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
})

function fresh() {
  const copy = structuredClone(inventory)
  return { inventory: copy, plugin: copy.plugins.find((entry) => entry.id === 'quirky.terminal')! }
}

function rawLoading() {
  const copy = fresh()
  const source = copy.plugin.sources.find((entry) => entry.file === VIEW)!
  const next = source.content.replace('<NoticeLine>Loading workspace…</NoticeLine>', '<p>Loading workspace…</p>')
  expect(next).not.toBe(source.content)
  source.content = next
  return copy
}

test('final workspace fragment covers its ten graph members and every Terminal audit check passes', () => {
  expect(coverage.schemaVersion).toBe(1)
  expect(coverage.surfaces).toEqual({})
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  for (const file of OWNED) expect(graph.files).toContain(file)
  for (const check of auditPlugin(inventory, plugin)) {
    const failures = check.evidence.filter((entry) => !['state-covered', 'state-not-applicable', 'not-state', 'action-routed', 'action-transient', 'action-not-user'].includes(entry.code))
    expect({ id: check.id, status: check.status, failures }).toEqual({ id: check.id, status: 'pass', failures: [] })
  }
  for (const id of CHECKS) expect(checkPlugin(inventory, 'quirky.terminal').find((check) => check.id === id)?.status).toBe('pass')
})

test('workspace states use floating shared loading, empty and failure evidence', () => {
  const shared = coverage.states.filter((entry) => entry.render.component !== 'toast')
  expect(shared.every((entry) => entry.surface === FLOATING)).toBe(true)
  for (const [file, state, component] of [[VIEW, 'loading', 'NoticeLine'], [VIEW, 'empty', 'EmptyState'], [VIEW, 'error', 'InlineError'], [PANE, 'loading', 'NoticeLine'], [PANE, 'error', 'InlineError'], [`${ROOT}src/window/workspace/PromptDialog.tsx`, 'error', 'InlineError'], [`${ROOT}src/window/workspace/PromptDialog.tsx`, 'loading', 'NoticeLine']] as const) {
    expect(shared.some((entry) => entry.site.file === file && entry.state === state && entry.render.component === component)).toBe(true)
  }
})

test('raw workspace loading invalidates loading coverage', () => {
  const copy = rawLoading()
  expect(auditPlugin(copy.inventory, copy.plugin).find((entry) => entry.id === 'loading')?.status).toBe('fail')
})

test('exit Close requires its own command coverage', () => {
  const copy = fresh()
  const fragment = copy.plugin.coverageFragments!.find((entry) => entry.file === FRAGMENT)!
  const next = parseCoverage(fragment.content)
  const index = next.actions.findIndex((entry) => entry.site.file === PANE && 'route' in entry && /controller\.closePane\(leaf\.id\)/.test(entry.site.quote) && entry.site.quote.includes('Button'))
  expect(index).toBeGreaterThanOrEqual(0)
  next.actions.splice(index, 1)
  fragment.content = JSON.stringify(next)
  expect(auditPlugin(copy.inventory, copy.plugin).find((entry) => entry.id === 'commands')?.evidence.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === PANE)).toBe(true)
})

test('workspace action must remain publicly declared', () => {
  const copy = fresh()
  copy.plugin.contributions!.commands = copy.plugin.contributions!.commands.filter((id) => id !== ACTION)
  expect(auditPlugin(copy.inventory, copy.plugin).find((entry) => entry.id === 'commands')?.evidence.some((entry) => entry.code === 'route-undeclared' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('Terminal enrollment retains all five checks and the entire static ratchet passes', () => {
  const enrollment = parseRatchetConfig(readFileSync(resolve(import.meta.dir, '../../../../scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(enrollment['quirky.terminal']).toEqual(CHECKS)
  expect(checkRatchet(inventory, enrollment)).toEqual({ exitCode: 0, failures: [] })
}, 60_000)

test('Terminal-only ratchet reports a workspace loading regression', () => {
  const copy = rawLoading()
  const result = checkRatchet(copy.inventory, { 'quirky.terminal': CHECKS })
  expect(result.exitCode).toBe(1)
  expect(result.failures.some((entry) => entry.message.includes('quirky.terminal') && entry.message.includes('loading'))).toBe(true)
})

test('inline title adapters cannot hide a controller action behind forwarded callbacks', () => {
  const source = plugin.sources.find((entry) => entry.file === PANE)!
  const parsed = ts.createSourceFile(PANE, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const field = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'InlineField')
  expect(field?.body).toBeDefined()
  const calls = new Set<string>()
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = node.expression.getText(parsed)
      expect(['useState', 'useRef', 'useEffect', 'input.current?.focus', 'input.current?.select', 'onCommit', 'onCancel', 'setValue', 'finish', 'event.stopPropagation', 'event.preventDefault']).toContain(call)
      calls.add(call)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      expect(node.left.getText(parsed)).toBe('finished.current')
      expect(node.right.kind).toBe(ts.SyntaxKind.TrueKeyword)
    }
    expect([ts.SyntaxKind.NewExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.PostfixUnaryExpression]).not.toContain(node.kind)
    ts.forEachChild(node, inspect)
  }
  inspect(field!.body!)
  expect(calls.has('onCommit')).toBe(true)
  expect(calls.has('onCancel')).toBe(true)
})

test('prompt DOM adapters normalize events and forward only the supplied submission callback', () => {
  const file = `${ROOT}src/window/workspace/PromptDialog.tsx`
  const content = plugin.sources.find((entry) => entry.file === file)!.content
  const parsed = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['submit', 'onPromptKeyDown'].includes(node.name.text)) declarations.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(declarations.map((node) => node.name.getText(parsed)).sort()).toEqual(['onPromptKeyDown', 'submit'])
  for (const declaration of declarations) {
    const calls: string[] = []
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(parsed)
        expect(['event.preventDefault', 'onSubmit', 'submit']).toContain(call)
        calls.push(call)
      }
      if (ts.isBinaryExpression(node)) expect(node.operatorToken.kind < ts.SyntaxKind.FirstAssignment || node.operatorToken.kind > ts.SyntaxKind.LastAssignment).toBe(true)
      expect([ts.SyntaxKind.NewExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.PostfixUnaryExpression]).not.toContain(node.kind)
      ts.forEachChild(node, inspect)
    }
    inspect(declaration.initializer!)
    expect(calls).toContain(declaration.name.getText(parsed) === 'submit' ? 'onSubmit' : 'submit')
  }
})

test('propagation adapters contain only an event stop and cannot change application state', () => {
  const files = discoverUiFiles(plugin).files
  const candidates = discoverCandidates(plugin, files)
  const resolver = createEvidenceResolver(plugin, files)
  const barriers = coverage.actions.filter((entry) => 'notAction' in entry && entry.notAction === 'barrier')
  expect(barriers.length).toBeGreaterThan(0)
  for (const entry of barriers) {
    const reference = resolver.resolveRef(entry.site)
    if ('code' in reference) throw new Error(reference.message)
    const candidate = selectCandidate(reference, candidates, 'action', entry.anchor)
    if ('code' in candidate) throw new Error(candidate.message)
    const handlers: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.getStart(reference.source) === candidate.anchorStart && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) handlers.push(node.initializer.expression)
      ts.forEachChild(node, visit)
    }
    visit(reference.source)
    const handler = handlers[0]
    expect(handler && ts.isArrowFunction(handler)).toBe(true)
    if (!handler || !ts.isArrowFunction(handler)) continue
    const parameter = handler.parameters[0]?.name.getText(reference.source)
    const body = handler.body
    expect(ts.isCallExpression(body)).toBe(true)
    if (!ts.isCallExpression(body)) continue
    expect(body.expression.getText(reference.source)).toBe(`${parameter}.stopPropagation`)
    expect(body.arguments).toHaveLength(0)
  }
})

test('pane handle and state adapters only forward registration and reports', () => {
  const content = plugin.sources.find((entry) => entry.file === PANE)!.content
  const parsed = ts.createSourceFile(PANE, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = new Map<string, string[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['onHandle', 'onState'].includes(node.name.text)) {
      const calls: string[] = []
      const inspect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) calls.push(child.expression.getText(parsed))
        ts.forEachChild(child, inspect)
      }
      inspect(node.initializer!)
      found.set(node.name.text, calls)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(found.get('onHandle')).toEqual(['controller.registerHandle'])
  expect(found.get('onState')).toEqual(['controller.setPaneState'])
})
