import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATUS_ENTRY_LIMIT } from '@quirky/git'
import { createFakeGit, useTestGit } from '@quirky/git/testing'
import { RpcErrorCode, type GitDiff, type GitStatusEntry, type ReviewFile, type ReviewModel, type Worktree } from '@quirky/protocol'
import { readReview } from '../../src/daemon/review'
import type { DaemonEnv } from '../../src/daemon/env'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import { commitInFeat, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const review = (): Promise<ReviewModel> => s!.api('review')
const mark = (path: string, reviewed = true, expected?: string | null) =>
  s!.api('setReviewMark', { path, reviewed, ...(expected === undefined ? {} : { expected }) })
const row = (model: ReviewModel, path: string): ReviewFile => {
  const found = model.files.find((file) => file.path === path)
  if (!found) throw new Error(`${path} is not in the review: ${model.files.map((file) => file.path).join(', ')}`)
  return found
}
const reviewDiff = (path: string, against: 'base' | 'reviewed', extra: Record<string, unknown> = {}): Promise<GitDiff> =>
  s!.api('diff', { path, source: 'review', against, ...extra })
const countOf = (type: string) => s!.events.filter((event) => event.type === type).length

/** One file of every kind: committed, partly staged, unstaged, deleted, untracked, committed then edited. */
function everyKind(scenario: Scenario): void {
  commitInFeat(scenario, { 'util.ts': 'util\n', 'old.ts': 'export const a = 1\nexport const b = 3\n', 'math.ts': 'a\nB\nc\nd\ne\n' })
  scenario.write('a.ts', 'one\nuno\n')
  scenario.gitIn('add', 'a.ts')
  scenario.write('a.ts', 'one\nuno\ntres\n')
  scenario.write('b.ts', 'bee\nbuzz\n')
  rmSync(join(scenario.feat.path, 'c.ts'))
  scenario.write('new.txt', 'fresh\n')
  scenario.write('math.ts', 'a\nB\nC\nd\ne\n')
}

describe('the review model', () => {
  test('lists every changed file once from the merge base to the disk, with flags, counts and totals', async () => {
    s = await startScenario(scratch)
    everyKind(s)

    const model = await review()
    expect(model).toMatchObject({
      worktreeId: s.feat.id,
      branch: 'zoe/feat',
      base: { name: 'origin/main', source: 'worktree', isCurrentBranch: false },
      compare: { status: 'ready', mergeBase: s.gitIn('rev-parse', 'origin/main'), headOid: s.gitIn('rev-parse', 'HEAD') },
      totals: { added: 8, removed: 4 },
      counts: { files: 7, reviewed: 0, changed: 0, uncommitted: 5, staged: 1 },
      capped: false
    })
    expect(model.files).toEqual([
      { path: 'a.ts', status: 'M', added: 2, removed: 0, binary: false, uncommitted: true, staged: true, mark: 'none', notes: 0 },
      { path: 'b.ts', status: 'M', added: 1, removed: 0, binary: false, uncommitted: true, staged: false, mark: 'none', notes: 0 },
      { path: 'c.ts', status: 'D', added: 0, removed: 1, binary: false, uncommitted: true, staged: false, mark: 'none', notes: 0 },
      { path: 'math.ts', status: 'M', added: 2, removed: 2, binary: false, uncommitted: true, staged: false, mark: 'none', notes: 0 },
      { path: 'new.txt', status: 'A', added: 1, removed: 0, binary: false, uncommitted: true, staged: false, mark: 'none', notes: 0 },
      { path: 'old.ts', status: 'M', added: 1, removed: 1, binary: false, uncommitted: false, staged: false, mark: 'none', notes: 0 },
      { path: 'util.ts', status: 'A', added: 1, removed: 0, binary: false, uncommitted: false, staged: false, mark: 'none', notes: 0 }
    ])
  })

  test('orders paths by UTF-8 bytes and reports a rename with its old path as R', async () => {
    s = await startScenario(scratch)
    s.gitIn('mv', 'old.ts', 'renamed.ts')
    s.write('é.txt', 'accent\n')
    s.write('aa.txt', 'lower\n')
    s.write('Zz.txt', 'caps\n')

    const model = await review()
    expect(model.files.map((file) => file.path)).toEqual(['Zz.txt', 'aa.txt', 'renamed.ts', 'é.txt'])
    expect(row(model, 'renamed.ts')).toMatchObject({ status: 'R', oldPath: 'old.ts', staged: true, uncommitted: true })
  })

  test('counts the diff notes of each file', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await s.api('addNote', { path: 'b.ts', line: 2, body: 'why' })
    expect(row(await review(), 'b.ts').notes).toBe(1)
  })

  test('lists a conflicted path with its conflict and never a mark', async () => {
    s = await startScenario(scratch)
    s.gitIn('checkout', '-q', '-b', 'other')
    commitInFeat(s, { 'a.ts': 'theirs\n' }, 'theirs')
    s.gitIn('checkout', '-q', 'zoe/feat')
    commitInFeat(s, { 'a.ts': 'ours\n' }, 'ours')
    expect(s.gitTry(null, 'merge', 'other').code).not.toBe(0)

    await mark('a.ts')
    const file = row(await review(), 'a.ts')
    expect(file).toMatchObject({ conflict: { kind: 'both_modified', state: 'unresolved' }, mark: 'none', uncommitted: true })
  })

  test('shows only the uncommitted files when the compare cannot run, and keeps marks across those reads', async () => {
    s = await startScenario(scratch)
    everyKind(s)
    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'no-such-ref' })

    const model = await review()
    expect(model.compare).toMatchObject({ status: 'invalid-base', mergeBase: null })
    expect(model.compare.message).toContain('no-such-ref')
    expect(model.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'math.ts', 'new.txt'])
    expect(model.files.every((file) => file.uncommitted)).toBe(true)

    await mark('a.ts')
    await mark('README.md')
    expect(row(await review(), 'a.ts').mark).toBe('reviewed')
    expect(await s.api('reviewedContent', { path: 'README.md' })).toMatchObject({ content: 'one\ntwo\n' })
  })
})

