/**
 * The shared side of the build queue. Every lane reads and changes the queue only through the
 * integration worktree, which keeps `build/roadmap` checked out and is never worked in, and only
 * while holding the lock, so two lanes never claim one item or land at once.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rebuild } from './decisions'
import { load, next, QUEUE_FILE, save, setStatus, STATUSES, type Item, type Next, type Status } from './queue'

export type Repo = { integration: string; lock: string }

export const VERIFY = [
  ['bun', 'run', 'test'],
  ['bun', 'test', 'scripts'],
  ['bun', 'run', 'typecheck'],
]

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

/** The integration worktree and lock live in the shared git dir, so every worktree finds the same ones. */
export function locate(cwd = process.cwd()): Repo {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const repo = { integration: join(common, 'build-loop', 'integration'), lock: join(common, 'build-loop', 'lock') }
  if (!existsSync(repo.integration)) throw new Error(`no integration worktree at ${repo.integration}; see docs/loop/README.md`)
  return repo
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Runs `fn` holding the queue lock, taking over a lock whose holder has died. */
export async function withLock<T>(lock: string, fn: () => T | Promise<T>, timeoutMs = 30 * 60_000): Promise<T> {
  const owner = join(lock, 'owner')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(owner, String(process.pid))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // the holder writes its pid just after mkdir, so a missing pid is only stale once it's old
      const pid = existsSync(owner) ? Number(readFileSync(owner, 'utf8')) : undefined
      const stale = pid === undefined ? Date.now() - statSync(lock).mtimeMs > 60_000 : !alive(pid)
      if (stale) rmSync(lock, { recursive: true, force: true })
      else if (Date.now() > deadline) throw new Error(`queue lock held by pid ${pid} for over ${timeoutMs / 60_000} minutes`)
      else await Bun.sleep(1000)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

const queuePath = (repo: Repo) => join(repo.integration, QUEUE_FILE)

function commit(repo: Repo, message: string): void {
  git(repo.integration, 'add', 'docs/loop')
  git(repo.integration, 'commit', '-q', '-m', message)
}

function requireClean(repo: Repo): void {
  const dirty = git(repo.integration, 'status', '--porcelain')
  if (dirty) throw new Error(`the integration worktree has uncommitted changes:\n${dirty}`)
}

/** Returns what `lane` should work on, claiming the next ready item for it if it holds none. */
export function claim(repo: Repo, lane: number): Promise<Next> {
  return withLock(repo.lock, () => {
    const items = load(queuePath(repo))
    const result = next(items, lane)
    if (result.kind !== 'item' || result.item.status !== 'todo') return result
    requireClean(repo)
    const claimed = setStatus(items, result.item.id, 'in-progress', lane)
    save(claimed, queuePath(repo))
    commit(repo, `chore(build): start ${result.item.id} (lane ${lane})`)
    return { kind: 'item', item: claimed.find((item) => item.id === result.item.id)! }
  })
}

/** Claims, retrying every `pollMs` while the lane is only `busy`, for at most `waitMs`. */
export async function waitForWork(repo: Repo, lane: number, waitMs = 9 * 60_000, pollMs = 30_000): Promise<Next> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const result = await claim(repo, lane)
    if (result.kind !== 'busy' || Date.now() + pollMs > deadline) return result
    await Bun.sleep(pollMs)
  }
}

function run(cmd: string[], cwd: string): boolean {
  return Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' }).exitCode === 0
}

