import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Baseline, FileResult, GhRunner, TestStatus } from './types'

const ARTIFACT_NAME = /^test-baseline-([0-9a-f]{40})$/
const WALK_LIMIT = 500
const FLAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export type BaselineArtifact<T extends { commit: string }> = {
  name: RegExp
  entry: string
  cacheNamespace: string
  validate(value: unknown): T | null
  maxJsonBytes?: number
  source?: { event: 'push'; workflowPath: '.github/workflows/tests.yml' }
}

export type FindOptions = { cwd: string; head: string; repo: string; gh?: GhRunner; fromParent?: boolean }
export type ArtifactFindOptions = FindOptions & {
  artifact?: Pick<BaselineArtifact<{ commit: string }>, 'name' | 'source'>
}
export type Found = { commit: string; artifactId: number }
export type FetchOptions = {
  cwd: string
  repo: string
  gh?: GhRunner
  download?: (args: string[], dest: string) => Promise<void>
}

type ArtifactSource = NonNullable<BaselineArtifact<{ commit: string }>['source']>

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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function publishedByMain(run: unknown, commit: string): boolean {
  const value = record(run)
  if (!value) return false
  const repositoryId = value.repository_id ?? record(value.repository)?.id
  const headRepositoryId = value.head_repository_id ?? record(value.head_repository)?.id
  return value.head_branch === 'main' && value.head_sha === commit && repositoryId != null && headRepositoryId === repositoryId
}

