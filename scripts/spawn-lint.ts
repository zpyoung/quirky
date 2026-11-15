import { lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from 'node:fs'
import { extname, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

export type SpawnLintRule = 'process/no-direct-spawn' | 'process/no-escaped-global' | 'process/no-dynamic-code' | 'process/no-blocking' | 'process/baseline-exceeded' | 'process/baseline-stale' | 'process/config'

export type SpawnLintDiagnostic = {
  file: string
  line: number
  column: number
  rule: SpawnLintRule
  message: string
}

export type SpawnLintBaseline = Record<string, number>

const forbiddenBunMembers = new Set(['spawn', 'spawnSync', '$', 'openInEditor'])
const childProcessModules = new Set(['child_process', 'node:child_process'])
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const excludedDirectories = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', 'test', 'tests', '__tests__', '__test__',
  '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures',
])
const excludedFilename = /(?:^|[.-])(?:test|spec|fixture|fixtures)\.[^.]+$/i
const baselineFile = 'scripts/spawn-lint-baseline.json'

class SpawnLintFailure extends Error {
  constructor(readonly file: string, message: string) {
    super(message)
  }
}

function compareText(left: string, right: string): number {
  let leftOffset = 0
  let rightOffset = 0
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCode = left.codePointAt(leftOffset)!
    const rightCode = right.codePointAt(rightOffset)!
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1
    leftOffset += leftCode > 0xffff ? 2 : 1
    rightOffset += rightCode > 0xffff ? 2 : 1
  }
  return leftOffset === left.length ? (rightOffset === right.length ? 0 : -1) : 1
}

function sortDiagnostics<T extends SpawnLintDiagnostic>(diagnostics: T[]): T[] {
  return diagnostics.sort((left, right) => compareText(left.file, right.file) || left.line - right.line || left.column - right.column || compareText(left.rule, right.rule))
}

function location(file: string, sourceFile: ts.SourceFile, node: ts.Node): Pick<SpawnLintDiagnostic, 'file' | 'line' | 'column'> {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { file, line: line + 1, column: character + 1 }
}

function isStringLike(node: ts.Node | undefined): node is ts.StringLiteralLike {
  return node !== undefined && ts.isStringLiteralLike(node)
}

function transparentExpression(node: ts.Node): node is ts.Expression & { expression: ts.Expression } {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) ||
    (ts.isExpressionWithTypeArguments(node) && !ts.isHeritageClause(node.parent))
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (transparentExpression(current)) current = current.expression
  return current
}

function staticString(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined
  const value = unwrapExpression(expression)
  return isStringLike(value) ? value.text : undefined
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  if (ts.isComputedPropertyName(name)) return staticString(name.expression)
  return undefined
}

function callModuleName(call: ts.CallExpression): string | undefined {
  return staticString(call.arguments[0])
}

function dynamicImportCall(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
}

function importedModuleName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  return node.moduleSpecifier && isStringLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
}

function acquiredModuleName(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return importedModuleName(node)
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return staticString(node.moduleReference.expression)
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isStringLike(node.argument.literal)) return node.argument.literal.text
  return undefined
}

function staticMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : staticString(node.argumentExpression)
}

function inTypePosition(node: ts.Node): boolean {
  if (ts.isExpressionWithTypeArguments(node)) {
    if (!ts.isHeritageClause(node.parent)) return false
    return !(node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent)))
  }
  return ts.isTypeNode(node)
}

