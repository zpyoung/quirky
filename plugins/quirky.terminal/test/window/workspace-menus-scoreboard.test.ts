import { beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { auditPlugin } from '../../../../scripts/ui-scoreboard/audit'
import { discoverCandidates, discoverUiFiles } from '../../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage } from '../../../../scripts/ui-scoreboard/audit-evidence'
import { collectInventory } from '../../../../scripts/ui-scoreboard/inventory'
import type { CheckResult, CoverageFile, Inventory, PluginInventory } from '../../../../scripts/ui-scoreboard/contracts'

const ROOT = 'plugins/quirky.terminal/'
const FRAGMENT = `${ROOT}ui-scoreboard/workspace-menus.json`
const GROUP_VIEW = `${ROOT}src/window/workspace/GroupView.tsx`
const CONTROLLER = `${ROOT}src/window/workspace/controller.ts`
const COMMANDS = `${ROOT}src/window/commands.ts`
const ASSIGNMENT_SOURCES = new Set([COMMANDS, CONTROLLER, `${ROOT}src/window/workspace/model.ts`])
const OWNED = new Set([
  GROUP_VIEW,
  CONTROLLER,
  `${ROOT}src/window/workspace/model.ts`,
  COMMANDS,
  `${ROOT}src/window/quick-commands/pane-items.ts`,
  `${ROOT}src/window/window-command.ts`
])
const MENU = 'command:quirky.terminal/run-menu-item'
const WORKSPACE = 'command:quirky.terminal/workspace-menu-action'
const FLOATING = 'overlay:quirky.terminal/floating'
const PASS: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true
}

let inventory: Inventory
let terminal: PluginInventory
let coverage: CoverageFile
let checks: CheckResult[]

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../../..'))
  expect(inventory.failures).toEqual([])
  terminal = inventory.plugins.find((entry) => entry.id === 'quirky.terminal')!
  const fragment = terminal.coverageFragments?.find((entry) => entry.file === FRAGMENT)
  expect(fragment).toBeDefined()
  coverage = parseCoverage(fragment!.content)
  checks = auditPlugin(inventory, terminal)
})

function freshTerminal(): { inventory: Inventory; terminal: PluginInventory } {
  const copy = structuredClone(inventory)
  return { inventory: copy, terminal: copy.plugins.find((entry) => entry.id === 'quirky.terminal')! }
}

function replaceFragment(plugin: PluginInventory, content: string): void {
  const fragments = plugin.coverageFragments!
  expect(fragments.some((entry) => entry.file === FRAGMENT)).toBe(true)
  plugin.coverageFragments = fragments.map((entry) => entry.file === FRAGMENT ? { ...entry, content } : entry)
}

function sourceFor(plugin: PluginInventory, file: string) {
  const source = plugin.sources.find((entry) => entry.file === file)
  expect(source).toBeDefined()
  return source!
}

test('owned Terminal fragment and source candidates have no attributed coverage failures', () => {
  expect(Object.keys(coverage.surfaces)).toEqual([])
  for (const file of OWNED) expect(terminal.sources.some((source) => source.file === file)).toBe(true)
  const ownFailures = checks.flatMap((check) => check.evidence).filter((entry) =>
    !PASS[entry.code] && (entry.coverageFile === FRAGMENT || OWNED.has(entry.source?.file ?? ''))
  )
  expect(ownFailures).toEqual([])
  expect(checks.find((check) => check.id === 'empty')!.evidence.some((entry) =>
    entry.code === 'state-covered' && entry.targetId === FLOATING && entry.coverageFile === FRAGMENT
  )).toBe(true)
})

test('workspace menu sources have no unresolved indexed assignments', () => {
  const graph = discoverUiFiles(terminal)
  expect(graph.failures).toEqual([])
  const unresolved = discoverCandidates(terminal, graph.files).filter((candidate) =>
    ASSIGNMENT_SOURCES.has(candidate.file) && candidate.kind === 'unresolved-assignment'
  )
  expect(unresolved).toEqual([])
})

