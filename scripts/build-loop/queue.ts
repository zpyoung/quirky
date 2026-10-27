#!/usr/bin/env bun
/**
 * Work queue for the unattended build loops (docs/loop/LOOP.md). Several lanes, each an Orca loop
 * in its own worktree, share one queue: the copy on `build/roadmap`, held in the integration
 * worktree that only these commands touch, under a lock.
 *
 *   bun scripts/build-loop/queue.ts claim --lane <n>   this lane's item, as JSON (claims a new one if it has none)
 *   bun scripts/build-loop/queue.ts wait --lane <n>    claim, retrying while other lanes hold the only ready work
 *   bun scripts/build-loop/queue.ts land <id>          merge build/<id> into build/roadmap, verify, mark it done;
 *                                                      other lanes' waiting items may land in the same run
 *   bun scripts/build-loop/queue.ts merge <branch>     merge a non-item branch into build/roadmap, verified
 *   bun scripts/build-loop/queue.ts add <items.json>   add todo items, ahead of the parity sweep
 *   bun scripts/build-loop/queue.ts block <id> <file>  mark it blocked, with <file> as its BLOCKERS.md entry
 *   bun scripts/build-loop/queue.ts set <id> <status>
 *   bun scripts/build-loop/queue.ts status             counts, and who holds what
 *   bun scripts/build-loop/queue.ts check              exit 0 only when every item is done and the suite is green
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Status = 'todo' | 'in-progress' | 'done' | 'blocked' | 'waiting'

export type Item = {
  id: string
  milestone: string
  kind?: 'gate'
  title: string
  docs: string[]
  deps: string[]
  status: Status
  lane?: number
}

export type Next =
  | { kind: 'item'; item: Item }
  | { kind: 'waiting'; item: Item }
  | { kind: 'busy'; running: Item[] }
  | { kind: 'stuck'; blocked: string[] }
  | { kind: 'done' }

export const STATUSES: Status[] = ['todo', 'in-progress', 'done', 'blocked', 'waiting']
export const QUEUE_FILE = 'docs/loop/queue.json'
const QUEUE_PATH = resolve(import.meta.dir, '../..', QUEUE_FILE)

export function load(path = QUEUE_PATH): Item[] {
  return JSON.parse(readFileSync(path, 'utf8')).items
}

export function save(items: Item[], path = QUEUE_PATH): void {
  writeFileSync(path, `${JSON.stringify({ items }, null, 2)}\n`)
}

/** A `*` dependency means every item that doesn't itself depend on `*`. */
function depsOf(item: Item, items: Item[]): string[] {
  if (!item.deps.includes('*')) return item.deps
  return items.filter((other) => !other.deps.includes('*')).map((other) => other.id)
}

/**
 * Picks what `lane` works on. Its own in-progress item wins so a crashed iteration resumes it; a
 * waiting gate halts every lane; otherwise the first todo item, in file order, whose dependencies
 * are all done. When nothing is ready but other lanes hold work, the lane is `busy`, because their
 * items may unblock more.
 */
export function next(items: Item[], lane = 1): Next {
  const byId = new Map(items.map((item) => [item.id, item]))
  const own = items.find((item) => item.status === 'in-progress' && (item.lane ?? 1) === lane)
  if (own) return { kind: 'item', item: own }
  const waiting = items.find((item) => item.status === 'waiting')
  if (waiting) return { kind: 'waiting', item: waiting }
  const ready = items.find(
    (item) =>
      item.status === 'todo' && depsOf(item, items).every((dep) => byId.get(dep)?.status === 'done')
  )
  if (ready) return { kind: 'item', item: ready }
  const running = items.filter((item) => item.status === 'in-progress')
  if (running.length > 0) return { kind: 'busy', running }
  if (items.every((item) => item.status === 'done')) return { kind: 'done' }
  return { kind: 'stuck', blocked: items.filter((item) => item.status === 'blocked').map((item) => item.id) }
}

/** Sets an item's status; `lane` records who holds an in-progress item and is dropped otherwise. */
export function setStatus(items: Item[], id: string, status: Status, lane?: number): Item[] {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`)
  if (!items.some((item) => item.id === id)) throw new Error(`unknown item "${id}"`)
  return items.map((item) => {
    if (item.id !== id) return item
    const { lane: _, ...rest } = item
    return status === 'in-progress' && lane !== undefined ? { ...rest, status, lane } : { ...rest, status }
  })
}

if (import.meta.main) {
  const { main } = await import('./lanes')
  process.exit(await main(Bun.argv.slice(2)))
}
