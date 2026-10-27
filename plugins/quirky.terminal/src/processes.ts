import { basename } from 'node:path'

export type ProcessRow = { pid: number; ppid: number; command: string }

const ROW = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/

/**
 * Reads the output of `ps -A -o pid=,ppid=,comm=`: one row per line with the command reduced to
 * its basename (macOS prints the full path, which may contain spaces). Lines that don't fit
 * the shape are skipped.
 */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = ROW.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: basename(match[3]!) })
  }
  return rows
}

/** The machine's whole process table as `ps` prints it; throws when `ps` can't be run or fails. */
export function defaultPs(): string {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,comm='], { stdout: 'pipe', stderr: 'ignore' })
  if (!result.success) throw new Error(`ps exited with ${result.exitCode}`)
  return result.stdout.toString()
}

/**
 * The first direct child of process `pid` (in `ps` order) with its command's basename, or null
 * when it has none or the process table can't be read.
 */
export function runningChildOf(pid: number, ps: () => string = defaultPs): { command: string } | null {
  try {
    const child = parsePsOutput(ps()).find((row) => row.ppid === pid)
    return child ? { command: child.command } : null
  } catch {
    return null
  }
}
