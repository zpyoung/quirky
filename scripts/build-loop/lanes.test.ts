import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { add, block, claim, land, locate, merge, requestLand, waitForDeps, withLock, type Repo } from './lanes'
import { load, save, type Item } from './queue'

const item = (id: string, deps: string[] = []): Item => ({ id, milestone: 'M1', title: id, docs: [], deps, status: 'todo' })

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

let dir: string
let repo: Repo

// a throwaway repo laid out like the real one: a lane checkout plus the integration worktree on build/roadmap
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'build-loop-'))
  git(dir, 'init', '-q', '-b', 'build/roadmap')
  git(dir, 'config', 'user.email', 'loop@test')
  git(dir, 'config', 'user.name', 'loop')
  mkdirSync(join(dir, 'docs/loop/decisions'), { recursive: true })
  writeFileSync(join(dir, 'docs/loop/decisions/.gitkeep'), '')
  writeFileSync(join(dir, 'docs/loop/BLOCKERS.md'), '# Blockers\n')
  save([item('a'), item('b'), item('c', ['a'])], join(dir, 'docs/loop/queue.json'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'seed')
  git(dir, 'checkout', '-q', '--detach')
  git(dir, 'worktree', 'add', '-q', join(dir, '.git/build-loop/integration'), 'build/roadmap')
  repo = locate(dir)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const queue = () => load(join(repo.integration, 'docs/loop/queue.json'))
const head = () => git(repo.integration, 'rev-parse', 'HEAD')

/** Makes `build/<id>` off build/roadmap with one committed file. */
function branch(id: string, file: string, text: string): void {
  git(dir, 'checkout', '-q', '-b', `build/${id}`, 'build/roadmap')
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', id)
  git(dir, 'checkout', '-q', '--detach')
}

describe('claim', () => {
  test('gives each lane its own item and commits the claim on build/roadmap', async () => {
    expect(await claim(repo, 1)).toMatchObject({ kind: 'item', item: { id: 'a', status: 'in-progress', lane: 1 } })
    expect(await claim(repo, 2)).toMatchObject({ kind: 'item', item: { id: 'b', lane: 2 } })
    expect(git(repo.integration, 'log', '-1', '--format=%s')).toBe('chore(build): start b (lane 2)')
  })

  test('returns a lane its own in-progress item again, so a crashed iteration resumes it', async () => {
    await claim(repo, 1)
    const before = head()
    expect(await claim(repo, 1)).toMatchObject({ kind: 'item', item: { id: 'a' } })
    expect(head()).toBe(before)
  })

  test('reports busy while other lanes hold what the rest depends on', async () => {
    await claim(repo, 1)
    await claim(repo, 2)
    expect(await claim(repo, 3)).toMatchObject({ kind: 'busy', running: [{ id: 'a' }, { id: 'b' }] })
  })
})

describe('land', () => {
  test('merges the branch, marks the item done and deletes the branch', async () => {
    await claim(repo, 1)
    branch('a', 'a.txt', 'a\n')
    await land(repo, 'a', [['true']])
    expect(readFileSync(join(repo.integration, 'a.txt'), 'utf8')).toBe('a\n')
    expect(queue().find((entry) => entry.id === 'a')).toEqual({ ...item('a'), status: 'done' })
    expect(existsSync(join(repo.integration, 'docs/loop/DECISIONS.md'))).toBe(true)
    expect(git(dir, 'branch', '--list', 'build/a')).toBe('')
  })

  test('leaves build/roadmap untouched when verification fails', async () => {
    await claim(repo, 1)
    branch('a', 'a.txt', 'a\n')
    const before = head()
    await expect(land(repo, 'a', [['false']])).rejects.toThrow('failed on the merge result')
    expect(head()).toBe(before)
    expect(git(repo.integration, 'status', '--porcelain')).toBe('')
    expect(queue().find((entry) => entry.id === 'a')?.status).toBe('in-progress')
  })

  test('skips verification when the branch changes only docs/', async () => {
    await claim(repo, 1)
    branch('a', 'docs/notes.md', 'notes\n')
    await land(repo, 'a', [['false']])
    expect(readFileSync(join(repo.integration, 'docs/notes.md'), 'utf8')).toBe('notes\n')
    expect(queue().find((entry) => entry.id === 'a')?.status).toBe('done')
  })

  test('refuses a branch that conflicts with build/roadmap', async () => {
    await claim(repo, 1)
    await claim(repo, 2)
    branch('a', 'shared.txt', 'from a\n')
    branch('b', 'shared.txt', 'from b\n')
    await land(repo, 'a', [['true']])
    const before = head()
    await expect(land(repo, 'b', [['true']])).rejects.toThrow('conflicts with build/roadmap')
    expect(head()).toBe(before)
    expect(git(repo.integration, 'status', '--porcelain')).toBe('')
  })

  test('moves build/roadmap only after verification passes', async () => {
    await claim(repo, 1)
    branch('a', 'a.txt', 'a\n')
    const before = head()
    const seen = join(mkdtempSync(join(tmpdir(), 'seen-')), 'ref')
    const recordRef = (ok: boolean) => [['sh', '-c', `git rev-parse build/roadmap > ${seen} && ${ok}`]]
    await expect(land(repo, 'a', recordRef(false))).rejects.toThrow('failed on the merge result')
    expect(readFileSync(seen, 'utf8').trim()).toBe(before)
    expect(git(repo.integration, 'symbolic-ref', '--short', 'HEAD')).toBe('build/roadmap')
    await land(repo, 'a', recordRef(true))
    expect(readFileSync(seen, 'utf8').trim()).toBe(before)
    expect(git(repo.integration, 'log', '-1', '--format=%s', 'build/roadmap')).toBe('chore(build): finish a')
    expect(git(repo.integration, 'symbolic-ref', '--short', 'HEAD')).toBe('build/roadmap')
  })

  test('lets queue commands run while a land is verified, and lands over their commits', async () => {
    await claim(repo, 1)
    branch('a', 'a.txt', 'a\n')
    const out = join(mkdtempSync(join(tmpdir(), 'claim-')), 'claim.json')
    const queueTs = join(import.meta.dir, 'queue.ts')
    await land(repo, 'a', [['sh', '-c', `cd ${dir} && bun ${queueTs} claim --lane 2 > ${out}`]])
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ kind: 'item', item: { id: 'b', lane: 2 } })
    expect(queue().map((entry) => [entry.id, entry.status])).toEqual([['a', 'done'], ['b', 'in-progress'], ['c', 'todo']])
    expect(readFileSync(join(repo.integration, 'a.txt'), 'utf8')).toBe('a\n')
    expect(git(repo.integration, 'status', '--porcelain')).toBe('')
  }, 20_000)

  test('refuses an item that is not in progress', async () => {
    await expect(land(repo, 'a', [['true']])).rejects.toThrow('a is todo, not in-progress')
  })
})

