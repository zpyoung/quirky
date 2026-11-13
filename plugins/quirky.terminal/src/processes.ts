import type { ProcessRunner } from '@quirky/protocol'
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

/** The machine's whole process table as `ps` prints it; rejects when the command does not succeed cleanly. */
export async function defaultPs(runner: ProcessRunner): Promise<string> {
  const result = await runner.run(['ps', '-A', '-o', 'pid=,ppid=,comm='], { rerunnable: true })
  if (result.exitCode !== 0 || result.signal !== null || result.stopped !== undefined || result.spawnError !== undefined) {
    throw new Error('ps failed')
  }
  return result.stdoutText
}

/**
 * The first direct child of process `pid` (in `ps` order) with its command's basename, or null
 * when it has none or the process table can't be read.
 */
export async function runningChildOf(pid: number, ps: () => Promise<string>): Promise<{ command: string } | null> {
  try {
    const child = parsePsOutput(await ps()).find((row) => row.ppid === pid)
    return child ? { command: child.command } : null
  } catch {
    return null
  }
}
