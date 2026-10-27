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

export type IsAlive = (pid: number, start: string | null) => boolean

const collapseSpaces = (text: string) => text.trim().replace(/\s+/g, ' ')

/**
 * Whether the agent process behind a pid still runs: the pid answers a signal 0 and, when its start
 * time is known, `ps` reports that same start (a reused pid starts at another time). Synchronous
 * because the identity decision waits on it.
 */
export function processAlive(pid: number, start: string | null): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  if (start === null) return true
  const ps = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'ignore'
  })
  if (ps.exitCode !== 0) return false
  return collapseSpaces(ps.stdout.toString()) === collapseSpaces(start)
}

/**
 * Decides whether an event belongs to a session's row. A row's lead is the agent and provider
 * session of its first accepted event; an event from a different agent kind whose row is unfinished,
 * or from a different provider session of the same kind, is a nested agent (a helper the lead
 * started) and is ignored while the row is fresh and the lead's process lives. A finished row of
 * another kind yields to the new agent, and a `clear`/`resume` SessionStart moves the lead.
 * The lead's process is probed only when the answer depends on it.
 */
export function decideIdentity(row: AgentRow | null, event: IdentityEvent, now: number, isAlive: IsAlive): IdentityVerdict {
  if (!row) return 'accept'
  if (row.lead.ended) return 'replace'

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
  if (row.lead.agentPid !== null && !isAlive(row.lead.agentPid, row.lead.agentStart)) return 'replace'
  return 'ignore'
}
