import type { Session } from '@quirky/protocol'
import { appendTab, boundSessions, closePaneOp, makeTab, normalize, setPaneExit, workspaceTabs } from './ops'
import type { OpResult } from './ops'
import { nextTerminalTitle } from './titles'
import { paneLeaves } from './tree'
import type { IdSource } from './tree'
import { isTerminalTab } from './types'
import type { Workspace } from './types'

export type ReconcileInput = {
  workspace: Workspace
  /** Every session the session plugin knows, whatever its worktree. */
  sessions: readonly Session[]
  /** Sessions held by panes of other workspaces, which this one must not adopt. */
  boundElsewhere: ReadonlySet<string>
  hasInput: (sessionId: string) => boolean
  ids: IdSource
  now: string
}

export type ReconcileOutput = {
  workspace: Workspace
  /** Sessions whose pane closed because the shell exited 0; the caller closes them in the session plugin. */
  closeSessions: string[]
  /** What changed, one line each, for the log. */
  notes: string[]
}

const GENERATED_SHELL_TITLE = /^Shell( \d+)?$/

/** The default title of an adopted tab: its session's own title unless that is the session plugin's generated shell title. */
function adoptedTitle(session: Session, existingTitles: readonly string[]): string {
  const generated = session.kind === 'terminal' && session.agent === 'shell' && GENERATED_SHELL_TITLE.test(session.title)
  return generated ? nextTerminalTitle(existingTitles) : session.title
}



/**
 * Brings one workspace in line with the session list: panes whose session is gone are removed,
 * sessions no pane holds get a tab at the end of the active group, and ended shells close their
 * pane (exit 0 after the person typed into it, or in a split) or keep it with the exit recorded.
 * A session lost with the PTY host changes nothing, since it cold-restores.
 */
export function reconcileWorkspace(input: ReconcileInput): ReconcileOutput {
  const { sessions, boundElsewhere, hasInput, ids, now } = input
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const closeSessions: string[] = []
  const notes: string[] = []
  let ws = normalize(input.workspace)
  const apply = (result: OpResult) => {
    if (result.ok) ws = result.value
  }

  for (const tab of workspaceTabs(ws)) {
    if (!isTerminalTab(tab)) continue
    for (const leaf of paneLeaves(tab.root)) {
      if (byId.has(leaf.session)) continue
      apply(closePaneOp(ws, leaf.id, null))
      notes.push(`removed ${leaf.id}: session ${leaf.session} is gone`)
    }
  }

  const held = new Set([...boundSessions(ws), ...boundElsewhere])
  const unbound = sessions
    .filter((session) => session.worktreeId === ws.id && session.kind === 'terminal' && session.background !== true && !held.has(session.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const session of unbound) {
    const titles = workspaceTabs(ws).filter(isTerminalTab).map((tab) => tab.defaultTitle)
    const defaultTitle = adoptedTitle(session, titles)
    apply(appendTab(ws, ws.activeGroup, makeTab(ids, { defaultTitle, session: session.id, now })))
    notes.push(`added a tab for session ${session.id}`)
  }

  const terminalTabs = workspaceTabs(ws).filter(isTerminalTab)
  const paneCounts = new Map(terminalTabs.map((tab) => [tab.id, paneLeaves(tab.root).length]))
  for (const tab of terminalTabs) {
    for (const leaf of paneLeaves(tab.root)) {
      const session = byId.get(leaf.session)
      if (!session || session.kind !== 'terminal') continue
      if (session.status !== 'exited') {
        if (leaf.exit) apply(setPaneExit(ws, leaf.id, null))
        continue
      }
      if (session.exitCause === 'host-restart' || session.exitCause === 'host-lost' || session.exitCause === 'stopped') continue
      const lone = paneCounts.get(tab.id) === 1
      if (session.exitCode === 0 && session.exitCause === 'exited' && !(lone && !hasInput(session.id))) {
        apply(closePaneOp(ws, leaf.id, null))
        closeSessions.push(session.id)
        notes.push(`closed ${leaf.id}: the shell exited 0`)
        continue
      }
      const exit = { code: session.exitCode, signal: session.exitSignal }
      if (leaf.exit?.code !== exit.code || leaf.exit?.signal !== exit.signal) {
        apply(setPaneExit(ws, leaf.id, exit))
        notes.push(`${leaf.id} kept: the shell ended with ${exit.code ?? exit.signal ?? 'no code'}`)
      }
    }
  }

  return { workspace: normalize(ws), closeSessions, notes }
}
