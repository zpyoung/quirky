import * as ts from 'typescript'
import { posix } from 'node:path'
import type { Candidate, CandidateCategory, CoverageFile, Evidence, PluginInventory, Ref, Route } from './contracts'

export type ResolvedRef = { file: string; source: ts.SourceFile; start: number; end: number; text: string }

type RecordValue = Record<string, unknown>
type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration
type ViaDeclaration = { node: ts.FunctionLikeDeclaration; name: string; start: number; end: number }

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidCoverage(message: string): never {
  throw new Error(`Invalid coverage file: ${message}`)
}

function exactKeys(value: RecordValue, label: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalidCoverage(`${label} is missing ${key}`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidCoverage(`${label} has unknown key ${key}`)
  }
}

function recordValue(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) invalidCoverage(`${label} must be an object`)
  return value
}

function stringValue(value: unknown, label: string, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && value.trim().length === 0)) invalidCoverage(`${label} must be a${nonempty ? ' non-empty' : ''} string`)
  return value
}


function parseRef(value: unknown, label: string): Ref {
  const ref = recordValue(value, label)
  exactKeys(ref, label, ['file', 'quote'])
  return {
    file: stringValue(ref.file, `${label}.file`),
    quote: stringValue(ref.quote, `${label}.quote`)
  }
}

function parseRefArray(value: unknown, label: string): Ref[] {
  if (!Array.isArray(value)) invalidCoverage(`${label} must be an array`)
  return value.map((entry, index) => parseRef(entry, `${label}[${index}]`))
}

function parseDecision(value: unknown, label: string): CoverageFile['surfaces'][string]['loading'] {
  const decision = recordValue(value, label)
  if (decision.applicable === true) {
    exactKeys(decision, label, ['applicable'])
    return { applicable: true }
  }
  if (decision.applicable === false) {
    exactKeys(decision, label, ['applicable', 'reason', 'evidence'])
    const evidence = parseRefArray(decision.evidence, `${label}.evidence`)
    if (evidence.length === 0) invalidCoverage(`${label}.evidence must not be empty`)
    return { applicable: false, reason: stringValue(decision.reason, `${label}.reason`), evidence }
  }
  invalidCoverage(`${label}.applicable must be a boolean`)
}

function parseSurface(value: unknown, label: string): CoverageFile['surfaces'][string] {
  const surface = recordValue(value, label)
  exactKeys(surface, label, ['loading', 'empty', 'error'])
  return {
    loading: parseDecision(surface.loading, `${label}.loading`),
    empty: parseDecision(surface.empty, `${label}.empty`),
    error: parseDecision(surface.error, `${label}.error`)
  }
}

function parseVia(value: RecordValue, label: string): Ref[] | undefined {
  return Object.hasOwn(value, 'via') ? parseRefArray(value.via, `${label}.via`) : undefined
}

function parseRender(value: unknown, label: string): CoverageFile['states'][number]['render'] {
  const render = recordValue(value, label)
  const component = stringValue(render.component, `${label}.component`)
  if (component === 'toast') {
    exactKeys(render, label, ['component', 'call'], ['via'])
    const via = parseVia(render, label)
    return { component, call: parseRef(render.call, `${label}.call`), ...(via === undefined ? {} : { via }) }
  }
  if (component === 'EmptyState' || component === 'NoticeLine' || component === 'InlineError' || component === 'FormRow') {
    exactKeys(render, label, ['component', 'element', 'import'], ['via'])
    const via = parseVia(render, label)
    return {
      component,
      element: parseRef(render.element, `${label}.element`),
      import: parseRef(render.import, `${label}.import`),
      ...(via === undefined ? {} : { via })
    }
  }
  invalidCoverage(`${label}.component is unsupported`)
}

