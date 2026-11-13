import * as ts from 'typescript'
import { COMMANDS } from '../../packages/cli/src/commands'
import { groupOf } from '../../packages/cli/src/generated'
import { cliGroupWord, effectiveCliWords } from '../../packages/daemon/src/plugins/kinds'
import type { ActionEntry, Candidate, CheckResult, CoverageFile, Evidence, Inventory, PluginInventory, Ref, Render, StateKind } from './contracts'
import { discoverCandidates, discoverUiFiles } from './audit-discovery'
import { parseCoverage, resolveRef, resolveTarget, resolveVia, selectCandidate, type ResolvedRef } from './audit-evidence'

const IDS = ['loading', 'empty', 'error', 'commands'] as const
const STATE_IDS: readonly StateKind[] = ['loading', 'empty', 'error']
const PASS_CODES: Record<string, true> = { 'state-covered': true, 'state-not-applicable': true, 'not-state': true, 'action-routed': true, 'action-transient': true, 'action-not-user': true }
const LEAVES: Record<string, true> = { 'shared-render': true, 'toast-call': true, 'status-role': true, 'state-text': true }
const DECISIVE: Record<string, true> = { click: true, doubleclick: true, dblclick: true, auxclick: true, submit: true, drop: true, action: true, select: true, choose: true, confirm: true, retry: true, save: true }
const LIFECYCLE: Record<string, true> = { load: true, error: true, abort: true, animationstart: true, animationend: true, animationiteration: true, transitionstart: true, transitionend: true, transitionrun: true, transitioncancel: true, loadeddata: true, loadedmetadata: true, canplay: true, ended: true, resize: true }
type AuditId = typeof IDS[number]
type LocatedNode = { file: string; node: ts.Node }
type RouteResult = { api: string; cli: string } | Evidence

function issue(code: string, message: string, at?: ResolvedRef | LocatedNode): Evidence {
  if (!at) return { code, message, basis: 'source-audit' }
  const node = 'node' in at ? at.node : undefined
  const source = node ? node.getSourceFile() : (at as ResolvedRef).source
  const position = source.getLineAndCharacterOfPosition(node ? node.getStart(source) : (at as ResolvedRef).start)
  return { code, message, basis: 'source-audit', source: { file: at.file, line: position.line + 1, column: position.character + 1 } }
}

function contains(outer: ts.Node, inner: ts.Node) {
  return outer.getSourceFile().fileName === inner.getSourceFile().fileName && outer.getStart() <= inner.getStart() && outer.end >= inner.end
}

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
  return node
}

function lastName(node: ts.Node): string | undefined {
  node = unwrap(node)
  return ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined
}

function staticPropertyName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text
  return undefined
}

function candidateNode(candidate: Candidate, source: ts.SourceFile): ts.Node | undefined {
  let result: ts.Node | undefined
  const matches = (node: ts.Node) => {
    switch (candidate.kind) {
      case 'conditional-render': return ts.isConditionalExpression(node) || ts.isBinaryExpression(node)
      case 'branch-return': return ts.isIfStatement(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)
      case 'branch-dom-write': return ts.isIfStatement(node)
      case 'shared-render': case 'native-form': return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)
      case 'toast-call': case 'event-listener': case 'unresolved-listener': return ts.isCallExpression(node)
      case 'status-role': case 'jsx-handler': return ts.isJsxAttribute(node)
      case 'state-text': return ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      case 'handler-property': return ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)
      case 'handler-assignment': return ts.isBinaryExpression(node)
      case 'command-entry': return ts.isPropertyAssignment(node)
      case 'unresolved-spread': return ts.isJsxSpreadAttribute(node) || ts.isSpreadAssignment(node)
      case 'unresolved-computed': return ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isShorthandPropertyAssignment(node)
      default: return false
    }
  }
  const visit = (node: ts.Node) => {
    if (node.getStart(source) > candidate.anchorStart || node.end < candidate.anchorEnd) return
    if (matches(node)) result = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function controlled(node: ts.Node): ts.Node[] {
  if (ts.isIfStatement(node)) return node.elseStatement ? [node.thenStatement, node.elseStatement] : [node.thenStatement]
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return [...node.statements]
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse]
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return [node.right]
  return [node]
}

