import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type GitCompare, type GitHistory, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { git } from '../../../quirky.repo/test/git-fixtures'
import { addPeer, commitInFeat, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('')

/** Sets feat's own base through the worktree plugin, bypassing setBase's validation. */
const forceBase = (scenario: Scenario, baseRef: string | null, worktree: Worktree = scenario.feat) =>
  scenario.client.callAny('quirky.worktree/set', { worktree: worktree.id, baseRef })

/** Adds `count` empty commits to feat in one git process. */
function addCommits(scenario: Scenario, count: number): void {
  const stream = Array.from(
    { length: count },
    (_, i) =>
      `commit refs/heads/zoe/feat\nmark :${i + 1}\ncommitter T <t@example.com> ${1_700_000_000 + i} +0000\ndata 8\nc ${String(i).padStart(5, '0')}\n${i === 0 ? `from ${scenario.gitIn('rev-parse', 'HEAD')}\n` : ''}\n`
  ).join('')
  const result = Bun.spawnSync(['git', 'fast-import', '--quiet', '--force'], { cwd: scenario.feat.path, stdin: new TextEncoder().encode(stream), env: process.env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  scenario.gitIn('reset', '-q', '--hard', 'refs/heads/zoe/feat')
}

describe('compare', () => {
  test('SC-47: lists what the branch changed since the merge base, with totals, and not the base\'s own newer commit (CLI)', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'math.ts': `a\nB\nC\nD\ne\n${lines(9, 'n')}`, 'util.ts': lines(20) }, 'first')
    commitInFeat(s, { 'util.ts': lines(40) }, 'second')
    const peer = addPeer(s, scratch() + '/peer')
    peer.commit({ 'elsewhere.txt': 'x\n' }, 'newer main')
    peer.push('main')
    s.gitIn('fetch', '-q')

    const result = await s.cli(['git', 'compare', '--json'])
    expect(result.code).toBe(0)
    const compare = JSON.parse(result.stdout) as GitCompare
    expect(compare).toMatchObject({
      status: 'ready',
      base: 'origin/main',
      baseSource: 'worktree',
      message: null,
      ahead: 2,
      behind: 1,
      added: 52,
      removed: 3,
      baseOid: s.gitIn('rev-parse', 'origin/main'),
      headOid: s.gitIn('rev-parse', 'HEAD'),
      mergeBase: s.gitIn('rev-parse', 'origin/main~1')
    })
    expect(compare.entries).toEqual([
      { path: 'math.ts', status: 'modified', added: 12, removed: 3, binary: false },
      { path: 'util.ts', status: 'added', added: 40, removed: 0, binary: false }
    ])
  })

  test('SC-48: a base that does not exist, an unborn HEAD and a branch with no shared history each explain themselves (CLI)', async () => {
    s = await startScenario(scratch)
    await forceBase(s, 'origin/gone')
    const gone = JSON.parse((await s.cli(['git', 'compare', '--json'])).stdout)
    expect(gone).toMatchObject({
      status: 'invalid-base',
      base: 'origin/gone',
      baseSource: 'worktree',
      message: 'Base ref origin/gone could not be resolved in this repository.',
      baseOid: null,
      entries: []
    })
    await forceBase(s, null)

    s.gitIn('checkout', '-q', '--orphan', 'solo')
    s.gitIn('rm', '-rfq', '.')
    const unborn = JSON.parse((await s.cli(['git', 'compare', '--json'])).stdout)
    expect(unborn).toMatchObject({
      status: 'unborn-head',
      base: 'origin/main',
      baseSource: 'detected',
      message: 'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.',
      headOid: null
    })

    s.gitIn('commit', '-q', '--allow-empty', '-m', 'solo')
    const unrelated = JSON.parse((await s.cli(['git', 'compare', '--json'])).stdout)
    expect(unrelated).toMatchObject({
      status: 'no-merge-base',
      message: 'This branch and origin/main do not share a merge base, so compare-to-base is unavailable.',
      mergeBase: null
    })
  })

  test('with no base anywhere the compare says so as a result, not an error', async () => {
    s = await startScenario(scratch)
    await forceBase(s, null)
    s.gitIn('remote', 'set-head', 'origin', '-d')
    git(s.repoDir, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(s.repoDir, 'branch', '-m', 'main', 'trunk')
    expect(await s.api('compare')).toMatchObject({
      status: 'invalid-base',
      base: null,
      baseSource: null,
      message: 'No base ref could be found for this repository.',
      entries: []
    })
    expect(await s.api('compare', { base: 'trunk' })).toMatchObject({ status: 'ready', base: 'trunk', baseSource: 'param' })
  })

  test('a base param wins over every other source', async () => {
    s = await startScenario(scratch)
    commitInFeat(s, { 'util.ts': 'u\n' })
    expect(await s.api('compare', { base: 'main' })).toMatchObject({ base: 'main', baseSource: 'param', ahead: 1, added: 1 })
    expect(await s.api('compare', { base: 'origin/missing' })).toMatchObject({ status: 'invalid-base', baseSource: 'param' })
  })

  test('SC-49: the base comes from the worktree, then the project, then the detected default; Branch upstream only fills the gaps (API)', async () => {
    s = await startScenario(scratch)
    const peer = addPeer(s, scratch() + '/peer')
    for (const branch of ['release', 'develop']) {
      peer.git('checkout', '-q', '-B', branch, 'origin/main')
      peer.commit({ [`${branch}.txt`]: 'x\n' }, branch)
      peer.push(branch)
    }
    git(s.repoDir, 'fetch', '-q')

    const create = async (name: string, base: string) =>
      ((await s!.client.callAny('quirky.worktree/create', { repo: s!.repo.id, name, branchName: `zoe/${name}`, base, setup: 'skip' })) as WorktreeCreateResult).worktree
    const w1 = await create('w1', 'origin/release')
    const w2 = await s.addWorktree('w2')
    const w3 = await s.addWorktree('w3')
    const w4 = await s.addWorktree('w4')
    for (const worktree of [w2, w3, w4]) await forceBase(s, null, worktree)
    for (const worktree of [w1, w4]) await s.api('push', { worktree: worktree.id })
    const baseOf = async (worktree: Worktree) => {
      const { base, baseSource } = await s!.api('compare', { worktree: worktree.id })
      return [base, baseSource]
    }

    await s.client.callAny('quirky.repo/set', { repo: s.repo.id, defaultBase: 'origin/develop' })
    expect(await baseOf(w1)).toEqual(['origin/release', 'worktree'])
    expect(await baseOf(w2)).toEqual(['origin/develop', 'project'])
    await s.client.callAny('quirky.repo/set', { repo: s.repo.id, defaultBase: '' })
    expect(await baseOf(w3)).toEqual(['origin/main', 'detected'])
    expect(await baseOf(w4)).toEqual(['origin/main', 'detected'])

    await s.client.callAny('setting.set', { id: 'setting:quirky.git/compareBase', value: 'branch-upstream' })
    expect(await baseOf(w1)).toEqual(['origin/release', 'worktree'])
    expect(await baseOf(w4)).toEqual(['origin/zoe/w4', 'upstream'])
    expect(await baseOf(w3)).toEqual(['origin/main', 'detected'])
    expect(await s.api('rebaseFromBase', { worktree: w4.id })).toEqual({ ok: true, base: 'origin/main' })
  })
})

describe('setBase and branches', () => {
  test('SC-50: setBase writes the worktree\'s own base when it has one and the project\'s otherwise; clear undoes it (CLI)', async () => {
    s = await startScenario(scratch)
    const peer = addPeer(s, scratch() + '/peer')
    peer.git('checkout', '-q', '-B', 'release', 'origin/main')
    peer.commit({ 'release.txt': 'r\n' }, 'release')
    peer.push('release')
    git(s.repoDir, 'fetch', '-q')
    git(s.repoDir, 'branch', 'release', 'origin/release')
    const w2 = await s.addWorktree('w2')
    await forceBase(s, null, w2)
    const shown = async (worktree: Worktree) => ((await s!.client.callAny('quirky.worktree/show', { worktree: worktree.id })) as Worktree).baseRef
    const projectBase = async () => ((await s!.client.callAny('quirky.repo/show', { repo: s!.repo.id })) as { settings: { defaultBase?: string | null } }).settings.defaultBase
    const before = s.changedEvents()

    expect(JSON.parse((await s.cli(['git', 'setBase', '--base', 'release', '--json'])).stdout)).toEqual({ target: 'worktree', base: 'release' })
    expect(await shown(s.feat)).toBe('release')
    expect(await projectBase()).toBeFalsy()
    expect((await s.api('compare')).baseSource).toBe('worktree')

    const second = await s.cli(['git', 'setBase', '--base', 'origin/main', '--json'], { cwd: w2.path })
    expect(JSON.parse(second.stdout)).toEqual({ target: 'project', base: 'origin/main' })
    expect(await shown(w2)).toBeNull()
    expect(await projectBase()).toBe('origin/main')
    expect(await s.api('compare', { worktree: w2.id })).toMatchObject({ base: 'origin/main', baseSource: 'project' })

    expect(JSON.parse((await s.cli(['git', 'setBase', '--clear', '--json'], { cwd: w2.path })).stdout)).toEqual({ target: 'project', base: null })
    expect(await projectBase()).toBeFalsy()
    expect(await s.api('compare', { worktree: w2.id })).toMatchObject({ baseSource: 'detected' })
    expect(await s.api('setBase', { clear: true })).toEqual({ target: 'worktree', base: null })
    expect(await shown(s.feat)).toBeNull()
    await Bun.sleep(80)
    expect(s.changedEvents()).toBe(before + 4)
  })

  test('setBase refuses a base that is no commit, giving both or neither of base and clear, and a blank base', async () => {
    s = await startScenario(scratch)
    expect(await s.fails(s.api('setBase', { base: 'origin/nope' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Base ref origin/nope could not be resolved in this repository.',
      data: { reason: 'invalid-base' }
    })
    expect(await s.fails(s.api('setBase', { base: 'main', clear: true }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await s.fails(s.api('setBase', {}))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await s.fails(s.api('setBase', { base: '  ' }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await s.fails(s.api('setBase', { base: '--help' }))).toMatchObject({ data: { reason: 'invalid-base' } })
    expect((await s.client.callAny('quirky.worktree/show', { worktree: s.feat.id }) as Worktree).baseRef).toBe('origin/main')
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(0)
  })

  test('SC-50: branches lists locals first then remotes, filtered by a case-insensitive substring, and names the current one', async () => {
    s = await startScenario(scratch)
    git(s.repoDir, 'branch', 'release', 'origin/main')
    const peer = addPeer(s, scratch() + '/peer')
    peer.git('checkout', '-q', '-B', 'release', 'origin/main')
    peer.push('release')
    git(s.repoDir, 'fetch', '-q')

    expect(await s.api('branches', { query: 'REL' })).toEqual({
      refs: [
        { name: 'release', kind: 'local' },
        { name: 'origin/release', kind: 'remote' }
      ],
      current: 'zoe/feat'
    })
    const all = await s.api('branches')
    expect(all.refs.map((ref: { name: string }) => ref.name)).toEqual(['main', 'release', 'zoe/feat', 'origin/main', 'origin/release'])
    expect(JSON.parse((await s.cli(['git', 'branches', '--query', 'main', '--json'])).stdout).refs.map((ref: { name: string }) => ref.name)).toEqual(['main', 'origin/main'])
    s.gitIn('checkout', '-q', '--detach')
    expect((await s.api('branches')).current).toBeNull()
  })
})

describe('history', () => {
  test('SC-52: lists 50 commits newest first with their fields, and a limit past the cap returns everything up to 200 (CLI)', async () => {
    s = await startScenario(scratch)
    addCommits(s, 57)
    s.gitIn('checkout', '-q', '-b', 'side', 'HEAD~3')
    commitInFeat(s, { 'side.txt': 's\n' }, 'side work')
    s.gitIn('checkout', '-q', 'zoe/feat')
    s.gitIn('merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    s.gitIn('tag', 'v1')
    expect(s.gitIn('rev-list', '--count', 'HEAD')).toBe('60')

    const first = JSON.parse((await s.cli(['git', 'history', '--json'])).stdout) as GitHistory
    expect(first.commits).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    const tip = first.commits[0]!
    expect(tip).toMatchObject({
      oid: s.gitIn('rev-parse', 'HEAD'),
      parents: [s.gitIn('rev-parse', 'HEAD^1'), s.gitIn('rev-parse', 'HEAD^2')],
      author: 'Test',
      email: 'test@example.com',
      subject: 'Merge side',
      body: ''
    })
    expect(tip.refs).toEqual(expect.arrayContaining(['HEAD -> zoe/feat', 'tag: v1']))
    expect(tip.authoredAt).toBeGreaterThan(1_700_000_000_000)
    expect(typeof tip.committedAt).toBe('number')
    expect(first.commits.map((commit) => commit.oid)).toEqual(s.gitIn('log', '--topo-order', '--format=%H', '-n50').split('\n'))

    const capped = await s.api('history', { limit: 200 })
    expect(capped.commits).toHaveLength(60)
    expect(capped.hasMore).toBe(false)
    expect((await s.api('history', { limit: 3 })).commits).toHaveLength(3)
  })

  test('SC-52: the limit is capped at 200 even when more commits exist', async () => {
    s = await startScenario(scratch)
    addCommits(s, 230)
    const result = await s.api('history', { limit: 200 })
    expect(result.commits).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    expect((await s.api('history', { limit: 1 })).commits).toHaveLength(1)
  })

  test('an unborn HEAD has no history', async () => {
    s = await startScenario(scratch)
    s.gitIn('checkout', '-q', '--orphan', 'solo')
    expect(await s.api('history')).toEqual({ commits: [], hasMore: false })
  })
})

describe('commitFiles', () => {
  test('SC-53: lists what a commit changed with renames, diffs the renamed file across the commit, and treats the root against nothing (CLI)', async () => {
    s = await startScenario(scratch)
    const root = s.gitIn('rev-list', '--max-parents=0', 'HEAD')
    s.write('math.ts', 'a\nb\nc\nd\ne\nf\ng\n')
    s.gitIn('mv', 'old.ts', 'new.ts')
    s.write('new.ts', 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
    const commit = commitInFeat(s, {}, 'change and rename')
    const parent = s.gitIn('rev-parse', 'HEAD~1')

    const files = JSON.parse((await s.cli(['git', 'commitFiles', '--commit', commit, '--json'])).stdout)
    expect(files).toEqual({
      commit,
      parent,
      entries: [
        { path: 'math.ts', status: 'modified', added: 2, removed: 0, binary: false },
        { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', added: 1, removed: 0, binary: false }
      ]
    })
    const viaRef = await s.api('commitFiles', { commit: 'HEAD' })
    expect(viaRef.commit).toBe(commit)

    const diff = JSON.parse((await s.cli(['git', 'diff', '--source', 'commit', '--commit', commit, '--path', 'new.ts', '--old-path', 'old.ts', '--json'])).stdout)
    expect(diff).toMatchObject({
      path: 'new.ts',
      oldPath: 'old.ts',
      source: 'commit',
      original: 'export const a = 1\nexport const b = 2\n',
      modified: 'export const a = 1\nexport const b = 2\nexport const c = 3\n'
    })

    const first = JSON.parse((await s.cli(['git', 'commitFiles', '--commit', root, '--json'])).stdout)
    expect(first).toMatchObject({ commit: root, parent: null })
    expect(first.entries.map((entry: { path: string; status: string }) => [entry.path, entry.status])).toEqual(
      ['README.md', 'a.ts', 'b.ts', 'c.ts', 'math.ts', 'old.ts'].map((path) => [path, 'added'])
    )
    expect(await s.api('diff', { source: 'commit', commit: root, path: 'a.ts' })).toMatchObject({ original: '', modified: 'one\n' })
  })

  test('an unknown commit or a flag-like value is invalid-params', async () => {
    s = await startScenario(scratch)
    for (const commit of ['a'.repeat(40), 'no-such-ref', '--output=/tmp/x']) {
      expect(await s.fails(s.api('commitFiles', { commit })), commit).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })
})
