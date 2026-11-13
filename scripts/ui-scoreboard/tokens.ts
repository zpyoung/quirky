import * as ts from 'typescript'
import { uiTokens } from '../../packages/ui/src/design-system/tokens'
import { CHECK_IDS, type CheckResult, type Evidence, type Inventory, type PluginInventory, type SourceFile } from './contracts'
import { auditPlugin } from './audit'

const SOURCE_EXTENSIONS: Record<string, true> = {
  '.ts': true, '.tsx': true, '.js': true, '.jsx': true, '.mts': true, '.cts': true, '.mjs': true, '.cjs': true,
  '.html': true, '.htm': true, '.svg': true, '.css': true, '.scss': true, '.sass': true, '.less': true
}
const MARKUP_EXTENSIONS: Record<string, true> = { '.html': true, '.htm': true, '.svg': true, '.css': true, '.scss': true, '.sass': true, '.less': true }
const HTML_COMMENT_EXTENSIONS: Record<string, true> = { '.html': true, '.htm': true, '.svg': true }
const LINE_COMMENT_EXTENSIONS: Record<string, true> = { '.scss': true, '.sass': true, '.less': true }
const EXCLUDED_DIRECTORIES: Record<string, true> = {
  node_modules: true, vendor: true, dist: true, build: true, coverage: true, '.git': true,
  test: true, tests: true, __tests__: true, __test__: true, _test: true, _tests: true,
  fixture: true, fixtures: true, __fixtures__: true, _fixtures: true
}
const COMPLETE_COMPAT_TOKEN = /--compat-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g
const CSS_ESCAPED_COMPAT_PREFIX = /\\0*2d\s*\\0*2d\s*compat-/gi
const CSS_VAR_ARGUMENT = /var\(\s*([^,)]*)/gi
const CSS_ESCAPED_PROPERTY = /--[^\s:;,(){}]*\\[^\s:;,(){}]*/g

function normalizedPath(file: string): string {
  return file.replace(/\\/g, '/')
}

function extensionOf(file: string): string {
  return file.slice(file.lastIndexOf('.')).toLowerCase()
}

function shouldScan(source: SourceFile): boolean {
  const file = normalizedPath(source.file)
  if (file.endsWith('/design-system/compatibility-tokens.css')) return false
  if (!(extensionOf(file) in SOURCE_EXTENSIONS)) return false
  return !file.split('/').some((part) => part in EXCLUDED_DIRECTORIES)
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = extensionOf(file)
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function maskComments(content: string, file: string): string {
  const htmlComments = extensionOf(file) in HTML_COMMENT_EXTENSIONS
  const lineComments = extensionOf(file) in LINE_COMMENT_EXTENSIONS
  const parts: string[] = []
  let cursor = 0
  let quote = ''
  let escaped = false

  for (let index = 0; index < content.length; index++) {
    const character = content[index] ?? ''
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    let end = -1
    if (content.startsWith('/*', index)) {
      const close = content.indexOf('*/', index + 2)
      end = close < 0 ? content.length : close + 2
    } else if (htmlComments && content.startsWith('<!--', index)) {
      const close = content.indexOf('-->', index + 4)
      end = close < 0 ? content.length : close + 3
    } else if (lineComments && content.startsWith('//', index)) {
      const lineStart = content.lastIndexOf('\n', index - 1) + 1
      const prefix = content.slice(lineStart, index)
      if (prefix.trim() === '' || /\s$/.test(prefix)) {
        const newline = content.indexOf('\n', index)
        end = newline < 0 ? content.length : newline
      }
    }
    if (end < 0) continue

    parts.push(content.slice(cursor, index), content.slice(index, end).replace(/[^\r\n]/g, ' '))
    cursor = end
    index = end - 1
  }

  parts.push(content.slice(cursor))
  return parts.join('')
}

type Finding = { offset: number; evidence: Evidence }

type ImportedCatalogs = Set<string>

function scanText(content: string, report: (code: string, offset: number, message: string) => void): void {
  const tokenMatches = [...content.matchAll(COMPLETE_COMPAT_TOKEN)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    token: match[0]
  }))

  for (const match of tokenMatches) {
    const following = content.slice(match.end, match.end + 2)
    if (content[match.end] === '\\' || following === '${') {
      report('unresolved-style-token', match.start, `Unresolved escaped or dynamically extended style token fragment ${match.token}`)
    } else {
      report('compatibility-token', match.start, `Compatibility style token ${match.token} is still in use`)
    }
  }

  const possiblePrefix = /--c(?:o(?:m(?:p(?:a(?:t)?)?)?)?)?/g
  for (const match of content.matchAll(possiblePrefix)) {
    const offset = match.index!
    const next = content[offset + match[0].length] ?? ''
    const continues = match[0] === '--compat' ? /[A-Za-z0-9_]/.test(next) : /[A-Za-z0-9_-]/.test(next)
    if (continues || tokenMatches.some((token) => token.start === offset)) continue
    report('unresolved-style-token', offset, 'Unresolved incomplete compatibility style token fragment')
  }

}

