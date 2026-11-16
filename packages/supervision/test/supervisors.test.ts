import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const supervisors = ['quirky.heimdall', 'quirky.orchestration', 'quirky.loops', 'quirky.automations']
const forbidden = new Set([
  'quirky.structured/create', 'quirky.structured/resume', 'quirky.structured/send',
  'quirky.structured/messages', 'quirky.structured/stop', 'quirky.structured/stopOwned',
  'quirky.agent-status/wait', 'quirky.checks/run', 'quirky.checks/cancel'
])
const temporary: string[] = []
type Violation = { file: string; line: number; method: string }
type Scope = { parent?: Scope; functionScope: boolean; bindings: Map<string, { expression?: ts.Expression; scope: Scope }> }

/** Checks statically resolvable RPC arguments, not arbitrary dynamically generated JavaScript. */
function inspect(file: string, text: string): { violations: Violation[]; imports: string[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const scopes = new Map<ts.Node, Scope>()
  const root: Scope = { functionScope: true, bindings: new Map() }
  function bindName(name: ts.BindingName, scope: Scope, expression?: ts.Expression): void {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, { expression, scope })
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindName(element.name, scope)
  }
  function bind(node: ts.Node, scope: Scope): void {
    if (node !== source && (ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node) ||
      ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCaseBlock(node))) {
      scope = { parent: scope, functionScope: ts.isFunctionLike(node), bindings: new Map() }
    }
    scopes.set(node, scope)
    if (ts.isVariableDeclaration(node)) {
      const flags = ts.isVariableDeclarationList(node.parent) ? node.parent.flags : ts.NodeFlags.BlockScoped
      let declarationScope = scope
      if (!(flags & ts.NodeFlags.BlockScoped)) {
        while (!declarationScope.functionScope && declarationScope.parent) declarationScope = declarationScope.parent
      }
      bindName(node.name, declarationScope, flags & ts.NodeFlags.Const ? node.initializer : undefined)
    }
    if (ts.isParameter(node)) bindName(node.name, scope)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const enclosing = ts.isFunctionDeclaration(node) ? scope.parent ?? scope : scope
      enclosing.bindings.set(node.name.text, { scope: enclosing })
    }
    ts.forEachChild(node, (child) => bind(child, scope))
  }
  bind(source, root)
  function literal(expression: ts.Expression, scope: Scope, seen = new Set<ts.Expression>()): string | undefined {
    if (seen.has(expression)) return undefined
    seen = new Set(seen).add(expression)
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
      return literal(expression.expression, scope, seen)
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(expression.left, scope, seen)
      const right = literal(expression.right, scope, seen)
      return left === undefined || right === undefined ? undefined : left + right
    }
    if (ts.isIdentifier(expression)) {
      let current: Scope | undefined = scope
      while (current) {
        const binding = current.bindings.get(expression.text)
        if (binding) return binding.expression ? literal(binding.expression, binding.scope, seen) : undefined
        current = current.parent
      }
    }
    return undefined
  }
  const violations: Violation[] = []
  const imports: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const names = clause?.namedBindings
      const typesOnly = clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names) && names.elements.length > 0 && names.elements.every((name) => name.isTypeOnly))
      if (!typesOnly) imports.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const imported = node.moduleReference.expression
      if (imported && ts.isStringLiteral(imported)) imports.push(imported.text)
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause
      if (!(names && ts.isNamedExports(names) && names.elements.length > 0 && names.elements.every((name) => name.isTypeOnly))) imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        const method = literal(argument, scopes.get(node) ?? root)
        if (method && forbidden.has(method)) {
          violations.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, method })
        }
      }
      const argument = node.arguments[0]
      if (argument && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        imports.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { violations, imports }
}

