import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { bunTestFile } from '../suite'
import { type Context, runCli } from './cli'
import type { Attempt, Baseline, FileError, FileResult, GhRunner, Plan, TestStatus, Verdict } from './types'

type Run = typeof bunTestFile

const sha = (n: number) => n.toString(16).padStart(40, '0')
const NOW = new Date('2026-10-30T12:00:00Z')
const key = (file: string, name: string) => [file, '', name].join('\0')

let root: string
let seq = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const dirOf = (name: string) => {
  const dir = join(root, `${name}-${seq++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function put(cwd: string, path: string, text: string) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), text)
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** A repo whose first commit holds two plugins, a package and a docs file; returns its path and that commit. */
function makeRepo(extra: Record<string, string> = {}): { dir: string; base: string } {
  const dir = dirOf('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  const files: Record<string, string> = {
    'plugins/x/src/a.ts': 'export const a = 1\n',
    'plugins/x/test/a.test.ts': "import { a } from '../src/a'\nvoid a\n",
    'plugins/y/test/b.test.ts': 'export {}\n',
    'plugins/test/imports.test.ts': 'export {}\n',
    'packages/p/src/p.ts': 'export const p = 1\n',
    'packages/p/test/p.test.ts': "import { p } from '../src/p'\nvoid p\n",
    'docs/readme.md': '# docs\n',
    ...extra,
  }
  for (const [path, text] of Object.entries(files)) put(dir, path, text)
  const base = commitAll(dir, 'base')
  git(dir, 'update-ref', 'refs/remotes/origin/main', base)
  return { dir, base }
}

const ALL_TESTS = ['packages/p/test/p.test.ts', 'plugins/test/imports.test.ts', 'plugins/x/test/a.test.ts', 'plugins/y/test/b.test.ts']

function baselineOf(commit: string, tests: Record<string, TestStatus> = {}, files: Baseline['files'] = {}, flakeHistory: Baseline['flakeHistory'] = {}): Baseline {
  return { version: 1, commit, createdAt: '2026-10-29T12:00:00Z', runId: '1', files, tests, flakeHistory }
}

function seedBaseline(repo: string, baseline: Baseline) {
  const dir = join(repo, '.git', 'test-baseline')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${baseline.commit}.json`), JSON.stringify(baseline))
}

function artifactsGh(commits: string[], calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args)
    return commits
      .map((commit, index) =>
        JSON.stringify({
          id: 100 + index,
          name: `test-baseline-${commit}`,
          expired: false,
          created_at: '2026-10-29T00:00:00Z',
          workflow_run: { id: 1, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: commit },
        }),
      )
      .join('\n')
  }
}

const brokenGh: GhRunner = async () => {
  throw new Error('gh is down')
}

const forbiddenGh: GhRunner = async (args) => {
  throw new Error(`gh must not run: ${args.join(' ')}`)
}

type Harness = { ctx: Context; out: string[]; err: string[] }

function harness(cwd: string, over: Partial<Context> = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const ctx: Context = {
    cwd,
    env: { GITHUB_REPOSITORY: 'acme/quirky' },
    gh: forbiddenGh,
    now: () => NOW,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...over,
  }
  return { ctx, out, err }
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

function attempt(tests: Record<string, 'pass' | 'fail' | 'skip'> = {}, file = 'a.test.ts', fileError: FileError = null): Attempt {
  const status = { pass: 'passed', fail: 'failed', skip: 'skipped' } as const
  return {
    exitCode: fileError || Object.values(tests).includes('fail') ? 1 : 0,
    fileError,
    tests: Object.entries(tests).map(([name, s]) => ({ key: key(file, name), status: status[s] })),
  }
}

function fileResult(file: string, first: Attempt, rerun?: Attempt, platform: 'linux' | 'macos' = 'linux'): FileResult {
  return { file, platform, durationMs: 100, first, ...(rerun ? { rerun } : {}) }
}

function planOf(over: Partial<Plan> = {}): Plan {
  return {
    event: 'pull_request',
    head: sha(9),
    baseline: null,
    selection: { mode: 'some', files: ['a.test.ts'], reasons: [] },
    rangeSelection: null,
    deleted: [],
    notOnCi: [],
    linuxShards: [['a.test.ts']],
    macos: [],
    ...over,
  }
}

function writePlan(dir: string, plan: Plan, baseline?: Baseline) {
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  if (baseline) writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline))
}

const reportOf = (args: string[]) => args.find((arg) => arg.startsWith('--reporter-outfile='))!.slice('--reporter-outfile='.length)

type Calls = { files: string[]; active: number; maxActive: number }

/** A fake `bun test`: each file's attempts are consumed in order, the last one repeating. */
function fakeRun(script: Record<string, Record<string, 'pass' | 'fail'>[]>, calls: Calls = { files: [], active: 0, maxActive: 0 }): Run {
  const used: Record<string, number> = {}
  return async (_cwd, args) => {
    const file = args.find((arg) => !arg.startsWith('-'))!.replace(/^\.\//, '')
    const attempts = script[file]
    if (!attempts) throw new Error(`unexpected file ${file}`)
    const tests = attempts[Math.min(used[file] ?? 0, attempts.length - 1)]
    used[file] = (used[file] ?? 0) + 1
    calls.files.push(file)
    calls.active++
    calls.maxActive = Math.max(calls.maxActive, calls.active)
    await Bun.sleep(15)
    calls.active--
    const cases = Object.entries(tests).map(([name, s]) => (s === 'fail' ? `<testcase name="${name}" classname=""><failure message="x" /></testcase>` : `<testcase name="${name}" classname="" />`))
    writeFileSync(reportOf(args), `<testsuites><testsuite name="${file}">${cases.join('')}</testsuite></testsuites>`)
    return { code: Object.values(tests).includes('fail') ? 1 : 0, output: '', timedOut: false }
  }
}

describe('argument handling', () => {
  test('no subcommand exits 2 with usage on stderr', async () => {
    const { ctx, err, out } = harness(root)
    expect(await runCli([], ctx)).toBe(2)
    expect(err.join('')).toContain('plan')
    expect(err.join('')).toContain('usage')
    expect(out).toEqual([])
  })

  test('an unknown subcommand is an error', async () => {
    const { ctx, err } = harness(root)
    expect(await runCli(['frobnicate'], ctx)).toBe(2)
    expect(err.join('')).toContain('frobnicate')
  })

  test.each([
    ['plan without --out', ['plan', '--event', 'push']],
    ['plan with an unknown event', ['plan', '--event', 'schedule', '--out', 'x']],
    ['plan with an unknown option', ['plan', '--event', 'push', '--out', 'x', '--nope']],
    ['plan with a stray argument', ['plan', 'extra', '--event', 'push', '--out', 'x']],
    ['run-shard with neither --shard nor --macos', ['run-shard', '--plan', 'p', '--out', 'o']],
    ['run-shard with both --shard and --macos', ['run-shard', '--plan', 'p', '--shard', '0', '--macos', '--out', 'o']],
    ['run-shard with a bad index', ['run-shard', '--plan', 'p', '--shard', 'one', '--out', 'o']],
    ['rerun without --in', ['rerun', '--plan', 'p', '--out', 'o']],
    ['verdict with a bad --jobs-ok', ['verdict', '--plan', 'p', '--in', 'i', '--out', 'o', '--jobs-ok', 'maybe']],
    ['verdict without --jobs-ok', ['verdict', '--plan', 'p', '--in', 'i', '--out', 'o']],
    ['issues without --baseline', ['issues', '--plan', 'p', '--only', 'open']],
    ['issues without --only', ['issues', '--plan', 'p', '--baseline', 'b']],
    ['issues with an invalid --only', ['issues', '--plan', 'p', '--baseline', 'b', '--only', 'both']],
    ['affected with a zero --jobs', ['affected', '--jobs', '0']],
    ['affected with a non-numeric --jobs', ['affected', '--jobs', 'many']],
  ])('%s exits 2', async (_name, argv) => {
    const { ctx, err } = harness(root)
    expect(await runCli(argv, ctx)).toBe(2)
    expect(err.join('')).toContain('usage')
  })

  test('the process exits 2 for a bad command and prints usage', () => {
    const result = Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'bogus'], { cwd: root })
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('usage')
  })
})

