import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoFiles } from '../test-support/repo-files'
import { buildImportGraph } from './graph'
import { findSpawners, SPAWN_HELPERS, SPAWN_MARKER, selectTests } from './select'
import type { ChangedPath, ImportGraph } from './types'

const REPO = join(import.meta.dir, '..', '..')
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

/** A graph from direct imports: `imports[a]` lists what `a` imports. */
function fakeGraph(imports: Record<string, string[]>): ImportGraph & { files: string[] } {
  const direct = new Map<string, Set<string>>()
  for (const [importer, targets] of Object.entries(imports)) {
    for (const target of targets) direct.set(target, (direct.get(target) ?? new Set()).add(importer))
  }
  return {
    files: Object.keys(imports),
    misses: 0,
    importersOf(path) {
      const seen = new Set([path])
      const queue = [path]
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        for (const importer of direct.get(next) ?? []) {
          if (!seen.has(importer)) {
            seen.add(importer)
            queue.push(importer)
          }
        }
      }
      return seen
    }
  }
}

const mod = (path: string): ChangedPath => ({ path, status: 'M' })
const noGraph = fakeGraph({})

const TESTS = [
  'apps/desktop/test/a.test.ts',
  'packages/daemon/test/d.test.ts',
  'packages/ui/test/u.test.ts',
  'packages/ui/test/v.test.ts',
  'packages/cli/test/c.test.ts',
  'plugins/quirky.git/test/g.test.ts',
  'plugins/quirky.palette/test/p.test.ts',
  'plugins/test/imports.test.ts',
  'scripts/suite.test.ts'
]

function select(changed: ChangedPath[], overrides: Partial<Parameters<typeof selectTests>[0]> = {}) {
  return selectTests({ changed, testFiles: TESTS, graph: noGraph, spawners: new Set(), ...overrides })
}