describe('the review model without a compare', () => {
  test('lists a partly staged file once even when its bytes on disk match HEAD', async () => {
    s = await startScenario(scratch)
    s.write('README.md', 'one\ntwo\nthree\n')
    s.gitIn('add', 'README.md')
    s.write('README.md', 'one\ntwo\n')
    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'no-such-ref' })

    const model = await review()
    expect(model.compare.status).toBe('invalid-base')
    expect(model.files).toEqual([
      { path: 'README.md', status: 'M', added: 1, removed: 1, binary: false, uncommitted: true, staged: true, mark: 'none', notes: 0 }
    ])
    expect(model.counts).toMatchObject({ files: 1, uncommitted: 1, staged: 1 })
  })
})

describe('the review model size', () => {
  function stubbed(
    entries: GitStatusEntry[],
    listed: number,
    options: { path?: string; paths?: string[]; marks?: { path: string; hash: string }[] } = {}
  ): { env: DaemonEnv; worktree: Worktree } {
    const fake = createFakeGit()
    fake.compare = async () => ({
      status: 'ready' as const,
      baseSource: 'detected' as const,
      message: null,
      base: 'main',
      mergeBase: 'abc',
      headOid: 'def',
      baseOid: 'abc',
      ahead: 1,
      behind: 0,
      entries: [],
      added: 0,
      removed: 0
    })
    useTestGit(fake)
    const env = {
      context: { getSetting: () => undefined },
      readStatus: async () => ({ branch: 'feature', unborn: false, capped: false, entries }),
      changeList: async () => ({
        changes: (options.paths ?? Array.from({ length: listed }, (_, i) => `f${String(i).padStart(4, '0')}`)).map((path) => ({ path, status: 'modified' as const, added: 1, removed: 0, binary: false })),
        capped: false
      }),
      reviewMarks: { list: () => (options.marks ?? []).map((mark) => ({ ...mark, baseKey: 'main' })), clear: () => 0, removeAll: () => 0 },
      notes: { list: () => [] },
      reviewChanged: () => {},
      changed: () => {}
    } as unknown as DaemonEnv
    return { env, worktree: { id: 'w', path: options.path ?? process.cwd(), baseRef: 'main' } as unknown as Worktree }
  }
  afterEach(() => useTestGit(null))

  test('never lists more than the status limit, keeps the conflicts that did not fit and says it was capped', async () => {
    const conflict: GitStatusEntry = { path: 'zz-conflict', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'unresolved' } }
    const { env, worktree } = stubbed([conflict], STATUS_ENTRY_LIMIT)

    const model = await readReview(env, worktree)
    expect(model.files).toHaveLength(STATUS_ENTRY_LIMIT)
    expect(model.files.some((file) => file.path === 'zz-conflict' && file.conflict !== undefined)).toBe(true)
    expect(model.capped).toBe(true)
  })

  test('a mark stored while the change list is being read survives the prune of that read', async () => {
    const { env, worktree } = stubbed([], 0, { paths: [] })
    let marks: { path: string; baseKey: string; hash: string; markedAt: number }[] = [{ path: 'old.txt', baseKey: 'main', hash: 'h', markedAt: 0 }]
    env.reviewMarks = {
      list: () => marks,
      clear: () => 0,
      removeAll: (_id: string, paths: readonly string[]) => {
        const before = marks.length
        marks = marks.filter((mark) => !paths.includes(mark.path))
        return before - marks.length
      }
    } as unknown as DaemonEnv['reviewMarks']
    env.changeList = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      marks = [...marks, { path: 'new.txt', baseKey: 'main', hash: 'n', markedAt: Date.now() }]
      return { changes: [], capped: false }
    }) as unknown as DaemonEnv['changeList']

    await readReview(env, worktree)
    expect(marks.map((mark) => mark.path)).toEqual(['new.txt'])
  })

  test('a marked file that cannot be read is changed and does not fail the review', async () => {
    if (process.getuid?.() === 0) return
    const dir = mkdtempSync(join(tmpdir(), 'qd-unreadable-'))
    const file = join(dir, 'locked.txt')
    writeFileSync(file, 'text\n')
    chmodSync(file, 0o000)
    try {
      const { env, worktree } = stubbed([{ path: 'locked.txt', area: 'unstaged', status: 'modified' }], 0, {
        path: dir,
        paths: ['locked.txt'],
        marks: [{ path: 'locked.txt', hash: sha256('text\n') }]
      })
      const model = await readReview(env, worktree)
      expect(row(model, 'locked.txt').mark).toBe('changed')
    } finally {
      chmodSync(file, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a list within the limit is not capped', async () => {
    const conflict: GitStatusEntry = { path: 'zz-conflict', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'unresolved' } }
    const { env, worktree } = stubbed([conflict], STATUS_ENTRY_LIMIT - 1)

    const model = await readReview(env, worktree)
    expect(model.files).toHaveLength(STATUS_ENTRY_LIMIT)
    expect(model.capped).toBe(false)
  })
})