function parseState(value: unknown, label: string): CoverageFile['states'][number] {
  const state = recordValue(value, label)
  exactKeys(state, label, ['surface', 'state', 'site', 'render'], ['anchor'])
  const stateKind = stringValue(state.state, `${label}.state`)
  if (stateKind !== 'loading' && stateKind !== 'empty' && stateKind !== 'error') invalidCoverage(`${label}.state is unsupported`)
  return {
    surface: stringValue(state.surface, `${label}.surface`),
    state: stateKind,
    site: parseRef(state.site, `${label}.site`),
    ...(Object.hasOwn(state, 'anchor') ? { anchor: stringValue(state.anchor, `${label}.anchor`, false) } : {}),
    render: parseRender(state.render, `${label}.render`)
  }
}

function parseNotState(value: unknown, label: string): CoverageFile['notState'][number] {
  const entry = recordValue(value, label)
  exactKeys(entry, label, ['site', 'reason'], ['anchor'])
  return {
    site: parseRef(entry.site, `${label}.site`),
    ...(Object.hasOwn(entry, 'anchor') ? { anchor: stringValue(entry.anchor, `${label}.anchor`, false) } : {}),
    reason: stringValue(entry.reason, `${label}.reason`)
  }
}

function parseRoute(value: unknown, label: string): Route {
  const route = recordValue(value, label)
  exactKeys(route, label, ['invoke', 'target'], ['via'])
  const via = parseVia(route, label)
  return {
    invoke: parseRef(route.invoke, `${label}.invoke`),
    target: stringValue(route.target, `${label}.target`),
    ...(via === undefined ? {} : { via })
  }
}

function parseAction(value: unknown, label: string): CoverageFile['actions'][number] {
  const entry = recordValue(value, label)
  if (!Object.hasOwn(entry, 'site')) invalidCoverage(`${label} is missing site`)
  const hasRoute = Object.hasOwn(entry, 'route')
  const hasTransient = Object.hasOwn(entry, 'transient')
  const hasNotAction = Object.hasOwn(entry, 'notAction')
  if (Number(hasRoute) + Number(hasTransient) + Number(hasNotAction) !== 1) invalidCoverage(`${label} must have exactly one action classification`)

  if (hasRoute) {
    exactKeys(entry, label, ['site', 'route'], ['anchor'])
    return {
      site: parseRef(entry.site, `${label}.site`),
      ...(Object.hasOwn(entry, 'anchor') ? { anchor: stringValue(entry.anchor, `${label}.anchor`, false) } : {}),
      route: parseRoute(entry.route, `${label}.route`)
    }
  }
  if (hasTransient) {
    exactKeys(entry, label, ['site', 'transient', 'reason'], ['anchor'])
    const transient = stringValue(entry.transient, `${label}.transient`)
    if (transient !== 'caret' && transient !== 'hover' && transient !== 'draft') invalidCoverage(`${label}.transient is unsupported`)
    return {
      site: parseRef(entry.site, `${label}.site`),
      ...(Object.hasOwn(entry, 'anchor') ? { anchor: stringValue(entry.anchor, `${label}.anchor`, false) } : {}),
      transient,
      reason: stringValue(entry.reason, `${label}.reason`)
    }
  }
  exactKeys(entry, label, ['site', 'notAction', 'reason'], ['anchor'])
  const notAction = stringValue(entry.notAction, `${label}.notAction`)
  if (notAction !== 'lifecycle' && notAction !== 'subscription' && notAction !== 'forwarded') invalidCoverage(`${label}.notAction is unsupported`)
  return {
    site: parseRef(entry.site, `${label}.site`),
    ...(Object.hasOwn(entry, 'anchor') ? { anchor: stringValue(entry.anchor, `${label}.anchor`, false) } : {}),
    notAction,
    reason: stringValue(entry.reason, `${label}.reason`)
  }
}

function assertUniqueJsonKeys(text: string): void {
  let source: ts.JsonSourceFile
  try {
    source = ts.parseJsonText('ui-scoreboard.json', text)
  } catch {
    invalidCoverage('malformed JSON')
  }

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>()
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.name)) continue
        const key = property.name.text
        if (seen.has(key)) invalidCoverage(`duplicate key ${key}`)
        seen.add(key)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** Parses a strict coverage file, rejecting duplicate and unknown keys at every depth. */