type RootKind = 'bun' | 'atomics' | 'global' | 'process' | 'commonjs' | 'module' | 'loader' | 'createRequire' | 'generated'
type AccessRule = 'process/no-direct-spawn' | 'process/no-escaped-global' | 'process/no-dynamic-code' | 'process/no-blocking'
const globalRoots: Partial<Record<string, RootKind>> = {
  Bun: 'bun', Atomics: 'atomics', globalThis: 'global', global: 'global', self: 'global', process: 'process', module: 'commonjs',
  require: 'loader', eval: 'generated', Function: 'generated',
}
const capabilityModules: Partial<Record<string, RootKind>> = {
  bun: 'bun', process: 'process', 'node:process': 'process', module: 'module', 'node:module': 'module',
}
const safeCommonjsMembers: Partial<Record<string, true>> = {
  exports: true, id: true, filename: true, path: true, loaded: true, paths: true,
}
const safeModuleMembers: Partial<Record<string, true>> = {
  builtinModules: true, isBuiltin: true, constants: true, SourceMap: true, findSourceMap: true,
}
const dynamicProcessMembers: Partial<Record<string, true>> = {
  binding: true, _linkedBinding: true, dlopen: true, mainModule: true,
}
const ruleMessages: Record<AccessRule, string> = {
  'process/no-direct-spawn': 'Use the shared process runner.',
  'process/no-escaped-global': 'Read Bun, Atomics, process, module and the global object only through a static, allowed member.',
  'process/no-dynamic-code': 'Load modules by literal specifier and run no generated code.',
  'process/no-blocking': 'Do not block the event loop.',
}

function memberPolicy(kind: RootKind, name: string): RootKind | AccessRule | undefined {
  switch (kind) {
    case 'global': return Object.hasOwn(globalRoots, name) ? globalRoots[name] : undefined
    case 'bun':
      if (forbiddenBunMembers.has(name)) return 'process/no-direct-spawn'
      if (name === 'sleepSync') return 'process/no-blocking'
      return name === 'default' ? 'bun' : undefined
    case 'atomics': return name === 'wait' ? 'process/no-blocking' : undefined
    case 'process':
      if (name === 'execve') return 'process/no-direct-spawn'
      if (Object.hasOwn(dynamicProcessMembers, name)) return 'process/no-dynamic-code'
      if (name === 'getBuiltinModule') return 'loader'
      return name === 'default' ? 'process' : undefined
    case 'commonjs':
      if (name === 'require') return 'loader'
      return Object.hasOwn(safeCommonjsMembers, name) ? undefined : 'process/no-dynamic-code'
    case 'module':
      if (name === 'createRequire') return 'createRequire'
      if (name === 'Module' || name === 'default') return 'module'
      return Object.hasOwn(safeModuleMembers, name) ? undefined : 'process/no-dynamic-code'
    case 'loader': return name === 'resolve' ? undefined : 'process/no-dynamic-code'
    case 'generated':
    case 'createRequire': return undefined
  }
}

function escapeRule(kind: RootKind): AccessRule {
  return kind === 'loader' || kind === 'createRequire' || kind === 'generated' ?
    'process/no-dynamic-code' : 'process/no-escaped-global'
}

function acquisitionRule(name: string | undefined): AccessRule | undefined {
  if (childProcessModules.has(name ?? '')) return 'process/no-direct-spawn'
  if (name === 'vm' || name === 'node:vm') return 'process/no-dynamic-code'
  return undefined
}

function isAccessRule(value: RootKind | AccessRule | undefined): value is AccessRule {
  return value?.startsWith('process/') ?? false
}

function ambientDeclaration(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true
  }
  return false
}

function valueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isShorthandPropertyAssignment(parent)) return true
  if ('name' in parent && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false
  return !ts.isLabeledStatement(parent) && !ts.isBreakStatement(parent) && !ts.isContinueStatement(parent)
}