describe('review marks', () => {
  test('mark reviewed, change it outside Quirky, put the bytes back: reviewed, changed, reviewed', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')

    expect(await mark('b.ts')).toEqual({ mark: 'reviewed' })
    expect(row(await review(), 'b.ts').mark).toBe('reviewed')
    expect((await review()).counts).toMatchObject({ reviewed: 1, changed: 0 })

    s.write('b.ts', 'bee\nbuzz\nbang\n')
    expect(row(await review(), 'b.ts').mark).toBe('changed')
    expect((await review()).counts).toMatchObject({ reviewed: 0, changed: 1 })

    s.write('b.ts', 'bee\nbuzz\n')
    expect(row(await review(), 'b.ts').mark).toBe('reviewed')
  })

  test('commits and staging that leave the bytes alone leave the mark alone', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await mark('b.ts')
    s.gitIn('add', 'b.ts')
    commitInFeat(s, {}, 'commit it')
    expect(row(await review(), 'b.ts')).toMatchObject({ mark: 'reviewed', uncommitted: false })
  })

  test('unmarking deletes the row and is idempotent', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await mark('b.ts')
    expect(await mark('b.ts', false)).toEqual({ mark: 'none' })
    expect(row(await review(), 'b.ts').mark).toBe('none')
    expect(await mark('b.ts', false)).toEqual({ mark: 'none' })
    expect(await mark('c.ts', false)).toEqual({ mark: 'none' })
  })

  test('a deleted file shows D and can be marked reviewed through the deletion hash', async () => {
    s = await startScenario(scratch)
    rmSync(join(s.feat.path, 'c.ts'))
    expect(row(await review(), 'c.ts')).toMatchObject({ status: 'D', mark: 'none' })

    expect(await mark('c.ts', true, null)).toEqual({ mark: 'reviewed' })
    expect(row(await review(), 'c.ts').mark).toBe('reviewed')
    expect(await s.api('reviewedContent', { path: 'c.ts' })).toEqual({ content: null, hash: 'deleted', binary: false, tooLarge: false })

    s.write('c.ts', 'back\n')
    expect(row(await review(), 'c.ts').mark).toBe('changed')
  })

  test('a mismatched expected hash fails with changed-on-disk and stores nothing', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')

    const failure = await s.fails(mark('b.ts', true, sha256('something else')))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'changed-on-disk' } })
    expect(row(await review(), 'b.ts').mark).toBe('none')
    expect((await s.fails(s.api('reviewedContent', { path: 'b.ts' }))).code).toBe(RpcErrorCode.NotFound)

    expect(await mark('b.ts', true, sha256('bee\nbuzz\n'))).toEqual({ mark: 'reviewed' })
    const missing = await s.fails(mark('c.ts', true, null))
    expect(missing.data.reason).toBe('changed-on-disk')
  })

  test('rejects a path outside the worktree', async () => {
    s = await startScenario(scratch)
    expect((await s.fails(mark('../escape.txt'))).data.reason).toBe('outside-worktree')
  })

  test('a file that matches the base again loses its row', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await mark('b.ts')
    s.write('b.ts', 'bee\n')
    expect((await review()).files.map((file) => file.path)).toEqual([])
    expect((await s.fails(s.api('reviewedContent', { path: 'b.ts' }))).code).toBe(RpcErrorCode.NotFound)

    s.write('b.ts', 'bee\nbuzz\n')
    expect(row(await review(), 'b.ts').mark).toBe('none')
  })

  test('setBase clears every mark of the worktree, even to the same base', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    s.write('a.ts', 'one\nuno\n')
    await mark('b.ts')
    await mark('a.ts')

    await s.api('setBase', { base: 'origin/main' })
    const model = await review()
    expect(model.files.map((file) => file.mark)).toEqual(['none', 'none'])
    expect((await s.fails(s.api('reviewedContent', { path: 'a.ts' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('a base change made outside setBase clears the marks on the next read', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await mark('b.ts')
    expect(row(await review(), 'b.ts').mark).toBe('reviewed')

    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'main' })
    expect(row(await review(), 'b.ts').mark).toBe('none')
    expect((await s.fails(s.api('reviewedContent', { path: 'b.ts' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('marks are scoped to their worktree', async () => {
    s = await startScenario(scratch)
    const other = await s.addWorktree('other')
    s.write('b.ts', 'bee\nbuzz\n')
    writeFileSync(join(other.path, 'b.ts'), 'bee\nbuzz\n')
    await mark('b.ts')

    const there = (await s.client.callAny('quirky.git/review', { worktree: other.id })) as ReviewModel
    expect(row(there, 'b.ts').mark).toBe('none')
  })

  test('marks survive a daemon restart on the same home', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await mark('b.ts')

    const { client } = await s.t.restart()
    const model = (await client.callAny('quirky.git/review', { worktree: s.feat.id })) as ReviewModel
    expect(row(model, 'b.ts').mark).toBe('reviewed')
  })

  test('stores binary content as a hash only', async () => {
    s = await startScenario(scratch)
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03])
    writeFileSync(join(s.feat.path, 'blob.bin'), bytes)
    await mark('blob.bin')

    expect(await s.api('reviewedContent', { path: 'blob.bin' })).toEqual({ content: null, hash: sha256(bytes), binary: true, tooLarge: false })
    expect(row(await review(), 'blob.bin')).toMatchObject({ binary: true, added: null, mark: 'reviewed' })
  })

  test('pruning and clearing marks on a read announce reviewChanged and changed once, and a read with nothing to prune stays quiet', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    s.write('a.ts', 'one\nuno\n')
    let marked = { review: countOf('quirky.git/reviewChanged'), changed: countOf('quirky.git/changed') }
    await mark('b.ts')
    await waitFor(
      () => countOf('quirky.git/reviewChanged') > marked.review && countOf('quirky.git/changed') > marked.changed
    )
    marked = { review: countOf('quirky.git/reviewChanged'), changed: countOf('quirky.git/changed') }
    await mark('a.ts')
    await waitFor(
      () => countOf('quirky.git/reviewChanged') > marked.review && countOf('quirky.git/changed') > marked.changed
    )
    await review()
    await s.flushEvents()
    const quiet = { review: countOf('quirky.git/reviewChanged'), changed: countOf('quirky.git/changed') }
    await review()
    await s.flushEvents()
    expect(countOf('quirky.git/reviewChanged')).toBe(quiet.review)

    s.write('b.ts', 'bee\n')
    await review()
    await waitFor(() => countOf('quirky.git/reviewChanged') >= quiet.review + 1)
    expect(countOf('quirky.git/reviewChanged')).toBe(quiet.review + 1)
    expect(countOf('quirky.git/changed')).toBeGreaterThan(quiet.changed)
    await review()
    await s.flushEvents()
    expect(countOf('quirky.git/reviewChanged')).toBe(quiet.review + 1)

    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'main' })
    await review()
    await waitFor(() => countOf('quirky.git/reviewChanged') >= quiet.review + 2)
    expect(countOf('quirky.git/reviewChanged')).toBe(quiet.review + 2)
    await review()
    await s.flushEvents()
    expect(countOf('quirky.git/reviewChanged')).toBe(quiet.review + 2)
  })

  test('a marked file whose folder became a symlink out of the worktree reads as changed and is never followed', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'dir/f.txt': 'base\n' })
    s.write('dir/f.txt', 'mine\n')
    await mark('dir/f.txt')
    expect(row(await review(), 'dir/f.txt').mark).toBe('reviewed')

    const outside = mkdtempSync(join(tmpdir(), 'qd-outside-'))
    try {
      writeFileSync(join(outside, 'f.txt'), 'mine\n')
      rmSync(join(s.feat.path, 'dir'), { recursive: true })
      symlinkSync(outside, join(s.feat.path, 'dir'))
      const model = await review()
      expect(model.files.find((file) => file.path === 'dir/f.txt')?.mark ?? 'changed').toBe('changed')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('every mutation announces reviewChanged and changed for the worktree', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    await s.flushEvents()
    const before = { review: countOf('quirky.git/reviewChanged'), changed: countOf('quirky.git/changed') }

    let step = 0
    for (const mutation of [() => mark('b.ts'), () => mark('b.ts', false), () => s!.api('setBase', { base: 'origin/main' })]) {
      await mutation()
      step++
      await waitFor(
        () =>
          countOf('quirky.git/reviewChanged') >= before.review + step &&
          countOf('quirky.git/changed') >= before.changed + step
      )
      expect(countOf('quirky.git/reviewChanged')).toBe(before.review + step)
      expect(countOf('quirky.git/changed')).toBeGreaterThanOrEqual(before.changed + step)
    }
    const last = s.events.filter((event) => event.type === 'quirky.git/reviewChanged').at(-1)
    expect(last).toEqual({
      type: 'quirky.git/reviewChanged',
      data: { worktreeId: s.feat.id },
      worktreeId: s.feat.id
    })
  })
})

describe('the review diff source', () => {
  test('against base reads the merge base to the disk, labelled review, with the disk hash', async () => {
    s = await startScenario(scratch)
    everyKind(s)

    expect(await reviewDiff('math.ts', 'base')).toMatchObject({
      source: 'review',
      staged: false,
      original: 'a\nb\nc\nd\ne\n',
      modified: 'a\nB\nC\nd\ne\n',
      kind: 'text',
      modifiedHash: sha256('a\nB\nC\nd\ne\n')
    })
    expect(await reviewDiff('util.ts', 'base')).toMatchObject({ original: '', modified: 'util\n' })
    expect(await reviewDiff('c.ts', 'base')).toMatchObject({ source: 'review', original: 'sea\n', modified: '', modifiedHash: null, modifiedDeleted: true })
  })

  test('against base follows a rename through oldPath', async () => {
    s = await startScenario(scratch)
    s.gitIn('mv', 'old.ts', 'renamed.ts')
    expect(await reviewDiff('renamed.ts', 'base', { oldPath: 'old.ts' })).toMatchObject({
      source: 'review',
      oldPath: 'old.ts',
      original: 'export const a = 1\nexport const b = 2\n',
      modified: 'export const a = 1\nexport const b = 2\n'
    })
  })

  test('against base falls back to HEAD when the compare cannot run', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'math.ts': 'committed\n' })
    s.write('math.ts', 'draft\n')
    await s.client.callAny('quirky.worktree/set', { worktree: s.feat.id, baseRef: 'no-such-ref' })
    expect(await reviewDiff('math.ts', 'base')).toMatchObject({ source: 'review', original: 'committed\n', modified: 'draft\n' })
  })

  test('against reviewed reads the stored content to the disk and fails without a mark', async () => {
    s = await startScenario(scratch)
    s.write('b.ts', 'bee\nbuzz\n')
    expect((await s.fails(reviewDiff('b.ts', 'reviewed'))).code).toBe(RpcErrorCode.NotFound)

    await mark('b.ts')
    s.write('b.ts', 'bee\nbuzz\nbang\n')
    expect(await reviewDiff('b.ts', 'reviewed')).toMatchObject({
      source: 'review',
      original: 'bee\nbuzz\n',
      modified: 'bee\nbuzz\nbang\n',
      kind: 'text',
      modifiedHash: sha256('bee\nbuzz\nbang\n')
    })
    expect(await s.api('reviewedContent', { path: 'b.ts' })).toEqual({ content: 'bee\nbuzz\n', hash: sha256('bee\nbuzz\n'), binary: false, tooLarge: false })
  })

  test('against reviewed shows the binary notice when the reviewed version kept no content', async () => {
    s = await startScenario(scratch)
    writeFileSync(join(s.feat.path, 'blob.bin'), Buffer.from([0, 1, 2]))
    await mark('blob.bin')
    writeFileSync(join(s.feat.path, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    expect(await reviewDiff('blob.bin', 'reviewed')).toMatchObject({ source: 'review', kind: 'binary', binary: true })
  })

  test('requires a valid against', async () => {
    s = await startScenario(scratch)
    expect((await s.fails(s.api('diff', { path: 'b.ts', source: 'review' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await s.fails(s.api('diff', { path: 'b.ts', source: 'unstaged', against: 'base' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('reviewedContent fails not-found when the file has no row', async () => {
    s = await startScenario(scratch)
    expect((await s.fails(s.api('reviewedContent', { path: 'b.ts' }))).code).toBe(RpcErrorCode.NotFound)
  })
})