describe('plan', () => {
  const MACOS = 'plugins/y/test/b.test.ts  needs chrome\n'
  const NOT_ON_CI = 'packages/p/test/p.test.ts  runner limitation\n'

  test('push selects everything, finds a baseline from the parent and records the range selection', async () => {
    const { dir, base } = makeRepo({ 'scripts/test-on-macos.txt': MACOS, 'scripts/test-not-on-ci.txt': NOT_ON_CI })
    seedBaseline(
      dir,
      baselineOf(
        base,
        {},
        Object.fromEntries(ALL_TESTS.map((file) => [file, { platform: 'linux' as const, durationMs: file === 'plugins/x/test/a.test.ts' ? 400_000 : 1000, fileError: null, flaky: false }])),
      ),
    )
    put(dir, 'plugins/x/src/a.ts', 'export const a = 2\n')
    const head = commitAll(dir, 'change a')
    const calls: string[][] = []
    const { ctx, out } = harness(dir, { gh: artifactsGh([base], calls), env: { GITHUB_REPOSITORY: 'acme/quirky', GITHUB_SHA: head } })
    const outDir = join(dirOf('out'), 'plan')

    expect(await runCli(['plan', '--event', 'push', '--out', outDir], ctx)).toBe(0)

    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.event).toBe('push')
    expect(plan.head).toBe(head)
    expect(plan.selection.mode).toBe('all')
    expect(plan.selection.files).toEqual(ALL_TESTS)
    expect(plan.baseline).toEqual({ commit: base, createdAt: '2026-10-29T12:00:00Z' })
    expect(plan.rangeSelection?.mode).toBe('some')
    expect(plan.rangeSelection?.files).toEqual(['plugins/test/imports.test.ts', 'plugins/x/test/a.test.ts'])
    expect(plan.macos).toEqual(['plugins/y/test/b.test.ts'])
    expect(plan.notOnCi).toEqual(['packages/p/test/p.test.ts'])
    const linux = plan.linuxShards.flat().sort()
    expect(linux).toEqual(['plugins/test/imports.test.ts', 'plugins/x/test/a.test.ts'])
    expect(plan.linuxShards[0]).toEqual(['plugins/x/test/a.test.ts'])
    expect(readJson<Baseline>(join(outDir, 'baseline.json')).commit).toBe(base)
    expect(calls.length).toBeGreaterThan(0)
    expect(out.join('')).toContain('plugins/x/src/a.ts')
  })

  test('push on a repo with no baseline artifact has no baseline and no range selection', async () => {
    const { dir } = makeRepo()
    const { ctx } = harness(dir, { gh: artifactsGh([]) })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'push', '--out', outDir], ctx)).toBe(0)
    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.baseline).toBeNull()
    expect(plan.rangeSelection).toBeNull()
    expect(plan.selection.mode).toBe('all')
    expect(plan.head).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(existsSync(join(outDir, 'baseline.json'))).toBe(false)
  })

  test('push never finds its own baseline', async () => {
    const { dir } = makeRepo()
    const head = git(dir, 'rev-parse', 'HEAD')
    const { ctx } = harness(dir, { gh: artifactsGh([head]), env: { GITHUB_REPOSITORY: 'acme/quirky', GITHUB_SHA: head } })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'push', '--out', outDir], ctx)).toBe(0)
    expect(readJson<Plan>(join(outDir, 'plan.json')).baseline).toBeNull()
  })

  test('workflow_dispatch selects everything and has no range selection', async () => {
    const { dir, base } = makeRepo()
    seedBaseline(dir, baselineOf(base))
    put(dir, 'plugins/x/src/a.ts', 'export const a = 2\n')
    commitAll(dir, 'change a')
    const { ctx } = harness(dir, { gh: artifactsGh([base]) })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'workflow_dispatch', '--out', outDir], ctx)).toBe(0)
    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.selection).toMatchObject({ mode: 'all', files: ALL_TESTS })
    expect(plan.rangeSelection).toBeNull()
  })

  test('pull_request selects from the diff against the baseline and lists deleted test files', async () => {
    const { dir, base } = makeRepo()
    seedBaseline(dir, baselineOf(base, { [key('plugins/y/test/b.test.ts', 'works')]: 'passed' }))
    put(dir, 'plugins/x/src/a.ts', 'export const a = 2\n')
    git(dir, 'rm', '-q', 'plugins/y/test/b.test.ts')
    commitAll(dir, 'change a, drop b')
    const { ctx } = harness(dir, { gh: artifactsGh([base]) })
    const outDir = join(dirOf('out'), 'plan')

    expect(await runCli(['plan', '--event', 'pull_request', '--out', outDir], ctx)).toBe(0)

    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.baseline?.commit).toBe(base)
    expect(plan.selection.mode).toBe('some')
    expect(plan.selection.files).toEqual(['plugins/test/imports.test.ts', 'plugins/x/test/a.test.ts'])
    expect(plan.deleted).toEqual(['plugins/y/test/b.test.ts'])
    expect(plan.rangeSelection).toBeNull()
    expect(readJson<Baseline>(join(outDir, 'baseline.json')).commit).toBe(base)
  })

  test('pull_request files in the not-on-CI list are in no job', async () => {
    const { dir, base } = makeRepo({ 'scripts/test-on-macos.txt': MACOS, 'scripts/test-not-on-ci.txt': NOT_ON_CI })
    seedBaseline(dir, baselineOf(base))
    put(dir, 'plugins/y/test/b.test.ts', 'export const b = 1\n')
    put(dir, 'packages/p/src/p.ts', 'export const p = 2\n')
    commitAll(dir, 'touch y and p')
    const { ctx } = harness(dir, { gh: artifactsGh([base]) })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'pull_request', '--out', outDir], ctx)).toBe(0)
    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.selection.files).toEqual(['packages/p/test/p.test.ts', 'plugins/test/imports.test.ts', 'plugins/y/test/b.test.ts'])
    expect(plan.notOnCi).toEqual(['packages/p/test/p.test.ts'])
    expect(plan.macos).toEqual(['plugins/y/test/b.test.ts'])
    expect(plan.linuxShards).toEqual([['plugins/test/imports.test.ts']])
  })

  test('a docs-only pull_request selects nothing and plans no jobs', async () => {
    const { dir, base } = makeRepo()
    seedBaseline(dir, baselineOf(base))
    put(dir, 'docs/readme.md', '# changed\n')
    commitAll(dir, 'docs')
    const { ctx } = harness(dir, { gh: artifactsGh([base]) })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'pull_request', '--out', outDir], ctx)).toBe(0)
    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.selection.mode).toBe('none')
    expect(plan.linuxShards).toEqual([])
    expect(plan.macos).toEqual([])
  })

  test('pull_request with no ancestor baseline runs everything with no baseline', async () => {
    const { dir } = makeRepo()
    put(dir, 'docs/readme.md', '# changed\n')
    commitAll(dir, 'docs')
    const { ctx } = harness(dir, { gh: artifactsGh([]) })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'pull_request', '--out', outDir], ctx)).toBe(0)
    const plan = readJson<Plan>(join(outDir, 'plan.json'))
    expect(plan.baseline).toBeNull()
    expect(plan.selection).toMatchObject({ mode: 'all', files: ALL_TESTS })
    expect(existsSync(join(outDir, 'baseline.json'))).toBe(false)
  })

  test('a failing gh fails the job and writes no plan', async () => {
    const { dir } = makeRepo()
    commitAll(dir, 'second')
    const { ctx, err } = harness(dir, { gh: brokenGh })
    const outDir = join(dirOf('out'), 'plan')
    for (const event of ['pull_request', 'push']) {
      expect(await runCli(['plan', '--event', event, '--out', outDir], ctx)).toBe(1)
    }
    expect(err.join('')).toContain('gh is down')
    expect(existsSync(join(outDir, 'plan.json'))).toBe(false)
  })

  test('uses the repository from the environment and head from rev-parse when GITHUB_SHA is unset', async () => {
    const { dir } = makeRepo()
    commitAll(dir, 'second')
    const calls: string[][] = []
    const { ctx } = harness(dir, { gh: artifactsGh([], calls), env: { GITHUB_REPOSITORY: 'someone/else' } })
    const outDir = join(dirOf('out'), 'plan')
    expect(await runCli(['plan', '--event', 'push', '--out', outDir], ctx)).toBe(0)
    expect(calls[0].join(' ')).toContain('repos/someone/else/actions/artifacts')
    expect(readJson<Plan>(join(outDir, 'plan.json')).head).toBe(git(dir, 'rev-parse', 'HEAD'))
  })
})