test('removing Copy Tab ID coverage exposes its action candidate', () => {
  const index = coverage.actions.findIndex((entry) => {
    if (!('route' in entry) || entry.route.target !== WORKSPACE) return false
    const witnesses = [entry.site.quote, entry.route.invoke.quote, ...(entry.route.via ?? []).map((via) => via.quote)].join('\n')
    return /action\s*:\s*['"]copy-id['"]/.test(witnesses) && /(?:kind\s*:\s*['"]tab['"]|['"]tab['"])/.test(witnesses)
  })
  expect(index).toBeGreaterThanOrEqual(0)
  const candidateFile = coverage.actions[index]!.site.file
  const fresh = freshTerminal()
  const fragment = fresh.terminal.coverageFragments!.find((entry) => entry.file === FRAGMENT)!
  const clonedCoverage = parseCoverage(fragment.content)
  clonedCoverage.actions.splice(index, 1)
  replaceFragment(fresh.terminal, JSON.stringify(clonedCoverage))
  const missing = auditPlugin(fresh.inventory, fresh.terminal).find((check) => check.id === 'commands')!.evidence
  expect(missing.some((entry) => entry.code === 'coverage-missing' && entry.source?.file === candidateFile)).toBe(true)
})

test('undeclaring MENU makes the workspace-menu route undeclared', () => {
  const fresh = freshTerminal()
  fresh.terminal.contributions = {
    ...fresh.terminal.contributions!,
    commands: fresh.terminal.contributions!.commands.filter((id) => id !== MENU)
  }
  const routeFailures = auditPlugin(fresh.inventory, fresh.terminal).find((check) => check.id === 'commands')!.evidence
  expect(routeFailures.some((entry) => entry.code === 'route-undeclared' && entry.coverageFile === FRAGMENT)).toBe(true)
})

test('raw markup cannot satisfy the floating EmptyState witness', () => {
  const state = coverage.states.find((entry) => entry.surface === FLOATING && entry.state === 'empty')
  expect(state?.render.component).toBe('EmptyState')
  if (!state || state.render.component === 'toast') throw new Error('floating empty evidence must use EmptyState')
  const sourceFile = state.render.element.file
  const sharedQuote = state.render.element.quote
  const rawQuote = sharedQuote.replaceAll('EmptyState', 'div')
  expect(rawQuote).not.toBe(sharedQuote)

  const fresh = freshTerminal()
  const source = sourceFor(fresh.terminal, sourceFile)
  const changed = source.content.replace(sharedQuote, rawQuote)
  expect(changed).not.toBe(source.content)
  source.content = changed
  const emptyFailures = auditPlugin(fresh.inventory, fresh.terminal).find((check) => check.id === 'empty')!.evidence
    .filter((entry) => !PASS[entry.code])
  expect(emptyFailures.some((entry) => entry.coverageFile === FRAGMENT)).toBe(true)
})

test('workspace menu commands declare strict public argument schemas', async () => {
  type PropertySchema = { type: unknown; enum?: string[]; additionalProperties?: unknown }
  type CommandSchema = {
    id: string
    title: string
    palette?: boolean
    args: {
      type: unknown
      required?: string[]
      additionalProperties?: unknown
      properties: Record<string, PropertySchema>
    }
  }
  const manifest = await Bun.file(resolve(import.meta.dir, '../../quirky-plugin.json')).json() as {
    contributes: { command: CommandSchema[] }
  }
  const menu = manifest.contributes.command.find((entry) => entry.id === 'run-menu-item')!
  const workspace = manifest.contributes.command.find((entry) => entry.id === 'workspace-menu-action')!
  expect(menu.title).toBe('Run Terminal Menu Item')
  expect(workspace.title).toBe('Terminal Workspace Menu Action')

  expect(menu.palette).toBe(false)
  expect(menu.args.type).toBe('object')
  expect(menu.args.required).toEqual(['item'])
  expect(menu.args.additionalProperties).toBe(false)
  expect(Object.keys(menu.args.properties).sort()).toEqual(['group', 'item', 'session', 'workspace', 'worktree'])
  for (const property of Object.values(menu.args.properties)) expect(property.type).toBe('string')

  expect(workspace.palette).toBe(false)
  expect(workspace.args.type).toBe('object')
  expect(workspace.args.required).toEqual(['action', 'target'])
  expect(workspace.args.additionalProperties).toBe(false)
  expect(Object.keys(workspace.args.properties).sort()).toEqual(['action', 'agent', 'args', 'background', 'command', 'kind', 'open', 'target'])
  expect(workspace.args.properties.action.type).toBe('string')
  expect(workspace.args.properties.action.enum).toEqual(['copy-id', 'choose-agent', 'hidden-tabs', 'run-group-command'])
  expect(workspace.args.properties.kind.type).toBe('string')
  expect(workspace.args.properties.kind.enum).toEqual(['tab', 'pane', 'session'])
  for (const key of ['agent', 'command', 'target']) expect(workspace.args.properties[key]!.type).toBe('string')
  for (const key of ['background', 'open']) expect(workspace.args.properties[key]!.type).toBe('boolean')
  expect(workspace.args.properties.args!.type).toBe('object')
  expect(workspace.args.properties.args!.additionalProperties).toBe(true)
  for (const property of Object.values(workspace.args.properties)) expect(typeof property.type).toBe('string')
})

