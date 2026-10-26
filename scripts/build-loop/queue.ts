#!/usr/bin/env bun
/**
 * Work queue for the unattended build loop (docs/loop/LOOP.md).
 *
 *   bun scripts/build-loop/queue.ts next             the item to work on, as JSON
 *   bun scripts/build-loop/queue.ts set <id> <status>
 *   bun scripts/build-loop/queue.ts status           counts and the blocked or waiting items
 *   bun scripts/build-loop/queue.ts check            exit 0 only when every item is done and the suite is green
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
}

export type Next =
  | { kind: 'item'; item: Item }
  | { kind: 'waiting'; item: Item }
  | { kind: 'stuck'; blocked: string[] }
  | { kind: 'done' }

const STATUSES: Status[] = ['todo', 'in-progress', 'done', 'blocked', 'waiting']
const QUEUE_PATH = resolve(import.meta.dir, '../../docs/loop/queue.json')

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
 * Picks what the loop works on next. An in-progress item wins so a crashed iteration resumes it;
 * a waiting gate halts the queue; otherwise the first todo item, in file order, whose dependencies
 * are all done.
 */
export function next(items: Item[]): Next {
  const byId = new Map(items.map((item) => [item.id, item]))
  const inProgress = items.find((item) => item.status === 'in-progress')
  if (inProgress) return { kind: 'item', item: inProgress }
  const waiting = items.find((item) => item.status === 'waiting')
  if (waiting) return { kind: 'waiting', item: waiting }
  const ready = items.find(
    (item) =>
      item.status === 'todo' && depsOf(item, items).every((dep) => byId.get(dep)?.status === 'done')
  )
  if (ready) return { kind: 'item', item: ready }
  if (items.every((item) => item.status === 'done')) return { kind: 'done' }
  return { kind: 'stuck', blocked: items.filter((item) => item.status === 'blocked').map((item) => item.id) }
}

export function setStatus(items: Item[], id: string, status: Status): Item[] {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`)
  if (!items.some((item) => item.id === id)) throw new Error(`unknown item "${id}"`)
  return items.map((item) => (item.id === id ? { ...item, status } : item))
}

function run(cmd: string[]): number {
  return Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' }).exitCode
}

function main(argv: string[]): number {
  const [command, ...rest] = argv
  const items = load()
  switch (command) {
    case 'next':
      console.log(JSON.stringify(next(items), null, 2))
      return 0
    case 'set': {
      const [id, status] = rest
      save(setStatus(items, id, status as Status))
      return 0
    }
    case 'status': {
      for (const status of STATUSES) {
        const ids = items.filter((item) => item.status === status).map((item) => item.id)
        const listed = status !== 'done' && status !== 'todo' && ids.length > 0
        console.log(`${status}: ${ids.length}${listed ? ` ${ids.join(' ')}` : ''}`)
      }
      return 0
    }
    case 'check': {
      const result = next(items)
      if (result.kind !== 'done') {
        console.log(`not done: ${JSON.stringify(result.kind === 'item' || result.kind === 'waiting' ? result.item.id : result)}`)
        return 1
      }
      return run(['bun', 'run', 'test']) || run(['bun', 'test', 'scripts']) || run(['bun', 'run', 'typecheck'])
    }
    default:
      console.error('usage: queue.ts next | set <id> <status> | status | check')
      return 2
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