describe('run-shard', () => {
  test('runs the shard and exits 0 even when a test fails', async () => {
    const cwd = dirOf('cwd')
    const planDir = dirOf('plan')
    writePlan(planDir, planOf({ linuxShards: [['a.test.ts'], ['b.test.ts', 'c.test.ts']] }))
    const calls: Calls = { files: [], active: 0, maxActive: 0 }
    const run = fakeRun({ 'b.test.ts': [{ ok: 'fail' }], 'c.test.ts': [{ ok: 'pass' }] }, calls)
    const out = join(dirOf('out'), 'linux-1.json')
    const { ctx } = harness(cwd, { run })
    expect(await runCli(['run-shard', '--plan', planDir, '--shard', '1', '--out', out], ctx)).toBe(0)
    const results = readJson<FileResult[]>(out)
    expect(results.map((r) => r.file)).toEqual(['b.test.ts', 'c.test.ts'])
    expect(results.map((r) => r.platform)).toEqual(['linux', 'linux'])
    expect(results[0].first.tests[0].status).toBe('failed')
    expect(results[0].rerun).toBeUndefined()
    expect(calls.files.sort()).toEqual(['b.test.ts', 'c.test.ts'])
  })

  test('--macos runs the macOS list and reruns its own failures', async () => {
    const cwd = dirOf('cwd')
    const planDir = dirOf('plan')
    writePlan(planDir, planOf({ macos: ['m1.test.ts', 'm2.test.ts'], linuxShards: [['a.test.ts']] }))
    const calls: Calls = { files: [], active: 0, maxActive: 0 }
    const run = fakeRun({ 'm1.test.ts': [{ t: 'fail' }, { t: 'pass' }], 'm2.test.ts': [{ t: 'pass' }] }, calls)
    const out = join(dirOf('out'), 'macos.json')
    const { ctx } = harness(cwd, { run })
    expect(await runCli(['run-shard', '--plan', planDir, '--macos', '--out', out], ctx)).toBe(0)
    const results = readJson<FileResult[]>(out)
    expect(results.map((r) => [r.file, r.platform])).toEqual([
      ['m1.test.ts', 'macos'],
      ['m2.test.ts', 'macos'],
    ])
    expect(results[0].rerun?.tests[0].status).toBe('passed')
    expect(results[1].rerun).toBeUndefined()
    expect(calls.files.filter((f) => f === 'm1.test.ts')).toHaveLength(2)
  })

  test('a shard index outside the plan is an argument error', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf())
    const { ctx } = harness(dirOf('cwd'), { run: fakeRun({}) })
    expect(await runCli(['run-shard', '--plan', planDir, '--shard', '4', '--out', join(root, 'o.json')], ctx)).toBe(2)
  })

  test('an unreadable plan fails the job', async () => {
    const { ctx, err } = harness(dirOf('cwd'), { run: fakeRun({}) })
    expect(await runCli(['run-shard', '--plan', dirOf('empty'), '--shard', '0', '--out', join(root, 'o.json')], ctx)).toBe(1)
    expect(err.join('')).toContain('plan.json')
  })
})

