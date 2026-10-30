import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaselineUnavailable, buildBaseline, fetchBaseline, findBaseline } from './baseline'
import type { Attempt, Baseline, FileResult, GhRunner } from './types'

const REPO = 'acme/quirky'
const sha = (n: number) => n.toString(16).padStart(40, '0')

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commit(cwd: string, message: string): string {
  git(cwd, 'commit', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

type WorkflowRun = { id: number; repository_id: number; head_repository_id: number; head_branch: string; head_sha: string }
type Artifact = { id: number; name: string; expired?: boolean; created_at?: string; workflow_run?: Partial<WorkflowRun> | null }

function legitRun(name: string): WorkflowRun {
  return { id: 1, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: name.replace(/^test-baseline-/, '') }
}

function fakeGh(artifacts: Artifact[], calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args)
    return artifacts
      .map((a) => {
        const entry: Record<string, unknown> = { id: a.id, name: a.name, expired: a.expired ?? false, created_at: a.created_at ?? '2026-10-01T00:00:00Z' }
        if (a.workflow_run !== null) entry.workflow_run = { ...legitRun(a.name), ...a.workflow_run }
        return JSON.stringify(entry)
      })
      .join('\n')
  }
}

const root = mkdtempSync(join(tmpdir(), 'baseline-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let repoCounter = 0
function makeRepo(): { dir: string; main: string[]; branch: string[] } {
  const dir = join(root, `repo-${repoCounter++}`)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  const main = [commit(dir, 'm1'), commit(dir, 'm2'), commit(dir, 'm3')]
  git(dir, 'update-ref', 'refs/remotes/origin/main', main[2])
  git(dir, 'checkout', '-q', '-b', 'feature')
  const branch = [commit(dir, 'f1'), commit(dir, 'f2')]
  return { dir, main, branch }
}

describe('findBaseline', () => {
  test('walks from the merge base and returns the nearest ancestor with an artifact', async () => {
    const { dir, main, branch } = makeRepo()
    const gh = fakeGh([
      { id: 1, name: `test-baseline-${main[0]}` },
      { id: 2, name: `test-baseline-${main[1]}` },
      { id: 3, name: `test-baseline-${branch[0]}` },
    ])
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toEqual({ commit: main[1], artifactId: 2 })
  })

  test('lists artifacts through the paginated api for the repo', async () => {
    const { dir, branch } = makeRepo()
    const calls: string[][] = []
    await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh: fakeGh([], calls) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--paginate')
    expect(calls[0].some((a) => a.includes(`repos/${REPO}/actions/artifacts`))).toBe(true)
  })

  test('skips expired artifacts and names that are not a baseline', async () => {
    const { dir, main, branch } = makeRepo()
    const gh = fakeGh([
      { id: 1, name: `test-baseline-${main[2]}`, expired: true },
      { id: 2, name: `test-baseline-${main[2].slice(0, 39)}` },
      { id: 3, name: `test-baseline-${main[2]}-extra` },
      { id: 4, name: `other-test-baseline-${main[2]}` },
      { id: 5, name: `test-baseline-${main[1].toUpperCase()}` },
      { id: 6, name: `test-baseline-${main[0]}` },
    ])
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toEqual({ commit: main[0], artifactId: 6 })
  })

  test('takes the newest artifact for one commit', async () => {
    const { dir, main, branch } = makeRepo()
    const gh = fakeGh([
      { id: 1, name: `test-baseline-${main[2]}`, created_at: '2026-10-02T00:00:00Z' },
      { id: 2, name: `test-baseline-${main[2]}`, created_at: '2026-10-05T00:00:00Z' },
      { id: 3, name: `test-baseline-${main[2]}`, created_at: '2026-10-03T00:00:00Z' },
    ])
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toEqual({ commit: main[2], artifactId: 2 })
  })

  test('asks gh for the workflow run of each artifact', async () => {
    const { dir, branch } = makeRepo()
    const calls: string[][] = []
    await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh: fakeGh([], calls) })
    expect(calls[0].join(' ')).toContain('workflow_run')
  })

  describe('trust', () => {
    const forgeries: [string, (commit: string) => Artifact['workflow_run']][] = [
      ['a fork whose branch is called main', () => ({ head_repository_id: 99 })],
      ['a branch other than main', () => ({ head_branch: 'feature' })],
      ['a head sha that is not the named commit', () => ({ head_sha: sha(5) })],
      ['no workflow run at all', () => null],
      ['a workflow run without repository ids', () => ({ repository_id: undefined, head_repository_id: undefined })],
    ]

    for (const [title, run] of forgeries) {
      test(`ignores an artifact from ${title}`, async () => {
        const { dir, main, branch } = makeRepo()
        const gh = fakeGh([
          { id: 1, name: `test-baseline-${main[1]}` },
          { id: 2, name: `test-baseline-${main[2]}`, workflow_run: run(main[2]) },
        ])
        expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toEqual({ commit: main[1], artifactId: 1 })
      })

      test(`prefers the legitimate artifact over a newer one from ${title}`, async () => {
        const { dir, main, branch } = makeRepo()
        const gh = fakeGh([
          { id: 1, name: `test-baseline-${main[2]}`, created_at: '2026-10-02T00:00:00Z' },
          { id: 2, name: `test-baseline-${main[2]}`, created_at: '2026-10-09T00:00:00Z', workflow_run: run(main[2]) },
        ])
        expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toEqual({ commit: main[2], artifactId: 1 })
      })
    }
  })

  test('returns null when no ancestor has an artifact', async () => {
    const { dir, branch } = makeRepo()
    const gh = fakeGh([{ id: 1, name: `test-baseline-${sha(7)}` }])
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toBeNull()
  })

  test('ignores a baseline on a descendant of the merge base', async () => {
    const { dir, branch } = makeRepo()
    const gh = fakeGh([{ id: 1, name: `test-baseline-${branch[1]}` }])
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).toBeNull()
  })

  test('returns null when there is no origin/main to take a merge base with', async () => {
    const { dir, branch } = makeRepo()
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(await findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh: fakeGh([]) })).toBeNull()
  })

  test('on push starts at the first parent so a run never finds itself', async () => {
    const { dir, main } = makeRepo()
    git(dir, 'checkout', '-q', 'main')
    const head = main[2]
    const gh = fakeGh([
      { id: 1, name: `test-baseline-${main[2]}` },
      { id: 2, name: `test-baseline-${main[1]}` },
    ])
    expect(await findBaseline({ cwd: dir, head, repo: REPO, gh, fromParent: true })).toEqual({ commit: main[1], artifactId: 2 })
  })

  test('on push a commit with no parent returns null', async () => {
    const { dir, main } = makeRepo()
    const gh = fakeGh([{ id: 1, name: `test-baseline-${main[0]}` }])
    expect(await findBaseline({ cwd: dir, head: main[0], repo: REPO, gh, fromParent: true })).toBeNull()
  })

  test('gives up after 500 commits', async () => {
    const long = join(root, 'long')
    mkdirSync(long)
    git(long, 'init', '-q', '-b', 'main')
    const lines: string[] = []
    for (let i = 1; i <= 510; i++) {
      lines.push('commit refs/heads/main', `mark :${i}`, `committer t <t@example.com> ${1700000000 + i} +0000`, 'data 2', 'c')
      if (i > 1) lines.push(`from :${i - 1}`)
      lines.push('')
    }
    const imported = Bun.spawnSync(['git', 'fast-import', '--quiet'], { cwd: long, stdin: new TextEncoder().encode(lines.join('\n') + '\n') })
    expect(imported.exitCode).toBe(0)
    const head = git(long, 'rev-parse', 'main')
    const root0 = git(long, 'rev-list', '--max-parents=0', 'main')
    git(long, 'update-ref', 'refs/remotes/origin/main', head)
    const gh = fakeGh([{ id: 1, name: `test-baseline-${root0}` }])
    expect(await findBaseline({ cwd: long, head, repo: REPO, gh })).toBeNull()
  })

  test('wraps a gh failure in BaselineUnavailable', async () => {
    const { dir, branch } = makeRepo()
    const gh: GhRunner = async () => {
      throw new Error('gh: HTTP 502')
    }
    await expect(findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).rejects.toBeInstanceOf(BaselineUnavailable)
  })

  test('treats unparseable gh output as BaselineUnavailable', async () => {
    const { dir, branch } = makeRepo()
    const gh: GhRunner = async () => '<html>rate limited</html>'
    await expect(findBaseline({ cwd: dir, head: branch[1], repo: REPO, gh })).rejects.toBeInstanceOf(BaselineUnavailable)
  })
})

