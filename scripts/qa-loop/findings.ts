#!/usr/bin/env bun
/**
 * Findings queue for the overnight visual QA loop (docs/qa-loop/README.md). The QA lane files what
 * it sees in the running app; fix lanes claim one finding at a time. The queue lives in
 * `<git common dir>/qa-loop/`, so every worktree of the repo shares it, and each change holds a lock.
 *
 *   bun scripts/qa-loop/findings.ts add <findings.json>   file findings (an array); prints the new ids
 *   bun scripts/qa-loop/findings.ts claim --lane <n>       this lane's finding as JSON, claiming one if it has none
 *   bun scripts/qa-loop/findings.ts wait --lane <n> [--minutes 20]   claim, retrying each minute while the queue is empty
 *   bun scripts/qa-loop/findings.ts done <id> <pr-url>
 *   bun scripts/qa-loop/findings.ts block <id> <reason>
 *   bun scripts/qa-loop/findings.ts release <id>           back to the queue for another lane
 *   bun scripts/qa-loop/findings.ts next-area              the next area to test, round robin
 *   bun scripts/qa-loop/findings.ts status                 counts and who holds what
 *   bun scripts/qa-loop/findings.ts deadline               exit 0 once the configured deadline has passed
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const AREAS = ['sessions', 'worktrees', 'git', 'files', 'terminals', 'panels'] as const

export type Status = 'todo' | 'in-progress' | 'done' | 'blocked'

export type Finding = {
  id: string
  area: string
  title: string
  steps: string[]
  expected: string
  actual: string
  /** Screenshot paths under the queue directory's evidence folder. */
  evidence: string[]
  status: Status
  createdAt: string
  lane?: number
  claimedAt?: string
  /** The merged PR for a done finding, or why a blocked one could not be fixed. */
  outcome?: string
}

type Queue = { findings: Finding[]; nextArea: number }
export type Claim = { kind: 'item'; item: Finding } | { kind: 'empty' } | { kind: 'deadline' }

/** A claim older than this is presumed abandoned by a lane that died, and goes back to the queue. */
const STALE_CLAIM_MS = 3 * 60 * 60 * 1000
const LOCK_STALE_MS = 60 * 1000

export function queueDir(): string {
  if (process.env.QA_LOOP_DIR) return process.env.QA_LOOP_DIR
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
  return join(resolve(common), 'qa-loop')
}