function localModule(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier)
  const extension = extname(target)
  const stem = extension ? target.slice(0, -extension.length) : target
  const substitutes: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'], '.jsx': ['.tsx', '.ts'], '.mjs': ['.mts'], '.cjs': ['.cts']
  }
  const candidates = extension
    ? [target, ...(substitutes[extension] ?? []).map((suffix) => stem + suffix)]
    : [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((suffix) => target + suffix), ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((name) => join(target, name))]
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!found) throw new Error(`${from}: unresolved local module ${specifier}`)
  return found
}

function graph(manifest: string): { files: Set<string>; violations: Violation[] } {
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { main?: unknown }
  if (typeof metadata.main !== 'string' || !metadata.main) throw new Error(`${manifest}: missing daemon main`)
  const entry = resolve(dirname(manifest), metadata.main)
  if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(`${manifest}: missing daemon root ${entry}`)
  const files = new Set<string>()
  const violations: Violation[] = []
  function visit(file: string): void {
    if (files.has(file)) return
    files.add(file)
    if (extname(file) === '.json') return
    const parsed = inspect(file, readFileSync(file, 'utf8'))
    violations.push(...parsed.violations)
    for (const imported of parsed.imports) if (imported.startsWith('.')) visit(localModule(file, imported))
  }
  visit(entry)
  return { files, violations }
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'supervisor-boundary-'))
  temporary.push(root)
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return join(root, 'quirky-plugin.json')
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('active daemon source graphs delegate low-level supervision RPCs to the engine', () => {
  const files = new Set<string>()
  const violations: Violation[] = []
  for (const supervisor of supervisors) {
    const result = graph(join(repository, 'plugins', supervisor, 'quirky-plugin.json'))
    for (const file of result.files) files.add(file)
    violations.push(...result.violations)
  }
  expect(violations.map(({ file, line, method }) => `${relative(repository, file)}:${line}: ${method}`)).toEqual([])
  for (const adapter of ['quirky.heimdall/src/owner/runtime.ts', 'quirky.orchestration/src/workers/runtime.ts', 'quirky.orchestration/src/workers/output.ts']) {
    const file = join(repository, 'plugins', adapter)
    expect(files.has(file)).toBe(true)
    expect(inspect(file, readFileSync(file, 'utf8')).imports).toContain('@quirky/supervision')
  }
  // the loop transcript view is display-only, not a daemon exception; avatar remains paused.
  expect(files.has(join(repository, 'plugins/quirky.loops/window/LoopView.tsx'))).toBe(false)
  expect([...files].some((file) => file.startsWith(join(repository, 'plugins/quirky.avatar/')))).toBe(false)
})

test('RPC detection handles call syntax, helpers and constant method expressions', () => {
  const calls = [
    "context.call('quirky.structured/create', {})",
    'context.call<unknown>("quirky.structured/resume", {})',
    'context["call"](`quirky.structured/send`, {})',
    "helper(watcher.id,\n ('quirky.structured/messages'),\n {})",
    "const method = 'quirky.structured/stop'; context.call(method, {})",
    "const prefix = 'quirky.structured/'; const method = prefix + 'stopOwned'; rpc(method)",
    "const method = ('quirky.agent-status/' + 'wait') as const; context.call(method)",
    "const method = 'quirky.checks/run'; const alias = method; call(alias)",
    "context.call(('quirky.checks/' + `cancel`), {})"
  ]
  expect(calls.flatMap((call) => inspect('fixture.ts', call).violations.map((item) => item.method))).toEqual([...forbidden])
})

test('comments, types, diagnostic strings and shadowed aliases are not RPC calls', () => {
  expect(inspect('fixture.ts', `
    // context.call('quirky.structured/create')
    /* helper('quirky.structured/send') */
    type Method = 'quirky.structured/messages'
    const diagnostic = { source: 'quirky.agent-status/wait' }
    const method = 'quirky.structured/stop'
    function safe(method: string) { context.call(method) }
    { const method = 'quirky.session/get'; context.call(method) }
    const cycle = cycle; context.call(cycle)
    context.call('quirky.session/pointer', {})
  `).violations).toEqual([])
})

