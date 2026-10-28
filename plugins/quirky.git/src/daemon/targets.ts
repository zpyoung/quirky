import type { PluginCaller, Session, Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import { isMarkdownShelfNote, releaseMarkdownNotes, reserveMarkdownNotes, settleMarkdownNotes } from './note-bridge'
import { announce, listMixedNotes, type Note } from './notes'
import { formatNotes } from './notes-format'
import { containedPath } from './paths'

/** How long a new agent tab may take to settle its first prompt before the send gives up. */
const DELIVERY_WAIT_MS = 30_000
const DELIVERY_POLL_MS = 100

type AgentEntry = { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean }
type Problem = { kind: 'invalid-params' | 'conflict'; reason: string; message: string }

/** A session as the send menu shows it: whether notes may go there and, when not, why. */
export type NoteTarget = {
  session: string
  agent: string
  label: string
  title: string
  status: string
  state: string | null
  lastActivityAt: number
  sendable: boolean
  reason?: string
}

async function agentEntries(env: DaemonEnv): Promise<AgentEntry[]> {
  const listing = (await env.context.call('quirky.agents/list', {})) as { agents: AgentEntry[] }
  return listing.agents
}

const labelOf = (entries: readonly AgentEntry[], agent: string): string => entries.find((entry) => entry.id === agent)?.label ?? agent

/** Why `session` cannot take notes, or null when it can: an agent terminal of this worktree that is up, ready and not asking for approval. */
function problemWith(session: Session, worktree: Worktree, label: string): Problem | null {
  if (session.kind !== 'terminal' || session.agent === 'shell' || session.worktreeId !== worktree.id) {
    return { kind: 'invalid-params', reason: 'not-a-target', message: 'Notes go to an agent session in this worktree.' }
  }
  if (session.status === 'exited') return { kind: 'conflict', reason: 'exited', message: 'The session has exited.' }
  if (session.status === 'starting') return { kind: 'conflict', reason: 'starting', message: `${label} is still starting.` }
  const state = session.agentStatus?.state
  if (session.status === 'waiting' || state === 'waiting' || state === 'blocked') {
    return { kind: 'conflict', reason: 'waiting', message: `${label} is waiting for approval.` }
  }
  return null
}

/** The live agent sessions of the worktree, each marked sendable or not, and the agents a new tab can start. */
export function noteTargets(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const [sessions, entries] = await Promise.all([
      env.context.call('quirky.session/list', { worktree: worktree.id }) as Promise<Session[]>,
      agentEntries(env)
    ])
    const targets: NoteTarget[] = sessions
      .filter((session) => session.kind === 'terminal' && session.agent !== 'shell' && session.status !== 'exited')
      .map((session) => {
        const label = labelOf(entries, session.agent)
        const problem = problemWith(session, worktree, label)
        return {
          session: session.id,
          agent: session.agent,
          label,
          title: session.title,
          status: session.status,
          state: session.agentStatus?.state ?? null,
          lastActivityAt: session.lastActivityAt,
          sendable: problem === null,
          ...(problem === null ? {} : { reason: problem.message })
        }
      })
    const usable = entries.filter((entry) => entry.installed && entry.enabled)
    const ordered = [...usable.filter((entry) => entry.isDefault), ...usable.filter((entry) => !entry.isDefault)]
    return { sessions: targets, agents: ordered.map(({ id, label }) => ({ id, label })) }
  }
}

type TabbedGroup = { kind: 'group'; id: string; tabs: { root: PaneNode }[] }
type PaneNode = { kind: 'pane'; session: string } | { kind: 'split'; first: PaneNode }
type GroupNode = TabbedGroup | { kind: 'split'; first: GroupNode; second: GroupNode }

function findGroup(node: GroupNode, id: string): TabbedGroup | null {
  if (node.kind === 'group') return node.id === id ? node : null
  return findGroup(node.first, id) ?? findGroup(node.second, id)
}

/** The session of the tab `quirky.terminal/newTab` appended last to the workspace's active group. */
function newestSession(workspace: { root: GroupNode; activeGroup: string }): string | null {
  const tab = findGroup(workspace.root, workspace.activeGroup)?.tabs.at(-1)
  let node = tab?.root
  while (node && node.kind === 'split') node = node.first
  return node?.session ?? null
}

/** Polls the new session until its first prompt has settled; null when it never does within the wait. */
async function settledDelivery(env: DaemonEnv, sessionId: string): Promise<string | null> {
  const deadline = Date.now() + DELIVERY_WAIT_MS
  while (Date.now() < deadline) {
    const session = (await env.context.call('quirky.session/get', { session: sessionId }).catch(() => null)) as Session | null
    if (session === null) return null
    const delivery = session.promptDelivery ?? null
    if (delivery !== 'pending' && (delivery !== null || session.status !== 'starting')) return delivery
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS))
  }
  return null
}

const invalid = (env: DaemonEnv, reason: string, message: string): Error => env.errors.reasoned('invalid-params', reason, message)

async function deliverToSession(env: DaemonEnv, worktree: Worktree, sessionId: string, text: string): Promise<{ session: string; delivery: string }> {
  const [session, entries] = await Promise.all([env.context.call('quirky.session/get', { session: sessionId }) as Promise<Session>, agentEntries(env)])
  const problem = problemWith(session, worktree, labelOf(entries, session.agent))
  if (problem) throw env.errors.reasoned(problem.kind, problem.reason, problem.message)
  await env.context.call('quirky.terminal/send', { session: session.id, text, enter: true })
  return { session: session.id, delivery: 'pasted' }
}