describe('batched land', () => {
  // a verify command that counts its runs in a file outside the integration worktree
  let runs: string
  const counted = (check = 'true') => [['sh', '-c', `echo run >> ${runs} && ${check}`]]
  const runCount = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0)
  const statusOf = (id: string) => queue().find((entry) => entry.id === id)?.status

  beforeEach(async () => {
    runs = join(mkdtempSync(join(tmpdir(), 'runs-')), 'count')
    await claim(repo, 1)
    await claim(repo, 2)
  })

  test("lands another lane's waiting item in the same verified run", async () => {
    branch('a', 'a.txt', 'a\n')
    branch('b', 'b.txt', 'b\n')
    requestLand(repo, 'b')
    await land(repo, 'a', counted())
    expect(runCount()).toBe(1)
    expect([statusOf('a'), statusOf('b')]).toEqual(['done', 'done'])
    expect(git(repo.integration, 'log', '--format=%s', '-2')).toBe('chore(build): finish b\nchore(build): finish a')
    await land(repo, 'b', counted())
    expect(runCount()).toBe(1)
  })

  test('leaves a waiting item that conflicts for its own lane', async () => {
    branch('a', 'shared.txt', 'from a\n')
    branch('b', 'shared.txt', 'from b\n')
    requestLand(repo, 'b')
    await land(repo, 'a', counted())
    expect([statusOf('a'), statusOf('b')]).toEqual(['done', 'in-progress'])
    expect(git(repo.integration, 'status', '--porcelain')).toBe('')
    await expect(land(repo, 'b', counted())).rejects.toThrow('conflicts with build/roadmap')
  })

  test('verifies its own item alone when the batch fails, and makes the other land alone', async () => {
    branch('a', 'a.txt', 'a\n')
    branch('b', 'b.txt', 'b\n')
    requestLand(repo, 'b')
    const check = 'test ! -f b.txt'
    await land(repo, 'a', counted(check))
    expect(runCount()).toBe(2)
    expect([statusOf('a'), statusOf('b')]).toEqual(['done', 'in-progress'])
    expect(readFileSync(join(repo.lands, 'b'), 'utf8')).toContain('"solo":true')
    await expect(land(repo, 'b', counted(check))).rejects.toThrow('failed on the merge result')
    expect(runCount()).toBe(3)
    expect(existsSync(join(repo.lands, 'b'))).toBe(false)
  })

  test('skips a waiting item whose branch moved after it asked to land', async () => {
    branch('a', 'a.txt', 'a\n')
    branch('b', 'b.txt', 'b\n')
    requestLand(repo, 'b')
    git(dir, 'checkout', '-q', 'build/b')
    writeFileSync(join(dir, 'b2.txt'), 'more\n')
    git(dir, 'add', 'b2.txt')
    git(dir, 'commit', '-q', '-m', 'more')
    git(dir, 'checkout', '-q', '--detach')
    await land(repo, 'a', counted())
    expect([statusOf('a'), statusOf('b')]).toEqual(['done', 'in-progress'])
  })

  test('takes an early item into the batch ahead of older requests', async () => {
    const items = queue()
    save([...items, { ...item('d'), status: 'in-progress', lane: 3, early: true }], join(repo.integration, 'docs/loop/queue.json'))
    git(repo.integration, 'commit', '-qam', 'early d')
    branch('a', 'a.txt', 'a\n')
    branch('b', 'b.txt', 'b\n')
    branch('d', 'd.txt', 'd\n')
    requestLand(repo, 'b')
    await Bun.sleep(20)
    requestLand(repo, 'd')
    await land(repo, 'a', counted())
    expect(git(repo.integration, 'log', '--format=%s', '-3')).toBe('chore(build): finish b\nchore(build): finish d\nchore(build): finish a')
  })

  test('ignores a request whose process has died', async () => {
    branch('a', 'a.txt', 'a\n')
    branch('b', 'b.txt', 'b\n')
    mkdirSync(repo.lands, { recursive: true })
    writeFileSync(join(repo.lands, 'b'), JSON.stringify({ pid: Bun.spawnSync(['true']).pid, head: git(dir, 'rev-parse', 'build/b') }))
    await land(repo, 'a', counted())
    expect([statusOf('a'), statusOf('b')]).toEqual(['done', 'in-progress'])
    expect(existsSync(join(repo.lands, 'b'))).toBe(false)
  })
})