/** Guard process acquisition, capability escapes, generated code and blocking waits. */
export function scanSourceContent(file: string, source: string): SpawnLintDiagnostic[] {
  const extension = extname(file).toLowerCase()
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX :
    ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const diagnostics: SpawnLintDiagnostic[] = []
  const imports = new Map<ts.Declaration, RootKind>()
  const candidates = new Set(Object.keys(globalRoots))
  const add = (node: ts.Node, rule: AccessRule = 'process/no-direct-spawn') => {
    diagnostics.push({ ...location(file, sourceFile, node), rule, message: ruleMessages[rule] })
  }
  const bind = (declaration: ts.Declaration, name: ts.Identifier, kind: RootKind) => {
    imports.set(declaration, kind)
    candidates.add(name.text)
  }
  const collectImports = (node: ts.Node): void => {
    const moduleName = acquiredModuleName(node)
    const acquisition = acquisitionRule(moduleName)
    if (acquisition) add(node, acquisition)
    const moduleKind = moduleName !== undefined && Object.hasOwn(capabilityModules, moduleName) ? capabilityModules[moduleName] : undefined
    if (ts.isImportDeclaration(node) && moduleKind && !node.importClause?.isTypeOnly) {
      const clause = node.importClause
      if (clause?.name) bind(clause, clause.name, moduleKind)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) bind(bindings, bindings.name, moduleKind)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (specifier.isTypeOnly) continue
          const policy = memberPolicy(moduleKind, specifier.propertyName?.text ?? specifier.name.text)
          if (isAccessRule(policy)) add(specifier, policy)
          else if (policy) bind(specifier, specifier.name, policy)
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && moduleKind) bind(node, node.name, moduleKind)
    if (ts.isExportDeclaration(node) && moduleKind && !node.isTypeOnly) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) add(node, moduleKind === 'bun' ? 'process/no-escaped-global' : 'process/no-dynamic-code')
      else {
        for (const specifier of node.exportClause.elements) {
          if (specifier.isTypeOnly) continue
          const policy = memberPolicy(moduleKind, specifier.propertyName?.text ?? specifier.name.text)
          if (policy) add(specifier.propertyName ?? specifier.name, isAccessRule(policy) ? policy : escapeRule(policy))
        }
      }
    }
    ts.forEachChild(node, collectImports)
  }
  collectImports(sourceFile)

  let checker: ts.TypeChecker | undefined
  const resolveIdentifier = (node: ts.Identifier): RootKind | undefined => {
    if (node.text === 'require') return 'loader'
    if (!candidates.has(node.text)) return undefined
    if (!checker) {
      const host: ts.CompilerHost = {
        getSourceFile: name => name === file ? sourceFile : undefined,
        getDefaultLibFileName: () => '',
        writeFile: () => {},
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: name => name === file,
        readFile: () => undefined,
        getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
      }
      checker = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker()
    }
    const symbol = ts.isShorthandPropertyAssignment(node.parent) ?
      checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node)
    for (const declaration of symbol?.declarations ?? []) {
      if (declaration.getSourceFile() !== sourceFile) continue
      const kind = imports.get(declaration)
      if (kind) return kind
      if (!ambientDeclaration(declaration)) return undefined
    }
    return Object.hasOwn(globalRoots, node.text) ? globalRoots[node.text] : undefined
  }
  const rootCache = new Map<ts.Expression, RootKind | undefined>()
  const rootKind = (expression: ts.Expression): RootKind | undefined => {
    if (rootCache.has(expression)) return rootCache.get(expression)
    const value = unwrapExpression(expression)
    let kind: RootKind | undefined
    if (ts.isIdentifier(value)) kind = resolveIdentifier(value)
    else if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const receiver = rootKind(value.expression)
      const name = staticMember(value)
      const policy = receiver && name !== undefined ? memberPolicy(receiver, name) : undefined
      if (policy && !isAccessRule(policy)) kind = policy
      else if (!receiver && ts.isMetaProperty(value.expression) && value.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        name === 'require') kind = 'loader'
    } else if (ts.isCallExpression(value)) {
      const callee = rootKind(value.expression)
      if (callee === 'createRequire') kind = 'loader'
      else if (dynamicImportCall(value) || callee === 'loader') {
        const name = callModuleName(value)
        if (name !== undefined && Object.hasOwn(capabilityModules, name)) kind = capabilityModules[name]
      }
    }
    rootCache.set(expression, kind)
    return kind
  }
  const checkPattern = (pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression, kind: RootKind): void => {
    const properties = ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties
    for (const property of properties) {
      if (ts.isSpreadAssignment(property) || (ts.isBindingElement(property) && property.dotDotDotToken)) {
        add(property, 'process/no-escaped-global')
        continue
      }
      let name: ts.PropertyName | ts.BindingName
      let target: ts.Node
      if (ts.isBindingElement(property)) {
        name = property.propertyName ?? property.name
        target = property.name
      } else if (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)) {
        name = property.name
        target = ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : property.name
        if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) target = target.left
      } else continue
      const member = propertyName(name)
      if (member === undefined) {
        add(name, 'process/no-escaped-global')
        continue
      }
      const policy = memberPolicy(kind, member)
      if (isAccessRule(policy)) add(name, policy)
      else if (policy) {
        if (policy !== 'loader' && policy !== 'createRequire' && policy !== 'generated' &&
          (ts.isObjectBindingPattern(target) || ts.isObjectLiteralExpression(target))) checkPattern(target, policy)
        else add(name, escapeRule(policy))
      }
    }
  }
  const allowedPosition = (node: ts.Expression, kind: RootKind): boolean => {
    let outer: ts.Node = node
    while (transparentExpression(outer.parent) && outer.parent.expression === outer) outer = outer.parent
    const parent = outer.parent
    if (ts.isTypeOfExpression(parent)) return true
    if (kind === 'generated') return false
    if (kind === 'createRequire') return ts.isCallExpression(parent) && parent.expression === outer
    if (kind === 'loader') {
      if (ts.isCallExpression(parent) && parent.expression === outer) return true
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) {
        return staticMember(parent) !== undefined
      }
      return ts.isCallExpression(node) && rootKind(node.expression) === 'createRequire' &&
        ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name) && parent.name.text === 'require'
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === outer) return true
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) {
      return staticMember(parent) !== undefined
    }
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
      checkPattern(parent.name, kind)
      return true
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === outer && ts.isObjectLiteralExpression(parent.left)) {
      checkPattern(parent.left, kind)
      return true
    }
    return false
  }
  const visitRuntime = (node: ts.Node): void => {
    if (inTypePosition(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = rootKind(node.expression)
      const member = staticMember(node)
      const policy = receiver && member !== undefined ? memberPolicy(receiver, member) : undefined
      if (isAccessRule(policy)) add(node, policy)
    }
    if (ts.isCallExpression(node) && (dynamicImportCall(node) || rootKind(node.expression) === 'loader')) {
      const name = callModuleName(node)
      const rule = name === undefined ? 'process/no-dynamic-code' : acquisitionRule(name)
      if (rule) add(node, rule)
    }
    if ((ts.isIdentifier(node) && valueIdentifier(node)) || ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
      const kind = rootKind(node as ts.Expression)
      if (kind && !allowedPosition(node as ts.Expression, kind)) {
        let rule = escapeRule(kind)
        let outer: ts.Node = node
        while (transparentExpression(outer.parent) && outer.parent.expression === outer) outer = outer.parent
        if ((ts.isPropertyAccessExpression(outer.parent) || ts.isElementAccessExpression(outer.parent)) &&
          outer.parent.expression === outer && staticMember(outer.parent) === undefined &&
          (kind === 'commonjs' || kind === 'module')) rule = 'process/no-dynamic-code'
        add(node, rule)
      }
    }
    ts.forEachChild(node, visitRuntime)
  }
  visitRuntime(sourceFile)
  return sortDiagnostics(diagnostics)
}

