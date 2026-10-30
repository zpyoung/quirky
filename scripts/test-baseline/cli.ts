import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { bunTestFile } from '../suite'
import { BaselineUnavailable, buildBaseline, defaultGh, fetchBaseline, findBaseline } from './baseline'
import { compareResults } from './compare'
import { applyIssueActions, planIssues, readOpenIssues } from './issues'
import { renderComment, renderLocal } from './report'
import { findSpawners, selectTests } from './select'
import { MAX_SHARDS_MAIN, MAX_SHARDS_PR, SHARD_TARGET_MS, splitShards } from './shards'
import type { Attempt, Baseline, ChangedPath, FileResult, GhRunner, Plan, Selection, Verdict } from './types'

const USAGE = `usage: bun scripts/test-baseline/cli.ts <command> [options]

  plan       --event <pull_request|push|workflow_dispatch> --out <dir>
  run-shard  --plan <dir> (--shard <index> | --macos) --out <file>
  rerun      --plan <dir> --in <dir> --out <file>
  verdict    --plan <dir> --in <dir> --out <dir> --jobs-ok <true|false>
  issues     --plan <dir> --baseline <file> --only <open|close>
  affected   [--json] [--jobs <n>] [--list]
`

const EVENTS = ['pull_request', 'push', 'workflow_dispatch']
const NOT_ON_CI_LIST = 'scripts/test-not-on-ci.txt'
const MACOS_LIST = 'scripts/test-on-macos.txt'
const RERUN_FILE = 'rerun.json'

/**
 * What the commands touch outside their arguments. Tests replace `gh`, the clock, the process
 * environment and the test runner; the real process supplies all of them by default.
 */
export type Context = {
  cwd: string
  env: Record<string, string | undefined>
  gh: GhRunner
  now: () => Date
  out: (text: string) => void
  err: (text: string) => void
  run?: typeof bunTestFile
  download?: (args: string[], dest: string) => Promise<void>
}

/** A bad command line. `runCli` answers it with the usage text and exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

function defaultContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    gh: defaultGh,
    now: () => new Date(),
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  }
}

type Options = Record<string, { type: 'string' | 'boolean' }>

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function need(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new UsageError(`missing --${name}`)
  return value
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function gitOrNull(cwd: string, args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function repoOf(ctx: Context): string {
  const fromEnv = ctx.env.GITHUB_REPOSITORY
  if (fromEnv) return fromEnv
  const url = gitOrNull(ctx.cwd, ['remote', 'get-url', 'origin'])
  const match = url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)
  if (match) return match[1]
  throw new BaselineUnavailable('cannot tell which GitHub repository this is; set GITHUB_REPOSITORY')
}

function headOf(ctx: Context): string {
  return ctx.env.GITHUB_SHA || git(ctx.cwd, ['rev-parse', 'HEAD']).trim()
}

function changesBetween(cwd: string, base: string, head: string | null): ChangedPath[] {
  const tokens = git(cwd, ['diff', '--name-status', '--no-renames', '-z', base, ...(head ? [head] : [])]).split('\0')
  const changed: ChangedPath[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i][0] === 'A' ? 'A' : tokens[i][0] === 'D' ? 'D' : 'M'
    changed.push({ path: tokens[i + 1], status })
  }
  return changed
}

function untrackedFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean)
}

type Selected = { selection: Selection; graphMisses: number }

/** The test files that exist in the working tree; `discover` also lists tracked files deleted but not yet staged. */
async function presentTests(ctx: Context): Promise<string[]> {
  const { discover } = await import('../suite')
  return discover(ctx.cwd, []).filter((file) => existsSync(join(ctx.cwd, file)))
}

/** Builds the import graph over `codeFiles` and selects tests for `changed`. Needs `bun install` to have run. */
async function selectFrom(ctx: Context, changed: ChangedPath[], codeFiles: string[]): Promise<Selected> {
  const { buildImportGraph } = await import('./graph')
  const graph = buildImportGraph(ctx.cwd, codeFiles)
  const testFiles = await presentTests(ctx)
  const spawners = findSpawners(graph, testFiles, (path) => readFileSync(join(ctx.cwd, path), 'utf8'))
  return { selection: selectTests({ changed, testFiles, graph, spawners }), graphMisses: graph.misses }
}