test('GroupView mousedown barriers only guard and stop their event', () => {
  const source = sourceFor(terminal, GROUP_VIEW)
  const parsed = ts.createSourceFile(GROUP_VIEW, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const attributes: ts.JsxAttribute[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'onMouseDown') attributes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)

  const eventBarriers = attributes.filter((attribute) => {
    const opening = attribute.parent.parent
    if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return false
    const isDivider = opening.attributes.properties.some((property) =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === 'data-group-divider'
    )
    return !isDivider
  })
  expect(eventBarriers).toHaveLength(4)

  for (const attribute of eventBarriers) {
    const handler = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined
    expect(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))).toBe(true)
    if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) continue
    const parameter = handler.parameters[0]?.name
    expect(parameter && ts.isIdentifier(parameter)).toBe(true)
    if (!parameter || !ts.isIdentifier(parameter)) continue
    const eventName = parameter.text
    let allowedCalls = 0
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        expect(ts.isPropertyAccessExpression(node.expression)).toBe(true)
        if (ts.isPropertyAccessExpression(node.expression)) {
          expect(ts.isIdentifier(node.expression.expression) && node.expression.expression.text === eventName).toBe(true)
          expect(['preventDefault', 'stopPropagation']).toContain(node.expression.name.text)
          expect(node.arguments).toHaveLength(0)
          allowedCalls++
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        expect(ts.isIdentifier(node.expression) && node.expression.text === eventName).toBe(true)
        expect(['button', 'preventDefault', 'stopPropagation']).toContain(node.name.text)
      }
      if (ts.isBinaryExpression(node)) {
        expect(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])
          .not.toContain(node.operatorToken.getText(parsed))
      }
      if (ts.isPrefixUnaryExpression(node)) expect([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]).not.toContain(node.operator)
      if (ts.isPostfixUnaryExpression(node)) expect([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]).not.toContain(node.operator)
      if (node.kind === ts.SyntaxKind.DeleteExpression) expect(false).toBe(true)
      ts.forEachChild(node, inspect)
    }
    inspect(handler.body)
    expect(allowedCalls).toBeGreaterThan(0)

    const opening = attribute.parent.parent
    expect(ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)).toBe(true)
    if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) continue
    const element = ts.isJsxOpeningElement(opening) ? opening.parent : opening
    expect(ts.isJsxElement(element) || ts.isJsxSelfClosingElement(element)).toBe(true)
    if (!ts.isJsxElement(element) && !ts.isJsxSelfClosingElement(element)) continue
    const site = element.getText(parsed)
    const evidence = coverage.actions.filter((entry) => entry.site.file === GROUP_VIEW && entry.site.quote === site && entry.anchor === 'onMouseDown')
    expect(evidence).toHaveLength(1)
    const barrier = evidence[0]!
    expect('transient' in barrier).toBe(true)
    if ('transient' in barrier) expect(['caret', 'draft']).toContain(barrier.transient)
  }
})