/** Format a diagnostic as a stable repository-relative location and rule message. */
export function formatDiagnostic(diagnostic: SpawnLintDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.rule}: ${diagnostic.message}`
}

function excludedPath(path: string): boolean {
  const parts = path.split('/')
  if (parts.some((part) => excludedDirectories.has(part.toLowerCase()))) return true
  return excludedFilename.test(parts.at(-1) ?? '')
}

function eligibleSourcePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) return false
  const parts = path.split('/')
  const underPackages = (parts[0] === 'packages' && (parts[1] === 'daemon' || parts[1] === 'git') && parts.length >= 3)
  const underPlugin = parts[0] === 'plugins' && parts.length >= 3
  if ((!underPackages && !underPlugin) || excludedPath(path)) return false
  const file = parts.at(-1) ?? ''
  if (/\.d\.(?:ts|mts|cts)$/i.test(file)) return false
  return sourceExtensions.has(extname(file).toLowerCase())
}

function fail(file: string, message: string): never {
  throw new SpawnLintFailure(file, message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lstatPath(path: string, diagnosticPath: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    fail(diagnosticPath, `Cannot inspect path: ${errorText(error)}`)
  }
}

function ensureDirectory(root: string, relativePath: string): string {
  const absolute = join(root, ...relativePath.split('/'))
  const info = lstatPath(absolute, relativePath)
  if (!info) fail(relativePath, `Required directory is missing: ${relativePath}.`)
  if (info.isSymbolicLink()) fail(relativePath, `Refusing to follow symbolic link: ${relativePath}.`)
  if (!info.isDirectory()) fail(relativePath, `Expected a directory: ${relativePath}.`)
  return absolute
}

function baselineError(message: string): never {
  return fail(baselineFile, message)
}

function validateBaselineKey(key: string): boolean {
  if (!eligibleSourcePath(key)) return false
  if (key.startsWith('plugins/')) {
    const pluginName = key.split('/')[1]
    if (!pluginName || pluginName === 'test') return false
  }
  return true
}

function readBaseline(root: string): SpawnLintBaseline {
  const scriptsPath = join(root, 'scripts')
  const scriptsInfo = lstatPath(scriptsPath, baselineFile)
  if (!scriptsInfo) baselineError(`Cannot read ${baselineFile}: scripts directory is missing.`)
  if (scriptsInfo.isSymbolicLink()) baselineError(`Refusing to follow symbolic link while reading ${baselineFile}.`)
  if (!scriptsInfo.isDirectory()) baselineError(`Cannot read ${baselineFile}: scripts is not a directory.`)
  const path = join(scriptsPath, 'spawn-lint-baseline.json')
  const info = lstatPath(path, baselineFile)
  if (!info) baselineError(`Cannot read ${baselineFile}: file is missing.`)
  if (info.isSymbolicLink()) baselineError(`Refusing to follow symbolic link: ${baselineFile}.`)
  if (!info.isFile()) baselineError(`Cannot read ${baselineFile}: expected a regular file.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    baselineError(`Cannot read valid JSON from ${baselineFile}: ${errorText(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) baselineError(`Invalid ${baselineFile}: expected an object of source paths to positive safe-integer ceilings.`)
  const baseline = parsed as Record<string, unknown>
  for (const [key, count] of Object.entries(baseline)) {
    if (!validateBaselineKey(key)) baselineError(`Invalid source path key ${JSON.stringify(key)} in ${baselineFile}.`)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) baselineError(`Invalid ceiling for ${JSON.stringify(key)} in ${baselineFile}: expected a positive safe integer.`)
  }
  return baseline as SpawnLintBaseline
}

function gitSourceFiles(root: string): ReadonlySet<string> | undefined {
  const gitPath = join(root, '.git')
  const info = lstatPath(gitPath, '.')
  if (!info) return undefined
  if (info.isSymbolicLink()) fail('.', 'Refusing to follow symbolic link at .git.')
  let result
  try {
    result = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        QUIRKY_HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  } catch (error) {
    fail('.', `Cannot enumerate Git files: ${errorText(error)}`)
  }
  if (result.exitCode !== 0) fail('.', `Cannot enumerate Git files: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}`)
  return new Set(result.stdout.toString().split('\0').filter(Boolean))
}

function readDirectory(root: string, relativePath: string): Dirent[] {
  try {
    return readdirSync(join(root, ...relativePath.split('/')), { withFileTypes: true })
  } catch (error) {
    fail(relativePath, `Cannot traverse directory: ${errorText(error)}`)
  }
}

function collectSourceFiles(root: string, relativePath: string, gitFiles: ReadonlySet<string> | undefined, output: string[]): void {
  const entries = readDirectory(root, relativePath).sort((left, right) => compareText(left.name, right.name))
  for (const entry of entries) {
    const path = `${relativePath}/${entry.name}`
    if (excludedPath(path) || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) collectSourceFiles(root, path, gitFiles, output)
    else if (entry.isFile() && eligibleSourcePath(path) && (!gitFiles || gitFiles.has(path))) output.push(path)
  }
}

function inventory(root: string): string[] {
  const absoluteRoot = resolve(root)
  const rootInfo = lstatPath(absoluteRoot, '.')
  if (!rootInfo) fail('.', 'Repository root is missing.')
  if (rootInfo.isSymbolicLink()) fail('.', 'Refusing to follow symbolic link at repository root.')
  if (!rootInfo.isDirectory()) fail('.', 'Repository root is not a directory.')
  const packages = lstatPath(join(absoluteRoot, 'packages'), 'packages')
  if (!packages) fail('packages/daemon', 'Required directory is missing: packages/daemon.')
  if (packages.isSymbolicLink()) fail('packages', 'Refusing to follow symbolic link: packages.')
  if (!packages.isDirectory()) fail('packages', 'Expected a directory: packages.')
  ensureDirectory(absoluteRoot, 'packages/daemon')
  ensureDirectory(absoluteRoot, 'packages/git')
  ensureDirectory(absoluteRoot, 'plugins')
  const gitFiles = gitSourceFiles(absoluteRoot)
  const files: string[] = []
  collectSourceFiles(absoluteRoot, 'packages/daemon', gitFiles, files)
  collectSourceFiles(absoluteRoot, 'packages/git', gitFiles, files)
  const pluginEntries = readDirectory(absoluteRoot, 'plugins').sort((left, right) => compareText(left.name, right.name))
  for (const entry of pluginEntries) {
    const path = `plugins/${entry.name}`
    if (entry.isSymbolicLink() || !entry.isDirectory() || excludedPath(path)) continue
    collectSourceFiles(absoluteRoot, path, gitFiles, files)
  }
  return files.sort(compareText)
}

function readSource(root: string, file: string): string {
  try {
    return readFileSync(join(root, ...file.split('/')), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    fail(file, `Cannot read source: ${errorText(error)}`)
  }
}

function configDiagnostic(file: string, message: string, rule: SpawnLintRule = 'process/config'): SpawnLintDiagnostic {
  return { file, line: 1, column: 1, rule, message }
}

/** Scan the configured production inventory and enforce or print its per-file ceilings. */
export function runSpawnLint(root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), options: { printBaseline?: boolean } = {}): number {
  try {
    const absoluteRoot = resolve(root)
    const rootInfo = lstatPath(absoluteRoot, '.')
    if (!rootInfo) fail('.', 'Repository root is missing.')
    if (rootInfo.isSymbolicLink()) fail('.', 'Refusing to follow symbolic link at repository root.')
    if (!rootInfo.isDirectory()) fail('.', 'Repository root is not a directory.')
    const printBaseline = options.printBaseline === true
    const baseline = printBaseline ? {} : readBaseline(absoluteRoot)
    const files = inventory(absoluteRoot)
    const hits = new Map<string, SpawnLintDiagnostic[]>()
    for (const file of files) {
      const diagnostics = scanSourceContent(file, readSource(absoluteRoot, file))
      if (diagnostics.length) hits.set(file, diagnostics)
    }
    if (printBaseline) {
      const result: SpawnLintBaseline = {}
      for (const file of [...hits.keys()].sort(compareText)) result[file] = hits.get(file)!.length
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    const diagnostics: SpawnLintDiagnostic[] = []
    let exceeded = false
    const allFiles = new Set([...Object.keys(baseline), ...hits.keys()])
    for (const file of [...allFiles].sort(compareText)) {
      const found = hits.get(file)?.length ?? 0
      const allowed = baseline[file] ?? 0
      if (found > allowed) {
        exceeded = true
        diagnostics.push(configDiagnostic(file, `found ${found}, baseline ${allowed}.`, 'process/baseline-exceeded'))
        diagnostics.push(...hits.get(file)!)
      } else if (found < allowed) {
        diagnostics.push(configDiagnostic(file, `found ${found}, baseline ${allowed}; lower or remove this entry.`, 'process/baseline-stale'))
      }
    }
    for (const diagnostic of sortDiagnostics(diagnostics)) console.error(formatDiagnostic(diagnostic))
    return exceeded ? 1 : 0
  } catch (error) {
    const diagnostic = error instanceof SpawnLintFailure ? configDiagnostic(error.file, error.message) : configDiagnostic('.', `Spawn lint failed: ${errorText(error)}`)
    console.error(formatDiagnostic(diagnostic))
    return 1
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--print-baseline')) {
    console.error('Usage: bun scripts/spawn-lint.ts [--print-baseline]')
    process.exitCode = 1
  } else {
    process.exitCode = runSpawnLint(undefined, { printBaseline: args[0] === '--print-baseline' })
  }
}
