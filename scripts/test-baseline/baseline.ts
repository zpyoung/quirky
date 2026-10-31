import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Baseline, FileResult, GhRunner, TestStatus } from './types'

const ARTIFACT_NAME = /^test-baseline-([0-9a-f]{40})$/
const WALK_LIMIT = 500
const FLAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Thrown when a baseline can't be located or used because `gh` failed or a download was unusable. A missing baseline is not an error; `findBaseline` returns null for that. */
export class BaselineUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BaselineUnavailable'
  }
}

/** The real `gh`. Resolves with stdout and rejects, carrying stderr, on a non-zero exit. */
export const defaultGh: GhRunner = async (args) => {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout
}

function git(cwd: string, args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

type Listed = { id: number; createdAt: string }

function publishedByMain(run: unknown, commit: string): boolean {
  if (!run || typeof run !== 'object') return false
  const { head_branch, head_sha, repository_id, head_repository_id } = run as Record<string, unknown>
  return head_branch === 'main' && head_sha === commit && repository_id != null && head_repository_id === repository_id
}

async function listBaselines(repo: string, gh: GhRunner): Promise<Map<string, Listed>> {
  let output: string
  try {
    output = await gh([
      'api',
      '--paginate',
      `repos/${repo}/actions/artifacts?per_page=100`,
      '--jq',
      '.artifacts[] | {id, name, expired, created_at, workflow_run}',
    ])
  } catch (error) {
    throw new BaselineUnavailable(`could not list artifacts for ${repo}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
  const newest = new Map<string, Listed>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    let artifact: { id?: unknown; name?: unknown; expired?: unknown; created_at?: unknown; workflow_run?: unknown }
    try {
      artifact = JSON.parse(line)
    } catch (error) {
      throw new BaselineUnavailable(`unreadable artifact listing for ${repo}`, { cause: error })
    }
    const commit = typeof artifact.name === 'string' ? ARTIFACT_NAME.exec(artifact.name)?.[1] : undefined
    if (!commit || artifact.expired === true || typeof artifact.id !== 'number') continue
    if (!publishedByMain(artifact.workflow_run, commit)) continue
    const createdAt = typeof artifact.created_at === 'string' ? artifact.created_at : ''
    const current = newest.get(commit)
    if (!current || createdAt > current.createdAt || (createdAt === current.createdAt && artifact.id > current.id)) {
      newest.set(commit, { id: artifact.id, createdAt })
    }
  }
  return newest
}

/**
 * Finds the nearest first-parent ancestor of `head` on main that has a stored baseline, looking back at most 500 commits.
 * A baseline counts only when it was published by a run on this repository's main at that commit; artifacts from
 * forks, other branches or another commit's run are ignored.
 * The walk starts at the merge base of `head` and `origin/main`, or at `head`'s first parent when `fromParent` is set
 * (a push, so a run never finds itself). Returns null when nothing matches, when there is no merge base, or when
 * `fromParent` is set on a commit with no parent. Throws `BaselineUnavailable` when `gh` fails.
 */
export async function findBaseline(opts: {
  cwd: string
  head: string
  repo: string
  gh?: GhRunner
  fromParent?: boolean
}): Promise<{ commit: string; artifactId: number } | null> {
  const start = opts.fromParent ? git(opts.cwd, ['rev-parse', '--verify', '--quiet', `${opts.head}^`]) : git(opts.cwd, ['merge-base', opts.head, 'origin/main'])
  if (!start) return null
  const listed = await listBaselines(opts.repo, opts.gh ?? defaultGh)
  if (listed.size === 0) return null
  const walk = git(opts.cwd, ['rev-list', '--first-parent', '-n', String(WALK_LIMIT), start])
  if (walk === null) return null
  for (const commit of walk.split('\n')) {
    const found = listed.get(commit)
    if (found) return { commit, artifactId: found.id }
  }
  return null
}

function parseBaseline(text: string): Baseline | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && value.version === 1 ? (value as Baseline) : null
  } catch {
    return null
  }
}

async function downloadWithGh(args: string[], dest: string): Promise<void> {
  const proc = Bun.spawn(['gh', ...args], { stdout: Bun.file(dest), stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
}

/**
 * Loads the baseline `findBaseline` returned. A copy cached at `<git common dir>/test-baseline/<commit>.json` is used
 * when valid; otherwise the artifact zip is downloaded, `baseline.json` is extracted with the system `unzip`, checked for
 * `version: 1` and for a `commit` equal to `found.commit`, and cached. A cached copy that fails either check is
 * downloaded again. Throws `BaselineUnavailable` for a failed download, a missing or unreadable `baseline.json`,
 * a wrong version or a baseline recorded for a different commit. `gh` is accepted for symmetry with `findBaseline` but unused, since a zip can't pass through a
 * `GhRunner`; `download` receives the `gh` arguments and a path to write the zip to.
 */
export async function fetchBaseline(
  found: { commit: string; artifactId: number },
  opts: { cwd: string; repo: string; gh?: GhRunner; download?: (args: string[], dest: string) => Promise<void> },
): Promise<Baseline> {
  const common = git(opts.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new BaselineUnavailable(`${opts.cwd} is not in a git repository`)
  const cacheDir = join(common, 'test-baseline')
  const cached = join(cacheDir, `${found.commit}.json`)
  if (existsSync(cached)) {
    const hit = parseBaseline(readFileSync(cached, 'utf8'))
    if (hit && hit.commit === found.commit) return hit
  }

  mkdirSync(cacheDir, { recursive: true })
  const scratch = mkdtempSync(join(cacheDir, 'download-'))
  try {
    const zip = join(scratch, 'artifact.zip')
    try {
      await (opts.download ?? downloadWithGh)(['api', `repos/${opts.repo}/actions/artifacts/${found.artifactId}/zip`], zip)
    } catch (error) {
      throw new BaselineUnavailable(`could not download artifact ${found.artifactId}: ${error instanceof Error ? error.message : error}`, { cause: error })
    }
    const unzipped = Bun.spawnSync(['unzip', '-p', zip, 'baseline.json'])
    if (unzipped.exitCode !== 0) {
      throw new BaselineUnavailable(`artifact ${found.artifactId} has no readable baseline.json: ${unzipped.stderr.toString().trim()}`)
    }
    const baseline = parseBaseline(unzipped.stdout.toString())
    if (!baseline) throw new BaselineUnavailable(`artifact ${found.artifactId} holds an unreadable or unsupported baseline.json`)
    if (baseline.commit !== found.commit) {
      throw new BaselineUnavailable(`artifact ${found.artifactId} holds a baseline for ${baseline.commit}, not ${found.commit}`)
    }
    const staged = join(scratch, 'baseline.json')
    writeFileSync(staged, JSON.stringify(baseline))
    renameSync(staged, cached)
    return baseline
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Turns one complete run into the record stored for its commit. A test's status is its rerun's when the file was rerun,
 * otherwise its first attempt's; a test that failed first and is missing from or skipped in the rerun stays failed. A file
 * is flaky when a test in it failed first and passed in the rerun, or when a first-attempt `fileError` was cleared by the
 * rerun, whatever else in the file kept failing. A file whose rerun fixed nothing is not flaky. `flakeHistory` carries forward from `previous`, gains
 * `now` for each flaky file, and keeps only dates within 7 days of `now`.
 */
export function buildBaseline(input: { commit: string; runId: string; results: FileResult[]; previous: Baseline | null; now: Date }): Baseline {
  const files: Baseline['files'] = {}
  const tests: Record<string, TestStatus> = {}
  const flakyFiles: string[] = []

  for (const result of input.results) {
    const last = result.rerun ?? result.first
    const firstFailed = new Set(result.first.tests.filter((t) => t.status === 'failed').map((t) => t.key))
    const recovered = result.rerun?.tests.some((t) => t.status === 'passed' && firstFailed.has(t.key)) ?? false
    const errorCleared = result.first.fileError !== null && result.rerun !== undefined && result.rerun.fileError === null
    const flaky = recovered || errorCleared
    if (flaky) flakyFiles.push(result.file)
    files[result.file] = { platform: result.platform, durationMs: result.durationMs, fileError: last.fileError, flaky }
    for (const test of result.first.tests) tests[test.key] = test.status
    for (const test of result.rerun?.tests ?? []) {
      tests[test.key] = firstFailed.has(test.key) && test.status === 'skipped' ? 'failed' : test.status
    }
  }

  const nowIso = input.now.toISOString()
  const cutoff = input.now.getTime() - FLAKE_WINDOW_MS
  const merged: Record<string, string[]> = {}
  for (const [file, dates] of Object.entries(input.previous?.flakeHistory ?? {})) merged[file] = [...dates]
  for (const file of flakyFiles) (merged[file] ??= []).push(nowIso)
  const flakeHistory: Record<string, string[]> = {}
  for (const [file, dates] of Object.entries(merged)) {
    const recent = dates.filter((date) => Date.parse(date) >= cutoff)
    if (recent.length > 0) flakeHistory[file] = recent
  }

  return { version: 1, commit: input.commit, createdAt: nowIso, runId: input.runId, files, tests, flakeHistory }
}