async function deliverToNewAgent(env: DaemonEnv, worktree: Worktree, agent: string, text: string): Promise<{ session: string; delivery: string }> {
  const entry = (await agentEntries(env)).find((candidate) => candidate.id === agent)
  if (!entry || !entry.installed || !entry.enabled) throw invalid(env, 'agent-unavailable', `${entry?.label ?? agent} is not installed or enabled.`)
  const { workspace } = (await env.context.call('quirky.terminal/newTab', { workspace: worktree.id, agent, prompt: text })) as {
    workspace: { root: GroupNode; activeGroup: string }
  }
  const session = newestSession(workspace)
  const delivery = session === null ? null : await settledDelivery(env, session)
  if (session !== null && (delivery === 'pasted' || delivery === 'command-line')) return { session, delivery }
  if (delivery === 'unconfirmed') {
    throw env.errors.reasoned('conflict', 'unconfirmed', 'The agent may not have received the notes. They were kept.')
  }
  throw env.errors.reasoned('conflict', 'not-delivered', 'The agent did not receive the notes.')
}


/**
 * Sends notes (one, one file's, or all) to a running agent session or to a new agent tab, as one
 * prompt. The notes are held out of other sends from before the first await until the send ends.
 * On delivery each note that is unchanged since the send began is deleted (`sent`); one edited
 * meanwhile stays (`kept`). When delivery is refused, unconfirmed or fails, nothing is deleted.
 */
export function sendNotes(env: DaemonEnv): Handler {
  return async (params, caller: PluginCaller) => {
    const { scope } = params
    const hasSession = typeof params.session === 'string' && params.session !== ''
    const hasAgent = typeof params.agent === 'string' && params.agent !== ''
    if (hasSession === hasAgent) throw invalid(env, 'bad-target', 'Give exactly one of session and agent.')
    if (scope === 'note' && typeof params.id !== 'string') throw invalid(env, 'missing-id', 'Scope note needs the note id.')
    if (scope === 'file' && typeof params.path !== 'string') throw invalid(env, 'missing-path', 'Scope file needs the path.')

    const worktree = await env.resolve(params, caller)
    const path = scope === 'file' ? (await containedPath(worktree.path, params.path)).rel : undefined
    const inScope = await listMixedNotes(env, worktree, scope === 'file' ? path : undefined)
    let selected: Note[]
    if (scope === 'note') {
      const note = inScope.find((item) => item.id === params.id)
      if (!note) throw env.errors.reasoned('not-found', 'no-note', `There is no note ${params.id} in this worktree.`)
      selected = [note]
    } else selected = inScope
    if (selected.length === 0) throw env.errors.reasoned('conflict', 'no-unsent-notes', 'There are no unsent notes.')

    const picked = selected.filter((note) => !env.holds.has(worktree.id, note.id))
    if (picked.length === 0) throw env.errors.reasoned('conflict', 'all-held', 'All notes are already being sent.')
    const ids = picked.map((note) => note.id)
    const holdId = crypto.randomUUID()
    let editorReservationAttempted = false
    env.holds.add(worktree.id, ids)
    try {
      const markdown = picked.filter(isMarkdownShelfNote)
      if (markdown.length > 0) editorReservationAttempted = true
      const reservation = markdown.length === 0
        ? { reservedNoteIds: [], unavailableNoteIds: [] }
        : await reserveMarkdownNotes(env, worktree, holdId, markdown)
      const reserved = new Set(reservation.reservedNoteIds)
      const unavailable = markdown.filter((note) => !reserved.has(note.markdownSnapshot.id)).map((note) => note.id)
      const deliverable = picked.filter((note) => !isMarkdownShelfNote(note) || reserved.has(note.markdownSnapshot.id))
      if (deliverable.length === 0) {
        throw env.errors.reasoned('conflict', 'all-held', 'All notes are already being sent.')
      }

      const text = formatNotes(deliverable)
      const target = hasSession
        ? await deliverToSession(env, worktree, params.session, text)
        : await deliverToNewAgent(env, worktree, params.agent, text)
      const markdownPicked = deliverable.filter(isMarkdownShelfNote)
      const markdownSettlement = await settleMarkdownNotes(env, worktree, holdId, markdownPicked)
      const gitPicked = deliverable.filter((note) => !isMarkdownShelfNote(note))
      const gitSettlement = env.notes.settle(worktree.id, gitPicked)
      const sentIds = new Set([...gitSettlement.sent, ...markdownSettlement.sent])
      const keptIds = new Set([...gitSettlement.kept, ...markdownSettlement.kept, ...unavailable])
      return {
        sent: deliverable.filter((note) => sentIds.has(note.id)).map((note) => note.id),
        kept: [...deliverable.filter((note) => keptIds.has(note.id)).map((note) => note.id), ...unavailable],
        target: { session: target.session },
        delivery: target.delivery
      }
    } finally {
      env.holds.release(worktree.id, ids)
      try {
        if (editorReservationAttempted) await releaseMarkdownNotes(env, worktree, holdId)
      } finally {
        announce(env, worktree.id)
      }
    }
  }
}
