import { lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from 'node:fs'
import { extname, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

export type SpawnLintRule = 'process/no-direct-spawn' | 'process/baseline-exceeded' | 'process/baseline-stale' | 'process/config'

export type SpawnLintDiagnostic = {
  file: string
  line: number
  column: number
  rule: SpawnLintRule
  message: string
}

export type SpawnLintBaseline = Record<string, number>

const forbiddenBunMembers = new Set(['spawn', 'spawnSync', '$'])
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current)
  ) current = current.expression
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

function moduleRequireCall(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression)
  if (ts.isIdentifier(callee)) return callee.text === 'require'
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = unwrapExpression(callee.expression)
    return ts.isIdentifier(receiver) && receiver.text === 'module' && callee.name.text === 'require'
  }
  if (ts.isElementAccessExpression(callee)) {
    const receiver = unwrapExpression(callee.expression)
    return ts.isIdentifier(receiver) && receiver.text === 'module' && staticString(callee.argumentExpression) === 'require'
  }
  return false
}

function dynamicImportCall(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
}

function importedModuleName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  return node.moduleSpecifier && isStringLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
}

function childProcessAcquisition(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return childProcessModules.has(importedModuleName(node) ?? '')
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression
    return isStringLike(expression) && childProcessModules.has(expression.text)
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument
    return ts.isLiteralTypeNode(argument) && isStringLike(argument.literal) && childProcessModules.has(argument.literal.text)
  }
  if (ts.isCallExpression(node)) {
    const moduleName = callModuleName(node)
    return childProcessModules.has(moduleName ?? '') && (dynamicImportCall(node) || moduleRequireCall(node))
  }
  return false
}

function bunImportReceiverNames(node: ts.ImportDeclaration, receivers: Set<string>, add: (node: ts.Node) => void): void {
  if (importedModuleName(node) !== 'bun') return
  const clause = node.importClause
  if (!clause || clause.isTypeOnly) return
  if (clause.name) receivers.add(clause.name.text)
  const bindings = clause.namedBindings
  if (!bindings) return
  if (ts.isNamespaceImport(bindings)) {
    receivers.add(bindings.name.text)
    return
  }
  for (const specifier of bindings.elements) {
    if (specifier.isTypeOnly) continue
    const imported = specifier.propertyName?.text ?? specifier.name.text
    if (forbiddenBunMembers.has(imported)) add(specifier)
  }
}

function isGlobalThisBun(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(value)) {
    const receiver = unwrapExpression(value.expression)
    return value.name.text === 'Bun' && ts.isIdentifier(receiver) && receiver.text === 'globalThis'
  }
  if (ts.isElementAccessExpression(value)) {
    const receiver = unwrapExpression(value.expression)
    return ts.isIdentifier(receiver) && receiver.text === 'globalThis' && staticString(value.argumentExpression) === 'Bun'
  }
  return false
}

function isBunModuleObject(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression)
  if (!ts.isCallExpression(value)) return false
  const moduleName = callModuleName(value)
  return moduleName === 'bun' && (dynamicImportCall(value) || moduleRequireCall(value))
}

function isBunReceiver(expression: ts.Expression, receivers: ReadonlySet<string>): boolean {
  const value = unwrapExpression(expression)
  if (ts.isIdentifier(value)) return value.text === 'Bun' || receivers.has(value.text)
  return isGlobalThisBun(value) || isBunModuleObject(value)
}

function staticMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : staticString(node.argumentExpression)
}

function inTypePosition(node: ts.Node): boolean {
  if (!ts.isTypeNode(node)) return false
  if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))) return false
  return true
}

/** Find direct Bun primitive access and child_process acquisition in one source file. */
export function scanSourceContent(file: string, source: string): SpawnLintDiagnostic[] {
  const extension = extname(file).toLowerCase()
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX :
    ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const diagnostics: SpawnLintDiagnostic[] = []
  const receivers = new Set<string>()
  const add = (node: ts.Node) => {
    diagnostics.push({ ...location(file, sourceFile, node), rule: 'process/no-direct-spawn', message: 'Use the shared process runner.' })
  }
  const collectImports = (node: ts.Node): void => {
    if (childProcessAcquisition(node)) add(node)
    if (ts.isImportDeclaration(node)) bunImportReceiverNames(node, receivers, add)
    ts.forEachChild(node, collectImports)
  }
  collectImports(sourceFile)

  const visitRuntime = (node: ts.Node): void => {
    if (inTypePosition(node)) return
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      forbiddenBunMembers.has(staticMember(node) ?? '') && isBunReceiver(node.expression, receivers)) add(node)
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isBunReceiver(node.initializer, receivers)) {
      for (const element of node.name.elements) {
        const member = propertyName(element.propertyName ?? element.name)
        if (member && forbiddenBunMembers.has(member)) add(element.propertyName ?? element.name)
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