describe('rerun', () => {
  const stageResults = (results: Record<string, FileResult[]>) => {
    const dir = dirOf('in')
    for (const [name, list] of Object.entries(results)) writeFileSync(join(dir, name), JSON.stringify(list))
    return dir
  }

  test('reruns only failed linux files and writes only the files it reran', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf())
    const inDir = stageResults({
      'linux-0.json': [fileResult('a.test.ts', attempt({ ok: 'pass' }, 'a.test.ts')), fileResult('b.test.ts', attempt({ t: 'fail' }, 'b.test.ts'))],
      'linux-1.json': [fileResult('c.test.ts', attempt({ t: 'pass' }, 'c.test.ts'))],
    })
    const calls: Calls = { files: [], active: 0, maxActive: 0 }
    const out = join(dirOf('out'), 'rerun.json')
    const { ctx } = harness(dirOf('cwd'), { run: fakeRun({ 'b.test.ts': [{ t: 'pass' }] }, calls) })
    expect(await runCli(['rerun', '--plan', planDir, '--in', inDir, '--out', out], ctx)).toBe(0)
    const written = readJson<FileResult[]>(out)
    expect(written.map((r) => r.file)).toEqual(['b.test.ts'])
    expect(written[0].rerun?.tests[0].status).toBe('passed')
    expect(calls.files).toEqual(['b.test.ts'])
  })

  test('writes an empty list and exits 0 when nothing failed', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf())
    const inDir = stageResults({ 'linux-0.json': [fileResult('a.test.ts', attempt({ ok: 'pass' }, 'a.test.ts'))] })
    const out = join(dirOf('out'), 'rerun.json')
    const { ctx } = harness(dirOf('cwd'), { run: fakeRun({}) })
    expect(await runCli(['rerun', '--plan', planDir, '--in', inDir, '--out', out], ctx)).toBe(0)
    expect(readJson<FileResult[]>(out)).toEqual([])
  })

  test('reruns nothing when more files failed than the limit', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf())
    const failing = Array.from({ length: 6 }, (_, i) => fileResult(`f${i}.test.ts`, attempt({ t: 'fail' }, `f${i}.test.ts`)))
    const inDir = stageResults({ 'linux-0.json': failing })
    const out = join(dirOf('out'), 'rerun.json')
    const { ctx } = harness(dirOf('cwd'), { run: fakeRun({}) })
    expect(await runCli(['rerun', '--plan', planDir, '--in', inDir, '--out', out], ctx)).toBe(0)
    expect(readJson<FileResult[]>(out)).toEqual([])
  })

  test('an unreadable results file fails the job', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf())
    const inDir = dirOf('in')
    writeFileSync(join(inDir, 'linux-0.json'), '{ nope')
    const { ctx } = harness(dirOf('cwd'), { run: fakeRun({}) })
    expect(await runCli(['rerun', '--plan', planDir, '--in', inDir, '--out', join(root, 'r.json')], ctx)).toBe(1)
  })
})

