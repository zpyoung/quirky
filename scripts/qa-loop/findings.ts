#!/usr/bin/env bun
/**
 * Findings queue for the QA loop (docs/qa-loop/README.md). QA agents file what they see in the running
 * app, and the orchestrator assigns one finding per fix worktree. The queue lives in
 * `<git common dir>/qa-loop/`, so every worktree of the repo shares it, and each change holds a lock.
 *
 *   bun scripts/qa-loop/findings.ts add <findings.json>      file findings (an array); prints the new ids
 *   bun scripts/qa-loop/findings.ts assign                   give the next finding a fix worktree, unless the cap is reached
 *   bun scripts/qa-loop/findings.ts open                     the findings holding a fix worktree
 *   bun scripts/qa-loop/findings.ts show <id>                one finding, with its answers and rework feedback
 *   bun scripts/qa-loop/findings.ts list [--status <s>] [--area <a>]
 *   bun scripts/qa-loop/findings.ts question <id> <text>     park a finding until the orchestrator answers
 *   bun scripts/qa-loop/findings.ts answer <id> <text>
 *   bun scripts/qa-loop/findings.ts review <id> <pr-url>     hand an open PR to the orchestrator
 *   bun scripts/qa-loop/findings.ts rework <id> <feedback>   send a PR back to its worktree
 *   bun scripts/qa-loop/findings.ts prioritize <id>          put a queued finding ahead of the older backlog
 *   bun scripts/qa-loop/findings.ts done <id> <pr-url>
 *   bun scripts/qa-loop/findings.ts block <id> <reason>      close a finding without a merge
 *   bun scripts/qa-loop/findings.ts release <id>             back to the queue, for a fix that could not run
 *   bun scripts/qa-loop/findings.ts next-area --pool native|web   the next area for that kind of QA agent
 *   bun scripts/qa-loop/findings.ts status                   counts
 *   bun scripts/qa-loop/findings.ts deadline                 exit 0 once the configured deadline has passed
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Which areas each kind of QA agent rotates through. Only the native agent has a real agent login and OS chrome. */
export const AREA_POOLS = {
  native: ['workflows', 'new-features', 'sessions', 'terminals', 'panels'],
  web: ['worktrees', 'git', 'files']
} as const

export type Pool = keyof typeof AREA_POOLS

export type Status = 'todo' | 'in-progress' | 'needs-answer' | 'in-review' | 'done' | 'blocked'

/** How many fix worktrees may be open at once; later findings wait in the queue. */
export const MAX_OPEN_WORKTREES = 12

const OPEN_STATUSES: readonly Status[] = ['in-progress', 'needs-answer', 'in-review']

export type FindingNote = { kind: 'question' | 'answer' | 'rework'; text: string; at: string }

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
  /** The Orca worktree fixing this finding. */
  worktree?: string
  assignedAt?: string
  /** The open PR while the finding is in review or being reworked. */
  pr?: string
  prioritized?: boolean
  notes?: FindingNote[]
  /** The merged PR for a done finding, or why a blocked one was closed. */
  outcome?: string
}

type Queue = { findings: Finding[]; areaCursors?: Partial<Record<Pool, number>> }
export type Assignment =
  | { kind: 'item'; item: Finding }
  | { kind: 'empty' }
  | { kind: 'full'; open: number }
  | { kind: 'deadline' }

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
  if (!existsSync(path)) return { findings: [] }
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

