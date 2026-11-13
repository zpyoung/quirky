import { extname, posix } from 'node:path'
import * as ts from 'typescript'
import type { Candidate, Evidence, PluginInventory, SourceFile } from './contracts'

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const
const CODE_EXTENSION_SET: Record<string, true> = {
  '.ts': true, '.tsx': true, '.js': true, '.jsx': true, '.mts': true, '.cts': true, '.mjs': true, '.cjs': true
}
const IGNORED_ASSET_EXTENSIONS: Record<string, true> = {
  '.json': true, '.css': true, '.scss': true, '.sass': true, '.less': true, '.styl': true,
  '.svg': true, '.png': true, '.jpg': true, '.jpeg': true, '.gif': true, '.webp': true, '.avif': true, '.ico': true,
  '.bmp': true, '.tif': true, '.tiff': true
}
const STATE_TEXT = /\b(loading|no [a-z]+( [a-z]+)? (yet|found)|nothing|empty|error|failed|unable|could ?n[o'’]t|retry|try again|offline)\b/i
const SHARED_RENDER_TAGS: Record<string, true> = { EmptyState: true, NoticeLine: true, InlineError: true }
const DOM_WRITE_PROPERTIES: Record<string, true> = { textContent: true, innerHTML: true, innerText: true }
const DOM_WRITE_METHODS: Record<string, true> = {
  replaceChildren: true, appendChild: true, append: true, prepend: true, insertAdjacentHTML: true
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function codeFile(path: string): boolean {
  return CODE_EXTENSION_SET[extname(path).toLowerCase()] === true
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function sourceFile(file: string, content: string): ts.SourceFile {
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind(file))
}

function sourceEvidence(code: string, message: string, file?: string, content?: string, position?: number): Evidence {
  const result: Evidence = { code, message, basis: 'source-audit' }
  if (file !== undefined && content !== undefined && position !== undefined) {
    const before = content.slice(0, position)
    const line = before.split('\n').length
    const lineStart = before.lastIndexOf('\n') + 1
    result.source = { file, line, column: position - lineStart + 1 }
  }
  return result
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..'
}

function insidePlugin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`)
}

type Resolution = { kind: 'file'; file: string } | { kind: 'ignored' } | { kind: 'unresolved' } | { kind: 'outside' }

function resolveModule(importer: string, specifier: string, directory: string, sources: ReadonlyMap<string, SourceFile>): Resolution {
  if (!isRelativeSpecifier(specifier)) return { kind: 'ignored' }
  const base = posix.normalize(posix.join(posix.dirname(importer), normalizedPath(specifier)))
  if (!insidePlugin(base, directory)) return { kind: 'outside' }
  const explicitExtension = extname(base).toLowerCase()
  const isCodeExtension = CODE_EXTENSION_SET[explicitExtension] === true
  if (explicitExtension && !isCodeExtension && IGNORED_ASSET_EXTENSIONS[explicitExtension] === true) {
    return { kind: 'ignored' }
  }

  const candidates: string[] = []
  if (isCodeExtension) {
    candidates.push(base)
    if (explicitExtension === '.js') {
      const stem = base.slice(0, -explicitExtension.length)
      candidates.push(`${stem}.ts`, `${stem}.tsx`)
    }
  } else if (explicitExtension) {
    for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`)
  } else {
    for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of CODE_EXTENSIONS) candidates.push(`${base}/index${extension}`)
  }

  for (const candidate of candidates) {
    if (!insidePlugin(candidate, directory)) return { kind: 'outside' }
    if (sources.has(candidate) && codeFile(candidate)) return { kind: 'file', file: candidate }
  }
  return explicitExtension && !isCodeExtension ? { kind: 'ignored' } : { kind: 'unresolved' }
}

