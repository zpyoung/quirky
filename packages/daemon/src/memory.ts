import { basename } from 'node:path'
import type {
  DiagnosticsMemoryReport,
  MemoryProcess,
  MemoryTree,
  ProcessRunner,
  PtySessionInfo,
  RunResult
} from '@quirky/protocol'

const KIB = 1024
const MAX_PROCESSES_PER_TREE = 50

export type MemoryDeps = {
  daemonPid: number
  memoryUsage: () => { heapUsed: number; heapTotal: number; external: number }
  pty: { hostPid: number | null; connected: boolean; list(): Promise<PtySessionInfo[]> }
  readProcessTable: () => Promise<{ readerPid: number; text: string } | null>
  now: () => number
}

export const MEMORY_READER_ARGV = [
  '/bin/sh',
  '-c',
  'echo $$; exec ps -A -o pid=,ppid=,rss=,comm='
] as const

export function parseMemoryProcessTable(text: string): MemoryProcess[] {
  const processes: MemoryProcess[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const rssKiB = Number(match[3])
    if (
      !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(rssKiB) || rssKiB < 0
    ) continue
    const name = basename(match[4]!.trim()).slice(0, 64)
    if (!name) continue
    processes.push({ pid, ppid, rssBytes: rssKiB * KIB, name })
  }
  return processes
}

export async function readMemoryProcessTable(
  runner: Pick<ProcessRunner, 'run'>
): Promise<{ readerPid: number; text: string } | null> {
  let result: RunResult
  try {
    result = await runner.run(MEMORY_READER_ARGV, {
      env: { LC_ALL: 'C' },
      timeoutMs: 5000,
      share: true,
      rerunnable: true
    })
  } catch {
    return null
  }
  if (result.exitCode !== 0 || result.stopped) return null

  const newline = result.stdoutText.indexOf('\n')
  const firstLine = (newline < 0 ? result.stdoutText : result.stdoutText.slice(0, newline)).trim()
  if (!/^\d+$/.test(firstLine)) return null
  const readerPid = Number(firstLine)
  if (!Number.isSafeInteger(readerPid) || readerPid <= 0) return null
  return { readerPid, text: newline < 0 ? '' : result.stdoutText.slice(newline + 1) }
}

function collectTree(
  rootPid: number,
  processes: ReadonlyMap<number, MemoryProcess>,
  children: ReadonlyMap<number, readonly MemoryProcess[]>,
  includeRoot = true
): MemoryProcess[] {
  const found: MemoryProcess[] = []
  const visited = new Set<number>()
  const pending = [rootPid]
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    const process = processes.get(pid)
    if (process && (includeRoot || pid !== rootPid)) found.push(process)
    for (const child of children.get(pid) ?? []) pending.push(child.pid)
  }
  return found
}

function summarizeTree(processes: readonly MemoryProcess[]): MemoryTree {
  const sorted = [...processes].sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid)
  return {
    processCount: processes.length,
    rssBytes: processes.reduce((total, process) => total + process.rssBytes, 0),
    processes: sorted.slice(0, MAX_PROCESSES_PER_TREE),
    omitted: Math.max(0, processes.length - MAX_PROCESSES_PER_TREE)
  }
}