async function allTests(ctx: Context, reason: string): Promise<Selection> {
  return { mode: 'all', files: await presentTests(ctx), reasons: [reason] }
}

async function deletedTests(changed: ChangedPath[]): Promise<string[]> {
  const { TEST_FILE } = await import('../suite')
  return changed.filter((change) => change.status === 'D' && TEST_FILE.test(change.path)).map((change) => change.path)
}

function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function writeJson(path: string, value: unknown) {
  writeText(path, JSON.stringify(value, null, 2) + '\n')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

function asPlan(value: unknown): Plan {
  if (
    isRecord(value) &&
    typeof value.event === 'string' &&
    isRecord(value.selection) &&
    isStrings(value.selection.files) &&
    isStrings(value.deleted) &&
    isStrings(value.notOnCi) &&
    isStrings(value.macos) &&
    Array.isArray(value.linuxShards) &&
    value.linuxShards.every(isStrings)
  ) {
    return value as Plan
  }
  throw new Error('plan.json does not hold a plan')
}

function readPlan(dir: string): Plan {
  try {
    return asPlan(readJson(join(dir, 'plan.json')))
  } catch (error) {
    throw new Error(`cannot read ${join(dir, 'plan.json')}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
}

function asBaseline(value: unknown): Baseline {
  if (isRecord(value) && value.version === 1 && typeof value.commit === 'string' && isRecord(value.tests) && isRecord(value.files)) {
    return { flakeHistory: {}, ...value } as Baseline
  }
  throw new Error('not a baseline')
}

const FILE_ERRORS = [null, 'timeout', 'no-report', 'exit-mismatch']
const TEST_STATUSES = ['passed', 'failed', 'skipped']

const isTestResult = (value: unknown): boolean => isRecord(value) && typeof value.key === 'string' && TEST_STATUSES.includes(value.status as string)

const isAttempt = (value: unknown): value is Attempt =>
  isRecord(value) && typeof value.exitCode === 'number' && FILE_ERRORS.includes(value.fileError as string | null) && Array.isArray(value.tests) && value.tests.every(isTestResult)

const isFileResult = (value: unknown): value is FileResult =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  (value.platform === 'linux' || value.platform === 'macos') &&
  typeof value.durationMs === 'number' &&
  isAttempt(value.first) &&
  (value.rerun === undefined || isAttempt(value.rerun))

function asResults(value: unknown): FileResult[] {
  if (Array.isArray(value) && value.every(isFileResult)) return value
  throw new Error('not a list of file results')
}

function jsonFilesIn(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...jsonFilesIn(path))
    else if (entry.name.endsWith('.json')) found.push(path)
  }
  return found.sort()
}

type Loaded = { results: FileResult[]; rerun: FileResult[]; problems: string[] }

function loadResults(dir: string): Loaded {
  const loaded: Loaded = { results: [], rerun: [], problems: [] }
  let paths: string[]
  try {
    paths = jsonFilesIn(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return loaded
    loaded.problems.push(`cannot list ${dir}: ${error instanceof Error ? error.message : error}`)
    return loaded
  }
  for (const path of paths) {
    try {
      const list = asResults(readJson(path))
      if (path.split('/').pop() === RERUN_FILE) loaded.rerun.push(...list)
      else loaded.results.push(...list)
    } catch (error) {
      loaded.problems.push(`cannot read ${path}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return loaded
}

async function planCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { event: { type: 'string' }, out: { type: 'string' } })
  const event = need(values.event, 'event')
  if (!EVENTS.includes(event)) throw new UsageError(`--event must be one of ${EVENTS.join(', ')}`)
  const outDir = need(values.out, 'out')

  const { macosOnly } = await import('../suite')
  const head = headOf(ctx)
  const repo = repoOf(ctx)
  const found = await findBaseline({ cwd: ctx.cwd, head, repo, gh: ctx.gh, fromParent: event !== 'pull_request' })
  const baseline = found ? await fetchBaseline(found, { cwd: ctx.cwd, repo, gh: ctx.gh, download: ctx.download }) : null

  let changed: ChangedPath[] = []
  let range: Selected | null = null
  if (found) {
    changed = changesBetween(ctx.cwd, found.commit, 'HEAD')
    const tracked = git(ctx.cwd, ['ls-files', '-z']).split('\0').filter(Boolean)
    range = await selectFrom(ctx, changed, tracked)
  }

  let selection: Selection
  if (event === 'pull_request') selection = range?.selection ?? (await allTests(ctx, 'no baseline found, so every test runs'))
  else selection = await allTests(ctx, `${event}: every test runs`)

  const notOnCiList = macosOnly(join(ctx.cwd, NOT_ON_CI_LIST))
  const macosList = macosOnly(join(ctx.cwd, MACOS_LIST))
  const notOnCi = selection.files.filter((file) => notOnCiList.has(file))
  const macos = selection.files.filter((file) => macosList.has(file) && !notOnCiList.has(file))
  const linux = selection.files.filter((file) => !macosList.has(file) && !notOnCiList.has(file))
  const durations = Object.fromEntries(Object.entries(baseline?.files ?? {}).map(([file, info]) => [file, info.durationMs]))
  const linuxShards = splitShards(linux, durations, { targetMs: SHARD_TARGET_MS, maxShards: event === 'pull_request' ? MAX_SHARDS_PR : MAX_SHARDS_MAIN })

  const plan: Plan = {
    event,
    head,
    baseline: baseline ? { commit: baseline.commit, createdAt: baseline.createdAt } : null,
    selection,
    rangeSelection: event === 'push' ? (range?.selection ?? null) : null,
    deleted: await deletedTests(changed),
    notOnCi,
    linuxShards,
    macos,
  }
  writeJson(join(outDir, 'plan.json'), plan)
  if (baseline) writeJson(join(outDir, 'baseline.json'), baseline)

  ctx.out(`selection: ${selection.mode}, ${selection.files.length} files, ${linuxShards.length} linux shards, ${macos.length} macos, ${notOnCi.length} not on ci\n`)
  for (const reason of selection.reasons) ctx.out(`  ${reason}\n`)
  if (plan.rangeSelection) for (const reason of plan.rangeSelection.reasons) ctx.out(`  range: ${reason}\n`)
  if (range && range.graphMisses > 0) ctx.out(`import graph misses: ${range.graphMisses}\n`)
  return 0
}

async function runShardCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { plan: { type: 'string' }, shard: { type: 'string' }, macos: { type: 'boolean' }, out: { type: 'string' } })
  const planDir = need(values.plan, 'plan')
  const out = need(values.out, 'out')
  if (Boolean(values.macos) === (values.shard !== undefined)) throw new UsageError('give exactly one of --shard and --macos')
  if (values.shard !== undefined && !/^\d+$/.test(values.shard)) throw new UsageError('--shard must be a shard index')

  const plan = readPlan(planDir)
  const files = values.macos ? plan.macos : plan.linuxShards[Number(values.shard)]
  if (!files) throw new UsageError(`--shard ${values.shard} is outside the plan's ${plan.linuxShards.length} shards`)

  const { FILE_LIMIT_MS, FILES_AT_ONCE_CI, RERUN_LIMIT, rerunFailed, runTestFiles } = await import('./runner')
  const options = { cwd: ctx.cwd, files, platform: values.macos ? ('macos' as const) : ('linux' as const), jobs: FILES_AT_ONCE_CI, limitMs: FILE_LIMIT_MS, run: ctx.run }
  let results = await runTestFiles(options)
  if (values.macos) {
    const rerun = await rerunFailed(options, results, RERUN_LIMIT)
    if (rerun.skipped) ctx.err(`more than ${RERUN_LIMIT} macos files failed, so none were rerun\n`)
    results = rerun.results
  }
  writeJson(out, results)
  ctx.out(`ran ${results.length} files\n`)
  return 0
}