/** Merges `branch` into `build/roadmap` and runs `verify`; a conflict or failure leaves it as it was. */
function mergeVerified(repo: Repo, branch: string, verify: string[][]): void {
  const before = git(repo.integration, 'rev-parse', 'HEAD')
  try {
    git(repo.integration, 'merge', '--no-ff', '-q', '-m', `Merge branch '${branch}' into build/roadmap`, branch)
  } catch (error) {
    if (existsSync(join(git(repo.integration, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))) git(repo.integration, 'merge', '--abort')
    throw new Error(`${branch} conflicts with build/roadmap: merge build/roadmap into it, resolve, and try again\n${(error as Error).message}`)
  }
  const failed = verify.find((cmd) => !run(cmd, repo.integration))
  if (failed) {
    git(repo.integration, 'reset', '-q', '--hard', before)
    throw new Error(`\`${failed.join(' ')}\` failed on the merge result: merge build/roadmap into ${branch}, fix it there, and try again`)
  }
}

function deleteBranch(repo: Repo, branch: string): void {
  try {
    git(repo.integration, 'branch', '-q', '-d', branch)
  } catch {
    console.error(`merged, but ${branch} is still checked out somewhere, so it wasn't deleted`)
  }
}

/** Lands `build/<id>` through {@link mergeVerified} and marks the item done. */
export function land(repo: Repo, id: string, verify = VERIFY): Promise<void> {
  return withLock(repo.lock, () => {
    requireClean(repo)
    const items = load(queuePath(repo))
    const item = items.find((entry) => entry.id === id)
    if (item?.status !== 'in-progress') throw new Error(`${id} is ${item?.status ?? 'not in the queue'}, not in-progress`)
    mergeVerified(repo, `build/${id}`, verify)
    save(setStatus(items, id, 'done'), queuePath(repo))
    rebuild(join(repo.integration, 'docs/loop'))
    commit(repo, `chore(build): finish ${id}`)
    deleteBranch(repo, `build/${id}`)
  })
}

/** Lands a branch that isn't a queue item, such as a nightly native run's results. */
export function merge(repo: Repo, branch: string, verify = VERIFY): Promise<void> {
  return withLock(repo.lock, () => {
    requireClean(repo)
    mergeVerified(repo, branch, verify)
    deleteBranch(repo, branch)
  })
}

/** Adds todo items ahead of the first `*` item, so the parity sweep still waits for them. */
export function add(repo: Repo, added: Item[]): Promise<void> {
  return withLock(repo.lock, () => {
    requireClean(repo)
    const items = load(queuePath(repo))
    const ids = new Set(items.map((item) => item.id))
    for (const item of added) {
      if (ids.has(item.id)) throw new Error(`"${item.id}" is already in the queue`)
      for (const dep of item.deps) if (!ids.has(dep)) throw new Error(`"${item.id}" depends on unknown "${dep}"`)
      ids.add(item.id)
    }
    const at = items.findIndex((item) => item.deps.includes('*'))
    const fresh = added.map((item) => ({ ...item, status: 'todo' as const }))
    save(at === -1 ? [...items, ...fresh] : [...items.slice(0, at), ...fresh, ...items.slice(at)], queuePath(repo))
    commit(repo, `chore(build): add ${added.map((item) => item.id).join(', ')}`)
  })
}

/** Marks `id` blocked, appends `entry` to BLOCKERS.md, and keeps its decision log from `blocked/<id>`. */
export function block(repo: Repo, id: string, entry: string): Promise<void> {
  return withLock(repo.lock, () => {
    requireClean(repo)
    const items = setStatus(load(queuePath(repo)), id, 'blocked')
    const log = `docs/loop/decisions/${id}.md`
    try {
      git(repo.integration, 'checkout', `blocked/${id}`, '--', log)
    } catch {
      console.error(`no ${log} on blocked/${id}, so the blocked item's decisions aren't in DECISIONS.md`)
    }
    appendFileSync(join(repo.integration, 'docs/loop/BLOCKERS.md'), `\n${entry.trim()}\n`)
    save(items, queuePath(repo))
    rebuild(join(repo.integration, 'docs/loop'))
    commit(repo, `chore(build): block ${id}`)
  })
}

export function set(repo: Repo, id: string, status: Status): Promise<void> {
  return withLock(repo.lock, () => {
    requireClean(repo)
    save(setStatus(load(queuePath(repo)), id, status), queuePath(repo))
    commit(repo, `chore(build): set ${id} ${status}`)
  })
}

function laneArg(args: string[]): number {
  const lane = Number(args[args.indexOf('--lane') + 1])
  if (!args.includes('--lane') || !Number.isInteger(lane) || lane < 1) throw new Error('--lane <n> is required')
  return lane
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    const repo = locate()
    switch (command) {
      case 'claim':
        console.log(JSON.stringify(await claim(repo, laneArg(rest)), null, 2))
        return 0
      case 'wait':
        console.log(JSON.stringify(await waitForWork(repo, laneArg(rest)), null, 2))
        return 0
      case 'land':
        await land(repo, rest[0])
        return 0
      case 'merge':
        await merge(repo, rest[0])
        return 0
      case 'add':
        await add(repo, JSON.parse(readFileSync(rest[0], 'utf8')))
        return 0
      case 'block':
        await block(repo, rest[0], readFileSync(rest[1], 'utf8'))
        return 0
      case 'set':
        await set(repo, rest[0], rest[1] as Status)
        return 0
      case 'status': {
        const items: Item[] = load(queuePath(repo))
        for (const status of STATUSES) {
          const held = items.filter((item) => item.status === status)
          const listed = status !== 'done' && status !== 'todo' && held.length > 0
          const names = held.map((item) => (item.lane ? `${item.id} (lane ${item.lane})` : item.id))
          console.log(`${status}: ${held.length}${listed ? ` ${names.join(' ')}` : ''}`)
        }
        return 0
      }
      case 'check': {
        const result = next(load(queuePath(repo)), 0)
        if (result.kind !== 'done') {
          console.log(`not done: ${result.kind}`)
          return 1
        }
        return VERIFY.every((cmd) => run(cmd, repo.integration)) ? 0 : 1
      }
      default:
        console.error('usage: queue.ts claim|wait --lane <n> | land <id> | merge <branch> | add <items.json> | block <id> <file> | set <id> <status> | status | check')
        return 2
    }
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
}