function scanDecodedLiteral(decoded: string, raw: string, start: number, report: (code: string, offset: number, message: string) => void): void {
  const rawCounts = new Map<string, number>()
  for (const match of raw.matchAll(COMPLETE_COMPAT_TOKEN)) rawCounts.set(match[0], (rawCounts.get(match[0]) ?? 0) + 1)

  for (const match of decoded.matchAll(COMPLETE_COMPAT_TOKEN)) {
    const count = rawCounts.get(match[0]) ?? 0
    if (count > 0) {
      rawCounts.set(match[0], count - 1)
      continue
    }
    const escapedOffset = raw.indexOf('\\')
    report('unresolved-style-token', start + Math.max(0, escapedOffset), `Unresolved escaped style token spelling ${match[0]}`)
  }
}

function scanEscapedCssTokens(content: string, report: (code: string, offset: number, message: string) => void): void {
  for (const match of content.matchAll(CSS_ESCAPED_COMPAT_PREFIX)) {
    report('unresolved-style-token', match.index!, 'Unresolved escaped CSS compatibility token')
  }
  for (const match of content.matchAll(CSS_VAR_ARGUMENT)) {
    const argument = match[1] ?? ''
    const escapedOffset = argument.indexOf('\\')
    if (escapedOffset >= 0) {
      report('unresolved-style-token', match.index! + match[0].indexOf(argument) + escapedOffset, 'Unresolved escape in CSS var() argument')
    }
  }
  for (const match of content.matchAll(CSS_ESCAPED_PROPERTY)) {
    report('unresolved-style-token', match.index! + match[0].indexOf('\\'), 'Unresolved escape in CSS custom-property name')
  }
}

function sourceLocation(sourceFile: ts.SourceFile, file: string, offset: number) {
  const position = sourceFile.getLineAndCharacterOfPosition(Math.max(0, Math.min(offset, sourceFile.text.length)))
  return { file, line: position.line + 1, column: position.character + 1 }
}

function bindingContains(name: ts.BindingName, expected: string): boolean {
  if (ts.isIdentifier(name)) return name.text === expected
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingContains(element.name, expected))
}

function declarationsInStatement(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((decl) => bindingContains(decl.name, name))
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name?.text === name
  return false
}

function hasVarBinding(node: ts.Node, name: string, root: ts.Node): boolean {
  if (node !== root && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return false
  if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0 && node.declarations.some((decl) => bindingContains(decl.name, name))) return true
  return ts.forEachChild(node, (child) => hasVarBinding(child, name, root)) ?? false
}

function isFunctionScope(scope: ts.Node): scope is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) ||
    ts.isMethodDeclaration(scope) || ts.isConstructorDeclaration(scope) || ts.isGetAccessorDeclaration(scope) || ts.isSetAccessorDeclaration(scope)
}

function scopeShadows(scope: ts.Node, name: string): boolean {
  if (isFunctionScope(scope)) {
    if (scope.parameters.some((parameter) => bindingContains(parameter.name, name))) return true
    if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) && scope.name?.text === name) return true
    return !!scope.body && hasVarBinding(scope.body, name, scope.body)
  }
  if (ts.isClassExpression(scope) && scope.name?.text === name) return true
  if (ts.isBlock(scope) || ts.isSourceFile(scope)) return scope.statements.some((statement) => declarationsInStatement(statement, name))
  if (ts.isCaseBlock(scope)) {
    return scope.clauses.some((clause) => clause.statements.some((statement) => declarationsInStatement(statement, name)))
  }
  if (ts.isCatchClause(scope)) return !!scope.variableDeclaration && bindingContains(scope.variableDeclaration.name, name)
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const initializer = scope.initializer
    return !!initializer && ts.isVariableDeclarationList(initializer) && initializer.declarations.some((decl) => bindingContains(decl.name, name))
  }
  return false
}