async function rerunCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { plan: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' } })
  const planDir = need(values.plan, 'plan')
  const inDir = need(values.in, 'in')
  const out = need(values.out, 'out')
  readPlan(planDir)

  const loaded = loadResults(inDir)
  if (loaded.problems.length > 0) throw new Error(loaded.problems.join('\n'))
  const { FILE_LIMIT_MS, RERUN_LIMIT, rerunFailed } = await import('./runner')
  const rerun = await rerunFailed({ cwd: ctx.cwd, files: [], platform: 'linux', jobs: 1, limitMs: FILE_LIMIT_MS, run: ctx.run }, loaded.results, RERUN_LIMIT)
  if (rerun.skipped) ctx.err(`more than ${RERUN_LIMIT} files failed, so none were rerun\n`)
  const written = rerun.results.filter((result, index) => result.rerun !== undefined && loaded.results[index].rerun === undefined)
  writeJson(out, written)
  ctx.out(`reran ${written.length} files\n`)
  return 0
}

async function verdictCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { plan: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' }, 'jobs-ok': { type: 'string' } })
  const planDir = need(values.plan, 'plan')
  const inDir = need(values.in, 'in')
  const outDir = need(values.out, 'out')
  const jobsOk = need(values['jobs-ok'], 'jobs-ok')
  if (jobsOk !== 'true' && jobsOk !== 'false') throw new UsageError('--jobs-ok must be true or false')

  const problems: string[] = []
  if (jobsOk === 'false') problems.push('a job in the run failed or was cancelled')

  let plan: Plan
  try {
    plan = readPlan(planDir)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    plan = {
      event: ctx.env.GITHUB_EVENT_NAME || 'pull_request',
      head: ctx.env.GITHUB_SHA ?? '',
      baseline: null,
      selection: { mode: 'none', files: [], reasons: [] },
      rangeSelection: null,
      deleted: [],
      notOnCi: [],
      linuxShards: [],
      macos: [],
    }
  }

  let baseline: Baseline | null = null
  if (plan.baseline) {
    try {
      baseline = asBaseline(readJson(join(planDir, 'baseline.json')))
      if (baseline.commit !== plan.baseline.commit) throw new Error(`holds ${baseline.commit}, not ${plan.baseline.commit}`)
    } catch (error) {
      baseline = null
      problems.push(`cannot read the plan's baseline: ${error instanceof Error ? error.message : error}`)
    }
  }

  const loaded = loadResults(inDir)
  problems.push(...loaded.problems)
  const results = new Map<string, FileResult>(loaded.results.map((result) => [result.file, result]))
  for (const again of loaded.rerun) {
    const first = results.get(again.file)
    if (!first || !again.rerun) {
      problems.push(`${RERUN_FILE} holds ${again.file}, which has no first result`)
      continue
    }
    results.set(again.file, { ...first, rerun: again.rerun })
  }
  const merged = [...results.values()]

  const verdict = compareResults({
    baseline,
    results: merged,
    selection: plan.selection,
    deleted: plan.deleted,
    notOnCi: plan.notOnCi,
    advisory: false,
    runBroken: problems.length > 0,
  })

  writeText(join(outDir, 'comment.md'), renderComment(verdict, ctx.now()))
  writeJson(join(outDir, 'verdict.json'), verdict)
  const baselinePath = join(outDir, 'baseline.json')
  rmSync(baselinePath, { force: true })
  const complete = !verdict.runBroken && verdict.incomplete.length === 0
  if (plan.event === 'push' && complete && plan.selection.mode === 'all') {
    writeJson(baselinePath, buildBaseline({ commit: plan.head, runId: ctx.env.GITHUB_RUN_ID ?? '', results: merged, previous: baseline, now: ctx.now() }))
  }

  for (const problem of problems) ctx.err(`${problem}\n`)
  const lenient = plan.event === 'push' || plan.event === 'workflow_dispatch'
  const failed = lenient ? !complete : !verdict.ok
  ctx.out(`${verdict.ok ? 'ok' : 'not ok'}: ${verdict.new.length} new, ${verdict.known.length} known, ${verdict.flaky.length} flaky, ${verdict.incomplete.length} incomplete${verdict.runBroken ? ', run broken' : ''}\n`)
  return failed ? 1 : 0
}

