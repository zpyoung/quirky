/**
 * The shared side of the build queue. Every lane reads and changes the queue only through the
 * integration worktree, which keeps `build/roadmap` checked out and is never worked in, and only
 * while holding the lock, so two lanes never claim one item or land at once.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rebuild } from './decisions'
import { load, next, pendingDeps, QUEUE_FILE, save, setStatus, STATUSES, type Item, type Next, type Status } from './queue'

export type Repo = { integration: string; lock: string; lands: string }

/** Run on every merge result that changes more than `docs/`; `bun run test` reruns a failing file alone once. */
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
  const repo = {
    integration: join(common, 'build-loop', 'integration'),
    lock: join(common, 'build-loop', 'lock'),
    lands: join(common, 'build-loop', 'lands')
  }
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

/** Waits up to `waitMs` for every dependency of `id` to be done; reports the ones still pending. */
export async function waitForDeps(repo: Repo, id: string, waitMs = 9 * 60_000, pollMs = 30_000): Promise<{ ready: boolean; pending: string[] }> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const pending = pendingDeps(load(queuePath(repo)), id)
    if (pending.length === 0 || Date.now() + pollMs > deadline) return { ready: pending.length === 0, pending }
    await Bun.sleep(pollMs)
  }
}

function run(cmd: string[], cwd: string): boolean {
  return Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' }).exitCode === 0
}

/** Merges `branch` into `build/roadmap`; false, with the merge undone, when it conflicts. */
function tryMerge(repo: Repo, branch: string): boolean {
  try {
    git(repo.integration, 'merge', '--no-ff', '-q', '-m', `Merge branch '${branch}' into build/roadmap`, branch)
    return true
  } catch {
    if (existsSync(join(git(repo.integration, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))) git(repo.integration, 'merge', '--abort')
    return false
  }
}

const conflicts = (branch: string) =>
  new Error(`${branch} conflicts with build/roadmap: merge build/roadmap into it, resolve, and try again`)

/** The first of `verify` that fails on what was merged since `before`; none when only `docs/` changed. */
function failing(repo: Repo, before: string, verify: string[][]): string[] | undefined {
  const changed = git(repo.integration, 'diff', '--name-only', before, 'HEAD').split('\n')
  if (changed.every((path) => path.startsWith('docs/'))) return undefined
  return verify.find((cmd) => !run(cmd, repo.integration))
}

const failedOn = (cmd: string[], branch: string) =>
  new Error(`\`${cmd.join(' ')}\` failed on the merge result: merge build/roadmap into ${branch}, fix it there, and try again`)

/**
 * Merges `branch` into `build/roadmap` and runs `verify`, unless the merge changed only `docs/`;
 * a conflict or failure leaves it as it was.
 */
function mergeVerified(repo: Repo, branch: string, verify: string[][]): void {
  const before = git(repo.integration, 'rev-parse', 'HEAD')
  if (!tryMerge(repo, branch)) throw conflicts(branch)
  const failed = failing(repo, before, verify)
  if (failed) {
    git(repo.integration, 'reset', '-q', '--hard', before)
    throw failedOn(failed, branch)
  }
}

function deleteBranch(repo: Repo, branch: string): void {
  try {
    git(repo.integration, 'branch', '-q', '-d', branch)
  } catch {
    console.error(`merged, but ${branch} is still checked out somewhere, so it wasn't deleted`)
  }
}

/**
 * Runs `fn` on a detached copy of `build/roadmap` and moves the branch to the result only when `fn`
 * returns, so a lane that merges `build/roadmap` never picks up a merge still being verified.
 */
function staged<T>(repo: Repo, fn: () => T): T {
  requireClean(repo)
  git(repo.integration, 'switch', '-q', '--detach')
  try {
    const result = fn()
    git(repo.integration, 'switch', '-q', '-C', 'build/roadmap')
    return result
  } catch (error) {
    git(repo.integration, 'switch', '-q', '-f', 'build/roadmap')
    throw error
  }
}

/** The most items one land verifies together. */
export const BATCH = 4

type Request = { pid: number; head: string; solo?: boolean }

function readRequest(path: string): Request | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Request
  } catch {
    return undefined
  }
}

const branchHead = (repo: Repo, id: string) => {
  try {
    return git(repo.integration, 'rev-parse', '--verify', '-q', `build/${id}`)
  } catch {
    return ''
  }
}

