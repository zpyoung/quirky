import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildImportGraph } from './graph'

const REPO = join(import.meta.dir, '..', '..')
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

const roots: string[] = []

function repo(tree: Record<string, string>): { root: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'graph-test-'))
  roots.push(dir)
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return { root: dir, files: Object.keys(tree).filter((path) => CODE_FILE.test(path)) }
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('buildImportGraph in a temp repo', () => {
  test('importersOf follows imports transitively and includes the path itself', () => {
    const { root, files } = repo({
      'a.ts': "import { b } from './b'\nexport const a = b",
      'b.ts': "export { c } from './c'\nexport const b = 1",
      'c.ts': 'export const c = 1',
      'lone.ts': 'export const lone = 1'
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('c.ts')].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect([...graph.importersOf('lone.ts')]).toEqual(['lone.ts'])
    expect(graph.misses).toBe(0)
  })

  test('survives import cycles', () => {
    const { root, files } = repo({
      'a.ts': "import './b'",
      'b.ts': "import './a'"
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('a.ts')].sort()).toEqual(['a.ts', 'b.ts'])
  })

  test('counts dynamic imports and require calls', () => {
    const { root, files } = repo({
      'x.ts': "export const load = () => import('./y')",
      'y.ts': 'export const y = 1',
      'z.cjs': "const w = require('./w.cjs')",
      'w.cjs': 'module.exports = 1'
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('y.ts')].sort()).toEqual(['x.ts', 'y.ts'])
    expect([...graph.importersOf('w.cjs')].sort()).toEqual(['w.cjs', 'z.cjs'])
  })

  test('ignores type-only imports', () => {
    const { root, files } = repo({
      'a.ts': "import type { T } from './t'\nimport { type U } from './u'\nexport type A = [T, U]",
      't.ts': 'export type T = 1',
      'u.ts': 'export type U = 1'
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('t.ts')]).toEqual(['t.ts'])
    expect([...graph.importersOf('u.ts')]).toEqual(['u.ts'])
  })

  test('scans tsx files with the tsx loader without counting the JSX runtime as a miss', () => {
    const { root, files } = repo({
      'view.tsx': "import { label } from './label'\nexport const View = () => <div>{label}</div>",
      'label.ts': "export const label = 'x'"
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('label.ts')].sort()).toEqual(['label.ts', 'view.tsx'])
    expect(graph.misses).toBe(0)
  })

  test('resolves a .js specifier to its .ts source', () => {
    const { root, files } = repo({
      'a.ts': "import './b.js'",
      'b.ts': 'export const b = 1'
    })
    expect([...buildImportGraph(root, files).importersOf('b.ts')].sort()).toEqual(['a.ts', 'b.ts'])
  })

  test('resolves workspace links through node_modules to repo-relative paths', () => {
    const { root, files } = repo({
      'packages/lib/package.json': JSON.stringify({ name: '@scope/lib', exports: { '.': './src/index.ts' } }),
      'packages/lib/src/index.ts': 'export const lib = 1',
      'packages/app/src/main.ts': "import { lib } from '@scope/lib'\nexport const app = lib"
    })
    mkdirSync(join(root, 'packages/app/node_modules/@scope'), { recursive: true })
    symlinkSync(join(root, 'packages/lib'), join(root, 'packages/app/node_modules/@scope/lib'))
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('packages/lib/src/index.ts')].sort()).toEqual([
      'packages/app/src/main.ts',
      'packages/lib/src/index.ts'
    ])
    expect(graph.misses).toBe(0)
  })

  test('skips bun: and node: specifiers and drops node_modules packages', () => {
    const { root, files } = repo({
      'a.ts': "import { test } from 'bun:test'\nimport { join } from 'node:path'\nimport dep from 'dep'",
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', main: 'index.js' }),
      'node_modules/dep/index.js': 'module.exports = 1'
    })
    const graph = buildImportGraph(root, files)
    expect([...graph.importersOf('a.ts')]).toEqual(['a.ts'])
    expect([...graph.importersOf('node_modules/dep/index.js')]).toEqual(['node_modules/dep/index.js'])
    expect(graph.misses).toBe(0)
  })

  test('drops imports that resolve outside the root', () => {
    const outer = repo({ 'outside.ts': 'export const o = 1' })
    const inner = repo({ 'a.ts': `import '${join(outer.root, 'outside.ts')}'` })
    const graph = buildImportGraph(inner.root, inner.files)
    expect(graph.misses).toBe(0)
    expect([...graph.importersOf('a.ts')]).toEqual(['a.ts'])
  })

  test('counts an unresolved import and a file that fails to scan, and keeps going', () => {
    const { root, files } = repo({
      'a.ts': "import './missing'\nimport './b'",
      'b.ts': 'export const b = 1',
      'broken.ts': 'const = = ='
    })
    const graph = buildImportGraph(root, files)
    expect(graph.misses).toBe(2)
    expect([...graph.importersOf('b.ts')].sort()).toEqual(['a.ts', 'b.ts'])
  })

  test('ignores listed files that are not code', () => {
    const { root } = repo({ 'a.ts': 'export const a = 1', 'notes.txt': 'x' })
    const graph = buildImportGraph(root, ['a.ts', 'notes.txt'])
    expect([...graph.importersOf('a.ts')]).toEqual(['a.ts'])
    expect(graph.misses).toBe(0)
  })

  test('an unknown path has only itself as an importer', () => {
    const { root, files } = repo({ 'a.ts': 'export const a = 1' })
    expect([...buildImportGraph(root, files).importersOf('gone.ts')]).toEqual(['gone.ts'])
  })
})

describe('buildImportGraph on the real repo', () => {
  const isTest = (path: string) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(path)
  let graph: ReturnType<typeof buildImportGraph>
  let files: string[]

  beforeAll(() => {
    const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO }).stdout.toString().split('\n')
    files = listed.filter((path) => CODE_FILE.test(path))
    graph = buildImportGraph(REPO, files)
  })

  test('scans every tracked code file without a miss', () => {
    expect(graph.misses).toBe(0)
  })

  test('packages/protocol/src/catalog.ts is reached by a few hundred test files', () => {
    const tests = [...graph.importersOf('packages/protocol/src/catalog.ts')].filter(isTest)
    expect(tests.length).toBeGreaterThan(100)
    expect(tests.length).toBeLessThan(1500)
  })

  test('plugins/quirky.git/src/ai/agents.ts is reached by a handful of test files', () => {
    const tests = [...graph.importersOf('plugins/quirky.git/src/ai/agents.ts')].filter(isTest)
    expect(tests.length).toBeGreaterThan(3)
    expect(tests.length).toBeLessThan(60)
  })
})