test('nested static imports, exports, dynamic imports and require discover new helpers without truncation', () => {
  const manifest = fixture({
    'quirky-plugin.json': JSON.stringify({ main: 'main.ts' }),
    'main.ts': "import './static'; export * from './exported'; import('./dynamic'); require('./required'); import type { T } from './missing-type'; import { type U } from './missing-type-too'; import '@quirky/supervision'",
    'static.ts': "import './nested/helper.js'",
    'nested/helper.ts': "/*" + 'x'.repeat(100_001) + "*/\ncontext.call('quirky.structured/create')",
    'exported.ts': "export const x = 1; export type { T } from './missing-export-type'",
    'dynamic.ts': "context.call('quirky.structured/messages')",
    'required.ts': "context.call('quirky.checks/run')"
  })
  const result = graph(manifest)
  expect([...result.files].map((file) => relative(dirname(manifest), file)).sort()).toEqual(['dynamic.ts', 'exported.ts', 'main.ts', 'nested/helper.ts', 'required.ts', 'static.ts'])
  expect(result.violations.map(({ file, line, method }) => [relative(dirname(manifest), file), line, method])).toEqual([
    ['nested/helper.ts', 2, 'quirky.structured/create'], ['dynamic.ts', 1, 'quirky.structured/messages'], ['required.ts', 1, 'quirky.checks/run']
  ])
})

test('missing manifests, roots and local modules fail closed', () => {
  const manifest = fixture({ 'quirky-plugin.json': '{}', 'main.ts': "import './missing'" })
  expect(() => graph(manifest + '.missing')).toThrow()
  expect(() => graph(manifest)).toThrow('missing daemon main')
  writeFileSync(manifest, JSON.stringify({ main: 'absent.ts' }))
  expect(() => graph(manifest)).toThrow('missing daemon root')
  writeFileSync(manifest, JSON.stringify({ main: 'main.ts' }))
  expect(() => graph(manifest)).toThrow('unresolved local module ./missing')
})

test('loop-local aliases cannot hide an outer forbidden method', () => {
  for (const loop of ['for (const method of []) {}', 'for (const method in {}) {}', 'for (let method = 0; method < 1; method++) {}']) {
    expect(inspect('fixture.ts', `const method = 'quirky.structured/stop'; ${loop} context.call(method)`).violations)
      .toEqual([{ file: 'fixture.ts', line: 1, method: 'quirky.structured/stop' }])
  }
})

test('runtime import-equals helpers are traversed and missing helpers fail closed', () => {
  const manifest = fixture({
    'quirky-plugin.json': JSON.stringify({ main: 'main.ts' }),
    'main.ts': "import helper = require('./helper'); import type Missing = require('./type-only-missing')",
    'helper.ts': "context.call('quirky.structured/send')"
  })
  expect(graph(manifest).violations).toEqual([
    { file: join(dirname(manifest), 'helper.ts'), line: 1, method: 'quirky.structured/send' }
  ])
  rmSync(join(dirname(manifest), 'helper.ts'))
  expect(() => graph(manifest)).toThrow('unresolved local module ./helper')
})

test('explicit non-source extensions cannot resolve to unrelated TypeScript files', () => {
  const manifest = fixture({
    'quirky-plugin.json': JSON.stringify({ main: 'main.ts' }),
    'main.ts': "import './helper.json'",
    'helper.ts': 'export const value = 1'
  })
  expect(() => graph(manifest)).toThrow('unresolved local module ./helper.json')
})

test('function-local var and destructured bindings shadow outer method aliases', () => {
  for (const local of [
    "function safe() { for (var method of ['quirky.session/get']) {} context.call(method) }",
    "function safe({ method }: { method: string }) { context.call(method) }",
    "function safe([method]: string[]) { context.call(method) }",
    "function safe() { const { method } = value; context.call(method) }",
    "function safe() { const [method] = value; context.call(method) }"
  ]) {
    expect(inspect('fixture.ts', `const method = 'quirky.structured/stop'; ${local}`).violations).toEqual([])
  }
})
