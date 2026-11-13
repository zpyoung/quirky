import type { ProcessRunner, RunResult } from '@quirky/process'

export const PROCESS_SCAN_TIMEOUT_MS = 1000
export const PROCESS_SCAN_DEADLINE_MS = 1250

const PROCESS_SCAN_ARGV = ['ps', '-A', '-o', 'pid=,ppid='] as const
const EMPTY_PROCESS_TABLE: ProcessTable = { children: new Map() }

/** One reading of the machine's process table: each parent's direct children. */
export type ProcessTable = { readonly children: ReadonlyMap<number, readonly number[]> }

/** Parses the `pid=,ppid=` columns emitted by `ps`, ignoring malformed rows. */
export function parseProcessTable(text: string): ProcessTable {
  const children = new Map<number, number[]>()
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 2 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) continue
    const pid = Number(fields[0])
    const ppid = Number(fields[1])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }
  return { children }
}

/** Every pid below `rootPid` or a tracked pid in `table`, without the roots themselves. */
export function descendantsIn(table: ProcessTable, rootPid: number, trackedRoots: Iterable<number> = []): number[] {
  const roots = new Set([rootPid, ...trackedRoots])
  const found = new Set<number>()
  const queue = [...roots]
  for (let i = 0; i < queue.length; i++) {
    for (const child of table.children.get(queue[i]!) ?? []) {
      if (roots.has(child) || found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return [...found]
}

export type ProcessTables = {
  /** A table read by a scan that started after this call. Calls waiting for the same scan share it. */
  fresh(): Promise<ProcessTable>
  /** The table of a running scan, or of one that started at most `maxAgeMs` ago, else a new scan's. */
  recent(maxAgeMs: number): Promise<ProcessTable>
  /** Ends every wait with the empty table and runs no more scans. */
  close(): void
}

type Waiter = (table: ProcessTable) => void
type Scan = {
  controller: AbortController
  startedAt: number | null
  waiters: Waiter[]
  deadline?: ReturnType<typeof setTimeout>
  timedOut: boolean
}

/** Shared readings of the process table. A timed-out run must settle before another can start. */
export function createProcessTables(
  runner: Pick<ProcessRunner, 'run'>,
  options: { timeoutMs?: number; deadlineMs?: number; now?: () => number } = {}
): ProcessTables {
  const timeoutMs = options.timeoutMs ?? PROCESS_SCAN_TIMEOUT_MS
  const deadlineMs = options.deadlineMs ?? PROCESS_SCAN_DEADLINE_MS
  const now = options.now ?? Date.now
  let active: Scan | undefined
  let queued: Waiter[] = []
  let last: { table: ProcessTable; startedAt: number } | undefined
  let closed = false

  const resolveWaiters = (waiters: Waiter[], table: ProcessTable) => {
    for (const resolve of waiters) resolve(table)
    waiters.length = 0
  }

  const finish = (scan: Scan, table: ProcessTable) => {
    if (active !== scan) return
    if (scan.deadline !== undefined) clearTimeout(scan.deadline)
    scan.deadline = undefined
    active = undefined
    if (scan.timedOut) return
    const startedAt = scan.startedAt!
    last = { table, startedAt }
    resolveWaiters(scan.waiters, table)
    if (queued.length > 0 && !closed) {
      const waiters = queued
      queued = []
      start(waiters)
    }
  }

  const expire = (scan: Scan) => {
    if (active !== scan || scan.timedOut) return
    scan.timedOut = true
    scan.controller.abort()
    scan.deadline = undefined
    resolveWaiters(scan.waiters, EMPTY_PROCESS_TABLE)
    resolveWaiters(queued, EMPTY_PROCESS_TABLE)
  }

  const start = (waiters: Waiter[]) => {
    const scan: Scan = {
      controller: new AbortController(),
      startedAt: null,
      waiters,
      timedOut: false
    }
    active = scan
    void Promise.resolve().then(() => {
      if (closed || active !== scan) return
      scan.startedAt = now()
      last = undefined
      scan.deadline = setTimeout(() => expire(scan), deadlineMs)
      let run: Promise<RunResult>
      try {
        run = runner.run(PROCESS_SCAN_ARGV, {
          timeoutMs,
          killGraceMs: 0,
          signal: scan.controller.signal
        })
      } catch {
        finish(scan, EMPTY_PROCESS_TABLE)
        return
      }
      void Promise.resolve(run).then(
        (result) => finish(scan, tableFromResult(result)),
        () => finish(scan, EMPTY_PROCESS_TABLE)
      )
    })
  }

  const waitFor = (scan: Scan): Promise<ProcessTable> => {
    const { promise, resolve } = Promise.withResolvers<ProcessTable>()
    scan.waiters.push(resolve)
    return promise
  }

  const fresh = (): Promise<ProcessTable> => {
    if (closed) return Promise.resolve(EMPTY_PROCESS_TABLE)
    const { promise, resolve } = Promise.withResolvers<ProcessTable>()
    if (active) {
      if (active.timedOut) resolve(EMPTY_PROCESS_TABLE)
      else if (active.startedAt === null) active.waiters.push(resolve)
      else queued.push(resolve)
    } else {
      start([resolve])
    }
    return promise
  }

  return {
    fresh,
    recent(maxAgeMs) {
      if (closed || active?.timedOut) return Promise.resolve(EMPTY_PROCESS_TABLE)
      if (active) return waitFor(active)
      if (last && now() - last.startedAt <= maxAgeMs) return Promise.resolve(last.table)
      return fresh()
    },
    close() {
      if (closed) return
      closed = true
      const scan = active
      active = undefined
      if (scan) {
        scan.controller.abort()
        if (scan.deadline !== undefined) clearTimeout(scan.deadline)
        resolveWaiters(scan.waiters, EMPTY_PROCESS_TABLE)
      }
      resolveWaiters(queued, EMPTY_PROCESS_TABLE)
      last = undefined
    }
  }
}

function tableFromResult(result: RunResult): ProcessTable {
  if (result.exitCode !== 0 || result.signal !== null || result.stopped !== undefined || result.spawnError !== undefined) {
    return EMPTY_PROCESS_TABLE
  }
  return parseProcessTable(result.stdoutText)
}

