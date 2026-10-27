import * as ts from 'typescript'
import { describe, expect, test } from 'bun:test'
import { builtinModules } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

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
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const violations: ImportViolation[] = []

  const inspect = (specifierNode: ts.Node | undefined, importNode: ts.Node) => {
    if (!specifierNode || (!ts.isStringLiteral(specifierNode) && !ts.isNoSubstitutionTemplateLiteral(specifierNode))) return

    const specifier = specifierNode.text
    const line = sourceFile.getLineAndCharacterOfPosition(importNode.getStart(sourceFile)).line + 1
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

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      inspect(node.moduleSpecifier, node)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspect(node.moduleReference.expression, node)
    } else if (ts.isImportTypeNode(node)) {
      inspect(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        inspect(node.arguments[0], node)
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        inspect(node.arguments[0], node)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
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
    const violations: string[] = []
    for (const dir of pluginDirs()) {
      const declared = declaredDependencies(dir)
      for (const file of sourceFiles(dir)) {
        for (const v of scanImports(readFileSync(file, 'utf8'), file, dir, declared)) {
          violations.push(`${relative(PLUGINS_ROOT, v.file)}:${v.line} imports '${v.specifier}' (${v.reason})`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('ignores import-like text in action values, comments, and strings', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const file = join(dir, 'src', 'a.ts')
    const source = [
      "const actions = ['import', ', ']",
      "type Action = 'import' | 'from' | 'require'",
      "if (action === 'import') { void action }",
      "// import { fine } from '../../../packages/commented'",
      "/* from '../../../packages/commented'; require('../../../packages/commented') */",
      "const quoted = \"import { secret } from '../../../packages/quoted'\"",
      "const template = `require('../../../packages/template')`",
      "const prose = 'from \"../../../packages/fake\" and import(\"../../../packages/fake\")'"
    ].join('\n')

    expect(scanImports(source, file, dir, new Set())).toEqual([])
  })

  test('flags real imports that leave the public API and allows public imports', () => {
    const dir = join(PLUGINS_ROOT, 'quirky.sample')
    const file = join(dir, 'src', 'a.tsx')
    const source = [
      "import { ok } from './b'",
      "import type { Repo } from '@quirky/protocol'",
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'path'",
      "import { createRoot } from 'react-dom/client'",
      "import { secret } from '../../../packages/daemon/src/x'",
      "import { other } from '../../quirky.repo/main'",
      "import lodash from 'lodash'",
      "import { absolute } from '/outside/plugin'",
      "// import { fine } from '../../../packages/daemon/src/commented'",
      "const lazy = await import('../../../packages/ui/src/y')",
      "import '../../../packages/side-effect'",
      "export { hidden } from '../../quirky.repo/re-export'",
      "const required = require('left-pad')",
      "import Alias = require('../../../packages/type-equals')",
      "type Imported = import('not-declared/import-type').Imported",
      "const view = <main />"
    ].join('\n')
    const violations = scanImports(source, file, dir, new Set(['react-dom']))

    expect(violations.sort((a, b) => a.line - b.line).map((v) => [v.line, v.specifier])).toEqual([
      [6, '../../../packages/daemon/src/x'],
      [7, '../../quirky.repo/main'],
      [8, 'lodash'],
      [9, '/outside/plugin'],
      [11, '../../../packages/ui/src/y'],
      [12, '../../../packages/side-effect'],
      [13, '../../quirky.repo/re-export'],
      [14, 'left-pad'],
      [15, '../../../packages/type-equals'],
      [16, 'not-declared/import-type']
    ])
  })
})