async function publishedBySource(repo: string, runId: number, commit: string, source: ArtifactSource, gh: GhRunner): Promise<boolean> {
  let output: string
  try {
    output = await gh([
      'api',
      `repos/${repo}/actions/runs/${runId}`,
      '--jq',
      '{id, event, path, head_branch, head_sha, repository_id: .repository.id, head_repository_id: .head_repository.id}',
    ])
  } catch (error) {
    throw new BaselineUnavailable(`could not verify workflow run ${runId} for ${repo}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }

  let run: unknown
  try {
    run = JSON.parse(output)
  } catch (error) {
    throw new BaselineUnavailable(`unreadable workflow run ${runId} for ${repo}`, { cause: error })
  }
  const value = record(run)
  return value?.id === runId
    && value.event === source.event
    && value.path === source.workflowPath
    && publishedByMain(value, commit)
}

function matchingCommit(name: unknown, pattern: RegExp): string | undefined {
  if (typeof name !== 'string') return undefined
  pattern.lastIndex = 0
  const commit = pattern.exec(name)?.[1]
  pattern.lastIndex = 0
  return commit
}

async function listBaselines(repo: string, gh: GhRunner, artifact: Pick<BaselineArtifact<{ commit: string }>, 'name' | 'source'>, candidateCommits: ReadonlySet<string>): Promise<Map<string, Listed>> {
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
  const sourceRuns = new Map<string, Promise<boolean>>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    let listed: { id?: unknown; name?: unknown; expired?: unknown; created_at?: unknown; workflow_run?: unknown }
    try {
      listed = JSON.parse(line)
    } catch (error) {
      throw new BaselineUnavailable(`unreadable artifact listing for ${repo}`, { cause: error })
    }
    const commit = matchingCommit(listed.name, artifact.name)
    if (!commit || !candidateCommits.has(commit) || listed.expired === true || typeof listed.id !== 'number') continue
    const workflowRun = record(listed.workflow_run)
    if (artifact.source) {
      const runId = workflowRun?.id
      if (typeof runId !== 'number') continue
      const sourceKey = `${runId}:${commit}`
      let trusted = sourceRuns.get(sourceKey)
      if (!trusted) {
        trusted = publishedBySource(repo, runId, commit, artifact.source, gh)
        sourceRuns.set(sourceKey, trusted)
      }
      if (!await trusted) continue
    } else if (!publishedByMain(workflowRun, commit)) {
      continue
    }
    const createdAt = typeof listed.created_at === 'string' ? listed.created_at : ''
    const current = newest.get(commit)
    if (!current || createdAt > current.createdAt || (createdAt === current.createdAt && listed.id > current.id)) {
      newest.set(commit, { id: listed.id, createdAt })
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
export async function findBaseline(opts: ArtifactFindOptions): Promise<Found | null> {
  return (await findBaselines(opts, 1))[0] ?? null
}

/** Up to `limit` baselines along the same walk as `findBaseline`, nearest first; the first is the one `findBaseline` returns. */
export async function findBaselines(opts: ArtifactFindOptions, limit: number): Promise<Found[]> {
  if (limit <= 0) return []
  const start = opts.fromParent ? git(opts.cwd, ['rev-parse', '--verify', '--quiet', `${opts.head}^`]) : git(opts.cwd, ['merge-base', opts.head, 'origin/main'])
  if (!start) return []
  const walk = git(opts.cwd, ['rev-list', '--first-parent', '-n', String(WALK_LIMIT), start])
  if (walk === null) return []
  const commits = new Set(walk.split('\n'))
  const listed = await listBaselines(opts.repo, opts.gh ?? defaultGh, opts.artifact ?? { name: ARTIFACT_NAME }, commits)
  if (listed.size === 0) return []
  const found: Found[] = []
  for (const commit of walk.split('\n')) {
    const hit = listed.get(commit)
    if (hit) found.push({ commit, artifactId: hit.id })
    if (found.length >= limit) break
  }
  return found
}

function parseBaseline(value: unknown): Baseline | null {
  const parsed = record(value)
  return parsed?.version === 1 ? parsed as Baseline : null
}

const TEST_ARTIFACT: BaselineArtifact<Baseline> = {
  name: ARTIFACT_NAME,
  entry: 'baseline.json',
  cacheNamespace: 'test-baseline',
  validate: parseBaseline,
}

export function parseArtifactJson(text: string): unknown {
  const parsed = JSON.parse(text) as unknown
  type Frame = { kind: 'array' } | { kind: 'object'; keys: Set<string>; expectingKey: boolean }
  const stack: Frame[] = []

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      let end = index + 1
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2
        } else if (text[end] === '"') {
          break
        } else {
          end++
        }
      }
      const frame = stack[stack.length - 1]
      if (frame?.kind === 'object' && frame.expectingKey) {
        const key = JSON.parse(text.slice(index, end + 1)) as string
        if (frame.keys.has(key)) throw new SyntaxError(`duplicate JSON object key ${JSON.stringify(key)}`)
        frame.keys.add(key)
        frame.expectingKey = false
      }
      index = end
    } else if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), expectingKey: true })
    } else if (char === '[') {
      stack.push({ kind: 'array' })
    } else if (char === '}' || char === ']') {
      stack.pop()
    } else if (char === ',') {
      const frame = stack[stack.length - 1]
      if (frame?.kind === 'object') frame.expectingKey = true
    }
  }
  return parsed
}

function validateArtifact<T extends { commit: string }>(text: string, artifact: BaselineArtifact<T>): T | null {
  try {
    const value = artifact === TEST_ARTIFACT ? JSON.parse(text) : parseArtifactJson(text)
    return artifact.validate(value)
  } catch {
    return null
  }
}

function readCached<T extends { commit: string }>(path: string, commit: string, artifact: BaselineArtifact<T>): T | null {
  try {
    if (artifact.maxJsonBytes !== undefined && statSync(path).size > artifact.maxJsonBytes) return null
    const cached = validateArtifact(readFileSync(path, 'utf8'), artifact)
    return cached?.commit === commit ? cached : null
  } catch {
    return null
  }
}

async function downloadWithGh(args: string[], dest: string): Promise<void> {
  const proc = Bun.spawn(['gh', ...args], { stdout: Bun.file(dest), stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
}

async function readZipEntry(zip: string, entry: string, maxBytes?: number): Promise<string> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new BaselineUnavailable(`invalid JSON size limit for ${entry}`)
  }
  const proc = Bun.spawn(['unzip', '-p', zip, entry], { stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  const stderrPromise = new Response(proc.stderr).text()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (maxBytes !== undefined && size + value.byteLength > maxBytes) {
        proc.kill()
        await proc.exited
        await stderrPromise
        throw new BaselineUnavailable(`${entry} exceeds its ${maxBytes}-byte decompressed JSON limit`)
      }
      chunks.push(value)
      size += value.byteLength
    }
  } catch (error) {
    if (!(error instanceof BaselineUnavailable)) {
      try {
        proc.kill()
      } catch {}
      await proc.exited
      await stderrPromise
    }
    throw error
  } finally {
    reader.releaseLock()
  }

  const [stderr, code] = await Promise.all([stderrPromise, proc.exited])
  if (code !== 0) throw new BaselineUnavailable(`could not read archive entry ${entry}: ${stderr.trim()}`)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Loads a listed baseline from its cache or artifact entry. Non-default descriptors key caches by commit and selected
 * artifact ID; the default unit cache remains keyed by commit. Both paths validate the value and its commit.
 */
export function fetchBaseline<T extends { commit: string }>(
  found: Found,
  opts: FetchOptions & { artifact: BaselineArtifact<T> },
): Promise<T>
export function fetchBaseline(found: Found, opts: FetchOptions): Promise<Baseline>
export async function fetchBaseline<T extends { commit: string }>(
  found: Found,
  opts: FetchOptions & { artifact?: BaselineArtifact<T> },
): Promise<T | Baseline> {
  const artifact = opts.artifact ?? TEST_ARTIFACT
  const common = git(opts.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new BaselineUnavailable(`${opts.cwd} is not in a git repository`)
  const cacheDir = join(common, artifact.cacheNamespace)
  const cacheName = `${found.commit}${opts.artifact ? `-${found.artifactId}` : ''}.json`
  const cached = join(cacheDir, cacheName)
  if (existsSync(cached)) {
    const hit = readCached(cached, found.commit, artifact)
    if (hit) return hit
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
    const text = await readZipEntry(zip, artifact.entry, artifact.maxJsonBytes)
    const value = validateArtifact(text, artifact)
    if (!value) throw new BaselineUnavailable(`artifact ${found.artifactId} holds an unreadable or unsupported ${artifact.entry}`)
    if (value.commit !== found.commit) {
      throw new BaselineUnavailable(`artifact ${found.artifactId} holds a baseline for ${value.commit}, not ${found.commit}`)
    }
    const staged = join(scratch, 'baseline.json')
    writeFileSync(staged, JSON.stringify(value))
    renameSync(staged, cached)
    return value
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
