import type { ProcessRunner, RunResult } from '@quirky/protocol'

import { displayOf } from './model'
import type { AgentRow } from './types'

/** What the identity rules need to know about an incoming event. */
export type IdentityEvent = {
  source: string
  providerSession: string | null
  /** A SessionStart that moves the lead to a new provider session (`clear`, `resume`). */
  movesLead: boolean
}

/** `accept` updates the row; `replace` starts a new row for the event's agent; `ignore` changes nothing. */
export type IdentityVerdict = 'accept' | 'replace' | 'ignore'

export type IsAlive = (pid: number, start: string | null) => Promise<boolean>

const collapseSpaces = (text: string) => text.trim().replace(/\s+/g, ' ')

/**
 * Whether the agent process behind a pid still runs: signal 0 proves the pid exists and, when its
 * start time is known, the plugin runner checks that `ps` reports the same start. An incomplete
 * identity read is not evidence that the lead has exited.
 */
export async function processAlive(pid: number, start: string | null, runner: ProcessRunner): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  if (start === null) return true

  let result: RunResult
  try {
    result = await runner.run(['ps', '-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' },
      rerunnable: true
    })
  } catch {
    return true
  }
  if (result.stopped !== undefined || result.spawnError !== undefined || typeof result.exitCode !== 'number' || result.signal !== null) return true
  if (result.exitCode !== 0) return false
  return collapseSpaces(result.stdoutText) === collapseSpaces(start)
}

/**
 * Decides whether an event belongs to a session's row. A row's lead is the agent and provider
 * session of its first accepted event; an event from a different agent kind whose row is unfinished,
 * or from a different provider session of the same kind, is a nested agent (a helper the lead
 * started) and is ignored while the row is fresh and the lead's process lives. A finished row of
 * another kind yields to the new agent, and a `clear`/`resume` SessionStart moves the lead.
 * A lead whose process is gone yields to any event, so a successor never inherits its pid.
 */
export async function decideIdentity(
  row: AgentRow | null,
  event: IdentityEvent,
  now: number,
  isAlive: IsAlive
): Promise<IdentityVerdict> {
  if (!row) return 'accept'
  if (row.lead.ended) return 'replace'
  // a successor can speak with no foreign provider session, so a dead lead is found before the event is judged
  if (row.lead.agentPid !== null && !(await isAlive(row.lead.agentPid, row.lead.agentStart))) return 'replace'

  const sameKind = event.source === row.agent
  if (!sameKind) {
    if (row.state === 'done') return 'replace'
  } else {
    const theirs = event.providerSession
    const ours = row.lead.providerSession
    const otherLead = theirs !== null && ours !== null && theirs !== ours && !event.movesLead
    if (!otherLead) return 'accept'
    // an agent whose hooks carry no pid can't be told apart from a successor once it has finished
    if (row.lead.agentPid === null && row.state === 'done') return 'replace'
  }

  const display = displayOf(row, now, true).display
  if (display === 'unverifiable' || display === 'idle' || display === 'unconfirmed') return 'replace'
  return 'ignore'
}