function moduleSpecifiers(file: ts.SourceFile): Array<{ text: string; position: number }> {
  const specifiers: Array<{ text: string; position: number }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ text: node.moduleSpecifier.text, position: node.moduleSpecifier.getStart(file) })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ text: node.moduleSpecifier.text, position: node.moduleSpecifier.getStart(file) })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        specifiers.push({ text: argument.text, position: argument.getStart(file) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

export function discoverUiFiles(plugin: PluginInventory): { files: string[]; failures: Evidence[] } {
  const directory = posix.normalize(normalizedPath(plugin.directory))
  const sources = new Map(plugin.sources.map((source) => [normalizedPath(source.file), source]))
  const entry = `${directory}/src/ui.tsx`
  const entrySource = sources.get(entry)
  if (!entrySource) {
    return {
      files: [],
      failures: [sourceEvidence('ui-entry-missing', `UI entry is missing: ${entry}`)]
    }
  }

  const queued = [entry]
  const visited = new Set<string>()
  const failures: Evidence[] = []
  for (let cursor = 0; cursor < queued.length; cursor++) {
    const file = queued[cursor]!
    if (visited.has(file)) continue
    visited.add(file)
    const source = sources.get(file)
    if (!source) continue
    const parsed = sourceFile(file, source.content)
    for (const specifier of moduleSpecifiers(parsed)) {
      if (!isRelativeSpecifier(specifier.text)) continue
      const resolution = resolveModule(file, specifier.text, directory, sources)
      if (resolution.kind === 'file') {
        if (!visited.has(resolution.file)) queued.push(resolution.file)
      } else if (resolution.kind === 'outside') {
        failures.push(sourceEvidence(
          'ui-import-outside-plugin',
          `Relative UI import resolves outside ${directory}: ${specifier.text}`,
          file,
          source.content,
          specifier.position
        ))
      } else if (resolution.kind === 'unresolved') {
        failures.push(sourceEvidence(
          'ui-import-unresolved',
          `Relative UI import cannot be resolved: ${specifier.text}`,
          file,
          source.content,
          specifier.position
        ))
      }
    }
  }
  return { files: [...visited].sort(compareText), failures }
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

function contains(node: ts.Node, predicate: (node: ts.Node) => boolean, skipNestedFunctions: boolean): boolean {
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (current !== node && skipNestedFunctions && isFunctionLike(current)) return
    if (predicate(current)) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function createElementCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const expression = node.expression
  if (ts.isIdentifier(expression)) return expression.text === 'createElement'
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'createElement'
}

function containsRender(node: ts.Node): boolean {
  return contains(node, (current) => ts.isJsxElement(current)
    || ts.isJsxSelfClosingElement(current)
    || ts.isJsxFragment(current)
    || createElementCall(current), false)
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunctionLike(parent)) return parent
  }
  return undefined
}

function hasReturn(node: ts.Node): boolean {
  return contains(node, ts.isReturnStatement, true)
}

function propertyNameText(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text
  return undefined
}

function propertyAccessName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

function assignmentLeft(node: ts.Expression): boolean {
  if (!ts.isBinaryExpression(node)) return false
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.PercentEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.AmpersandEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.BarEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.CaretEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.LessThanLessThanEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
}

function isDomWrite(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && assignmentLeft(node) && DOM_WRITE_PROPERTIES[propertyAccessName(node.left) ?? ''] === true) return true
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && DOM_WRITE_METHODS[node.expression.name.text] === true
}

function addCandidate(
  candidates: Candidate[],
  file: string,
  source: ts.SourceFile,
  category: Candidate['category'],
  kind: string,
  start: number,
  end: number
): void {
  if (end <= start) return
  candidates.push({
    category,
    kind,
    file,
    anchorStart: start,
    anchorEnd: end,
    anchorText: source.text.slice(start, end)
  })
}

function ifAnchorEnd(node: ts.IfStatement, source: ts.SourceFile): number {
  const closeParen = node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.CloseParenToken)
  return closeParen?.end ?? node.expression.end
}

function clauseAnchorEnd(node: ts.CaseOrDefaultClause, source: ts.SourceFile): number {
  const colon = node.getChildren(source).find((child) => child.kind === ts.SyntaxKind.ColonToken)
  return colon?.end ?? (ts.isCaseClause(node) ? node.expression.end : node.getStart(source) + 'default'.length)
}