export function parseCoverage(text: string): CoverageFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalidCoverage('malformed JSON')
  }
  assertUniqueJsonKeys(text)

  const root = recordValue(value, 'coverage file')
  exactKeys(root, 'coverage file', ['schemaVersion', 'surfaces', 'states', 'notState', 'actions'])
  if (root.schemaVersion !== 1) invalidCoverage('schemaVersion must be 1')

  const rawSurfaces = recordValue(root.surfaces, 'surfaces')
  const surfaces: CoverageFile['surfaces'] = Object.create(null) as CoverageFile['surfaces']
  for (const [surfaceId, rawSurface] of Object.entries(rawSurfaces)) {
    stringValue(surfaceId, 'surface key')
    surfaces[surfaceId] = parseSurface(rawSurface, `surfaces.${surfaceId}`)
  }
  if (!Array.isArray(root.states)) invalidCoverage('states must be an array')
  if (!Array.isArray(root.notState)) invalidCoverage('notState must be an array')
  if (!Array.isArray(root.actions)) invalidCoverage('actions must be an array')

  return {
    schemaVersion: 1,
    surfaces,
    states: root.states.map((entry, index) => parseState(entry, `states[${index}]`)),
    notState: root.notState.map((entry, index) => parseNotState(entry, `notState[${index}]`)),
    actions: root.actions.map((entry, index) => parseAction(entry, `actions[${index}]`))
  }
}

function evidence(code: string, message: string, file?: string, source?: ts.SourceFile, offset?: number): Evidence {
  const result: Evidence = { code, message, basis: 'source-audit' }
  if (file !== undefined && source !== undefined && offset !== undefined) {
    const location = source.getLineAndCharacterOfPosition(offset)
    result.source = { file, line: location.line + 1, column: location.character + 1 }
  }
  return result
}