describe('verdict', () => {
  type Staged = { planDir: string; inDir: string; outDir: string }

  function stage(plan: Plan | null, results: Record<string, unknown> = {}, baseline?: Baseline): Staged {
    const planDir = dirOf('plan')
    const inDir = dirOf('in')
    const outDir = join(dirOf('o'), 'verdict')
    if (plan) writePlan(planDir, plan, baseline)
    for (const [name, value] of Object.entries(results)) writeFileSync(join(inDir, name), typeof value === 'string' ? value : JSON.stringify(value))
    return { planDir, inDir, outDir }
  }

  async function verdictOf(staged: Staged, jobsOk = 'true', over: Partial<Context> = {}) {
    const h = harness(dirOf('cwd'), over)
    const code = await runCli(['verdict', '--plan', staged.planDir, '--in', staged.inDir, '--out', staged.outDir, '--jobs-ok', jobsOk], h.ctx)
    const verdict = existsSync(join(staged.outDir, 'verdict.json')) ? readJson<Verdict>(join(staged.outDir, 'verdict.json')) : null
    return { ...h, code, verdict }
  }

  const passing = fileResult('a.test.ts', attempt({ ok: 'pass' }))

  test('a clean pull_request run exits 0 and writes the comment and verdict', async () => {
    const staged = stage(planOf(), { 'linux-0.json': [passing] })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(0)
    expect(verdict?.ok).toBe(true)
    expect(verdict?.advisory).toBe(false)
    const comment = readFileSync(join(staged.outDir, 'comment.md'), 'utf8')
    expect(comment.startsWith('<!-- test-baseline-verdict -->')).toBe(true)
    expect(comment).toContain('Tests passed')
    expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
  })

  test('a new failure on a pull_request exits 1', async () => {
    const staged = stage(planOf(), { 'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))] })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.new).toEqual([key('a.test.ts', 'bad')])
    expect(readFileSync(join(staged.outDir, 'comment.md'), 'utf8')).toContain('Tests failed')
  })

  test('a known failure from the plan directory baseline does not block', async () => {
    const baseline = baselineOf(sha(1), { [key('a.test.ts', 'bad')]: 'failed' })
    const plan = planOf({ baseline: { commit: baseline.commit, createdAt: baseline.createdAt } })
    const staged = stage(plan, { 'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))] }, baseline)
    const { code, verdict, } = await verdictOf(staged, 'true', { gh: forbiddenGh })
    expect(code).toBe(0)
    expect(verdict?.known).toEqual([key('a.test.ts', 'bad')])
    expect(verdict?.baseline?.commit).toBe(baseline.commit)
  })

  test('overlays rerun.json by file so a rerun that passes makes the failure flaky', async () => {
    const staged = stage(planOf(), {
      'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))],
      'rerun.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }), attempt({ bad: 'pass' }))],
    })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(0)
    expect(verdict?.flaky).toEqual([key('a.test.ts', 'bad')])
    expect(verdict?.new).toEqual([])
  })

  test('takes only the rerun attempt from rerun.json', async () => {
    const staged = stage(planOf(), {
      'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))],
      'rerun.json': [fileResult('a.test.ts', attempt({ other: 'pass' }), attempt({ bad: 'fail' }))],
    })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.new).toEqual([key('a.test.ts', 'bad')])
  })

  test('reads results from nested artifact directories too', async () => {
    const staged = stage(planOf({ selection: { mode: 'some', files: ['a.test.ts', 'b.test.ts'], reasons: [] } }), { 'linux-0.json': [passing] })
    mkdirSync(join(staged.inDir, 'test-results-macos'))
    writeFileSync(join(staged.inDir, 'test-results-macos', 'macos.json'), JSON.stringify([fileResult('b.test.ts', attempt({ ok: 'pass' }, 'b.test.ts'), undefined, 'macos')]))
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(0)
    expect(verdict?.incomplete).toEqual([])
  })

  test('a rerun for a file with no first result marks the run broken', async () => {
    const staged = stage(planOf(), {
      'linux-0.json': [passing],
      'rerun.json': [fileResult('ghost.test.ts', attempt({ t: 'fail' }, 'ghost.test.ts'), attempt({ t: 'pass' }, 'ghost.test.ts'))],
    })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
  })

  test('--jobs-ok false sets runBroken and exits 1 even on push', async () => {
    for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
      const staged = stage(planOf({ event, selection: { mode: 'all', files: ['a.test.ts'], reasons: [] } }), { 'linux-0.json': [passing] })
      const { code, verdict } = await verdictOf(staged, 'false')
      expect(code).toBe(1)
      expect(verdict?.runBroken).toBe(true)
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    }
  })

  test('an unreadable results file sets runBroken instead of crashing', async () => {
    const staged = stage(planOf(), { 'linux-0.json': [passing], 'linux-1.json': '{ not json' })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
    expect(existsSync(join(staged.outDir, 'comment.md'))).toBe(true)
  })

  test('a results file that is not a list of file results sets runBroken', async () => {
    const staged = stage(planOf(), { 'linux-0.json': { surprise: true } })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
  })

  test.each([
    ['an invalid test status', { ...passing, first: { ...passing.first, tests: [{ key: key('a.test.ts', 'ok'), status: 'unknown' }] } }],
    ['a fileError outside the allowed values', { ...passing, first: { ...passing.first, fileError: 'exploded' } }],
    ['a malformed rerun attempt', { ...passing, rerun: { exitCode: 'zero', fileError: null, tests: [] } }],
    ['a missing durationMs', { file: 'a.test.ts', platform: 'linux', first: passing.first }],
    ['an unknown platform', { ...passing, platform: 'windows' }],
    ['a test without a key', { ...passing, first: { ...passing.first, tests: [{ status: 'passed' }] } }],
  ])('%s sets runBroken instead of passing', async (_name, bad) => {
    const staged = stage(planOf(), { 'linux-0.json': [bad] })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
    expect(verdict?.ok).toBe(false)
  })

  test('a rerun.json entry with a malformed rerun attempt sets runBroken', async () => {
    const staged = stage(planOf(), {
      'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))],
      'rerun.json': [{ ...fileResult('a.test.ts', attempt({ bad: 'fail' })), rerun: { exitCode: 0, fileError: null, tests: [{ key: key('a.test.ts', 'bad'), status: 'maybe' }] } }],
    })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
  })

  test('every fileError the runner can produce is accepted', async () => {
    const errors: FileError[] = [null, 'timeout', 'no-report', 'exit-mismatch']
    const results = errors.map((fileError, index) => fileResult(`f${index}.test.ts`, attempt({}, `f${index}.test.ts`, fileError), attempt({ ok: 'pass' }, `f${index}.test.ts`)))
    const staged = stage(planOf({ selection: { mode: 'some', files: results.map((result) => result.file), reasons: [] } }), { 'linux-0.json': results })
    const { verdict } = await verdictOf(staged)
    expect(verdict?.runBroken).toBe(false)
  })

  test('a missing plan sets runBroken and still reports', async () => {
    const staged = stage(null, { 'linux-0.json': [passing] })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
    expect(verdict?.ok).toBe(false)
    expect(existsSync(join(staged.outDir, 'comment.md'))).toBe(true)
  })

  test('a plan naming a baseline that is missing from the plan directory sets runBroken', async () => {
    const plan = planOf({ baseline: { commit: sha(1), createdAt: '2026-10-29T12:00:00Z' } })
    const staged = stage(plan, { 'linux-0.json': [passing] })
    const { code, verdict } = await verdictOf(staged, 'true', { gh: forbiddenGh })
    expect(code).toBe(1)
    expect(verdict?.runBroken).toBe(true)
  })

  test('a missing results directory leaves the selected files incomplete', async () => {
    const staged = stage(planOf())
    rmSync(staged.inDir, { recursive: true })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(1)
    expect(verdict?.incomplete).toEqual(['a.test.ts'])
  })

  test('an empty selection passes with nothing to run', async () => {
    const staged = stage(planOf({ selection: { mode: 'none', files: [], reasons: [] }, linuxShards: [] }))
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(0)
    expect(verdict?.ok).toBe(true)
    expect(readFileSync(join(staged.outDir, 'comment.md'), 'utf8')).toContain('No tests were needed')
  })

  test('a not-on-CI file is reported but not incomplete', async () => {
    const staged = stage(planOf({ selection: { mode: 'some', files: ['a.test.ts', 'n.test.ts'], reasons: [] }, notOnCi: ['n.test.ts'] }), { 'linux-0.json': [passing] })
    const { code, verdict } = await verdictOf(staged)
    expect(code).toBe(0)
    expect(verdict?.notOnCi).toEqual(['n.test.ts'])
    expect(verdict?.incomplete).toEqual([])
  })

  describe('on push', () => {
    const pushPlan = (over: Partial<Plan> = {}) => planOf({ event: 'push', head: sha(5), selection: { mode: 'all', files: ['a.test.ts', 'b.test.ts'], reasons: [] }, ...over })
    const results = {
      'linux-0.json': [fileResult('a.test.ts', attempt({ ok: 'pass' })), fileResult('b.test.ts', attempt({ bad: 'fail' }, 'b.test.ts'))],
    }

    test('a complete run writes the baseline and exits 0 despite failures', async () => {
      const staged = stage(pushPlan(), results)
      const { code, verdict } = await verdictOf(staged, 'true', { env: { GITHUB_REPOSITORY: 'acme/quirky', GITHUB_RUN_ID: '4242' } })
      expect(code).toBe(0)
      expect(verdict?.new).toEqual([key('b.test.ts', 'bad')])
      const baseline = readJson<Baseline>(join(staged.outDir, 'baseline.json'))
      expect(baseline.commit).toBe(sha(5))
      expect(baseline.runId).toBe('4242')
      expect(baseline.createdAt).toBe(NOW.toISOString())
      expect(baseline.tests[key('b.test.ts', 'bad')]).toBe('failed')
      expect(baseline.tests[key('a.test.ts', 'ok')]).toBe('passed')
    })

    test('carries the flake history of the plan directory baseline forward', async () => {
      const previous = baselineOf(sha(1), {}, {}, { 'old.test.ts': ['2026-10-28T00:00:00.000Z'], 'ancient.test.ts': ['2026-10-01T00:00:00.000Z'] })
      const plan = pushPlan({ baseline: { commit: previous.commit, createdAt: previous.createdAt } })
      const staged = stage(plan, {
        'linux-0.json': [fileResult('a.test.ts', attempt({ t: 'fail' }), attempt({ t: 'pass' })), fileResult('b.test.ts', attempt({ ok: 'pass' }, 'b.test.ts'))],
      }, previous)
      const { code } = await verdictOf(staged, 'true', { gh: forbiddenGh })
      expect(code).toBe(0)
      const baseline = readJson<Baseline>(join(staged.outDir, 'baseline.json'))
      expect(baseline.flakeHistory).toEqual({
        'old.test.ts': ['2026-10-28T00:00:00.000Z'],
        'a.test.ts': [NOW.toISOString()],
      })
    })

    test('an incomplete run exits 1 and writes no baseline', async () => {
      const staged = stage(pushPlan(), { 'linux-0.json': [fileResult('a.test.ts', attempt({ ok: 'pass' }))] })
      const { code, verdict } = await verdictOf(staged)
      expect(code).toBe(1)
      expect(verdict?.incomplete).toEqual(['b.test.ts'])
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    })

    test('a broken run writes no baseline even when every result is present', async () => {
      const staged = stage(pushPlan(), { ...results, 'linux-1.json': 'garbage' })
      const { code } = await verdictOf(staged)
      expect(code).toBe(1)
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    })

    test('a stale baseline.json in the output directory is removed when none is written', async () => {
      const staged = stage(pushPlan(), { 'linux-0.json': [] })
      mkdirSync(staged.outDir, { recursive: true })
      writeFileSync(join(staged.outDir, 'baseline.json'), '{}')
      await verdictOf(staged)
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    })

    test('a push plan that is not a full selection never becomes a baseline', async () => {
      const staged = stage(pushPlan({ selection: { mode: 'some', files: ['a.test.ts'], reasons: [] } }), { 'linux-0.json': [passing] })
      const { code } = await verdictOf(staged)
      expect(code).toBe(0)
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    })
  })

  describe('on workflow_dispatch', () => {
    const plan = planOf({ event: 'workflow_dispatch', selection: { mode: 'all', files: ['a.test.ts'], reasons: [] } })

    test('exits 0 on a new failure and never writes a baseline', async () => {
      const staged = stage(plan, { 'linux-0.json': [fileResult('a.test.ts', attempt({ bad: 'fail' }))] })
      const { code, verdict } = await verdictOf(staged)
      expect(code).toBe(0)
      expect(verdict?.new).toHaveLength(1)
      expect(existsSync(join(staged.outDir, 'baseline.json'))).toBe(false)
    })

    test('exits 1 when the run is incomplete', async () => {
      const staged = stage(plan, {})
      const { code } = await verdictOf(staged)
      expect(code).toBe(1)
    })
  })
})

describe('verdict without bun install', () => {
  const HERE = import.meta.dir
  const staticImports = (source: string) =>
    [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)].filter((match) => !match[1]).map((match) => match[2])

  test('cli.ts statically imports only node built-ins and dependency-free modules', () => {
    const specs = staticImports(readFileSync(join(HERE, 'cli.ts'), 'utf8'))
    const allowed = new Set(['./baseline', './compare', './issues', './report', './select', './shards'])
    for (const spec of specs) expect(spec.startsWith('node:') || allowed.has(spec)).toBe(true)
    expect(specs).not.toContain('./runner')
    expect(specs).not.toContain('./graph')
    expect(specs.some((spec) => spec.includes('suite'))).toBe(false)
  })

  test('the modules cli.ts imports statically import nothing that needs an install', () => {
    for (const name of ['baseline', 'compare', 'issues', 'report', 'select', 'shards']) {
      const specs = staticImports(readFileSync(join(HERE, `${name}.ts`), 'utf8'))
      for (const spec of specs) expect(spec.startsWith('node:') || spec.startsWith('./')).toBe(true)
      expect(specs).not.toContain('./runner')
      expect(specs).not.toContain('./graph')
    }
  })

  test('verdict runs from a directory that has only the modules it needs', () => {
    const lib = join(dirOf('lib'), 'scripts', 'test-baseline')
    mkdirSync(lib, { recursive: true })
    for (const name of ['cli', 'baseline', 'compare', 'issues', 'report', 'select', 'shards', 'types']) copyFileSync(join(HERE, `${name}.ts`), join(lib, `${name}.ts`))
    const planDir = dirOf('plan')
    const inDir = dirOf('in')
    const outDir = join(dirOf('o'), 'verdict')
    writePlan(planDir, planOf())
    writeFileSync(join(inDir, 'linux-0.json'), JSON.stringify([fileResult('a.test.ts', attempt({ ok: 'pass' }))]))
    const result = Bun.spawnSync(['bun', join(lib, 'cli.ts'), 'verdict', '--plan', planDir, '--in', inDir, '--out', outDir, '--jobs-ok', 'true'], { cwd: lib })
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    expect(readJson<Verdict>(join(outDir, 'verdict.json')).ok).toBe(true)
  })
})

describe('issues', () => {
  function issueGh(calls: string[][], openFailure: string | null = null): GhRunner {
    return async (args) => {
      calls.push(args)
      if (args[0] === 'label' && args[1] === 'list') return JSON.stringify([{ name: 'test-failure' }, { name: 'test-flake' }])
      if (args[0] === 'issue' && args[1] === 'list') {
        const label = args[args.indexOf('--label') + 1]
        if (label === 'test-failure' && openFailure) {
          return JSON.stringify([{ number: 7, body: `body\n\n<!-- test-baseline:${JSON.stringify({ tests: [openFailure] })} -->` }])
        }
        return '[]'
      }
      return ''
    }
  }

  function stageIssues(previous: Baseline | null, current: Baseline, rangeSelection: Plan['rangeSelection']) {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf({ event: 'push', rangeSelection, baseline: previous ? { commit: previous.commit, createdAt: previous.createdAt } : null }), previous ?? undefined)
    const file = join(dirOf('cur'), 'baseline.json')
    writeFileSync(file, JSON.stringify(current))
    return { planDir, file }
  }

  test('opens one failure issue for new failures and names a selection miss', async () => {
    const previous = baselineOf(sha(1), { [key('a.test.ts', 't')]: 'passed' })
    const current = baselineOf(sha(2), { [key('a.test.ts', 't')]: 'failed' })
    const { planDir, file } = stageIssues(previous, current, { mode: 'some', files: ['other.test.ts'], reasons: [] })
    const calls: string[][] = []
    const { ctx } = harness(dirOf('cwd'), { gh: issueGh(calls) })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'open'], ctx)).toBe(0)
    const created = calls.filter((c) => c[0] === 'issue' && c[1] === 'create')
    expect(created).toHaveLength(1)
    expect(created[0]).toContain('--repo')
    expect(created[0]).toContain('acme/quirky')
    expect(created[0][created[0].indexOf('--label') + 1]).toBe('test-failure')
    expect(created[0][created[0].indexOf('--title') + 1]).toContain(`${sha(1)}..${sha(2)}`)
    expect(created[0][created[0].indexOf('--body') + 1]).toContain('Selection misses')
  })

  test('does not mark a failure inside the range selection as a miss', async () => {
    const previous = baselineOf(sha(1), {})
    const current = baselineOf(sha(2), { [key('a.test.ts', 't')]: 'failed' })
    const { planDir, file } = stageIssues(previous, current, { mode: 'some', files: ['a.test.ts'], reasons: [] })
    const calls: string[][] = []
    const { ctx } = harness(dirOf('cwd'), { gh: issueGh(calls) })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'open'], ctx)).toBe(0)
    const body = calls.find((c) => c[1] === 'create')![calls.find((c) => c[1] === 'create')!.indexOf('--body') + 1]
    expect(body).not.toContain('Selection misses')
  })

  test('files nothing when the plan directory has no previous baseline', async () => {
    const current = baselineOf(sha(2), { [key('a.test.ts', 't')]: 'failed' })
    const { planDir, file } = stageIssues(null, current, null)
    const calls: string[][] = []
    const { ctx } = harness(dirOf('cwd'), { gh: issueGh(calls) })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'open'], ctx)).toBe(0)
    expect(calls.filter((c) => c[1] === 'create')).toEqual([])
  })

  test('closes an open failure issue whose tests pass again', async () => {
    const previous = baselineOf(sha(1), { [key('a.test.ts', 't')]: 'failed' })
    const current = baselineOf(sha(2), { [key('a.test.ts', 't')]: 'passed' })
    const { planDir, file } = stageIssues(previous, current, null)
    const calls: string[][] = []
    const { ctx } = harness(dirOf('cwd'), { gh: issueGh(calls, key('a.test.ts', 't')) })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'close'], ctx)).toBe(0)
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '7')).toBe(true)
  })

  describe('--only', () => {
    function mixed() {
      const previous = baselineOf(sha(1), { [key('a.test.ts', 'old')]: 'failed', [key('b.test.ts', 'fresh')]: 'passed' })
      const current = baselineOf(sha(2), { [key('a.test.ts', 'old')]: 'passed', [key('b.test.ts', 'fresh')]: 'failed' })
      return stageIssues(previous, current, null)
    }

    test('open applies only the opens', async () => {
      const { planDir, file } = mixed()
      const calls: string[][] = []
      const { ctx, out } = harness(dirOf('cwd'), { gh: issueGh(calls, key('a.test.ts', 'old')) })
      expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'open'], ctx)).toBe(0)
      expect(calls.filter((c) => c[0] === 'issue' && c[1] === 'create')).toHaveLength(1)
      expect(calls.filter((c) => c[0] === 'issue' && c[1] === 'close')).toEqual([])
      expect(out.join('')).toContain('issue actions: 1')
    })

    test('close applies only the closes', async () => {
      const { planDir, file } = mixed()
      const calls: string[][] = []
      const { ctx, out } = harness(dirOf('cwd'), { gh: issueGh(calls, key('a.test.ts', 'old')) })
      expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'close'], ctx)).toBe(0)
      expect(calls.filter((c) => c[0] === 'issue' && c[1] === 'create')).toEqual([])
      expect(calls.filter((c) => c[0] === 'issue' && c[1] === 'close' && c[2] === '7')).toHaveLength(1)
      expect(out.join('')).toContain('issue actions: 1')
    })
  })

  test('a failing gh fails the command', async () => {
    const previous = baselineOf(sha(1), {})
    const current = baselineOf(sha(2), {})
    const { planDir, file } = stageIssues(previous, current, null)
    const { ctx } = harness(dirOf('cwd'), { gh: brokenGh })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', file, '--only', 'open'], ctx)).toBe(1)
  })

  test('an unreadable baseline file fails the command', async () => {
    const planDir = dirOf('plan')
    writePlan(planDir, planOf({ event: 'push' }))
    const { ctx } = harness(dirOf('cwd'), { gh: forbiddenGh })
    expect(await runCli(['issues', '--plan', planDir, '--baseline', join(root, 'missing.json'), '--only', 'open'], ctx)).toBe(1)
  })
})