describe('selectTests: rule 1, docs', () => {
  test.each([
    'docs/guide.md',
    'docs/quirk/specs/x/tech.md',
    'prototypes/a/index.ts',
    'README.md',
    'packages/ui/README.md',
    'plugins/quirky.git/docs/notes.md',
    'LICENSE'
  ])('%s selects nothing', (path) => {
    const result = select([mod(path)])
    expect(result.mode).toBe('none')
    expect(result.files).toEqual([])
  })

  test('a markdown file under a test directory is not docs', () => {
    const result = select([mod('packages/ui/test/fixtures/sample.md')])
    expect(result.mode).toBe('some')
    expect(result.files).toEqual(['packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })

  test('docs wins over run-everything for the same path', () => {
    expect(select([mod('docs/package.json')]).mode).toBe('none')
  })
})

describe('selectTests: rule 2, run everything', () => {
  test.each([
    'package.json',
    'packages/ui/package.json',
    'bun.lock',
    'tsconfig.json',
    'tsconfig.base.json',
    'packages/ui/tsconfig.build.json',
    'bunfig.toml',
    '.github/workflows/tests.yml',
    'scripts/suite.ts',
    'scripts/test-support/process-scope.ts',
    'scripts/test-baseline/select.ts',
    'scripts/test-on-macos.txt',
    'scripts/test-not-on-ci.txt',
    'distros/arch/Dockerfile'
  ])('%s selects every test file', (path) => {
    const result = select([mod(path)])
    expect(result.mode).toBe('all')
    expect(result.files).toEqual([...TESTS].sort())
  })

  test('an unknown top-level path runs everything instead of throwing', () => {
    for (const path of ['.gitignore', 'mystery/file.bin', 'packages/loose.ts', 'apps', '']) {
      const result = select([mod(path)])
      expect(result.mode).toBe('all')
      expect(result.files).toEqual([...TESTS].sort())
    }
  })

  test('all wins over the other paths in the same change', () => {
    const result = select([mod('docs/x.md'), mod('packages/ui/src/a.ts'), mod('bun.lock')])
    expect(result.mode).toBe('all')
    expect(result.files).toEqual([...TESTS].sort())
  })

  test('mode all holds exactly testFiles, deduplicated and sorted', () => {
    const result = select([mod('bun.lock')], { testFiles: ['b.test.ts', 'a.test.ts', 'b.test.ts'] })
    expect(result.files).toEqual(['a.test.ts', 'b.test.ts'])
  })
})

describe('selectTests: rule 3, areas', () => {
  test('a changed path selects every test in its area and none elsewhere', () => {
    const result = select([mod('packages/ui/src/button.ts')])
    expect(result.mode).toBe('some')
    expect(result.files).toEqual(['packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })

  test('adds tests in other areas whose transitive imports reach the path', () => {
    const graph = fakeGraph({
      'apps/desktop/test/a.test.ts': ['apps/desktop/src/view.ts'],
      'apps/desktop/src/view.ts': ['packages/ui/src/button.ts'],
      'packages/ui/src/button.ts': []
    })
    const result = select([mod('packages/ui/src/button.ts')], { graph })
    expect(result.files).toEqual([
      'apps/desktop/test/a.test.ts',
      'packages/ui/test/u.test.ts',
      'packages/ui/test/v.test.ts'
    ])
  })

  test('only test files are selected from the importers', () => {
    const graph = fakeGraph({ 'apps/desktop/src/view.ts': ['packages/ui/src/button.ts'], 'packages/ui/src/button.ts': [] })
    expect(select([mod('packages/ui/src/button.ts')], { graph }).files).not.toContain('apps/desktop/src/view.ts')
  })

  test('scripts is an area', () => {
    expect(select([mod('scripts/owned-run.ts')]).files).toEqual(['scripts/suite.test.ts'])
  })

  test('a deleted path selects its whole area and ignores the graph', () => {
    const graph = fakeGraph({ 'apps/desktop/test/a.test.ts': ['packages/ui/src/gone.ts'] })
    const result = select([{ path: 'packages/ui/src/gone.ts', status: 'D' }], { graph })
    expect(result.files).toEqual(['packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })

  test('an added path selects its area', () => {
    const result = select([{ path: 'packages/ui/src/new.ts', status: 'A' }])
    expect(result.files).toEqual(['packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })

  test('an area with no tests selects nothing', () => {
    const result = select([mod('packages/empty/src/a.ts')])
    expect(result.mode).toBe('none')
  })

  test('unions several paths into one sorted list', () => {
    const result = select([mod('packages/ui/src/a.ts'), mod('apps/desktop/src/a.ts'), mod('packages/ui/src/b.ts')])
    expect(result.files).toEqual(['apps/desktop/test/a.test.ts', 'packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })
})

describe('selectTests: rule 4, plugins', () => {
  test('a plugin change also selects plugins/test', () => {
    const result = select([mod('plugins/quirky.git/src/a.ts')])
    expect(result.files).toEqual(['plugins/quirky.git/test/g.test.ts', 'plugins/test/imports.test.ts'])
  })

  test('a non-plugin change does not', () => {
    expect(select([mod('packages/ui/src/a.ts')]).files).not.toContain('plugins/test/imports.test.ts')
  })
})

describe('selectTests: rule 5, spawners', () => {
  const spawners = new Set(['packages/cli/test/c.test.ts', 'plugins/quirky.palette/test/p.test.ts'])

  test.each([
    'packages/daemon/src/a.ts',
    'packages/cli/src/a.ts',
    'packages/pty-host/src/a.ts',
    'packages/protocol/src/a.ts'
  ])('%s selects every spawner', (path) => {
    const result = select([mod(path)], { spawners })
    expect(result.files).toEqual(expect.arrayContaining([...spawners]))
  })

  test('a quirky-plugin.json change selects every spawner and the plugin area', () => {
    const result = select([mod('plugins/quirky.git/quirky-plugin.json')], { spawners })
    expect(result.files).toEqual([
      'packages/cli/test/c.test.ts',
      'plugins/quirky.git/test/g.test.ts',
      'plugins/quirky.palette/test/p.test.ts',
      'plugins/test/imports.test.ts'
    ])
  })

  test('other packages do not select spawners', () => {
    expect(select([mod('packages/ui/src/a.ts')], { spawners }).files).toEqual([
      'packages/ui/test/u.test.ts',
      'packages/ui/test/v.test.ts'
    ])
  })
})

describe('selectTests: postconditions', () => {
  test('an empty change list is none', () => {
    expect(select([])).toEqual({ mode: 'none', files: [], reasons: [] })
  })

  test('reasons name the rule per changed path', () => {
    const { reasons } = select([mod('docs/x.md'), mod('packages/ui/src/a.ts'), mod('bun.lock')])
    expect(reasons).toHaveLength(3)
    expect(reasons[0]).toContain('docs/x.md')
    expect(reasons[0]).toContain('rule 1')
    expect(reasons[1]).toContain('packages/ui/src/a.ts')
    expect(reasons[1]).toContain('rule 3')
    expect(reasons[2]).toContain('bun.lock')
    expect(reasons[2]).toContain('rule 2')
  })

  test('reasons stay within 20 entries', () => {
    const changed = Array.from({ length: 50 }, (_, i) => mod(`packages/ui/src/f${i}.ts`))
    expect(select(changed).reasons.length).toBeLessThanOrEqual(20)
  })

  test('files are deduplicated', () => {
    const graph = fakeGraph({
      'packages/ui/test/u.test.ts': ['packages/ui/src/a.ts', 'packages/ui/src/b.ts'],
      'packages/ui/src/a.ts': [],
      'packages/ui/src/b.ts': []
    })
    const result = select([mod('packages/ui/src/a.ts'), mod('packages/ui/src/b.ts')], { graph })
    expect(result.files).toEqual(['packages/ui/test/u.test.ts', 'packages/ui/test/v.test.ts'])
  })
})

describe('spawn marker', () => {
  test.each([
    "spawn(['bun', join(root, 'packages/daemon/src/main.ts')])",
    'const DAEMON_MAIN = x',
    'DAEMON_ENTRY',
    'packages/cli/src/main.ts',
    'CLI_MAIN',
    'CLI_ENTRY',
    'packages/pty-host/src/main.ts',
    'PTY_HOST_ENTRY',
    'await startDaemon({ home })',
    'spawnCli(args)'
  ])('matches %s', (text) => {
    expect(SPAWN_MARKER.test(text)).toBe(true)
  })

  test.each(['const daemon = 1', 'restartDaemon(x)', 'function spawnClient() {}', 'startDaemons'])('ignores %s', (text) => {
    expect(SPAWN_MARKER.test(text)).toBe(false)
  })
})

describe('findSpawners', () => {
  const sources: Record<string, string> = {
    'packages/a/test/direct.test.ts': 'await startDaemon({})',
    'packages/a/test/via-helper.test.ts': "import '../support'",
    'packages/a/test/via-chain.test.ts': "import '../mid'",
    'packages/a/test/plain.test.ts': "import '../plain'",
    'packages/a/test/fixture.test.ts': "import '../../cli/test/fixtures/fake-daemon'",
    'packages/a/support.ts': 'export const run = () => spawnCli([])',
    'packages/a/mid.ts': "import './support'",
    'packages/a/plain.ts': 'export const x = 1',
    'packages/cli/test/fixtures/fake-daemon.ts': 'export const entry = join(a, b)'
  }
  const graph = fakeGraph({
    'packages/a/test/direct.test.ts': [],
    'packages/a/test/via-helper.test.ts': ['packages/a/support.ts'],
    'packages/a/test/via-chain.test.ts': ['packages/a/mid.ts'],
    'packages/a/mid.ts': ['packages/a/support.ts'],
    'packages/a/test/plain.test.ts': ['packages/a/plain.ts'],
    'packages/a/test/fixture.test.ts': ['packages/cli/test/fixtures/fake-daemon.ts'],
    'packages/a/support.ts': [],
    'packages/a/plain.ts': [],
    'packages/cli/test/fixtures/fake-daemon.ts': []
  })
  const testFiles = Object.keys(sources).filter((path) => TEST_FILE.test(path))
  const read = (path: string) => sources[path] ?? ''

  test('lists the helper that builds its entry path indirectly', () => {
    expect(SPAWN_HELPERS).toContain('packages/cli/test/fixtures/fake-daemon.ts')
  })

  test('finds tests that match, import a match transitively, or import a listed helper', () => {
    expect([...findSpawners(graph, testFiles, read)].sort()).toEqual([
      'packages/a/test/direct.test.ts',
      'packages/a/test/fixture.test.ts',
      'packages/a/test/via-chain.test.ts',
      'packages/a/test/via-helper.test.ts'
    ])
  })

  test('skips a file that cannot be read', () => {
    const result = findSpawners(graph, testFiles, (path) => {
      if (path === 'packages/a/support.ts') throw new Error('gone')
      return read(path)
    })
    expect(result.has('packages/a/test/via-helper.test.ts')).toBe(false)
    expect(result.has('packages/a/test/direct.test.ts')).toBe(true)
  })

  test('works with a graph that only offers importersOf, checking tests and helpers', () => {
    const bare: ImportGraph = { misses: 0, importersOf: (path) => graph.importersOf(path) }
    expect([...findSpawners(bare, testFiles, read)].sort()).toEqual([
      'packages/a/test/direct.test.ts',
      'packages/a/test/fixture.test.ts'
    ])
  })
})

describe('selectTests on the real repo', () => {
  let testFiles: string[]
  let graph: ReturnType<typeof buildImportGraph>
  let spawners: Set<string>

  beforeAll(() => {
    const tracked = repoFiles(REPO)
    testFiles = tracked.filter((path) => TEST_FILE.test(path))
    graph = buildImportGraph(REPO, tracked.filter((path) => CODE_FILE.test(path)))
    spawners = findSpawners(graph, testFiles, (path) => readFileSync(join(REPO, path), 'utf8'))
  })

  const real = (changed: ChangedPath[]) => selectTests({ changed, testFiles, graph, spawners })

  test('finds a believable set of spawning tests', () => {
    expect(spawners.size).toBeGreaterThan(10)
    expect([...spawners].every((path) => testFiles.includes(path))).toBe(true)
  })

  test('packages/daemon/src/main.ts selects packages/daemon/test/shell-path.test.ts', () => {
    const result = real([mod('packages/daemon/src/main.ts')])
    expect(result.mode).toBe('some')
    expect(result.files).toContain('packages/daemon/test/shell-path.test.ts')
  })

  test('plugins/quirky.git/src/ai/agents.ts selects plugins/quirky.git/test/scenarios/ai.test.ts', () => {
    const result = real([mod('plugins/quirky.git/src/ai/agents.ts')])
    expect(result.mode).toBe('some')
    expect(result.files).toContain('plugins/quirky.git/test/scenarios/ai.test.ts')
    expect(result.files).toContain('plugins/test/imports.test.ts')
  })

  test('a quirky-plugin.json change selects the spawning tests', () => {
    const result = real([mod('plugins/quirky.palette/quirky-plugin.json')])
    expect(result.mode).toBe('some')
    for (const path of spawners) expect(result.files).toContain(path)
    expect(result.files.some((path) => !path.startsWith('plugins/quirky.palette/'))).toBe(true)
  })

  test('a plugin change selects plugins/test files', () => {
    const result = real([mod('plugins/quirky.palette/src/index.ts')])
    expect(result.files.filter((path) => path.startsWith('plugins/test/')).length).toBeGreaterThan(0)
    expect(testFiles.filter((path) => path.startsWith('plugins/test/')).every((path) => result.files.includes(path))).toBe(true)
  })

  test('docs/x.md selects nothing', () => {
    expect(real([mod('docs/x.md')])).toMatchObject({ mode: 'none', files: [] })
  })

  test('an unknown top-level path selects everything', () => {
    const result = real([mod('unknown-top-level/file.txt')])
    expect(result.mode).toBe('all')
    expect(result.files).toEqual([...testFiles].sort())
  })
})