function sampleBaseline(commitSha: string, overrides: Partial<Baseline> = {}): Baseline {
  return {
    version: 1,
    commit: commitSha,
    createdAt: '2026-10-30T00:00:00.000Z',
    runId: '42',
    files: { 'a.test.ts': { platform: 'linux', durationMs: 5, fileError: null, flaky: false } },
    tests: { 'a.test.ts\0c\0t': 'passed' },
    flakeHistory: {},
    ...overrides,
  }
}

function zipOf(scratch: string, content: string, entry = 'baseline.json'): string {
  const src = join(scratch, 'zip-src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, entry), content)
  const out = join(scratch, `${Math.random().toString(36).slice(2)}.zip`)
  const result = Bun.spawnSync(['zip', '-q', out, entry], { cwd: src })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return out
}

describe('fetchBaseline', () => {
  let dir: string
  let scratch: string
  beforeAll(() => {
    dir = makeRepo().dir
    scratch = mkdtempSync(join(root, 'fetch-'))
  })

  function downloader(zip: string, seen: { args: string[]; dest: string }[] = []) {
    return async (args: string[], dest: string) => {
      seen.push({ args, dest })
      writeFileSync(dest, readFileSync(zip))
    }
  }

  test('downloads the artifact zip, validates it and caches it under the git common dir', async () => {
    const found = { commit: sha(11), artifactId: 77 }
    const baseline = sampleBaseline(found.commit)
    const seen: { args: string[]; dest: string }[] = []
    const got = await fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zipOf(scratch, JSON.stringify(baseline)), seen) })
    expect(got).toEqual(baseline)
    expect(seen).toHaveLength(1)
    expect(seen[0].args.join(' ')).toContain(`repos/${REPO}/actions/artifacts/77/zip`)
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const cached = join(common, 'test-baseline', `${found.commit}.json`)
    expect(JSON.parse(readFileSync(cached, 'utf8'))).toEqual(baseline)
  })

  test('reads from the cache without downloading', async () => {
    const found = { commit: sha(12), artifactId: 78 }
    const baseline = sampleBaseline(found.commit, { runId: '99' })
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    mkdirSync(join(common, 'test-baseline'), { recursive: true })
    writeFileSync(join(common, 'test-baseline', `${found.commit}.json`), JSON.stringify(baseline))
    const download = async () => {
      throw new Error('should not download')
    }
    expect(await fetchBaseline(found, { cwd: dir, repo: REPO, download })).toEqual(baseline)
  })

  test('rejects a baseline with the wrong version and caches nothing', async () => {
    const found = { commit: sha(13), artifactId: 79 }
    const zip = zipOf(scratch, JSON.stringify({ ...sampleBaseline(found.commit), version: 2 }))
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zip) })).rejects.toBeInstanceOf(BaselineUnavailable)
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    expect(existsSync(join(common, 'test-baseline', `${found.commit}.json`))).toBe(false)
  })

  test('rejects a download that is not a zip', async () => {
    const found = { commit: sha(14), artifactId: 80 }
    const download = async (_args: string[], dest: string) => writeFileSync(dest, 'not a zip')
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download })).rejects.toBeInstanceOf(BaselineUnavailable)
  })

  test('rejects a zip with no baseline.json', async () => {
    const found = { commit: sha(15), artifactId: 81 }
    const zip = zipOf(scratch, '{}', 'other.json')
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zip) })).rejects.toBeInstanceOf(BaselineUnavailable)
  })

  test('rejects a baseline.json that is not JSON', async () => {
    const found = { commit: sha(16), artifactId: 82 }
    const zip = zipOf(scratch, '{nope')
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zip) })).rejects.toBeInstanceOf(BaselineUnavailable)
  })

  test('wraps a failed download in BaselineUnavailable', async () => {
    const found = { commit: sha(17), artifactId: 83 }
    const download = async () => {
      throw new Error('gh: 404')
    }
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download })).rejects.toBeInstanceOf(BaselineUnavailable)
  })

  test('rejects a download whose own commit differs from the one asked for', async () => {
    const found = { commit: sha(19), artifactId: 85 }
    const zip = zipOf(scratch, JSON.stringify(sampleBaseline(sha(20))))
    await expect(fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zip) })).rejects.toBeInstanceOf(BaselineUnavailable)
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    expect(existsSync(join(common, 'test-baseline', `${found.commit}.json`))).toBe(false)
  })

  test('downloads again when the cached copy is for a different commit', async () => {
    const found = { commit: sha(21), artifactId: 86 }
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    mkdirSync(join(common, 'test-baseline'), { recursive: true })
    writeFileSync(join(common, 'test-baseline', `${found.commit}.json`), JSON.stringify(sampleBaseline(sha(22))))
    const baseline = sampleBaseline(found.commit, { runId: '7' })
    const got = await fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zipOf(scratch, JSON.stringify(baseline))) })
    expect(got).toEqual(baseline)
  })

  test('refetches when the cached file has a bad version', async () => {
    const found = { commit: sha(18), artifactId: 84 }
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    mkdirSync(join(common, 'test-baseline'), { recursive: true })
    writeFileSync(join(common, 'test-baseline', `${found.commit}.json`), JSON.stringify({ version: 3 }))
    const baseline = sampleBaseline(found.commit)
    const got = await fetchBaseline(found, { cwd: dir, repo: REPO, download: downloader(zipOf(scratch, JSON.stringify(baseline))) })
    expect(got).toEqual(baseline)
  })
})