function scriptKind(file: string): ts.ScriptKind {
  const extension = posix.extname(file).toLowerCase()
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function canonicalPluginFile(file: string, directory: string): boolean {
  if (file.length === 0 || file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return false
  const segments = file.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  if (posix.normalize(file) !== file) return false
  const prefix = `${directory.replace(/\/+$/, '')}/`
  return file.startsWith(prefix)
}

/** Resolves a unique exact quote from one of the plugin's discovered UI files. */
export function resolveRef(plugin: PluginInventory, files: readonly string[], ref: Ref): ResolvedRef | Evidence {
  if (typeof ref?.file !== 'string' || !canonicalPluginFile(ref.file, plugin.directory) || !files.includes(ref.file)) {
    return evidence('evidence-path-invalid', `Evidence file is not a canonical UI path in the plugin graph: ${String(ref?.file)}`)
  }
  const sourceFile = plugin.sources.find((source) => source.file === ref.file)
  if (sourceFile === undefined) {
    return evidence('evidence-path-invalid', `Evidence file has no captured source: ${ref.file}`)
  }
  const quote = typeof ref.quote === 'string' ? ref.quote : ''
  if (quote.length === 0) return evidence('evidence-missing', `Evidence quote is empty in ${ref.file}`)

  let first = -1
  let count = 0
  for (let offset = sourceFile.content.indexOf(quote); offset !== -1; offset = sourceFile.content.indexOf(quote, offset + 1)) {
    if (first === -1) first = offset
    count += 1
    if (count > 1) break
  }
  if (count === 0) return evidence('evidence-missing', `Evidence quote was not found in ${ref.file}: ${JSON.stringify(quote)}`)

  const source = ts.createSourceFile(ref.file, sourceFile.content, ts.ScriptTarget.Latest, true, scriptKind(ref.file))
  if (count > 1) {
    return evidence('evidence-ambiguous', `Evidence quote occurs more than once in ${ref.file}: ${JSON.stringify(quote)}`, ref.file, source, first)
  }
  return { file: ref.file, source, start: first, end: first + quote.length, text: quote }
}

/** Maps a resolved quote to its unique candidate anchor, using an explicit anchor only to disambiguate. */
export function selectCandidate(ref: ResolvedRef, candidates: readonly Candidate[], category: CandidateCategory, anchor?: string): Candidate | Evidence {
  const matches = candidates.filter((candidate) => candidate.file === ref.file && candidate.category === category && candidate.anchorStart >= ref.start && candidate.anchorEnd <= ref.end)
  if (matches.length === 0) {
    return evidence('site-not-candidate', `No ${category} candidate anchor is contained in the quote from ${ref.file}`, ref.file, ref.source, ref.start)
  }
  if (matches.length === 1 && anchor === undefined) return matches[0]!
  if (anchor === undefined || anchor.length === 0) {
    return evidence('site-anchor-ambiguous', `Quote in ${ref.file} contains ${matches.length} ${category} candidate anchors; an anchor is required`, ref.file, ref.source, ref.start)
  }

  const first = ref.text.indexOf(anchor)
  if (first < 0 || ref.text.indexOf(anchor, first + 1) >= 0) {
    return evidence('site-anchor-ambiguous', `Anchor is not unique inside the quote from ${ref.file}: ${JSON.stringify(anchor)}`, ref.file, ref.source, ref.start)
  }
  const anchorStart = ref.start + first
  const selected = matches.filter((candidate) => candidate.anchorStart === anchorStart && candidate.anchorText.startsWith(anchor))
  if (selected.length !== 1) {
    return evidence('site-anchor-ambiguous', `Anchor does not exactly identify one ${category} candidate in ${ref.file}: ${JSON.stringify(anchor)}`, ref.file, ref.source, anchorStart)
  }
  return selected[0]!
}

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
}

function hasFunctionBody(node: FunctionNode): boolean {
  return ts.isArrowFunction(node) || node.body !== undefined
}

function bindingName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function variableForFunctionExpression(node: ts.FunctionExpression | ts.ArrowFunction): ts.VariableDeclaration | undefined {
  let expression: ts.Node = node
  while (expression.parent !== undefined && (
    (ts.isParenthesizedExpression(expression.parent) && expression.parent.expression === expression) ||
    (ts.isAsExpression(expression.parent) && expression.parent.expression === expression) ||
    (ts.isTypeAssertionExpression(expression.parent) && expression.parent.expression === expression) ||
    (ts.isSatisfiesExpression(expression.parent) && expression.parent.expression === expression) ||
    (ts.isNonNullExpression(expression.parent) && expression.parent.expression === expression)
  )) expression = expression.parent
  const declaration = expression.parent
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== expression) return undefined
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined
  return declaration
}

function describeViaNode(node: FunctionNode): ViaDeclaration | undefined {
  if (!hasFunctionBody(node)) return undefined
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const declaration = variableForFunctionExpression(node)
    const name = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
    if (declaration === undefined || name === undefined) return undefined
    return { node, name, start: declaration.getStart(node.getSourceFile()), end: declaration.getEnd() }
  }
  let name: string | undefined
  if (ts.isFunctionDeclaration(node)) name = node.name?.text
  else if (ts.isConstructorDeclaration(node)) {
    const classNode = node.parent
    name = ts.isClassDeclaration(classNode) || ts.isClassExpression(classNode) ? classNode.name?.text : undefined
  } else name = bindingName(node.name)
  if (name === undefined) return undefined
  return { node, name, start: node.getStart(), end: node.getEnd() }
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

/** Resolves a via quote only when it contains one complete, named function-like declaration. */
export function resolveVia(ref: ResolvedRef): { node: ts.FunctionLikeDeclaration; name: string } | Evidence {
  const nodes: FunctionNode[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node)) nodes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ref.source)

  const complete = nodes
    .map(describeViaNode)
    .filter((entry): entry is ViaDeclaration => entry !== undefined && entry.start >= ref.start && entry.end <= ref.end)
  const roots = complete.filter((entry) => !complete.some((other) => other !== entry && isDescendantOf(entry.node, other.node)))
  if (roots.length !== 1) {
    return evidence('via-invalid', `Via quote in ${ref.file} must contain one complete named function-like declaration`, ref.file, ref.source, ref.start)
  }

  const selected = roots[0]!
  return { node: selected.node, name: selected.name }
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const