/** Announces that this process is waiting to land `id` at its current commit, so whoever holds the lock may land it too. */
export function requestLand(repo: Repo, id: string): string {
  mkdirSync(repo.lands, { recursive: true })
  const path = join(repo.lands, id)
  writeFileSync(path, JSON.stringify({ pid: process.pid, head: branchHead(repo, id) } satisfies Request))
  return path
}

/** Other items waiting to land, early (critical-path) items then oldest first, skipping those that must land alone or whose branch has moved. */
function waitingToLand(repo: Repo, items: Item[], id: string): string[] {
  if (!existsSync(repo.lands)) return []
  const inProgress = new Set(items.filter((item) => item.status === 'in-progress').map((item) => item.id))
  const early = new Set(items.filter((item) => item.early).map((item) => item.id))
  const waiting: { id: string; since: number }[] = []
  for (const other of readdirSync(repo.lands)) {
    const path = join(repo.lands, other)
    const request = readRequest(path)
    if (!request || !alive(request.pid)) {
      rmSync(path, { force: true })
      continue
    }
    if (other === id || request.solo || !inProgress.has(other)) continue
    if (request.head && request.head === branchHead(repo, other)) waiting.push({ id: other, since: statSync(path).mtimeMs })
  }
  const rank = (entry: { id: string; since: number }) => (early.has(entry.id) ? 0 : 1)
  return waiting.sort((a, b) => rank(a) - rank(b) || a.since - b.since).map((entry) => entry.id)
}

function landAlone(repo: Repo, id: string): void {
  const path = join(repo.lands, id)
  const request = readRequest(path)
  if (request) writeFileSync(path, JSON.stringify({ ...request, solo: true } satisfies Request))
}

/**
 * Lands `build/<id>` and marks the item done. Items whose lanes are waiting to land too are merged
 * with it, up to {@link BATCH}, and verified in one run, since that run is what holds the lock longest.
 * A waiting item that conflicts is left for its own lane. If the batch fails, `id` is verified alone
 * and the others are marked to land alone, so one bad branch can't fail a batch twice.
 */
export async function land(repo: Repo, id: string, verify = VERIFY): Promise<void> {
  const own = requestLand(repo, id)
  try {
    await withLock(repo.lock, () => staged(repo, () => {
      const items = load(queuePath(repo))
      const item = items.find((entry) => entry.id === id)
      if (item?.status === 'done') {
        console.log(`${id} was landed together with another lane's item`)
        return
      }
      if (item?.status !== 'in-progress') throw new Error(`${id} is ${item?.status ?? 'not in the queue'}, not in-progress`)
      const others = readRequest(own)?.solo ? [] : waitingToLand(repo, items, id).slice(0, BATCH - 1)
      const before = git(repo.integration, 'rev-parse', 'HEAD')
      if (!tryMerge(repo, `build/${id}`)) throw conflicts(`build/${id}`)
      let batch = [id, ...others.filter((other) => tryMerge(repo, `build/${other}`))]
      let failed = failing(repo, before, verify)
      if (failed && batch.length > 1) {
        console.error(`\nthe batch ${batch.join(', ')} failed, so ${id} is verified alone`)
        git(repo.integration, 'reset', '-q', '--hard', before)
        for (const other of batch.slice(1)) landAlone(repo, other)
        batch = [id]
        tryMerge(repo, `build/${id}`)
        failed = failing(repo, before, verify)
      }
      if (failed) {
        git(repo.integration, 'reset', '-q', '--hard', before)
        throw failedOn(failed, `build/${id}`)
      }
      let landed = items
      for (const done of batch) {
        landed = setStatus(landed, done, 'done')
        save(landed, queuePath(repo))
        rebuild(join(repo.integration, 'docs/loop'))
        commit(repo, `chore(build): finish ${done}`)
      }
      for (const done of batch) deleteBranch(repo, `build/${done}`)
      if (batch.length > 1) console.log(`landed ${batch.join(', ')} in one verified run`)
    }))
  } finally {
    rmSync(own, { force: true })
  }
}

/** Lands a branch that isn't a queue item, such as a nightly native run's results. */
export function merge(repo: Repo, branch: string, verify = VERIFY): Promise<void> {
  return withLock(repo.lock, () =>
    staged(repo, () => {
      mergeVerified(repo, branch, verify)
      deleteBranch(repo, branch)
    })
  )
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
      case 'deps':
        console.log(JSON.stringify(await waitForDeps(repo, rest[0]), null, 2))
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
        console.error('usage: queue.ts claim|wait --lane <n> | land <id> | merge <branch> | add <items.json> | block <id> <file> | deps <id> | set <id> <status> | status | check')
        return 2
    }
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
}