describe('affected', () => {
  const A = 'plugins/x/test/a.test.ts'
  const IMPORTS = 'plugins/test/imports.test.ts'

  function setup(withBaseline: Baseline | 'none' | 'down' = 'none') {
    const { dir, base } = makeRepo()
    let gh: GhRunner = artifactsGh([])
    if (withBaseline === 'down') gh = brokenGh
    else if (withBaseline !== 'none') {
      seedBaseline(dir, { ...withBaseline, commit: base })
      gh = artifactsGh([base])
    }
    put(dir, 'plugins/x/src/a.ts', 'export const a = 2\n')
    return { dir, base, gh }
  }

  test('--list prints the selection from the working tree, untracked files included, and runs nothing', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    put(dir, 'plugins/y/test/new.test.ts', 'export {}\n')
    const { ctx, out } = harness(dir, { gh, run: fakeRun({}) })
    expect(await runCli(['affected', '--list'], ctx)).toBe(0)
    const lines = out.join('').trim().split('\n')
    expect(lines).toEqual(expect.arrayContaining([A, IMPORTS, 'plugins/y/test/b.test.ts', 'plugins/y/test/new.test.ts']))
    expect(lines).not.toContain('packages/p/test/p.test.ts')
  })

  describe('a test file deleted from the working tree but not staged', () => {
    const B = 'plugins/y/test/b.test.ts'
    const bKey = key(B, 'works')

    test('is not selected, including by the run-everything fallback', async () => {
      const { dir, gh } = setup(baselineOf(sha(0), { [bKey]: 'passed' }))
      rmSync(join(dir, B))
      const withBaseline = harness(dir, { gh, run: fakeRun({}) })
      expect(await runCli(['affected', '--list'], withBaseline.ctx)).toBe(0)
      expect(withBaseline.out.join('')).toContain(A)
      expect(withBaseline.out.join('')).not.toContain(B)

      git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
      const fallback = harness(dir, { gh: brokenGh, run: fakeRun({}) })
      expect(await runCli(['affected', '--list'], fallback.ctx)).toBe(0)
      expect(fallback.out.join('').trim().split('\n')).toEqual([IMPORTS, A, 'packages/p/test/p.test.ts'].sort())
    })

    test('is never run and its baseline tests are reported missing', async () => {
      const { dir, gh } = setup(baselineOf(sha(0), { [bKey]: 'passed' }))
      rmSync(join(dir, B))
      const calls: Calls = { files: [], active: 0, maxActive: 0 }
      const run = fakeRun({ [A]: [{ ok: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] }, calls)
      const { ctx, out } = harness(dir, { gh, run })
      expect(await runCli(['affected', '--json'], ctx)).toBe(0)
      expect(calls.files).not.toContain(B)
      expect((JSON.parse(out.join('')) as Verdict).missing).toEqual([bKey])
    })
  })

  test('--list --json prints the selection as JSON', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    const { ctx, out } = harness(dir, { gh, run: fakeRun({}) })
    expect(await runCli(['affected', '--list', '--json'], ctx)).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({ mode: 'some', files: [IMPORTS, A] })
  })

  test('an untracked source file selects its area', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    put(dir, 'packages/p/src/extra.ts', 'export const extra = 1\n')
    const { ctx, out } = harness(dir, { gh, run: fakeRun({}) })
    expect(await runCli(['affected', '--list'], ctx)).toBe(0)
    expect(out.join('')).toContain('packages/p/test/p.test.ts')
  })

  test('labels results against the baseline, prints advisory, and exits 1 on a new failure', async () => {
    const { dir, gh } = setup(baselineOf(sha(0), { [key(A, 'old')]: 'failed' }))
    const run = fakeRun({ [A]: [{ old: 'fail', fresh: 'fail' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected'], ctx)).toBe(1)
    const text = out.join('')
    expect(text).toContain(`new: ${A} > fresh`)
    expect(text).toContain(`known: ${A} > old`)
    expect(text).toMatch(/^advisory: 1 new failure, 1 known failure, 0 flaky, against baseline [0-9a-f]{7}$/m)
  })

  test('exits 0 when only known failures remain', async () => {
    const { dir, gh } = setup(baselineOf(sha(0), { [key(A, 'old')]: 'failed' }))
    const run = fakeRun({ [A]: [{ old: 'fail' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(out.join('')).toContain('advisory:')
  })

  test('--json prints the advisory verdict and still exits 1 on a new failure', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    const run = fakeRun({ [A]: [{ fresh: 'fail' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected', '--json'], ctx)).toBe(1)
    const verdict = JSON.parse(out.join('')) as Verdict
    expect(verdict.advisory).toBe(true)
    expect(verdict.new).toEqual([key(A, 'fresh')])
    expect(verdict.notOnCi).toEqual([])
  })

  test('a flaky failure that passes on rerun does not block', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    const run = fakeRun({ [A]: [{ t: 'fail' }, { t: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(out.join('')).toContain(`flaky: ${A} > t`)
  })

  test('--jobs overrides how many files run at once', async () => {
    const { dir, gh } = setup(baselineOf(sha(0)))
    put(dir, 'plugins/y/test/c.test.ts', 'export {}\n')
    const everything = {
      [A]: [{ ok: 'pass' as const }],
      [IMPORTS]: [{ ok: 'pass' as const }],
      'plugins/y/test/b.test.ts': [{ ok: 'pass' as const }],
      'plugins/y/test/c.test.ts': [{ ok: 'pass' as const }],
    }
    const one: Calls = { files: [], active: 0, maxActive: 0 }
    expect(await runCli(['affected', '--jobs', '1'], harness(dir, { gh, run: fakeRun(everything, one) }).ctx)).toBe(0)
    const dflt: Calls = { files: [], active: 0, maxActive: 0 }
    expect(await runCli(['affected'], harness(dir, { gh, run: fakeRun(everything, dflt) }).ctx)).toBe(0)
    const four: Calls = { files: [], active: 0, maxActive: 0 }
    expect(await runCli(['affected', '--jobs', '4'], harness(dir, { gh, run: fakeRun(everything, four) }).ctx)).toBe(0)
    expect([one.maxActive, dflt.maxActive, four.maxActive]).toEqual([1, 2, 4])
  })

  test('with no selected tests it says so and exits 0', async () => {
    const { dir, base } = makeRepo()
    seedBaseline(dir, baselineOf(base))
    put(dir, 'docs/readme.md', '# changed\n')
    const { ctx, out } = harness(dir, { gh: artifactsGh([base]), run: fakeRun({}) })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(out.join('')).toContain('No tests were needed')
  })

  test('when the baseline is unavailable it says so, selects from the merge base and treats every failure as new', async () => {
    const { dir, gh } = setup('down')
    const run = fakeRun({ [A]: [{ old: 'fail' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out, err } = harness(dir, { gh, run })
    expect(await runCli(['affected'], ctx)).toBe(1)
    expect(err.join('')).toContain('baseline unavailable')
    expect(err.join('')).toContain('merge base')
    expect(out.join('')).toContain(`new: ${A} > old`)
    expect(out.join('')).toMatch(/^advisory: 1 new failure, 0 known failures, 0 flaky, no baseline$/m)
  })

  test('with no baseline artifact at all it also selects from the merge base with no baseline', async () => {
    const { dir, gh } = setup('none')
    const run = fakeRun({ [A]: [{ ok: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(out.join('')).toContain('no baseline')
  })

  test('--json keeps stdout parseable when the baseline is unavailable', async () => {
    const { dir, gh } = setup('down')
    const run = fakeRun({ [A]: [{ ok: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, out } = harness(dir, { gh, run })
    expect(await runCli(['affected', '--json'], ctx)).toBe(0)
    expect((JSON.parse(out.join('')) as Verdict).baseline).toBeNull()
  })

  test('without GITHUB_REPOSITORY or an origin remote the baseline is unavailable', async () => {
    const { dir } = setup('none')
    const run = fakeRun({ [A]: [{ ok: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx, err } = harness(dir, { env: {}, gh: forbiddenGh, run })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(err.join('')).toContain('baseline unavailable')
  })

  test('reads the repository from an origin remote when GITHUB_REPOSITORY is unset', async () => {
    const { dir, base } = setup(baselineOf(sha(0)))
    git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/quirky.git')
    const calls: string[][] = []
    const run = fakeRun({ [A]: [{ ok: 'pass' }], [IMPORTS]: [{ ok: 'pass' }] })
    const { ctx } = harness(dir, { env: {}, gh: artifactsGh([base], calls), run })
    expect(await runCli(['affected'], ctx)).toBe(0)
    expect(calls[0].join(' ')).toContain('repos/acme/quirky/actions/artifacts')
  })
})
