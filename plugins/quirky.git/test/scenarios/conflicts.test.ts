import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type GitStatus } from '@quirky/protocol'
import { actionPaths, entryActions } from '../../src/panel/sections'
import { waitFor, waitForAsync } from '../../../../packages/daemon/test/helpers'
import { diverge, installHook, isolateScenarioGit, jsonError, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const status = (scenario: Scenario, worktree?: string): Promise<GitStatus> =>
  scenario.api('status', worktree ? { worktree } : {})
const conflictRows = (st: GitStatus) => st.entries.filter((entry) => entry.area === 'conflicts').map((entry) => [entry.path, entry.conflict!.kind, entry.conflict!.state])

/** Starts a merge of `other` into feat that conflicts on a.ts and b.ts. */
function mergeAB(scenario: Scenario): void {
  diverge(scenario, { 'a.ts': 'theirs a\n', 'b.ts': 'theirs b\n' }, { 'a.ts': 'ours a\n', 'b.ts': 'ours b\n' })
  expect(scenario.gitTry(null, 'merge', 'other').code).toBe(1)
}

describe('conflicts in status', () => {
  test('SC-3: conflicts are listed first with their kind', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': 'theirs\n', 'b.ts': null }, { 'a.ts': 'ours\n', 'b.ts': 'ours b\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    s.write('d.ts', 'added by us\n')
    const blob = s.gitIn('hash-object', '-w', 'd.ts')
    Bun.spawnSync(['git', 'update-index', '--index-info'], { cwd: s.feat.path, stdin: Buffer.from(`100644 ${blob} 2\td.ts\n`) })
    s.write('aaa.txt', 'untracked sorts first alphabetically\n')

    const st = await status(s)
    expect(st.operation).toBe('merge')
    expect(conflictRows(st)).toEqual([
      ['a.ts', 'both_modified', 'unresolved'],
      ['b.ts', 'deleted_by_them', 'unresolved'],
      ['d.ts', 'added_by_us', 'unresolved']
    ])
    expect(st.entries.slice(0, 3).every((entry) => entry.area === 'conflicts')).toBe(true)
  })

  test('SC-4 and SC-46: the operation is read from each worktree\'s own git directory', async () => {
    s = await startScenario(scratch)
    const w2 = await s.addWorktree('w2')
    const w3 = await s.addWorktree('w3')

    mergeAB(s)

    diverge(s, { 'a.ts': 'theirs\n' }, { 'a.ts': 'ours\n' }, { branch: 'rebase-onto', cwd: w2.path })
    expect(s.gitTry(w2.path, 'rebase', 'rebase-onto').code).toBe(1)

    diverge(s, { 'a.ts': 'picked\n' }, { 'a.ts': 'mine\n' }, { branch: 'pick-from', cwd: w3.path })
    expect(s.gitTry(w3.path, 'cherry-pick', 'pick-from').code).toBe(1)
    writeFileSync(join(w3.path, 'a.ts'), 'resolved\n')
    s.gitTry(w3.path, 'add', 'a.ts')

    expect((await status(s)).operation).toBe('merge')
    const rebasing = await status(s, w2.id)
    expect(rebasing.operation).toBe('rebase')
    expect(conflictRows(rebasing)).toEqual([['a.ts', 'both_modified', 'unresolved']])
    const picking = await status(s, w3.id)
    expect(picking.operation).toBe('cherry-pick')
    expect(conflictRows(picking)).toEqual([])
    expect(await s.fails(s.api('abort', { worktree: w3.id, yes: true }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Nothing to abort.',
      data: { reason: 'not-allowed' }
    })

    s.gitTry(null, 'merge', '--abort')
    s.gitTry(w2.path, 'rebase', '--abort')
    s.gitTry(w3.path, 'cherry-pick', '--abort')
    for (const worktree of [s.feat.id, w2.id, w3.id]) expect((await status(s, worktree)).operation).toBe('none')
  })
})

describe('opening a conflict', () => {
  test('SC-41: open, save without markers, stage, then the file shows as resolved locally and continue finishes the merge (CLI)', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'math.ts': 'a\nb\ntheirs\nd\ne\n' }, { 'math.ts': 'a\nb\nours\nd\ne\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)

    const opened = JSON.parse((await s.cli(['git', 'conflictFile', '--path', 'math.ts', '--json'])).stdout)
    expect(opened).toMatchObject({ path: 'math.ts', kind: 'both_modified', state: 'unresolved', operation: 'merge' })
    expect(opened.content).toContain('<<<<<<<')
    expect(opened.hash).toMatch(/^[0-9a-f]{64}$/)

    const saved = JSON.parse(
      (await s.cli(['git', 'save', '--path', 'math.ts', '--content', 'a\nb\nresolved\nd\ne\n', '--expected', opened.hash, '--json'])).stdout
    )
    expect(saved.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(conflictRows(await status(s))).toEqual([['math.ts', 'both_modified', 'unresolved']])

    expect((await s.cli(['git', 'stage', '--paths', 'math.ts'])).code).toBe(0)
    const staged = await status(s)
    expect(conflictRows(staged)).toEqual([['math.ts', 'both_modified', 'resolved_locally']])
    expect(staged.entries.filter((entry) => entry.path === 'math.ts').map((entry) => entry.area)).toEqual(['conflicts', 'staged'])

    const done = JSON.parse((await s.cli(['git', 'continue', '--json'])).stdout)
    expect(done).toEqual({ finished: true, operation: 'none' })
    expect(s.gitIn('rev-parse', 'HEAD^2')).toBe(s.gitIn('rev-parse', 'other'))
    expect(readFileSync(join(s.feat.path, 'math.ts'), 'utf8')).toBe('a\nb\nresolved\nd\ne\n')
    const after = await status(s)
    expect(after).toMatchObject({ operation: 'none', entries: [] })
  })

  test('a conflict staged without being opened is not listed as resolved locally', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    await s.api('conflictFile', { path: 'a.ts' })
    s.write('a.ts', 'ra\n')
    s.write('b.ts', 'rb\n')
    await s.api('stage', { paths: ['a.ts', 'b.ts'] })
    expect(conflictRows(await status(s))).toEqual([['a.ts', 'both_modified', 'resolved_locally']])
  })

  test('a peek reads the file without recording it as opened', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    expect(await s.api('conflictFile', { path: 'a.ts', peek: true })).toMatchObject({ path: 'a.ts', state: 'unresolved' })
    await s.api('conflictFile', { path: 'b.ts' })
    s.write('a.ts', 'ra\n')
    s.write('b.ts', 'rb\n')
    await s.api('stage', { paths: ['a.ts', 'b.ts'] })
    expect(conflictRows(await status(s))).toEqual([['b.ts', 'both_modified', 'resolved_locally']])
  })

  test('a new operation starts with nothing opened', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    await s.api('conflictFile', { path: 'a.ts' })
    s.gitIn('merge', '--abort')
    expect((await status(s)).operation).toBe('none')

    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    s.write('a.ts', 'ra\n')
    await s.api('stage', { paths: ['a.ts'] })
    expect(conflictRows(await status(s))).toEqual([['b.ts', 'both_modified', 'unresolved']])
  })

  test('a path that is deleted and staged after opening shows as resolved locally with no file', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': null }, { 'a.ts': 'ours\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    const opened = await s.api('conflictFile', { path: 'a.ts' })
    expect(opened).toMatchObject({ kind: 'deleted_by_them', content: 'ours\n' })
    rmSync(join(s.feat.path, 'a.ts'))
    expect(await s.api('conflictFile', { path: 'a.ts' })).toMatchObject({ content: null, hash: null })
    await s.api('stage', { paths: ['a.ts'] })
    expect(conflictRows(await status(s))).toEqual([['a.ts', 'deleted_by_them', 'resolved_locally']])
  })

  test('SC-44: Keep saves and stages deleted-by-them content, then continues with the file', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': null }, { 'a.ts': 'ours\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)

    const opened = await s.api('conflictFile', { path: 'a.ts' })
    expect(opened).toMatchObject({ kind: 'deleted_by_them', content: 'ours\n' })
    await s.api('save', { path: 'a.ts', content: 'kept\n', expected: opened.hash })
    await s.api('stage', { paths: ['a.ts'] })
    expect(conflictRows(await status(s))).toEqual([['a.ts', 'deleted_by_them', 'resolved_locally']])

    expect(await s.api('continue')).toEqual({ finished: true, operation: 'none' })
    expect(readFileSync(join(s.feat.path, 'a.ts'), 'utf8')).toBe('kept\n')
    expect(await status(s)).toMatchObject({ operation: 'none', entries: [] })
  })

  for (const kind of ['deleted_by_them', 'deleted_by_us'] as const) {
    test(`SC-44: Accept deletion resolves ${kind}, stages the removal and continues`, async () => {
      s = await startScenario(scratch)
      const theirs = kind === 'deleted_by_them' ? { 'a.ts': null } : { 'a.ts': 'theirs\n' }
      const ours = kind === 'deleted_by_them' ? { 'a.ts': 'ours\n' } : { 'a.ts': null }
      diverge(s, theirs, ours)
      expect(s.gitTry(null, 'merge', 'other').code).toBe(1)

      const opened = await s.api('conflictFile', { path: 'a.ts' })
      expect(opened).toMatchObject({ kind, content: kind === 'deleted_by_them' ? 'ours\n' : 'theirs\n' })
      await s.api('acceptConflictDeletion', { path: 'a.ts', expected: opened.hash })
      expect(existsSync(join(s.feat.path, 'a.ts'))).toBe(false)
      expect(s.gitIn('ls-files', '-u')).toBe('')
      expect(s.gitIn('ls-files', '--', 'a.ts')).toBe('')
      if (kind === 'deleted_by_them') {
        expect(s.gitIn('diff', '--cached', '--name-status').split(/\r?\n/)).toContain('D\ta.ts')
      }
      expect(conflictRows(await status(s))).toEqual([['a.ts', kind, 'resolved_locally']])

      expect(await s.api('continue')).toEqual({ finished: true, operation: 'none' })
      expect(existsSync(join(s.feat.path, 'a.ts'))).toBe(false)
      expect(await status(s)).toMatchObject({ operation: 'none', entries: [] })
    })
  }

  test('SC-44: acceptConflictDeletion refuses unrelated conflicts, paths outside the worktree and stale hashes', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': 'theirs a\n', 'b.ts': 'theirs b\n' }, { 'a.ts': null, 'b.ts': 'ours b\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    const opened = await s.api('conflictFile', { path: 'a.ts' })
    const modified = await s.api('conflictFile', { path: 'b.ts' })

    await s.fails(s.api('acceptConflictDeletion', { path: 'b.ts', expected: modified.hash }))
    await s.fails(s.api('acceptConflictDeletion', { path: 'math.ts', expected: opened.hash }))
    expect(await s.fails(s.api('acceptConflictDeletion', { path: '../outside', expected: opened.hash }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      data: { reason: 'outside-worktree' }
    })

    s.write('a.ts', 'newer content\n')
    await s.fails(s.api('acceptConflictDeletion', { path: 'a.ts', expected: opened.hash }))
    expect(readFileSync(join(s.feat.path, 'a.ts'), 'utf8')).toBe('newer content\n')
    expect(conflictRows(await status(s))).toContainEqual(['a.ts', 'deleted_by_us', 'unresolved'])
  })

  test('conflictFile refuses a path that is not in conflict, a binary file and a path outside the worktree', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': 'theirs\n' }, { 'a.ts': 'ours\n' })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)
    expect((await s.fails(s.api('conflictFile', { path: 'math.ts' }))).code).toBe(RpcErrorCode.NotFound)
    expect(await s.fails(s.api('conflictFile', { path: '../x' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'outside-worktree' } })
    writeFileSync(join(s.feat.path, 'a.ts'), Buffer.from([0, 1, 2, 3]))
    expect(await s.fails(s.api('conflictFile', { path: 'a.ts' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'not-allowed' } })
  })

  test('a binary deleted-by-them conflict can be staged and continued', async () => {
    s = await startScenario(scratch)
    const path = 'math.ts'
    const binaryContent = '\u0000ours binary\u0000content\n'
    const expectedBytes = Buffer.from(binaryContent)
    diverge(s, { [path]: null }, { [path]: binaryContent })
    expect(s.gitTry(null, 'merge', 'other').code).toBe(1)

    const merged = await status(s)
    expect(conflictRows(merged)).toEqual([[path, 'deleted_by_them', 'unresolved']])
    const refusal = await s.fails(s.api('conflictFile', { path, peek: true }))
    expect(refusal.data.reason).toBe('not-allowed')

    const conflict = merged.entries.find((entry) => entry.area === 'conflicts' && entry.path === path)!
    const context = { markersGone: new Set([path]), unreadableConflicts: new Set([path]) }
    expect(entryActions(conflict, context).stage).toBe(true)
    const paths = actionPaths([conflict], 'stage', context)
    expect(paths).toEqual([path])
    await s.api('stage', { paths })

    expect(s.gitIn('ls-files', '-u')).toBe('')
    const staged = await status(s)
    expect(staged.entries.some((entry) => entry.path === path && entry.conflict?.state === 'unresolved')).toBe(false)

    expect(await s.api('continue')).toEqual({ finished: true, operation: 'none' })
    expect(readFileSync(join(s.feat.path, path))).toEqual(expectedBytes)
    expect(s.gitIn('rev-parse', 'HEAD^2')).toBe(s.gitIn('rev-parse', 'other'))
    expect(await status(s)).toMatchObject({ operation: 'none', entries: [] })
  })
})