function isShadowed(identifier: ts.Identifier, sourceFile: ts.SourceFile, name: string): boolean {
  for (let parent = identifier.parent; parent && parent !== sourceFile; parent = parent.parent) {
    if (scopeShadows(parent, name)) return true
  }
  return scopeShadows(sourceFile, name)
}

function importedCatalogs(sourceFile: ts.SourceFile): ImportedCatalogs {
  const names = new Set<string>()
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@quirky/ui') {
      const clause = node.importClause
      if (clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === 'uiTokens') names.add(element.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function stripParentheses(node: ts.Expression): ts.Expression {
  let expression = node
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return expression
}

type CatalogAccess = { root: ts.Identifier; keys: string[] }

function catalogAccess(node: ts.Expression): CatalogAccess | null {
  const expression = stripParentheses(node)
  if (ts.isIdentifier(expression)) return { root: expression, keys: [] }
  if (ts.isPropertyAccessExpression(expression) && !expression.questionDotToken) {
    const access = catalogAccess(expression.expression)
    return access ? { root: access.root, keys: [...access.keys, expression.name.text] } : null
  }
  if (ts.isElementAccessExpression(expression) && !expression.questionDotToken && expression.argumentExpression) {
    const argument = stripParentheses(expression.argumentExpression)
    const key = ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : null
    const access = key === null ? null : catalogAccess(expression.expression)
    return access && key !== null ? { root: access.root, keys: [...access.keys, key] } : null
  }
  return null
}

function resolveCatalogValue(node: ts.Expression, sourceFile: ts.SourceFile, imports: ImportedCatalogs): string | null {
  const access = catalogAccess(node)
  if (!access || access.keys.length === 0 || !imports.has(access.root.text) || isShadowed(access.root, sourceFile, access.root.text)) return null

  let value: unknown = uiTokens
  for (const key of access.keys) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return null
    value = (value as Record<string, unknown>)[key]
  }
  return typeof value === 'string' && value.startsWith('--ui-') ? value : null
}

function templateParts(node: ts.TemplateExpression): string[] {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
}

function safeDynamicTemplate(node: ts.TemplateExpression, index: number, sourceFile: ts.SourceFile, imports: ImportedCatalogs): boolean {
  const parts = templateParts(node)
  const before = parts[index] ?? ''
  const after = parts[index + 1] ?? ''
  const span = node.templateSpans[index]
  if (!span) return false
  const open = before.lastIndexOf('var(')
  if (open < 0 || before.indexOf(')', open + 4) >= 0 || after.indexOf(')') < 0) return false

  const argumentPrefix = before.slice(open + 4).trim()
  if (argumentPrefix === '--ui-hue-' || argumentPrefix === '--ui-tile-') return true
  return argumentPrefix === '' && after.slice(0, after.indexOf(')')).trim() === '' &&
    !!resolveCatalogValue(span.expression, sourceFile, imports)
}

type DynamicVarExpression = { index: number; expression: ts.Expression }

function dynamicVarExpressions(node: ts.TemplateExpression): DynamicVarExpression[] {
  const parts = templateParts(node)
  const expressions: DynamicVarExpression[] = []
  for (let index = 0; index < node.templateSpans.length; index++) {
    const before = parts[index] ?? ''
    const span = node.templateSpans[index]
    if (!span) continue
    const open = before.lastIndexOf('var(')
    if (open < 0 || before.indexOf(')', open + 4) >= 0) continue
    expressions.push({ index, expression: span.expression })
  }
  return expressions
}

function dynamicCustomPropertyExpressions(node: ts.TemplateExpression): ts.Expression[] {
  const parent = node.parent
  let propertyNamePosition =
    (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
    (ts.isComputedPropertyName(parent) && parent.expression === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    const callee = parent.expression
    const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression)
        ? callee.argumentExpression.text : null
    propertyNamePosition ||= method === 'setProperty' || method === 'getPropertyValue' || method === 'removeProperty'
  }
  if (!propertyNamePosition) return []
  const parts = templateParts(node)
  const expressions: ts.Expression[] = []
  for (let index = 0; index < node.templateSpans.length; index++) {
    const before = parts[index] ?? ''
    const span = node.templateSpans[index]
    if (!span || !before.endsWith('--')) continue
    if (/[A-Za-z0-9_-]/.test(before.at(-3) ?? '')) continue
    const open = before.lastIndexOf('var(')
    if (open >= 0 && before.indexOf(')', open + 4) < 0) continue
    expressions.push(span.expression)
  }
  return expressions
}

function scanTemplateSegments(
  node: ts.TemplateExpression,
  sourceFile: ts.SourceFile,
  report: (code: string, offset: number, message: string) => void
): void {
  for (const segment of [node.head, ...node.templateSpans.map((span) => span.literal)]) {
    const start = segment.getStart(sourceFile) + 1
    const end = segment.end - (segment.kind === ts.SyntaxKind.TemplateTail ? 1 : 2)
    if (end < start) continue
    const raw = sourceFile.text.slice(start, end)
    let rawUnresolved = false
    scanText(raw, (code, offset, message) => {
      if (code === 'unresolved-style-token') rawUnresolved = true
      report(code, start + offset, message)
    })
    scanEscapedCssTokens(raw, (code, offset, message) => {
      if (code === 'unresolved-style-token') rawUnresolved = true
      report(code, start + offset, message)
    })
    if (!rawUnresolved) scanDecodedLiteral(segment.text, raw, start, report)
  }
}

function staticString(node: ts.Expression): string | null {
  const expression = stripParentheses(node)
  return ts.isStringLiteralLike(expression) ? expression.text : null
}

function concatenatedCompatibility(left: string, right: string): boolean {
  COMPLETE_COMPAT_TOKEN.lastIndex = 0
  const boundary = left.length
  return [...(left + right).matchAll(COMPLETE_COMPAT_TOKEN)].some((match) => match.index! < boundary && match.index! + match[0].length > boundary)
}

function concatenationParts(node: ts.Expression): ts.Expression[] {
  const expression = stripParentheses(node)
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...concatenationParts(expression.left), ...concatenationParts(expression.right)]
  }
  return [expression]
}