function actionHandler(node: ts.Node): ts.Node | undefined {
  if (ts.isJsxAttribute(node)) return node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined
  if (ts.isPropertyAssignment(node)) return node.initializer
  if (ts.isShorthandPropertyAssignment(node)) return node.name
  if (ts.isCallExpression(node)) return node.arguments[1]
  if (ts.isBinaryExpression(node)) return node.right
  if (ts.isJsxSpreadAttribute(node) || ts.isSpreadAssignment(node)) return node.expression
  return node
}

function nodesInRef(ref: ResolvedRef, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (node.end < ref.start || node.getStart(ref.source) > ref.end) return
    if (node.getStart(ref.source) >= ref.start && node.end <= ref.end && predicate(node)) {
      result.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(ref.source)
  return result
}

function referencesName(nodes: readonly ts.Node[], name: string) {
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) found = true
    if (!found) ts.forEachChild(node, visit)
  }
  for (const node of nodes) visit(node)
  return found
}

function isBindingName(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) return node.elements.some((element) => ts.isBindingElement(element) && isBindingName(element.name, name))
  return false
}

function sharedBinding(element: LocatedNode, witness: ResolvedRef, component: string): Evidence | undefined {
  if (element.file !== witness.file) return issue('render-binding-invalid', 'The shared import must be in the render file', witness)
  const opening = ts.isJsxElement(element.node) ? element.node.openingElement : element.node as ts.JsxSelfClosingElement
  if (!ts.isIdentifier(opening.tagName)) return issue('render-element-invalid', 'The render must use a named shared component', element)
  const local = opening.tagName.text
  let imported = false
  for (const statement of witness.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@quirky/ui') continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly || specifier.name.text !== local || (specifier.propertyName?.text ?? local) !== component) continue
      if ((witness.start <= statement.getStart() && witness.end >= statement.end) || (witness.start <= specifier.getStart() && witness.end >= specifier.end)) imported = true
    }
  }
  if (!imported) return issue('render-binding-invalid', `No witnessed value import binds ${local} to ${component} from @quirky/ui`, witness)
  let shadowed = false
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && isBindingName(node.name, local)) shadowed = true
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node)) && node.name?.text === local) shadowed = true
    ts.forEachChild(node, visit)
  }
  visit(witness.source)
  return shadowed ? issue('render-binding-shadowed', `A local binding shadows ${local}`, element) : undefined
}

function forwarded(node: ts.Node | undefined, spread: boolean): boolean {
  if (!node) return false
  node = unwrap(node)
  if (spread) return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
  const handlerName = lastName(node)
  if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && handlerName && /^on[A-Z]/.test(handlerName)) return true
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node)) return false
  let body: ts.Node | undefined = node.body
  if (body && ts.isBlock(body)) {
    if (body.statements.length !== 1) return false
    const statement = body.statements[0]!
    body = ts.isExpressionStatement(statement) ? statement.expression : ts.isReturnStatement(statement) ? statement.expression : undefined
  }
  if (!body) return false
  body = unwrap(body)
  return ts.isCallExpression(body) && /^on[A-Z]/.test(lastName(body.expression) ?? '')
}