function uiImportTarget(fromFile: string, specifier: string, files: readonly string[], plugin: PluginInventory): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  if (!canonicalPluginFile(base, plugin.directory) && !files.includes(base)) return undefined
  const candidates: string[] = []
  const extension = posix.extname(base)
  if (extension.length > 0) {
    candidates.push(base)
    if (extension === '.js') candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
    if (extension === '.jsx') candidates.push(base.slice(0, -4) + '.tsx', base.slice(0, -4) + '.ts')
    if (extension === '.mjs') candidates.push(base.slice(0, -4) + '.mts')
    if (extension === '.cjs') candidates.push(base.slice(0, -4) + '.cts')
  } else {
    candidates.push(base, ...CODE_EXTENSIONS.map((suffix) => `${base}${suffix}`))
    for (const suffix of CODE_EXTENSIONS) candidates.push(`${base}/index${suffix}`)
  }
  return candidates.find((candidate) => files.includes(candidate) && canonicalPluginFile(candidate, plugin.directory))
}

function literalString(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  return undefined
}

function topLevelConst(source: ts.SourceFile, name: string, exportedOnly = false): ts.VariableDeclaration[] {
  const matches: ts.VariableDeclaration[] = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    if (exportedOnly && !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) matches.push(declaration)
    }
  }
  return matches
}

function namedImportSource(plugin: PluginInventory, files: readonly string[], source: ts.SourceFile, localName: string): { source: ts.SourceFile; importedName: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause || statement.importClause.isTypeOnly) continue
    const namedBindings = statement.importClause.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
    const specifier = namedBindings.elements.find((entry) => !entry.isTypeOnly && entry.name.text === localName)
    if (!specifier) continue
    const target = uiImportTarget(source.fileName, statement.moduleSpecifier.text, files, plugin)
    if (target === undefined) return undefined
    const captured = plugin.sources.find((entry) => entry.file === target)
    if (captured === undefined) return undefined
    const imported = ts.createSourceFile(target, captured.content, ts.ScriptTarget.Latest, true, scriptKind(target))
    return { source: imported, importedName: specifier.propertyName?.text ?? specifier.name.text }
  }
  return undefined
}

function constantLiteral(plugin: PluginInventory, files: readonly string[], source: ts.SourceFile, name: string): string | undefined {
  const local = topLevelConst(source, name)
  if (local.length === 1) {
    const initializer = local[0]!.initializer
    return initializer === undefined ? undefined : literalString(initializer)
  }
  if (local.length > 1) return undefined

  const imported = namedImportSource(plugin, files, source, name)
  if (imported === undefined) return undefined
  const declarations = topLevelConst(imported.source, imported.importedName, true)
  if (declarations.length !== 1 || declarations[0]!.initializer === undefined) return undefined
  return literalString(declarations[0]!.initializer)
}

function templateSubstitution(plugin: PluginInventory, files: readonly string[], source: ts.SourceFile, expression: ts.Expression): string | undefined {
  const literal = literalString(expression)
  if (literal !== undefined) return literal
  if (ts.isIdentifier(expression)) return constantLiteral(plugin, files, source, expression.text)
  return undefined
}

function resolveExpressionTarget(plugin: PluginInventory, files: readonly string[], source: ts.SourceFile, expression: ts.Expression): string | undefined {
  const literal = literalString(expression)
  if (literal !== undefined) return literal
  if (ts.isIdentifier(expression)) return constantLiteral(plugin, files, source, expression.text)
  if (!ts.isTemplateExpression(expression)) return undefined

  let result = expression.head.text
  for (const span of expression.templateSpans) {
    const substitution = templateSubstitution(plugin, files, source, span.expression)
    if (substitution === undefined) return undefined
    result += substitution + span.literal.text
  }
  return result
}

/** Resolves literals and one-hop top-level const or named-import targets; no general evaluation is performed. */
export function resolveTarget(plugin: PluginInventory, files: readonly string[], source: ts.SourceFile, expression: ts.Expression): string | undefined {
  return resolveExpressionTarget(plugin, files, source, expression)
}