describe('continue', () => {
  test('SC-42: a rebase continues commit by commit, and continue refuses with conflicts left or nothing running (CLI)', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'a.ts': 'theirs a\n', 'b.ts': 'theirs b\n' }, { 'a.ts': 'ours a\n' })
    s.write('b.ts', 'ours b\n')
    s.gitIn('commit', '-q', '-am', 'second')
    expect(s.gitTry(null, 'rebase', 'other').code).toBe(1)

    const unresolved = await s.cli(['git', 'continue', '--json'])
    expect(jsonError(unresolved)).toMatchObject({ reason: 'unresolved', message: 'Resolve every conflict before continuing.' })
    expect((await status(s)).operation).toBe('rebase')

    s.write('a.ts', 'resolved a\n')
    await s.cli(['git', 'stage', '--paths', 'a.ts'])
    const first = JSON.parse((await s.cli(['git', 'continue', '--json'])).stdout)
    expect(first).toEqual({ finished: false, operation: 'rebase' })
    const stopped = await status(s)
    expect(stopped.operation).toBe('rebase')
    expect(conflictRows(stopped)).toEqual([['b.ts', 'both_modified', 'unresolved']])

    s.write('b.ts', 'resolved b\n')
    await s.cli(['git', 'stage', '--paths', 'b.ts'])
    const second = JSON.parse((await s.cli(['git', 'continue', '--json'])).stdout)
    expect(second).toEqual({ finished: true, operation: 'none' })
    expect(s.gitIn('log', '--format=%s', '-3')).toBe('second\nours\ntheirs')

    const nothing = await s.cli(['git', 'continue', '--json'])
    expect(jsonError(nothing)).toMatchObject({ reason: 'nothing-to-continue', message: 'Nothing to continue.' })
  })

  test('a hook failing the merge commit is classified like a commit, and the merge stays in progress', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    s.write('a.ts', 'ra\n')
    s.write('b.ts', 'rb\n')
    await s.api('stage', { paths: ['a.ts', 'b.ts'] })
    installHook(s, 'pre-commit', 'echo "eslint found 1 problem"; exit 1')
    const before = s.changedEvents()

    const failure = await s.fails(s.api('continue'))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Lint failed during commit.', data: { reason: 'lint', summary: 'Lint failed during commit.' } })
    expect(failure.data.output).toContain('eslint found 1 problem')
    expect((await status(s)).operation).toBe('merge')
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(before)
  })

  test('SC-30: a running continue shows as busy and refuses a second locked call', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    s.write('a.ts', 'ra\n')
    s.write('b.ts', 'rb\n')
    await s.api('stage', { paths: ['a.ts', 'b.ts'] })
    const gate = join(s.feat.path, '..', `gate-${Date.now()}`)
    installHook(s, 'pre-commit', `while [ ! -f "${gate}" ]; do sleep 0.05; done`)

    const scenario = s
    const running = s.api('continue')
    await waitForAsync(async () => (await status(scenario)).busy === 'continue', 10_000)
    expect(await s.fails(s.api('continue'))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'A continue is already running in this worktree.',
      data: { reason: 'busy' }
    })
    expect(await s.fails(s.api('abort', { yes: true }))).toMatchObject({ data: { reason: 'busy' } })

    writeFileSync(gate, '')
    expect(await running).toEqual({ finished: true, operation: 'none' })
    expect((await status(s)).busy).toBeNull()
  })
})