export async function collectMemorySnapshot(deps: MemoryDeps): Promise<DiagnosticsMemoryReport> {
  const takenAt = deps.now()
  const memoryUsage = deps.memoryUsage()
  const connected = deps.pty.connected
  const hostPid = deps.pty.hostPid

  const processTablePromise = Promise.resolve()
    .then(() => deps.readProcessTable())
    .then(
      (table) => ({ table, reason: null as string | null }),
      (error: unknown) => ({ table: null, reason: error instanceof Error ? error.message : String(error) })
    )
  const sessionsPromise = connected
    ? Promise.resolve()
        .then(() => deps.pty.list())
        .then(
          (sessions) => ({ sessions, reason: null as string | null }),
          (error: unknown) => ({ sessions: [] as PtySessionInfo[], reason: error instanceof Error ? error.message : String(error) })
        )
    : Promise.resolve({ sessions: [] as PtySessionInfo[], reason: null as string | null })
  const [processTableResult, sessionResult] = await Promise.all([processTablePromise, sessionsPromise])

  const unavailable: DiagnosticsMemoryReport['unavailable'] = []
  if (!processTableResult.table) {
    unavailable.push({
      part: 'process-table',
      reason: processTableResult.reason ?? 'Process table is unavailable'
    })
  }
  if (!connected) unavailable.push({ part: 'pty-host', reason: 'PTY host is not connected' })
  else if (sessionResult.reason !== null) {
    unavailable.push({ part: 'pty-sessions', reason: sessionResult.reason })
  }

  const runningSessions = connected
    ? sessionResult.sessions.filter((session) => session.state === 'running' && session.pid > 0)
    : []
  if (!processTableResult.table) {
    return {
      schemaVersion: 1,
      takenAt,
      daemon: {
        pid: deps.daemonPid,
        rssBytes: null,
        heapUsedBytes: memoryUsage.heapUsed,
        heapTotalBytes: memoryUsage.heapTotal,
        externalBytes: memoryUsage.external,
        descendants: null
      },
      ptyHost: { pid: hostPid, alive: connected, rssBytes: null },
      sessions: runningSessions.map((session) => ({
        sessionId: session.sessionId,
        pid: session.pid,
        title: session.title,
        cwd: session.cwd,
        tree: null
      })),
      totals: null,
      unavailable
    }
  }

  const table = processTableResult.table
  const processes = new Map<number, MemoryProcess>()
  for (const process of parseMemoryProcessTable(table.text)) processes.set(process.pid, process)
  const children = new Map<number, MemoryProcess[]>()
  for (const process of processes.values()) {
    const siblings = children.get(process.ppid)
    if (siblings) siblings.push(process)
    else children.set(process.ppid, [process])
  }

  const daemonProcess = processes.get(deps.daemonPid)
  const hostProcess = hostPid === null ? undefined : processes.get(hostPid)
  const hostTree = hostPid === null ? [] : collectTree(hostPid, processes, children)
  const hostTreePids = new Set(hostTree.map((process) => process.pid))
  const daemonDescendants = collectTree(deps.daemonPid, processes, children, false).filter(
    (process) => process.pid !== table.readerPid && !hostTreePids.has(process.pid)
  )
  const sessions = runningSessions.map((session) => {
    const treeProcesses = processes.has(session.pid)
      ? collectTree(session.pid, processes, children).filter((process) => process.pid !== table.readerPid)
      : []
    const tree = summarizeTree(treeProcesses)
    return {
      sessionId: session.sessionId,
      pid: session.pid,
      title: session.title,
      cwd: session.cwd,
      tree
    }
  })

  const totalsByPid = new Map<number, MemoryProcess>()
  const count = (process: MemoryProcess | undefined) => {
    if (process && process.pid !== table.readerPid) totalsByPid.set(process.pid, process)
  }
  count(daemonProcess)
  for (const process of daemonDescendants) count(process)
  count(hostProcess)
  for (const session of runningSessions) {
    if (!processes.has(session.pid)) continue
    for (const process of collectTree(session.pid, processes, children)) count(process)
  }

  return {
    schemaVersion: 1,
    takenAt,
    daemon: {
      pid: deps.daemonPid,
      rssBytes: daemonProcess?.rssBytes ?? null,
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      externalBytes: memoryUsage.external,
      descendants: summarizeTree(daemonDescendants)
    },
    ptyHost: { pid: hostPid, alive: connected, rssBytes: hostProcess?.rssBytes ?? null },
    sessions,
    totals: {
      processCount: totalsByPid.size,
      rssBytes: [...totalsByPid.values()].reduce((total, process) => total + process.rssBytes, 0)
    },
    unavailable
  }
}
