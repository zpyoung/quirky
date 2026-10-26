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

/** Blanks comments but keeps newlines, so offsets still map to the right line. */
function stripComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/[^\n]*/g, (_, lead: string) => lead + blank(_.slice(lead.length)))
}

const IMPORT_FORMS = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g
]

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
  const code = stripComments(source)
  const violations: ImportViolation[] = []
  for (const form of IMPORT_FORMS) {
    for (const match of code.matchAll(form)) {
      const specifier = match[2]!
      const line = code.slice(0, match.index).split('\n').length
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
})