function directLiteral(node: ts.Expression | undefined): ts.StringLiteralLike | undefined {
  return node && ts.isStringLiteralLike(node) ? node : undefined
}

function stateTextValue(node: ts.StringLiteralLike): string {
  return node.text
}

function isJsxChildExpression(node: ts.Node): boolean {
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  return !!parent && ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
}

export function discoverCandidates(plugin: PluginInventory, files: readonly string[]): Candidate[] {
  const sourceMap = new Map(plugin.sources.map((source) => [normalizedPath(source.file), source]))
  const candidates: Candidate[] = []

  for (const requestedFile of files) {
    const file = normalizedPath(requestedFile)
    const source = sourceMap.get(file)
    if (!source || !codeFile(file)) continue
    const parsed = sourceFile(file, source.content)
    const add = (category: Candidate['category'], kind: string, start: number, end: number): void => {
      addCandidate(candidates, file, parsed, category, kind, start, end)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isConditionalExpression(node)) {
        if (containsRender(node.whenTrue) || containsRender(node.whenFalse) || isJsxChildExpression(node)) {
          add('state', 'conditional-render', node.condition.getStart(parsed), node.questionToken.end)
        }
      } else if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        && (containsRender(node.right) || containsRender(node.left) || isJsxChildExpression(node))) {
        add('state', 'conditional-render', node.left.getStart(parsed), node.operatorToken.end)
      }

      if (ts.isIfStatement(node)) {
        const start = node.getStart(parsed)
        const end = ifAnchorEnd(node, parsed)
        const hasBranchReturn = hasReturn(node.thenStatement)
          || (node.elseStatement !== undefined && hasReturn(node.elseStatement))
        const renderFunction = hasBranchReturn ? enclosingFunction(node) : undefined
        const isBranchReturn = renderFunction !== undefined && containsRender(renderFunction)
        if (isBranchReturn) {
          add('state', 'branch-return', start, end)
        } else if (contains(node.thenStatement, isDomWrite, true)
          || (node.elseStatement && contains(node.elseStatement, isDomWrite, true))) {
          add('state', 'branch-dom-write', start, end)
        }
      } else if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && hasReturn(node)) {
        const fn = enclosingFunction(node)
        if (fn && containsRender(fn)) add('state', 'branch-return', node.getStart(parsed), clauseAnchorEnd(node, parsed))
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName
        if (ts.isIdentifier(tag) && SHARED_RENDER_TAGS[tag.text] === true) {
          add('state', 'shared-render', node.getStart(parsed), tag.end)
        }
        if (ts.isIdentifier(tag) && tag.text === 'FormRow'
          && node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && propertyNameText(attribute.name) === 'error')) {
          add('state', 'shared-render', node.getStart(parsed), tag.end)
        }
        if (ts.isIdentifier(tag) && tag.text === 'form'
          && !node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && propertyNameText(attribute.name) === 'onSubmit')) {
          add('action', 'native-form', node.getStart(parsed), tag.end)
        }
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            const spread = attribute.getChildren(parsed).find((child) => child.kind === ts.SyntaxKind.DotDotDotToken)!
            add('action', 'unresolved-spread', spread.getStart(parsed), attribute.expression.end)
          } else if (ts.isJsxAttribute(attribute)) {
            const name = propertyNameText(attribute.name) ?? ''
            const nameStart = attribute.name.getStart(parsed)
            const nameEnd = attribute.name.end
            if (/^on[A-Z]/.test(name)) add('action', 'jsx-handler', nameStart, nameEnd)
            if (name === 'role') {
              const value = attribute.initializer
              const text = value && ts.isStringLiteral(value) ? value.text
                : value && ts.isJsxExpression(value) && directLiteral(value.expression) ? directLiteral(value.expression)!.text
                  : undefined
              if (text === 'alert' || text === 'status') add('state', 'status-role', attribute.getStart(parsed), attribute.end)
            }
            if (attribute.initializer) {
              const literal = ts.isStringLiteral(attribute.initializer)
                ? attribute.initializer
                : ts.isJsxExpression(attribute.initializer) ? directLiteral(attribute.initializer.expression) : undefined
              if (literal && STATE_TEXT.test(stateTextValue(literal))) {
                add('state', 'state-text', literal.getStart(parsed), literal.end)
              }
            }
          }
        }
      }

      if (ts.isJsxText(node)) {
        const text = node.getText(parsed)
        const leading = text.match(/^\s*/)?.[0].length ?? 0
        const trailing = text.match(/\s*$/)?.[0].length ?? 0
        const start = node.getStart(parsed) + leading
        const end = node.end - trailing
        const trimmed = parsed.text.slice(start, end)
        if (trimmed && STATE_TEXT.test(trimmed)) add('state', 'state-text', start, end)
      } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression && directLiteral(node.expression)) {
        const literal = directLiteral(node.expression)
        if (literal && STATE_TEXT.test(stateTextValue(literal))) add('state', 'state-text', literal.getStart(parsed), literal.end)
      }

      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toast') {
          const openParen = node.getChildren(parsed).find((child) => child.kind === ts.SyntaxKind.OpenParenToken)
          add('state', 'toast-call', node.expression.getStart(parsed), openParen?.end ?? node.expression.end)
          for (const argument of node.arguments) {
            const literal = directLiteral(argument)
            if (literal && STATE_TEXT.test(stateTextValue(literal))) add('state', 'state-text', literal.getStart(parsed), literal.end)
          }
        }
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener') {
          const first = node.arguments[0]
          const literalEvent = directLiteral(first)
          const openParen = node.getChildren(parsed).find((child) => child.kind === ts.SyntaxKind.OpenParenToken)
          const end = first?.end ?? openParen?.end ?? node.expression.end
          add('action', literalEvent ? 'event-listener' : 'unresolved-listener', node.expression.getStart(parsed), end)
        }
        if (createElementCall(node)) {
          for (const child of node.arguments.slice(2)) {
            const literal = directLiteral(child)
            if (literal && STATE_TEXT.test(stateTextValue(literal))) add('state', 'state-text', literal.getStart(parsed), literal.end)
          }
          const props = node.arguments[1]
          if (props && ts.isObjectLiteralExpression(props)) {
            for (const property of props.properties) {
              if (ts.isSpreadAssignment(property)) {
                add('action', 'unresolved-spread', property.getStart(parsed), property.expression.end)
              } else if ('name' in property && ts.isComputedPropertyName(property.name)
                && !ts.isStringLiteralLike(property.name.expression) && !ts.isNumericLiteral(property.name.expression)) {
                add('action', 'unresolved-computed', property.name.getStart(parsed), property.name.end)
              }
            }
          }
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
            const name = propertyNameText(property.name) ?? ''
            if (/^on[A-Z]/.test(name)) add('action', 'handler-property', property.name.getStart(parsed), property.name.end)
            if (ts.isPropertyAssignment(property) && name === 'command' && ts.isStringLiteralLike(property.initializer)
              && property.initializer.text.startsWith('command:')) {
              add('action', 'command-entry', property.getStart(parsed), property.end)
            }
          }
        }
      }

      if (ts.isBinaryExpression(node) && assignmentLeft(node)) {
        const left = node.left
        const name = propertyAccessName(left) ?? ''
        if (/^on[a-z]/.test(name)) {
          add('action', 'handler-assignment', left.getStart(parsed), left.end)
        } else if (ts.isElementAccessExpression(left)
          && left.argumentExpression
          && !ts.isStringLiteralLike(left.argumentExpression)
          && !ts.isNumericLiteral(left.argumentExpression)) {
          add('action', 'unresolved-assignment', left.getStart(parsed), left.end)
        }
        if (name === 'textContent') {
          const literal = directLiteral(node.right)
          if (literal && STATE_TEXT.test(stateTextValue(literal))) add('state', 'state-text', literal.getStart(parsed), literal.end)
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }

  return candidates.sort((left, right) => compareText(left.file, right.file)
    || left.anchorStart - right.anchorStart
    || left.anchorEnd - right.anchorEnd
    || compareText(left.category, right.category)
    || compareText(left.kind, right.kind))
}
