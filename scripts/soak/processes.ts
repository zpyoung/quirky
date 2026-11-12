import type { ProcessRow } from './contracts'

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} [ 0-3]\d \d{2}:\d{2}:\d{2} \d{4})(.*)$/

/** Parses `ps -axo pid=,ppid=,stat=,rss=,lstart=,command=` rows, preserving the full start time. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = PROCESS_ROW.exec(line)
    if (!match) continue

    const pid = Number(match[1])
    const ppid = Number(match[2])
    const rssKb = Number(match[4])
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(rssKb) || rssKb < 0) continue

    rows.push({
      pid,
      ppid,
      state: match[3],
      rssKb,
      started: match[5],
      command: match[6].trimStart()
    })
  }

  return rows
}

/** Returns non-root descendants and sticky owned processes, recording their `pid:started` identities in `seen`. */
export function ownedProcesses(rows: ProcessRow[], roots: number[], seen: Set<string>): ProcessRow[] {
  const rootPids = new Set(roots)
  const children = new Map<number, ProcessRow[]>()
  const owned = new Set<string>()
  const pending = [...rootPids]
  const expanded = new Set<number>()

  for (const row of rows) {
    const key = `${row.pid}:${row.started}`
    if (!rootPids.has(row.pid) && seen.has(key)) {
      owned.add(key)
      pending.push(row.pid)
    }

    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }

  while (pending.length > 0) {
    const parentPid = pending.pop()!
    if (expanded.has(parentPid)) continue
    expanded.add(parentPid)

    const descendants = children.get(parentPid)
    if (!descendants) continue
    for (const row of descendants) {
      if (!rootPids.has(row.pid)) owned.add(`${row.pid}:${row.started}`)
      pending.push(row.pid)
    }
  }

  const result: ProcessRow[] = []
  for (const row of rows) {
    const key = `${row.pid}:${row.started}`
    if (!rootPids.has(row.pid) && owned.has(key)) {
      result.push(row)
      seen.add(key)
    }
  }

  return result
}
/** Reads the process table asynchronously; returns null if `ps` fails or exceeds five seconds. */
export async function readProcessTable(): Promise<ProcessRow[] | null> {
  try {
    const child = Bun.spawn(['ps', '-axo', 'pid=,ppid=,stat=,rss=,lstart=,command='], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may have exited as the timeout fired.
      }
    }, 5000)

    try {
      const [stdout, stderr, exitCode] = await Promise.allSettled([
        new Response(child.stdout).text(),
        drain(child.stderr),
        child.exited
      ])
      if (timedOut || stdout.status !== 'fulfilled' || stderr.status !== 'fulfilled' || exitCode.status !== 'fulfilled' || exitCode.value !== 0) return null
      return parseProcessTable(stdout.value)
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may have exited before cleanup.
      }
      await child.exited
      return null
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock()
  }
}