function dynamicVarConcatOffset(node: ts.BinaryExpression, sourceFile: ts.SourceFile): number | null {
  const parts = concatenationParts(node)
  for (let index = 0; index < parts.length; index++) {
    const value = staticString(parts[index]!)
    if (value === null) continue
    const open = value.lastIndexOf('var(')
    if (open < 0 || value.indexOf(')', open + 4) >= 0) continue

    let dynamic = false
    for (let next = index + 1; next < parts.length; next++) {
      const segment = staticString(parts[next]!)
      if (segment === null) {
        dynamic = true
        continue
      }
      if (segment.includes(')')) {
        if (dynamic) {
          const start = parts[index]!.getStart(sourceFile)
          const raw = sourceFile.text.slice(start, parts[index]!.end)
          return start + Math.max(0, raw.lastIndexOf('var('))
        }
        break
      }
    }
    if (dynamic) {
      const start = parts[index]!.getStart(sourceFile)
      const raw = sourceFile.text.slice(start, parts[index]!.end)
      return start + Math.max(0, raw.lastIndexOf('var('))
    }
  }
  return null
}

function cssOrHtmlSource(file: string): boolean {
  return extensionOf(file) in MARKUP_EXTENSIONS
}

/** Scans one production source for literal and unresolved style-token usage. */
export function scanTokens(source: SourceFile): Evidence[] {
  if (!shouldScan(source)) return []

  const file = normalizedPath(source.file)
  const sourceFile = ts.createSourceFile(file, source.content, ts.ScriptTarget.Latest, true, scriptKindFor(file))
  const findings = new Map<string, Finding>()
  const report = (code: string, offset: number, message: string): void => {
    const key = `${code}\0${offset}`
    if (findings.has(key)) return
    findings.set(key, {
      offset,
      evidence: { code, message, source: sourceLocation(sourceFile, file, offset), basis: 'scan' }
    })
  }

  if (cssOrHtmlSource(file)) {
    const visible = maskComments(source.content, file)
    scanText(visible, report)
    scanEscapedCssTokens(visible, report)
  } else {
    const imports = importedCatalogs(sourceFile)
    function visit(node: ts.Node): void {
      if (ts.isStringLiteralLike(node)) {
        const start = node.getStart(sourceFile)
        const raw = source.content.slice(start, node.end)
        let rawUnresolved = false
        scanText(raw, (code, offset, message) => {
          if (code === 'unresolved-style-token') rawUnresolved = true
          report(code, start + offset, message)
        })
        scanEscapedCssTokens(raw, (code, offset, message) => {
          if (code === 'unresolved-style-token') rawUnresolved = true
          report(code, start + offset, message)
        })
        if (!rawUnresolved) scanDecodedLiteral(node.text, raw, start, report)
      } else if (ts.isRegularExpressionLiteral(node) || ts.isJsxText(node)) {
        const start = node.getStart(sourceFile)
        const raw = source.content.slice(start, node.end)
        scanText(raw, (code, offset, message) => report(code, start + offset, message))
      }

      if (ts.isTemplateExpression(node)) {
        scanTemplateSegments(node, sourceFile, report)
        for (const { index, expression } of dynamicVarExpressions(node)) {
          if (!safeDynamicTemplate(node, index, sourceFile, imports)) {
            report('unresolved-style-token', expression.getStart(sourceFile), 'Unresolved dynamic style token in var() argument')
          }
        }
        for (const expression of dynamicCustomPropertyExpressions(node)) {
          report('unresolved-style-token', expression.getStart(sourceFile), 'Unresolved dynamic custom-property name')
        }
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(node.left)
        const right = staticString(node.right)
        if (left !== null && right !== null && concatenatedCompatibility(left, right)) {
          const rawLeft = source.content.slice(node.left.getStart(sourceFile), node.left.end)
          const tokenOffset = rawLeft.indexOf('--')
          report('unresolved-style-token', node.left.getStart(sourceFile) + Math.max(0, tokenOffset), 'Unresolved concatenated compatibility style token fragments')
        }
        const dynamicOffset = dynamicVarConcatOffset(node, sourceFile)
        if (dynamicOffset !== null) report('unresolved-style-token', dynamicOffset, 'Unresolved dynamically concatenated var() argument')
      }

      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return [...findings.values()]
    .sort((left, right) => left.offset - right.offset || left.evidence.code.localeCompare(right.evidence.code))
    .map(({ evidence }) => evidence)
}


/** Returns the concrete shared UI token findings for the report's shared evidence list. */
export function sharedTokenEvidence(inventory: Inventory): Evidence[] {
  return inventory.sharedSources.flatMap(scanTokens)
}

function tokenCheck(evidence: Evidence[]): CheckResult {
  return {
    id: 'compatibility-tokens',
    status: evidence.length ? 'fail' : 'pass',
    applicable: true,
    reason: evidence.length ? 'Compatibility style token findings were found' : 'No compatibility style tokens were found',
    evidence
  }
}
function sharedTokenReference(): Evidence {
  return {
    code: 'shared-compatibility-tokens',
    message: 'Shared UI compatibility-token findings are recorded in sharedTokenEvidence',
    basis: 'scan',
    sharedEvidence: 'compatibility-tokens'
  }
}

/** Scores shared UI token consumption for the host, referencing shared evidence once. */
export function checkHostTokens(inventory: Inventory): CheckResult {
  const shared = sharedTokenEvidence(inventory)
  return tokenCheck(shared.length ? [sharedTokenReference()] : [])
}

function isUiBearing(plugin: PluginInventory): boolean {
  return plugin.hasUi || plugin.targets.length > 0
}

function compareEvidence(left: Evidence, right: Evidence): number {
  const leftSource = left.source
  const rightSource = right.source
  if (!leftSource || !rightSource) return leftSource ? -1 : rightSource ? 1 : left.code.localeCompare(right.code)
  return leftSource.file.localeCompare(rightSource.file) || leftSource.line - rightSource.line || leftSource.column - rightSource.column || left.code.localeCompare(right.code)
}

function pluginTokenCheck(inventory: Inventory, plugin: PluginInventory): CheckResult {
  const evidence = plugin.sources.flatMap(scanTokens)
  if (isUiBearing(plugin) && sharedTokenEvidence(inventory).length > 0) evidence.push(sharedTokenReference())
  evidence.sort(compareEvidence)
  return tokenCheck(evidence)
}

/** Returns the five static plugin checks from one inventory snapshot. */
export function checkPlugin(inventory: Inventory, pluginId: string): CheckResult[] {
  const plugin = inventory.plugins.find((candidate) => candidate.id === pluginId)
  if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`)

  const audit = isUiBearing(plugin) ? auditPlugin(inventory, plugin) : (['loading', 'empty', 'error', 'commands'] as const).map((id): CheckResult => ({
    id, status: 'pass', applicable: false, reason: 'no-ui-surface', evidence: []
  }))
  const results: Record<string, CheckResult> = {
    'compatibility-tokens': pluginTokenCheck(inventory, plugin),
    ...Object.fromEntries(audit.map((check) => [check.id, check]))
  }
  return CHECK_IDS.filter((id) => id !== 'screenshots').map((id) => results[id]!)
}
