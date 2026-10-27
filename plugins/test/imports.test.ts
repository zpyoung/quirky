import { describe, expect, test } from 'bun:test'
import { builtinModules } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'

const PLUGINS_ROOT = resolve(import.meta.dir, '..')
const SKIPPED_DIRS = new Set(['test', 'node_modules', 'dist'])
const NODE_BUILTINS = new Set(builtinModules)

export type ImportViolation = { file: string; line: number; specifier: string; reason: string }

/** Every non-test `.ts` and `.tsx` file under a plugin directory. */
function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) files.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

/** The package a bare specifier names: `react/jsx-runtime` is `react`, `@xterm/xterm/css` is `@xterm/xterm`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function isRuntimeBuiltin(specifier: string): boolean {
  if (specifier === 'bun' || specifier.startsWith('bun:') || specifier.startsWith('node:')) return true
  return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(packageOf(specifier))
}

function stringSpecifier(node: ts.Node | undefined): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal
    if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return literal
  }
  return undefined
}

/**
 * Finds the imports in one plugin source file that reach beyond the plugin's public surface:
 * relative paths leaving `pluginDir`, absolute paths, and packages that are neither runtime
 * built-ins, `@quirky/protocol`, nor in `declared`.
 */
export function scanImports(source: string, file: string, pluginDir: string, declared: ReadonlySet<string>): ImportViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const imports: { specifier: string; position: number }[] = []
  const addSpecifier = (node: ts.Node | undefined) => {
    const literal = stringSpecifier(node)
    if (literal) imports.push({ specifier: literal.text, position: literal.getStart(sourceFile) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (ts.isImportTypeNode(node)) {
      addSpecifier(node.argument)
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      addSpecifier(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  imports.sort((a, b) => a.position - b.position)

  const violations: ImportViolation[] = []
  for (const { specifier, position } of imports) {
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1
    const flag = (reason: string) => violations.push({ file, line, specifier, reason })
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier)
      if (target !== pluginDir && !target.startsWith(pluginDir + sep)) flag('relative path leaves the plugin')
    } else if (specifier.startsWith('/')) {
      flag('absolute path')
    } else if (!isRuntimeBuiltin(specifier) && packageOf(specifier) !== '@quirky/protocol' && !declared.has(packageOf(specifier))) {
      flag('package is not declared in the plugin package.json')
    }
  }
  return violations
}

function pluginDirs(): string[] {
  return readdirSync(PLUGINS_ROOT)
    .filter((entry) => entry.startsWith('quirky.'))
    .map((entry) => join(PLUGINS_ROOT, entry))
    .filter((dir) => statSync(dir).isDirectory())
}

function declaredDependencies(pluginDir: string): Set<string> {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  return new Set(Object.keys(manifest.dependencies ?? {}))
}

describe('import fence', () => {
  test('SC-24: plugin code uses only the public API', () => {
    const dirs = pluginDirs()
    const violations: string[] = []
    for (const dir of dirs) {
      const declared = declaredDependencies(dir)
      for (const file of sourceFiles(dir)) {
        for (const v of scanImports(readFileSync(file, 'utf8'), file, dir, declared)) {
          violations.push(`${relative(PLUGINS_ROOT, v.file)}:${v.line} imports '${v.specifier}' (${v.reason})`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('the scanner flags a path into packages/ and other imports that leave the public API', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const file = join(dir, 'src', 'a.ts')
    const source = [
      "import { ok } from './b'",
      "import type { Repo } from '@quirky/protocol'",
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'path'",
      "import { createRoot } from 'react-dom/client'",
      "import { secret } from '../../../packages/daemon/src/x'",
      "import { other } from '../../quirky.repo/main'",
      "import lodash from 'lodash'",
      "// import { fine } from '../../../packages/daemon/src/commented'",
      "const lazy = await import('../../../packages/ui/src/y')"
    ].join('\n')
    const violations = scanImports(source, file, dir, new Set(['react-dom']))
    expect(violations.sort((a, b) => a.line - b.line).map((v) => [v.line, v.specifier])).toEqual([
      [6, '../../../packages/daemon/src/x'],
      [7, '../../quirky.repo/main'],
      [8, 'lodash'],
      [10, '../../../packages/ui/src/y']
    ])
  })

  test('ignores string contents, control flow, and comments that resemble imports', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const file = join(dir, 'src', 'a.ts')
    const source = [
      "const mode = 'import'",
      "if (mode === 'import') throw new Error('imports are unavailable')",
      `const docs = "Don't use import('undeclared-package') here"`,
      "// import 'comment-only-package'",
      "/* export * from 'another-comment-only-package' */"
    ].join('\n')
    expect(scanImports(source, file, dir, new Set())).toEqual([])
  })

  test('flags forbidden static, type-only, export, type-expression, and dynamic imports', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const file = join(dir, 'src', 'a.ts')
    const source = [
      "import { secret } from 'undeclared-runtime'",
      "import type { Secret } from 'undeclared-type-import'",
      "export type { Secret } from 'undeclared-type-export'",
      "type Imported = import('undeclared-type-expression').Secret",
      "const lazy = import('undeclared-dynamic')"
    ].join('\n')
    expect(scanImports(source, file, dir, new Set()).map((v) => [v.line, v.specifier])).toEqual([
      [1, 'undeclared-runtime'],
      [2, 'undeclared-type-import'],
      [3, 'undeclared-type-export'],
      [4, 'undeclared-type-expression'],
      [5, 'undeclared-dynamic']
    ])
  })

})
