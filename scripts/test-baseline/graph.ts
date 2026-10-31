import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ImportGraph } from './types'

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const JSX_FILE = /\.(tsx|jsx)$/
const SHEBANG = /^#!.*/
const JSX_RUNTIME = /^react(\/jsx(-dev)?-runtime)?$/

/** The graph plus the code files it was built from, so spawn detection can enumerate candidates. */
export type CodeImportGraph = ImportGraph & { files: string[] }

/**
 * Builds the static import graph of `files` (repo-relative paths under `root`). Files that aren't
 * code, and `.d.ts` declarations, which never run, are left out. A file that fails to scan or an
 * import that fails to resolve is counted in `misses` and skipped, never thrown. Imports of `bun:`
 * and `node:` modules, and anything resolving outside `root` or into `node_modules`, are not edges.
 * Needs `bun install` to have run so `@quirky/*` resolves through workspace links.
 */
export function buildImportGraph(root: string, files: string[]): CodeImportGraph {
  const realRoot = realpathSync(root)
  const codeFiles = files.filter((file) => CODE_FILE.test(file) && !DECLARATION_FILE.test(file))
  const importers = new Map<string, Set<string>>()
  let misses = 0

  for (const file of codeFiles) {
    const dir = dirname(join(realRoot, file))
    let specs: { path: string }[]
    try {
      const loader = JSX_FILE.test(file) ? 'tsx' : 'ts'
      specs = new Bun.Transpiler({ loader }).scanImports(readFileSync(join(realRoot, file), 'utf8').replace(SHEBANG, ''))
    } catch {
      misses++
      continue
    }
    for (const { path: spec } of specs) {
      if (spec.startsWith('bun:') || spec.startsWith('node:')) continue
      let resolved: string
      try {
        resolved = Bun.resolveSync(spec, dir)
      } catch {
        // the tsx loader injects react runtime imports the file never wrote
        if (!(JSX_FILE.test(file) && JSX_RUNTIME.test(spec))) misses++
        continue
      }
      const rel = relative(realRoot, resolved)
      if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('node_modules')) continue
      const key = sep === '/' ? rel : rel.split(sep).join('/')
      const set = importers.get(key) ?? new Set<string>()
      set.add(file)
      importers.set(key, set)
    }
  }

  return {
    files: codeFiles,
    misses,
    importersOf(path) {
      const seen = new Set<string>([path])
      const queue = [path]
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        for (const importer of importers.get(next) ?? []) {
          if (seen.has(importer)) continue
          seen.add(importer)
          queue.push(importer)
        }
      }
      return seen
    }
  }
}