const NOW = new Date('2026-10-30T12:00:00.000Z')

function attempt(fileError: Attempt['fileError'], ...tests: [string, 'passed' | 'failed' | 'skipped'][]): Attempt {
  return { exitCode: tests.some(([, s]) => s === 'failed') || fileError ? 1 : 0, fileError, tests: tests.map(([key, status]) => ({ key, status })) }
}

function result(file: string, first: Attempt, rerun?: Attempt): FileResult {
  return { file, platform: 'linux', durationMs: 10, first, ...(rerun ? { rerun } : {}) }
}

const build = (results: FileResult[], previous: Baseline | null = null) =>
  buildBaseline({ commit: sha(1), runId: '123', results, previous, now: NOW })

describe('buildBaseline', () => {
  test('records the commit, run and time', () => {
    const baseline = build([])
    expect(baseline).toEqual({ version: 1, commit: sha(1), createdAt: NOW.toISOString(), runId: '123', files: {}, tests: {}, flakeHistory: {} })
  })

  test('stores first-attempt statuses for a file with no rerun', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'passed'], ['a2', 'failed'], ['a3', 'skipped']))])
    expect(baseline.tests).toEqual({ a1: 'passed', a2: 'failed', a3: 'skipped' })
    expect(baseline.files['a.test.ts']).toEqual({ platform: 'linux', durationMs: 10, fileError: null, flaky: false })
  })

  test('takes statuses from the rerun when the file has one', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed'], ['a2', 'passed']), attempt(null, ['a1', 'passed'], ['a2', 'passed']))])
    expect(baseline.tests).toEqual({ a1: 'passed', a2: 'passed' })
    expect(baseline.files['a.test.ts'].flaky).toBe(true)
  })

  test('a test that failed first and is absent from the rerun stays failed', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed'], ['a2', 'passed']), attempt(null, ['a2', 'passed']))])
    expect(baseline.tests).toEqual({ a1: 'failed', a2: 'passed' })
  })

  test('a file whose rerun fails again is not flaky', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed']), attempt(null, ['a1', 'failed']))])
    expect(baseline.tests).toEqual({ a1: 'failed' })
    expect(baseline.files['a.test.ts'].flaky).toBe(false)
    expect(baseline.flakeHistory).toEqual({})
  })

  test('a failed-then-skipped test is stored as failed and does not make the file flaky', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed']), attempt(null, ['a1', 'skipped']))])
    expect(baseline.tests).toEqual({ a1: 'failed' })
    expect(baseline.files['a.test.ts'].flaky).toBe(false)
    expect(baseline.flakeHistory).toEqual({})
  })

  test('a file is flaky when one test recovered even though another keeps failing', () => {
    const baseline = build([
      result('a.test.ts', attempt(null, ['a1', 'failed'], ['a2', 'failed']), attempt(null, ['a1', 'passed'], ['a2', 'failed'])),
    ])
    expect(baseline.tests).toEqual({ a1: 'passed', a2: 'failed' })
    expect(baseline.files['a.test.ts'].flaky).toBe(true)
    expect(baseline.flakeHistory).toEqual({ 'a.test.ts': [NOW.toISOString()] })
  })

  test('a cleared file error makes the file flaky even when a test in the rerun fails', () => {
    const baseline = build([result('a.test.ts', attempt('timeout'), attempt(null, ['a1', 'failed']))])
    expect(baseline.files['a.test.ts'].flaky).toBe(true)
  })

  test('a first-attempt file error that clears on rerun is flaky', () => {
    const baseline = build([result('a.test.ts', attempt('timeout'), attempt(null, ['a1', 'passed']))])
    expect(baseline.files['a.test.ts']).toEqual({ platform: 'linux', durationMs: 10, fileError: null, flaky: true })
    expect(baseline.tests).toEqual({ a1: 'passed' })
  })

  test('a rerun that has a file error is not flaky and its error is kept', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed']), attempt('no-report'))])
    expect(baseline.files['a.test.ts']).toEqual({ platform: 'linux', durationMs: 10, fileError: 'no-report', flaky: false })
    expect(baseline.tests).toEqual({ a1: 'failed' })
  })

  test('a clean first attempt is not flaky even with a clean rerun', () => {
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'passed']), attempt(null, ['a1', 'passed']))])
    expect(baseline.files['a.test.ts'].flaky).toBe(false)
  })

  test('takes fileError from the last attempt', () => {
    const baseline = build([
      result('a.test.ts', attempt('exit-mismatch', ['a1', 'passed'])),
      result('b.test.ts', attempt('timeout'), attempt(null, ['b1', 'passed'])),
    ])
    expect(baseline.files['a.test.ts'].fileError).toBe('exit-mismatch')
    expect(baseline.files['b.test.ts'].fileError).toBeNull()
  })

  test('carries flake history forward, adds today for flaky files and prunes old dates', () => {
    const previous = sampleBaseline(sha(0), {
      flakeHistory: {
        'a.test.ts': ['2026-10-22T11:59:59.000Z', '2026-10-24T00:00:00.000Z'],
        'old.test.ts': ['2026-10-01T00:00:00.000Z'],
        'kept.test.ts': ['2026-10-23T12:00:00.000Z'],
      },
    })
    const baseline = build([result('a.test.ts', attempt(null, ['a1', 'failed']), attempt(null, ['a1', 'passed'])), result('b.test.ts', attempt(null, ['b1', 'passed']))], previous)
    expect(baseline.flakeHistory).toEqual({
      'a.test.ts': ['2026-10-24T00:00:00.000Z', NOW.toISOString()],
      'kept.test.ts': ['2026-10-23T12:00:00.000Z'],
    })
  })

  test('does not mutate the previous baseline', () => {
    const previous = sampleBaseline(sha(0), { flakeHistory: { 'a.test.ts': ['2026-10-29T00:00:00.000Z'] } })
    build([result('a.test.ts', attempt(null, ['a1', 'failed']), attempt(null, ['a1', 'passed']))], previous)
    expect(previous.flakeHistory).toEqual({ 'a.test.ts': ['2026-10-29T00:00:00.000Z'] })
  })
})