test('block records the entry and keeps the decision log from blocked/<id>', async () => {
  await claim(repo, 1)
  branch('a', 'docs/loop/decisions/a.md', '# a decisions\n\n## D1: Pick x\n- **Reversibility:** easy\n')
  git(dir, 'branch', '-m', 'build/a', 'blocked/a')
  await block(repo, 'a', '## a\nStopped at the build.')
  expect(readFileSync(join(repo.integration, 'docs/loop/BLOCKERS.md'), 'utf8')).toContain('## a\nStopped at the build.')
  expect(queue().find((entry) => entry.id === 'a')?.status).toBe('blocked')
  expect(readFileSync(join(repo.integration, 'docs/loop/DECISIONS.md'), 'utf8')).toContain('[a D1]')
})

test('merge lands a branch that is not a queue item', async () => {
  git(dir, 'checkout', '-q', '-b', 'native/n1', 'build/roadmap')
  writeFileSync(join(dir, 'n.txt'), 'n\n')
  git(dir, 'add', 'n.txt')
  git(dir, 'commit', '-q', '-m', 'n')
  git(dir, 'checkout', '-q', '--detach')
  await merge(repo, 'native/n1', [['true']])
  expect(readFileSync(join(repo.integration, 'n.txt'), 'utf8')).toBe('n\n')
  expect(git(dir, 'branch', '--list', 'native/n1')).toBe('')
})

describe('add', () => {
  test('inserts new todo items ahead of the first * item', async () => {
    const items = queue()
    save([...items, item('sweep', ['*'])], join(repo.integration, 'docs/loop/queue.json'))
    git(repo.integration, 'commit', '-qam', 'sweep')
    await add(repo, [{ ...item('fix', ['a']), status: 'done' }])
    expect(queue().map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'fix', 'sweep'])
    expect(queue().find((entry) => entry.id === 'fix')?.status).toBe('todo')
  })

  test('rejects a duplicate id or an unknown dependency', async () => {
    await expect(add(repo, [item('a')])).rejects.toThrow('already in the queue')
    await expect(add(repo, [item('z', ['nope'])])).rejects.toThrow('unknown "nope"')
  })
})

test('waitForDeps reports the dependencies still pending', async () => {
  await claim(repo, 1)
  expect(await waitForDeps(repo, 'c', 0)).toEqual({ ready: false, pending: ['a'] })
  branch('a', 'a.txt', 'a\n')
  await land(repo, 'a', [['true']])
  expect(await waitForDeps(repo, 'c', 0)).toEqual({ ready: true, pending: [] })
})

describe('withLock', () => {
  test('runs holders one at a time', async () => {
    const order: string[] = []
    const hold = (name: string) =>
      withLock(repo.lock, async () => {
        order.push(`${name} in`)
        await Bun.sleep(50)
        order.push(`${name} out`)
      })
    await Promise.all([hold('x'), hold('y')])
    expect(order).toEqual(['x in', 'x out', 'y in', 'y out'])
  })

  test('takes over a lock whose holder has died', async () => {
    const dead = Bun.spawnSync(['true']).pid
    mkdirSync(repo.lock)
    writeFileSync(join(repo.lock, 'owner'), String(dead))
    expect(await withLock(repo.lock, () => 'ran', 5_000)).toBe('ran')
  })
})
