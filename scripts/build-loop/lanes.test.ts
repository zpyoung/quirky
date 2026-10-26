import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { block, claim, land, locate, withLock, type Repo } from './lanes'
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

  test('refuses an item that is not in progress', async () => {
    await expect(land(repo, 'a', [['true']])).rejects.toThrow('a is todo, not in-progress')
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
