import { describe, expect, test } from 'bun:test'
import { builtinModules } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

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

/**
 * Finds the imports in one plugin source file that reach beyond the plugin's public surface:
 * relative paths leaving `pluginDir`, absolute paths, and packages that are neither runtime
 * built-ins, `@quirky/protocol`, nor in `declared`.
 */
export function scanImports(source: string, file: string, pluginDir: string, declared: ReadonlySet<string>): ImportViolation[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false)
  const violations: ImportViolation[] = []
  const visit = (node: ts.Node): void => {
    let literal: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal = node.moduleReference.expression
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require'
    )) {
      literal = node.arguments[0]
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const specifier = literal.text
      const line = syntax.getLineAndCharacterOfPosition(literal.getStart(syntax)).line + 1
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
    ts.forEachChild(node, visit)
  }
  visit(syntax)
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
    expect(dirs.length).toBeGreaterThanOrEqual(8)
    const violations: string[] = []
    let scanned = 0
    for (const dir of dirs) {
      const declared = declaredDependencies(dir)
      for (const file of sourceFiles(dir)) {
        scanned++
        for (const v of scanImports(readFileSync(file, 'utf8'), file, dir, declared)) {
          violations.push(`${relative(PLUGINS_ROOT, v.file)}:${v.line} imports '${v.specifier}' (${v.reason})`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(30)
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

  test('command metadata, quoted code and comments are not module imports', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const source = [
      "const commands = [{ name: 'import', description: 'Import setup from Claude Code' }]",
      'const quoted = "export * from \'private-package\'"',
      "const template = `require('private-package')`",
      'const view = <div title="import \'private-package\'">from \'private-package\'</div>',
      "// import 'private-package'",
      "/* require('private-package') */",
      "import { local } from './local'"
    ].join('\n')
    expect(scanImports(source, join(dir, 'src', 'a.tsx'), dir, new Set())).toEqual([])
  })

  test('re-exports and TypeScript literal module forms remain fenced', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    // These are parser inputs, not module loads.
    const source = [
      "export { value } from '../../quirky.other/export'",
      "import legacy = require('undeclared-package')",
      "type Hidden = import('../../../packages/daemon/src/hidden').Hidden",
      "const lazy = import(`../../quirky.other/template`)"
    ].join('\n')
    expect(scanImports(source, join(dir, 'src', 'a.ts'), dir, new Set()).map(({ line, specifier }) => [line, specifier])).toEqual([
      [1, '../../quirky.other/export'],
      [2, 'undeclared-package'],
      [3, '../../../packages/daemon/src/hidden'],
      [4, '../../quirky.other/template']
    ])
  })
})