/**
 * Plans issue actions from the baseline and applies only those of one kind, so the workflow can open
 * issues before publishing the baseline and close them only after the publish succeeded.
 */
async function issuesCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { plan: { type: 'string' }, baseline: { type: 'string' }, only: { type: 'string' } })
  const planDir = need(values.plan, 'plan')
  const only = need(values.only, 'only')
  if (only !== 'open' && only !== 'close') throw new UsageError('--only must be open or close')
  const current = asBaseline(readJson(need(values.baseline, 'baseline')))
  const plan = readPlan(planDir)
  const previous = plan.baseline ? asBaseline(readJson(join(planDir, 'baseline.json'))) : null
  const repo = repoOf(ctx)

  const openIssues = await readOpenIssues(ctx.gh, repo)
  const actions = planIssues({ previous, current, openIssues, rangeSelection: plan.rangeSelection, now: ctx.now() }).filter((action) => action.kind === only)
  await applyIssueActions(actions, ctx.gh, repo)
  ctx.out(`issue actions: ${actions.length}\n`)
  return 0
}

async function affectedCommand(args: string[], ctx: Context): Promise<number> {
  const values = parse(args, { json: { type: 'boolean' }, jobs: { type: 'string' }, list: { type: 'boolean' } })
  if (values.jobs !== undefined && !/^[1-9]\d*$/.test(values.jobs)) throw new UsageError('--jobs must be a positive integer')

  let baseline: Baseline | null = null
  let base: string | null = null
  try {
    const repo = repoOf(ctx)
    const found = await findBaseline({ cwd: ctx.cwd, head: headOf(ctx), repo, gh: ctx.gh })
    if (found) {
      baseline = await fetchBaseline(found, { cwd: ctx.cwd, repo, gh: ctx.gh, download: ctx.download })
      base = found.commit
    } else {
      ctx.err('no baseline found; selecting from the merge base with origin/main, and every failure counts as new\n')
    }
  } catch (error) {
    if (!(error instanceof BaselineUnavailable)) throw error
    ctx.err(`baseline unavailable: ${error.message}\nselecting from the merge base with origin/main, and every failure counts as new\n`)
  }
  base ??= gitOrNull(ctx.cwd, ['merge-base', 'HEAD', 'origin/main'])

  let changed: ChangedPath[] = []
  let selection: Selection
  if (base) {
    changed = [...changesBetween(ctx.cwd, base, null), ...untrackedFiles(ctx.cwd).map((path): ChangedPath => ({ path, status: 'A' }))]
    const codeFiles = git(ctx.cwd, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    selection = (await selectFrom(ctx, changed, codeFiles)).selection
  } else {
    selection = await allTests(ctx, 'no merge base with origin/main, so every test runs')
  }

  if (values.list) {
    ctx.out(values.json ? JSON.stringify(selection, null, 2) + '\n' : selection.files.map((file) => `${file}\n`).join(''))
    return 0
  }

  const { FILE_LIMIT_MS, FILES_AT_ONCE_LOCAL, RERUN_LIMIT, rerunFailed, runTestFiles } = await import('./runner')
  const options = {
    cwd: ctx.cwd,
    files: selection.files,
    platform: process.platform === 'darwin' ? ('macos' as const) : ('linux' as const),
    jobs: values.jobs ? Number(values.jobs) : FILES_AT_ONCE_LOCAL,
    limitMs: FILE_LIMIT_MS,
    run: ctx.run,
  }
  const first = await runTestFiles(options)
  const rerun = await rerunFailed(options, first, RERUN_LIMIT)
  if (rerun.skipped) ctx.err(`more than ${RERUN_LIMIT} files failed, so none were rerun\n`)

  const verdict: Verdict = compareResults({
    baseline,
    results: rerun.results,
    selection,
    deleted: await deletedTests(changed),
    notOnCi: [],
    advisory: true,
    runBroken: false,
  })
  ctx.out(values.json ? JSON.stringify(verdict, null, 2) + '\n' : renderLocal(verdict, ctx.now()))
  return verdict.new.length > 0 || verdict.incomplete.length > 0 ? 1 : 0
}

const COMMANDS: Record<string, (args: string[], ctx: Context) => Promise<number>> = {
  plan: planCommand,
  'run-shard': runShardCommand,
  rerun: rerunCommand,
  verdict: verdictCommand,
  issues: issuesCommand,
  affected: affectedCommand,
}

/**
 * Runs one subcommand and returns the process exit code: 0 or 1 as each command defines, 2 for a
 * bad command line (with usage on `ctx.err`), and 1 for any unexpected error so a broken step is
 * never silent. `runner`, `graph` and `suite.ts` are imported only by the commands that run or
 * select tests, so `verdict` and `issues` work without `bun install`.
 */
export async function runCli(argv: string[], ctx: Context = defaultContext()): Promise<number> {
  const [name, ...rest] = argv
  try {
    const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
    if (!command) throw new UsageError(name === undefined ? 'missing subcommand' : `unknown subcommand: ${name}`)
    return await command(rest, ctx)
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(`${error.message}\n${USAGE}`)
      return 2
    }
    ctx.err(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)))
