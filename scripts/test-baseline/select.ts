import type { ChangedPath, ImportGraph, Selection } from './types'

const MAX_REASONS = 20
const SPAWN_AREAS = new Set(['packages/daemon', 'packages/cli', 'packages/pty-host', 'packages/protocol'])
const RUN_EVERYTHING_PREFIXES = ['.github/', 'scripts/test-support/', 'scripts/test-baseline/']
const RUN_EVERYTHING_PATHS = new Set(['scripts/suite.ts', 'scripts/test-on-macos.txt', 'scripts/test-not-on-ci.txt'])
const RUN_EVERYTHING_NAMES = new Set(['package.json', 'bun.lock', 'bunfig.toml'])

/** Matches text that starts the daemon, the CLI or the pty host as a child process. */
export const SPAWN_MARKER =
  /daemon\/src\/main|DAEMON_MAIN|DAEMON_ENTRY|cli\/src\/main|CLI_MAIN|CLI_ENTRY|pty-host\/src\/main|PTY_HOST_ENTRY|\bstartDaemon\(|\bspawnCli\(/

/** Files that spawn a process without matching `SPAWN_MARKER` because they build the entry path with `join`. */
export const SPAWN_HELPERS = ['packages/cli/test/fixtures/fake-daemon.ts']

export type SelectInput = {
  changed: ChangedPath[]
  testFiles: string[]
  graph: ImportGraph
  spawners: Set<string>
}

function isDocs(path: string): boolean {
  if (path === 'LICENSE' || path.startsWith('docs/') || path.startsWith('prototypes/')) return true
  const parts = path.split('/')
  return path.endsWith('.md') && !parts.slice(0, -1).includes('test')
}

function runsEverything(path: string, area: string | null): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (RUN_EVERYTHING_NAMES.has(name) || /^tsconfig.*\.json$/.test(name)) return true
  if (RUN_EVERYTHING_PATHS.has(path) || RUN_EVERYTHING_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  return area === null
}

function areaOf(path: string): string | null {
  const parts = path.split('/')
  if (parts[0] === 'scripts' && parts.length >= 2) return 'scripts'
  if ((parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'plugins') && parts.length >= 3 && parts[1]) {
    return `${parts[0]}/${parts[1]}`
  }
  return null
}

function sorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort()
}

/**
 * Turns changed paths into the test files worth running. Docs select nothing, config and unknown
 * paths select everything, and a code path selects its area's tests plus every test that reaches it
 * through imports, with plugin and process-spawning changes adding their cross-cutting tests.
 * `mode: 'all'` means `files` is all of `testFiles`. Pure and never throws: a path it doesn't
 * recognise runs everything.
 */
export function selectTests(input: SelectInput): Selection {
  const { changed, graph, spawners } = input
  const testFiles = sorted(input.testFiles)
  const testSet = new Set(testFiles)
  const selected = new Set<string>()
  const reasons: string[] = []
  let all = false

  for (const { path, status } of changed) {
    if (isDocs(path)) {
      reasons.push(`${path}: docs, selects nothing (rule 1)`)
      continue
    }
    const area = areaOf(path)
    if (runsEverything(path, area)) {
      all = true
      reasons.push(`${path}: runs everything (rule 2)`)
      continue
    }
    const fired: string[] = []
    const areaPrefix = `${area}/`
    for (const file of testFiles) if (file.startsWith(areaPrefix)) selected.add(file)
    if (status !== 'D') for (const file of graph.importersOf(path)) if (testSet.has(file)) selected.add(file)
    fired.push(`area ${area} (rule 3)`)
    if (area!.startsWith('plugins/')) {
      for (const file of testFiles) if (file.startsWith('plugins/test/')) selected.add(file)
      fired.push('plugins/test (rule 4)')
    }
    if (SPAWN_AREAS.has(area!) || path.endsWith('quirky-plugin.json')) {
      for (const file of spawners) if (testSet.has(file)) selected.add(file)
      fired.push('spawning tests (rule 5)')
    }
    reasons.push(`${path}: ${fired.join(', ')}`)
  }

  const files = all ? testFiles : sorted(selected)
  const mode = all ? 'all' : files.length > 0 ? 'some' : 'none'
  const capped =
    reasons.length > MAX_REASONS
      ? [...reasons.slice(0, MAX_REASONS - 1), `and ${reasons.length - MAX_REASONS + 1} more changed paths`]
      : reasons
  return { mode, files, reasons: capped }
}

/**
 * Finds the test files that start the daemon, the CLI or the pty host: those whose own text, or
 * any file they import transitively, matches `SPAWN_MARKER` or is in `SPAWN_HELPERS`. Candidates are
 * `graph.files` when the graph lists them, plus the test files and helpers. A file `readFile` can't
 * read doesn't match.
 */
export function findSpawners(
  graph: ImportGraph & { files?: string[] },
  testFiles: string[],
  readFile: (path: string) => string
): Set<string> {
  const tests = new Set(testFiles)
  const spawners = new Set<string>()
  const sources = new Set([...(graph.files ?? []), ...testFiles])
  for (const path of sources) {
    let text: string
    try {
      text = readFile(path)
    } catch {
      continue
    }
    if (!SPAWN_MARKER.test(text)) continue
    for (const importer of graph.importersOf(path)) if (tests.has(importer)) spawners.add(importer)
  }
  for (const helper of SPAWN_HELPERS) {
    for (const importer of graph.importersOf(helper)) if (tests.has(importer)) spawners.add(importer)
  }
  return spawners
}