function withLock<T>(dir: string, action: () => T): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'lock')
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true })
      if (Date.now() > deadline) throw new Error(`could not take the qa-loop lock at ${lock}`)
      Bun.sleepSync(100)
    }
  }
  try {
    return action()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function read(dir: string): Queue {
  const path = join(dir, 'findings.json')
  if (!existsSync(path)) return { findings: [], nextArea: 0 }
  return JSON.parse(readFileSync(path, 'utf8')) as Queue
}

function write(dir: string, queue: Queue): void {
  const path = join(dir, 'findings.json')
  writeFileSync(`${path}.tmp`, `${JSON.stringify(queue, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

const normalized = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim()

/** Files findings and returns the new ids; one whose area and title match an existing finding is skipped. */
export function addFindings(dir: string, incoming: Omit<Finding, 'id' | 'status' | 'createdAt'>[]): string[] {
  return withLock(dir, () => {
    const queue = read(dir)
    const added: string[] = []
    for (const finding of incoming) {
      const duplicate = queue.findings.some((existing) => existing.area === finding.area && normalized(existing.title) === normalized(finding.title))
      if (duplicate) continue
      const count = queue.findings.filter((existing) => existing.area === finding.area).length
      const id = `qa-${finding.area}-${count + 1}`
      queue.findings.push({ ...finding, id, status: 'todo', createdAt: new Date().toISOString() })
      added.push(id)
    }
    write(dir, queue)
    return added
  })
}

export function claim(dir: string, lane: number, now = new Date()): Claim {
  return withLock(dir, () => {
    const queue = read(dir)
    const held = queue.findings.find((finding) => finding.status === 'in-progress' && finding.lane === lane)
    if (held) return { kind: 'item', item: held }
    for (const finding of queue.findings) {
      if (finding.status === 'in-progress' && finding.claimedAt && now.getTime() - Date.parse(finding.claimedAt) > STALE_CLAIM_MS) {
        finding.status = 'todo'
        delete finding.lane
      }
    }
    const next = queue.findings.find((finding) => finding.status === 'todo')
    if (!next) {
      write(dir, queue)
      return { kind: 'empty' }
    }
    next.status = 'in-progress'
    next.lane = lane
    next.claimedAt = now.toISOString()
    write(dir, queue)
    return { kind: 'item', item: next }
  })
}

function update(dir: string, id: string, change: (finding: Finding) => void): void {
  withLock(dir, () => {
    const queue = read(dir)
    const finding = queue.findings.find((candidate) => candidate.id === id)
    if (!finding) throw new Error(`no finding ${id}`)
    change(finding)
    write(dir, queue)
  })
}

export function finish(dir: string, id: string, status: 'done' | 'blocked', outcome: string): void {
  update(dir, id, (finding) => {
    finding.status = status
    finding.outcome = outcome
  })
}

export function release(dir: string, id: string): void {
  update(dir, id, (finding) => {
    finding.status = 'todo'
    delete finding.lane
    delete finding.claimedAt
  })
}

export function nextArea(dir: string): string {
  return withLock(dir, () => {
    const queue = read(dir)
    const area = AREAS[queue.nextArea % AREAS.length]!
    queue.nextArea = (queue.nextArea + 1) % AREAS.length
    write(dir, queue)
    return area
  })
}

export function pastDeadline(dir: string, now = new Date()): boolean {
  const path = join(dir, 'config.json')
  if (!existsSync(path)) return false
  const { deadline } = JSON.parse(readFileSync(path, 'utf8')) as { deadline?: string }
  return deadline !== undefined && now.getTime() >= Date.parse(deadline)
}

function status(dir: string): Record<string, unknown> {
  const { findings } = read(dir)
  const count = (state: Status) => findings.filter((finding) => finding.status === state).length
  return {
    todo: count('todo'),
    inProgress: findings.filter((finding) => finding.status === 'in-progress').map((finding) => ({ id: finding.id, lane: finding.lane })),
    done: count('done'),
    blocked: count('blocked')
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

async function main(args: string[]): Promise<number> {
  const dir = queueDir()
  const [command, first, second] = args
  const lane = Number(flag(args, '--lane'))
  switch (command) {
    case 'add':
      console.log(JSON.stringify(addFindings(dir, JSON.parse(readFileSync(first!, 'utf8')))))
      return 0
    case 'claim':
      console.log(JSON.stringify(pastDeadline(dir) ? { kind: 'deadline' } : claim(dir, lane)))
      return 0
    case 'wait': {
      const until = Date.now() + Number(flag(args, '--minutes') ?? 20) * 60_000
      for (;;) {
        const result: Claim = pastDeadline(dir) ? { kind: 'deadline' } : claim(dir, lane)
        if (result.kind !== 'empty' || Date.now() > until) {
          console.log(JSON.stringify(result))
          return 0
        }
        await Bun.sleep(60_000)
      }
    }
    case 'done':
      finish(dir, first!, 'done', second ?? '')
      return 0
    case 'block':
      finish(dir, first!, 'blocked', args.slice(2).join(' '))
      return 0
    case 'release':
      release(dir, first!)
      return 0
    case 'next-area':
      console.log(nextArea(dir))
      return 0
    case 'status':
      console.log(JSON.stringify(status(dir), null, 2))
      return 0
    case 'deadline':
      return pastDeadline(dir) ? 0 : 1
    default:
      console.error('usage: findings.ts add|claim|wait|done|block|release|next-area|status|deadline')
      return 2
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