function publicRoute(inventory: Inventory, target: string, operation: string, at: ResolvedRef): RouteResult {
  const cliFor = (api: string, suffix = ''): RouteResult => {
    const command = COMMANDS.find((command) => command.methods.includes(api))
    return command ? { api, cli: `quirky ${command.name}${suffix}` } : issue('route-no-cli', `No CLI command exposes ${api}`, at)
  }
  if (operation === 'executeCommand' || operation === 'command') {
    if (!inventory.plugins.some((plugin) => plugin.contributions?.commands.includes(target))) return issue('route-undeclared', `Undeclared command ${target}`, at)
    return cliFor('ui.command.run', ` ${target}`)
  }
  if (operation === 'openView' || operation === 'togglePanel') {
    const kind = operation === 'openView' ? 'view:' : 'panel:'
    if (!target.startsWith(kind) || !inventory.plugins.some((plugin) => plugin.targets.includes(target))) return issue('route-undeclared', `Undeclared UI target ${target}`, at)
    return cliFor(operation === 'openView' ? 'ui.view.open' : 'ui.panel.open', ` ${target}`)
  }
  if (operation === 'closeView') return cliFor('ui.view.close')
  if (operation !== 'call') return issue('route-no-cli', 'This expression has no public CLI route', at)
  if (!target.includes('/')) return cliFor(target)
  const owner = inventory.plugins.find((plugin) => plugin.contributions?.methods.includes(target))
  if (!owner) return issue('route-undeclared', `Undeclared method ${target}`, at)
  const declared = owner.contributions!.cliCommands.find((command) => command.methods.includes(target))
  const words = declared ? `${cliGroupWord(owner.id)} ${effectiveCliWords(declared.id, declared.words)}` : `${groupOf(owner.id)} ${target.slice(target.indexOf('/') + 1)}`
  if (COMMANDS.some((command) => words === command.name || words.startsWith(`${command.name} `))) return issue('route-cli-shadowed', `Kernel command shadows quirky ${words}`, at)
  if (!declared && inventory.plugins.some((plugin) => plugin.contributions?.cliCommands.some((command) => `${cliGroupWord(plugin.id)} ${effectiveCliWords(command.id, command.words)}` === words))) return issue('route-cli-shadowed', `A declared command shadows quirky ${words}`, at)
  return { api: target, cli: `quirky ${words}` }
}