describe('abort', () => {
  test('SC-43: abort asks first with the merge wording; declining changes nothing, confirming restores the pre-merge commit (CLI)', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    const head = s.gitIn('rev-parse', 'HEAD')
    const question =
      'Abort merge? This cancels the merge in progress and can discard conflict resolutions made during this merge.'
    expect(await s.api('describeAbort')).toBe(question)

    const declined = await s.cliAsk(['git', 'abort'], false)
    expect(declined.stderr).toContain(`confirm in Quirky: ${question}`)
    expect(declined.code).not.toBe(0)
    expect((await status(s)).operation).toBe('merge')

    const confirmed = await s.cliAsk(['git', 'abort'], true)
    expect(confirmed.code).toBe(0)
    expect(s.gitIn('rev-parse', 'HEAD')).toBe(head)
    expect(await status(s)).toMatchObject({ operation: 'none', entries: [] })
  })

  test('abort with --yes needs no ask, clears what was opened, and a rebase reads "rebase"', async () => {
    s = await startScenario(scratch)
    mergeAB(s)
    await s.api('conflictFile', { path: 'a.ts' })
    const before = s.changedEvents()
    expect((await s.cli(['git', 'abort', '--yes'])).code).toBe(0)
    await waitFor(() => s!.changedEvents() > before)
    expect((await status(s)).operation).toBe('none')

    diverge(s, { 'a.ts': 'theirs2\n' }, { 'a.ts': 'ours2\n' }, { branch: 'other2' })
    expect(s.gitTry(null, 'rebase', 'other2').code).toBe(1)
    expect(await s.api('describeAbort')).toBe(
      'Abort rebase? This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
    )
    await s.api('abort', { yes: true })
    expect((await status(s)).operation).toBe('none')
    expect(await s.fails(s.api('describeAbort'))).toMatchObject({ data: { reason: 'not-allowed' }, message: 'Nothing to abort.' })
  })
})