/** Assigns the next queued finding, prioritized first and then oldest, to a new worktree named after it. */
export function assign(dir: string, now = new Date()): Assignment {
  return withLock(dir, () => {
    const queue = read(dir)
    const open = queue.findings.filter((finding) => OPEN_STATUSES.includes(finding.status)).length
    const queued = queue.findings.filter((finding) => finding.status === 'todo')
    const next = queued.find((finding) => finding.prioritized) ?? queued[0]
    if (!next) return { kind: 'empty' }
    if (open >= MAX_OPEN_WORKTREES) return { kind: 'full', open }
    next.status = 'in-progress'
    next.worktree = `fix-${next.id}`
    next.assignedAt = now.toISOString()
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

function requireStatus(finding: Finding, expected: Status, command: string): void {
  if (finding.status !== expected) throw new Error(`${command}: ${finding.id} is ${finding.status}, not ${expected}`)
}

function addNote(finding: Finding, kind: FindingNote['kind'], text: string): void {
  finding.notes = [...(finding.notes ?? []), { kind, text, at: new Date().toISOString() }]
}

export function question(dir: string, id: string, text: string): void {
  update(dir, id, (finding) => {
    requireStatus(finding, 'in-progress', 'question')
    finding.status = 'needs-answer'
    addNote(finding, 'question', text)
  })
}

export function answer(dir: string, id: string, text: string): void {
  update(dir, id, (finding) => {
    requireStatus(finding, 'needs-answer', 'answer')
    finding.status = 'in-progress'
    addNote(finding, 'answer', text)
  })
}

export function review(dir: string, id: string, pr: string): void {
  update(dir, id, (finding) => {
    requireStatus(finding, 'in-progress', 'review')
    finding.status = 'in-review'
    finding.pr = pr
  })
}

export function rework(dir: string, id: string, feedback: string): void {
  update(dir, id, (finding) => {
    requireStatus(finding, 'in-review', 'rework')
    finding.status = 'in-progress'
    addNote(finding, 'rework', feedback)
  })
}

export function prioritize(dir: string, id: string): void {
  update(dir, id, (finding) => {
    finding.prioritized = true
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
    delete finding.worktree
    delete finding.assignedAt
    delete finding.pr
  })
}

export function openFindings(dir: string): Finding[] {
  return read(dir).findings.filter((finding) => OPEN_STATUSES.includes(finding.status))
}

export function listFindings(dir: string, filter: { status?: string; area?: string } = {}): Finding[] {
  return read(dir).findings.filter(
    (finding) => (!filter.status || finding.status === filter.status) && (!filter.area || finding.area === filter.area)
  )
}

export function nextArea(dir: string, pool: Pool): string {
  return withLock(dir, () => {
    const queue = read(dir)
    const areas = AREA_POOLS[pool]
    const cursor = queue.areaCursors?.[pool] ?? 0
    queue.areaCursors = { ...queue.areaCursors, [pool]: (cursor + 1) % areas.length }
    write(dir, queue)
    return areas[cursor % areas.length]!
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
    inProgress: count('in-progress'),
    needsAnswer: count('needs-answer'),
    inReview: count('in-review'),
    done: count('done'),
    blocked: count('blocked'),
    openWorktrees: `${findings.filter((finding) => OPEN_STATUSES.includes(finding.status)).length}/${MAX_OPEN_WORKTREES}`
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))

async function main(args: string[]): Promise<number> {
  const dir = queueDir()
  const [command, first, second] = args
  const rest = args.slice(2).join(' ')
  switch (command) {
    case 'add':
      console.log(JSON.stringify(addFindings(dir, JSON.parse(readFileSync(first!, 'utf8')))))
      return 0
    case 'assign':
      print(pastDeadline(dir) ? { kind: 'deadline' } : assign(dir))
      return 0
    case 'open': {
      const open = openFindings(dir).map(({ id, status, worktree, pr }) => ({ id, status, worktree, pr }))
      print({ count: open.length, max: MAX_OPEN_WORKTREES, findings: open })
      return 0
    }
    case 'show': {
      const found = listFindings(dir).find((finding) => finding.id === first)
      if (!found) {
        console.error(`no finding ${first}`)
        return 1
      }
      print(found)
      return 0
    }
    case 'list':
      print(listFindings(dir, { status: flag(args, '--status'), area: flag(args, '--area') }))
      return 0
    case 'question':
      question(dir, first!, rest)
      return 0
    case 'answer':
      answer(dir, first!, rest)
      return 0
    case 'review':
      review(dir, first!, second!)
      return 0
    case 'rework':
      rework(dir, first!, rest)
      return 0
    case 'prioritize':
      prioritize(dir, first!)
      return 0
    case 'done':
      finish(dir, first!, 'done', second ?? '')
      return 0
    case 'block':
      finish(dir, first!, 'blocked', rest)
      return 0
    case 'release':
      release(dir, first!)
      return 0
    case 'next-area': {
      const pool = flag(args, '--pool')
      if (pool !== 'native' && pool !== 'web') {
        console.error('next-area needs --pool native|web')
        return 2
      }
      console.log(nextArea(dir, pool))
      return 0
    }
    case 'status':
      print(status(dir))
      return 0
    case 'deadline':
      return pastDeadline(dir) ? 0 : 1
    default:
      console.error(
        'usage: findings.ts add|assign|open|show|list|question|answer|review|rework|prioritize|done|block|release|next-area|status|deadline'
      )
      return 2
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