/** Audits only the snapshotted UI graph, with quote-bound classifications and public routes. */
export function auditPlugin(inventory: Inventory, plugin: PluginInventory): CheckResult[] {
  const evidence: Record<AuditId, Evidence[]> = { loading: [], empty: [], error: [], commands: [] }
  const applicable: Record<AuditId, boolean> = { loading: true, empty: true, error: true, commands: true }
  const add = (ids: readonly AuditId[], item: Evidence) => { for (const id of ids) evidence[id].push(item) }
  const finish = () => IDS.map((id): CheckResult => {
    const failure = evidence[id].find((item) => !PASS_CODES[item.code])
    return { id, status: failure ? 'fail' : 'pass', applicable: applicable[id], reason: failure?.code ?? (applicable[id] ? 'source-audit' : 'state-not-applicable'), evidence: evidence[id] }
  })
  try {
    const graph = discoverUiFiles(plugin)
    for (const failure of graph.failures) add(IDS, { ...failure, basis: 'source-audit' })
    const candidates = discoverCandidates(plugin, graph.files)
    const sources = new Map(graph.files.map((file) => {
      const text = plugin.sources.find((source) => source.file === file)!.content
      return [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)] as const
    }))
    const nodeOf = (candidate: Candidate) => candidateNode(candidate, sources.get(candidate.file)!)
    const owners = new Map<Candidate, AuditId[][]>()
    const stateSites: Array<{ candidate: Candidate; state: StateKind }> = []
    const staleHelperRegions: Array<LocatedNode & { state: StateKind }> = []
    const claim = (candidate: Candidate, ids: AuditId[]) => {
      const previous = owners.get(candidate) ?? []
      if (previous.length) add([...new Set([...previous.flat(), ...ids])], issue('coverage-duplicate', `Candidate ${candidate.kind} is covered more than once`, { file: candidate.file, node: nodeOf(candidate)! }))
      previous.push(ids)
      owners.set(candidate, previous)
    }
    const resolve = (reference: Ref, ids: readonly AuditId[]) => {
      const resolved = resolveRef(plugin, graph.files, reference)
      if ('code' in resolved) { add(ids, resolved); return undefined }
      return resolved
    }
    const mapSite = (reference: Ref, anchor: string | undefined, category: 'state' | 'action', ids: AuditId[]) => {
      const resolved = resolve(reference, ids)
      if (!resolved) return undefined
      const candidate = selectCandidate(resolved, candidates, category, anchor)
      if ('code' in candidate) { add(ids, candidate); return undefined }
      claim(candidate, ids)
      return candidate
    }
    const linked = (site: LocatedNode | undefined, destination: LocatedNode, via: Ref[] | undefined, ids: AuditId[], failureCode: string, allowContainingRender = false) => {
      let roots = site ? controlled(site.node) : []
      let file = site?.file
      let valid = true
      for (const reference of via ?? []) {
        const resolved = resolve(reference, ids)
        if (!resolved) { valid = false; continue }
        const helper = resolveVia(resolved)
        if ('code' in helper) { add(ids, helper); valid = false; continue }
        if (!referencesName(roots, helper.name)) { add(ids, issue(failureCode, `The classified site does not reach helper ${helper.name}`, resolved)); valid = false }
        roots = [helper.node]
        file = resolved.file
      }
      if (!site) { add(ids, issue(failureCode, 'The classified site has no linked handler or render node', destination)); return false }
      const direct = file === destination.file && roots.some((root) => contains(root, destination.node))
      const insideRender = allowContainingRender && !via?.length && site.file === destination.file && contains(destination.node, site.node)
      if (!direct && !insideRender) { add(ids, issue(failureCode, 'The witness is not linked to the classified site', destination)); valid = false }
      return valid
    }
    const render = (entry: CoverageFile['states'][number], candidate: Candidate | undefined) => {
      const ids: AuditId[] = [entry.state]
      const value: Render = entry.render
      const accepted = entry.state === 'loading' ? ['EmptyState', 'NoticeLine'] : entry.state === 'empty' ? ['EmptyState'] : ['InlineError', 'FormRow', 'toast']
      if (!accepted.includes(value.component)) add(ids, issue('render-not-accepted', `${value.component} is not accepted for ${entry.state}`))
      const reference = resolve(value.component === 'toast' ? value.call : value.element, ids)
      const importRef = value.component === 'toast' ? undefined : resolve(value.import, ids)
      if (!reference) {
        let roots = candidate ? controlled(nodeOf(candidate)!) : []
        for (const via of value.via ?? []) {
          const resolved = resolve(via, ids)
          const quoted = ts.createSourceFile(via.file, via.quote, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
          const helper = resolveVia(resolved ?? { file: via.file, source: quoted, start: 0, end: via.quote.length, text: via.quote })
          if ('code' in helper) { if (resolved) add(ids, helper); continue }
          const source = sources.get(via.file)
          const matches: ts.Node[] = []
          const visit = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) && node.name?.text === helper.name) matches.push(node)
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === helper.name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) matches.push(node.initializer)
            ts.forEachChild(node, visit)
          }
          if (source && referencesName(roots, helper.name)) visit(source)
          if (matches.length === 1) {
            staleHelperRegions.push({ file: via.file, node: matches[0]!, state: entry.state })
            roots = matches
          }
        }
        return
      }
      const nodes = nodesInRef(reference, (node) => value.component === 'toast'
        ? ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toast'
        : ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
      const element = nodes.length === 1 ? nodes[0] : undefined
      if (!element || (value.component === 'toast' && ts.isCallExpression(element) && !element.arguments.length)) {
        add(ids, issue('render-element-invalid', 'The render quote must contain one complete shared element or nonempty toast call', reference))
        return
      }
      const located = { file: reference.file, node: element }
      if (value.component !== 'toast') {
        const opening = ts.isJsxElement(element) ? element.openingElement : element as ts.JsxSelfClosingElement
        if (!ts.isIdentifier(opening.tagName) || /^[a-z]/.test(opening.tagName.text)) add(ids, issue('render-element-invalid', 'A raw element is not a shared state component', located))
        else if (importRef) { const failure = sharedBinding(located, importRef, value.component); if (failure) add(ids, failure) }
        if (value.component === 'FormRow' && !opening.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'error')) add(ids, issue('render-element-invalid', 'FormRow error evidence requires an error attribute', located))
      }
      const siteNode = candidate && nodeOf(candidate)
      linked(siteNode ? { file: candidate!.file, node: siteNode } : undefined, located, value.via, ids, 'render-not-linked', true)
      for (const leaf of candidates) {
        if (leaf !== candidate && leaf.category === 'state' && LEAVES[leaf.kind] && leaf.file === reference.file) {
          const leafNode = nodeOf(leaf)
          if (leafNode && contains(element, leafNode)) claim(leaf, ids)
        }
      }
      if (candidate) add(ids, { ...issue('state-covered', `${entry.surface}: ${entry.state} uses ${value.component}`, { file: candidate.file, node: siteNode! }), component: value.component, targetId: entry.surface })
    }
    const action = (entry: ActionEntry) => {
      const ids: AuditId[] = ['commands']
      const candidate = mapSite(entry.site, entry.anchor, 'action', ids)
      const node = candidate && nodeOf(candidate)
      if ('route' in entry) {
        const invoke = resolve(entry.route.invoke, ids)
        if (!invoke) return
        const expressions = nodesInRef(invoke, (node) => ts.isCallExpression(node) || (ts.isPropertyAssignment(node) && staticPropertyName(node.name) === 'command'))
        const expression = expressions.length === 1 ? expressions[0] : undefined
        if (!expression) { add(ids, issue('route-no-cli', 'The invoke quote must contain one route expression', invoke)); return }
        const handler = node && (candidate?.kind === 'command-entry' ? node : actionHandler(node))
        linked(handler && candidate ? { file: candidate.file, node: handler } : undefined, { file: invoke.file, node: expression }, entry.route.via, ids, 'route-not-linked')
        let operation: string | undefined
        let target: string | undefined
        if (ts.isCallExpression(expression)) {
          operation = lastName(expression.expression)
          target = operation === 'closeView' ? 'ui.view.close' : expression.arguments[0] && resolveTarget(plugin, graph.files, invoke.source, expression.arguments[0])
        } else if (ts.isPropertyAssignment(expression)) {
          operation = 'command'
          target = resolveTarget(plugin, graph.files, invoke.source, expression.initializer)
        }
        if (!['call', 'executeCommand', 'openView', 'closeView', 'togglePanel', 'command'].includes(operation ?? '')) { add(ids, issue('route-no-cli', 'This operation has no public CLI route', invoke)); return }
        if (target === undefined) { add(ids, issue('route-target-unresolved', 'The route target is not a literal or one-hop constant', invoke)); return }
        if (target !== entry.route.target) { add(ids, issue('route-target-changed', `Witness resolves to ${target}, not ${entry.route.target}`, invoke)); return }
        const result = publicRoute(inventory, target, operation!, invoke)
        if ('code' in result) add(ids, result)
        else add(ids, { ...issue('action-routed', `Action routes through ${target}`, invoke), ...result })
      } else if (candidate && node) {
        const located = { file: candidate.file, node }
        const name = candidate.kind === 'event-listener' && ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text
          : candidate.kind === 'handler-assignment' && ts.isBinaryExpression(node) ? lastName(node.left) ?? ''
          : 'name' in node && node.name && typeof node.name === 'object' && 'getText' in node.name ? staticPropertyName(node.name as ts.Node) ?? '' : ''
        const event = name.replace(/^on/i, '').toLowerCase()
        const kind = 'transient' in entry ? entry.transient : entry.notAction
        const unresolved = candidate.kind.startsWith('unresolved-')
        if (kind === 'forwarded') {
          if (!forwarded(actionHandler(node), candidate.kind === 'unresolved-spread')) add(ids, issue('forwarded-invalid', 'Forwarding must be a handler reference, one forwarding call, or a props spread', located))
          else add(ids, issue('action-not-user', entry.reason, located))
        } else if (unresolved || DECISIVE[event] || (kind === 'lifecycle' && !LIFECYCLE[event]) || (kind === 'subscription' && !['handler-property', 'event-listener', 'handler-assignment'].includes(candidate.kind))) {
          add(ids, issue('transient-not-allowed', `Candidate ${candidate.kind} / ${name} must route or forward`, located))
        } else add(ids, issue('transient' in entry ? 'action-transient' : 'action-not-user', entry.reason, located))
      }
    }
    let coverage: CoverageFile | undefined
    if (!plugin.coverage) add(IDS, issue('coverage-file-missing', `Missing ${plugin.directory}/ui-scoreboard.json`))
    else {
      try { coverage = parseCoverage(plugin.coverage.content) }
      catch (error) { add(IDS, issue('coverage-file-invalid', error instanceof Error ? error.message : String(error))) }
    }
    if (coverage) {
      const surfaces = plugin.targets.length ? plugin.targets : ['ui']
      for (const surface of Object.keys(coverage.surfaces)) if (!surfaces.includes(surface)) add(STATE_IDS, { ...issue('surface-unknown', `Unknown surface ${surface}`), targetId: surface })
      for (const state of STATE_IDS) {
        applicable[state] = false
        for (const surface of surfaces) {
          const decision = coverage.surfaces[surface]?.[state]
          const entries = coverage.states.filter((entry) => entry.surface === surface && entry.state === state)
          if (!decision) { applicable[state] = true; add([state], { ...issue('surface-decision-missing', `${surface} needs a ${state} decision`), targetId: surface }); continue }
          if (decision.applicable) {
            applicable[state] = true
            if (!entries.length) add([state], { ...issue('state-missing', `${surface} requires ${state} evidence`), targetId: surface })
          } else {
            for (const reference of decision.evidence) resolve(reference, [state])
            if (entries.length) add([state], { ...issue('applicability-conflict', `${surface} marks ${state} inapplicable but classifies it`), targetId: surface })
            add([state], { ...issue('state-not-applicable', decision.reason), targetId: surface })
          }
        }
      }
      for (const entry of coverage.states) {
        if (!surfaces.includes(entry.surface)) add([entry.state], { ...issue('surface-unknown', `Unknown state surface ${entry.surface}`), targetId: entry.surface })
        const candidate = mapSite(entry.site, entry.anchor, 'state', [entry.state])
        if (candidate) stateSites.push({ candidate, state: entry.state })
        render(entry, candidate)
      }
      for (const entry of coverage.notState) {
        const candidate = mapSite(entry.site, entry.anchor, 'state', [...STATE_IDS])
        if (candidate) add(STATE_IDS, issue('not-state', entry.reason, { file: candidate.file, node: nodeOf(candidate)! }))
      }
      for (const entry of coverage.actions) action(entry)
    }
    for (const candidate of candidates) {
      const node = nodeOf(candidate)
      const at = node ? { file: candidate.file, node } : undefined
      if (candidate.kind === 'native-form') add(['commands'], issue('native-form-submit', 'A native form needs an onSubmit handler with a public route', at))
      if (owners.has(candidate)) continue
      let ids: readonly AuditId[] = candidate.category === 'action' ? ['commands'] : STATE_IDS
      if (candidate.category === 'state' && LEAVES[candidate.kind] && node) {
        const related = [
          ...stateSites.filter((site) => site.candidate.file === candidate.file && controlled(nodeOf(site.candidate)!).some((root) => contains(root, node))).map((site) => site.state),
          ...staleHelperRegions.filter((region) => region.file === candidate.file && contains(region.node, node)).map((region) => region.state)
        ]
        if (related.length) ids = [...new Set(related)]
      }
      add(ids, issue('coverage-missing', `Unmapped ${candidate.category} candidate ${candidate.kind}: ${candidate.anchorText}`, at))
    }
  } catch (error) {
    add(IDS, issue('source-audit-error', error instanceof Error ? error.message : String(error)))
  }
  return finish()
}
