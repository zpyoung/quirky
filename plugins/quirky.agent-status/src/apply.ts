import { foldLead } from './fold'
import { CAPS, capLine, capRaw, capText, readableDetail } from './model'
import type { AgentRow, Child, ChildKind, ChildOp, Normalized } from './types'

const MAX_CHILDREN = 64
const SESSION_CRONS_ID = 'session-crons'
const TOOL_NAME_CAP = 60

/** The event being applied, beside its normalized meaning. */
export type ApplyEvent = {
  sessionId: string
  /** The hook source, e.g. `claude`, `qwen-code`. */
  source: string
  /** When the evidence happened; a replayed event keeps its original time. */
  at: number
  agentPid?: number
  agentStart?: string
  replay: boolean
}

export type ApplyResult = {
  /** The row after the event; null when there is none (the agent's process ended, or the event can't start a row). */
  row: AgentRow | null
  /** The state the row just settled into, when that is worth announcing: a real change into done, waiting or blocked that is not a replay or a session boundary. */
  settled: 'done' | 'waiting' | 'blocked' | null
}

type Held = NonNullable<AgentRow['heldPermission']>

/** A done row with no evidence yet, for the event or fallback that starts it. */
export function newRow(ev: ApplyEvent): AgentRow {
  return {
    sessionId: ev.sessionId,
    agent: ev.source,
    state: 'done',
    prompt: '',
    detail: '',
    lead: { providerSession: null, agentPid: null, agentStart: null, ended: false, state: 'done', stateStartedAt: ev.at },
    children: [],
    stateStartedAt: ev.at,
    evidenceAt: ev.at,
    turnStartedAt: null,
    lastHookAt: null,
    source: 'hook'
  }
}

const hasFields = (n: Normalized) => Object.values(n.fields).some((value) => value !== undefined)

/** An event that changes nothing about the row: it neither names a state nor touches children or text. */
function isInert(n: Normalized): boolean {
  return (
    n.state === null &&
    !n.newTurn &&
    !n.childOps?.length &&
    !n.inventory &&
    n.cronsActive === undefined &&
    !hasFields(n) &&
    !n.permissionRequest
  )
}

function upsertChild(children: Child[], id: string, kind: ChildKind, state: Child['state']): void {
  const at = children.findIndex((child) => child.id === id)
  if (at >= 0) {
    children[at] = { ...children[at]!, state }
    return
  }
  children.push({ id, kind, state })
  if (children.length > MAX_CHILDREN) children.shift()
}

function removeChild(children: Child[], id: string): Child | undefined {
  const at = children.findIndex((child) => child.id === id)
  return at >= 0 ? children.splice(at, 1)[0] : undefined
}

/**
 * The tool event that settles a Claude permission request: the same tool with the same input from
 * the same owner. Claude sends the request without a tool use id and the approved tool's events
 * carry one, so a request that recorded none matches on tool and input alone; a recorded id must
 * match exactly. A failure carries no tool or input, so only its exact id settles the wait.
 */
function resumesApprovedTool(held: Held, n: Normalized): boolean {
  if ((n.agentId ?? null) !== held.childId) return false
  const nextId = n.fields.toolUseId
  if (n.eventName === 'PostToolUseFailure') return held.toolUseId !== null && held.toolUseId === nextId
  if (n.eventName !== 'PreToolUse' && n.eventName !== 'PostToolUse') return false
  if (nextId === undefined || (held.toolUseId !== null && held.toolUseId !== nextId)) return false
  return n.fields.toolName === held.toolName && (n.fields.toolInput ?? '') === held.input
}

/** The owning child ending: its stop, or its move to done. */
function endsHeldChild(held: Held, ops: readonly ChildOp[]): boolean {
  return held.childId !== null && ops.some((op) => op.id === held.childId && (op.op === 'stop' || (op.op === 'state' && op.state === 'done')))
}

/** Whether this event settles the held permission request. */
function releasesHold(held: Held, n: Normalized): boolean {
  if (n.newTurn && n.agentId === undefined) return true
  if (endsHeldChild(held, n.childOps ?? [])) return true
  return n.state === 'working' && resumesApprovedTool(held, n)
}

const isLeadEvent = (n: Normalized) => n.agentId === undefined

function applyChildOps(draft: AgentRow, ops: readonly ChildOp[]): { removedWaiting: boolean } {
  let removedWaiting = false
  for (const op of ops) {
    if (op.op === 'start') {
      upsertChild(draft.children, op.id, op.kind, 'working')
    } else if (op.op === 'stop') {
      if (removeChild(draft.children, op.id)?.state === 'waiting') removedWaiting = true
    } else {
      const known = draft.children.find((child) => child.id === op.id)
      if (known?.state === 'waiting' && op.state !== 'waiting') removedWaiting = true
      if (op.state === 'done') removeChild(draft.children, op.id)
      // a child's tool event can be the first sign of it, so an unknown id becomes a child
      else upsertChild(draft.children, op.id, known?.kind ?? 'agent', op.state)
    }
  }
  return { removedWaiting }
}

function applyInventory(draft: AgentRow, n: Normalized): void {
  const inventory = n.inventory
  if (!inventory) return
  const listed = new Set<string>()
  for (const task of inventory.tasks) {
    listed.add(task.id)
    if (!task.running) removeChild(draft.children, task.id)
    else upsertChild(draft.children, task.id, task.kind, draft.children.find((child) => child.id === task.id)?.state ?? 'working')
  }
  if (!inventory.complete) return
  // foreground subagents never appear in an inventory, so only a turn end (when none can run) may retire agents
  const retiresAgents = n.state === 'done'
  draft.children = draft.children.filter(
    (child) => listed.has(child.id) || child.kind === 'cron' || (child.kind === 'agent' && !retiresAgents)
  )
}

/**
 * The text fields an event sets. A lead event merges what it names; a new turn first clears the
 * previous turn's. A child's event, or the end of a waiting child, replaces the tool and question
 * (the normalizer sends the lead's own back when the child's card is settled).
 */
function applyFields(draft: AgentRow, n: Normalized, replaceCard: boolean): void {
  const { fields } = n
  if (isLeadEvent(n) && n.newTurn) {
    draft.prompt = ''
    delete draft.toolName
    delete draft.toolInput
    delete draft.lastAssistantMessage
    delete draft.question
  }
  if (replaceCard && hasFields(n)) {
    delete draft.toolName
    delete draft.toolInput
    delete draft.question
  } else if (isLeadEvent(n) && n.state !== null) {
    delete draft.question
  }
  if (fields.prompt !== undefined) draft.prompt = capLine(fields.prompt, CAPS.prompt)
  if (fields.toolName !== undefined) draft.toolName = capLine(fields.toolName, TOOL_NAME_CAP)
  if (fields.toolInput !== undefined) draft.toolInput = capLine(fields.toolInput, CAPS.toolInput)
  if (fields.lastAssistantMessage !== undefined) draft.lastAssistantMessage = capText(fields.lastAssistantMessage, CAPS.lastAssistantMessage)
  if (fields.question !== undefined) draft.question = capRaw(fields.question, CAPS.question)
  if (fields.model !== undefined) draft.model = capLine(fields.model, CAPS.model)
}

function recordEvidence(draft: AgentRow, ev: ApplyEvent): void {
  draft.evidenceAt = ev.at
  draft.lastHookAt = ev.at
  draft.source = ev.replay ? 'replay' : 'hook'
  delete draft.restoredUnconfirmed
}

/**
 * Applies one hook event to a session's row: identity has already accepted it. Children and
 * background work fold into the lead's state; Claude's permission hold keeps a waiting row waiting
 * until the approved tool resumes, an explicit prompt arrives or the owning child ends; the state
 * clock moves only when the folded state does. Pure: the caller stores the row and announces it.
 */
export function applyEvent(prev: AgentRow | null, n: Normalized, ev: ApplyEvent): ApplyResult {
  if (n.endsProcess) return { row: null, settled: null }
  if (isInert(n)) return { row: prev, settled: null }
  if (prev === null && (n.state === null || n.agentId !== undefined)) return { row: null, settled: null }

  const draft: AgentRow = prev ? { ...prev, lead: { ...prev.lead }, children: [...prev.children] } : newRow(ev)
  const leadEvent = isLeadEvent(n)

  if (ev.agentPid !== undefined && (draft.lead.agentPid === null || n.movesLead)) {
    draft.lead.agentPid = ev.agentPid
    draft.lead.agentStart = ev.agentStart ?? null
  }
  if (n.providerSession && (draft.lead.providerSession === null || n.movesLead)) {
    draft.lead.providerSession = n.providerSession.id
  }

  let held = draft.heldPermission
  if (held && n.state === 'working' && (n.agentId ?? null) === held.childId && !releasesHold(held, n)) {
    // the approval is still pending: an unrelated tool of the same owner is evidence only
    recordEvidence(draft, ev)
    draft.detail = readableDetail(draft)
    return { row: draft, settled: null }
  }
  if (held && releasesHold(held, n)) held = undefined

  if (leadEvent && n.newTurn && n.sessionBoundary) draft.children = []
  const { removedWaiting } = applyChildOps(draft, n.childOps ?? [])
  applyInventory(draft, n)
  if (n.cronsActive === true) upsertChild(draft.children, SESSION_CRONS_ID, 'cron', 'working')
  else if (n.cronsActive === false) removeChild(draft.children, SESSION_CRONS_ID)

  if (leadEvent && n.state !== null) {
    if (draft.lead.state !== n.state) draft.lead.stateStartedAt = ev.at
    // a verdict-less done after a done (Cursor's late response text) keeps the verdict the turn ended with
    const lateText = n.state === 'done' && !n.newTurn && draft.lead.state === 'done' && n.outcome === undefined && n.interrupted === undefined
    draft.lead.state = n.state
    if (!lateText) {
      draft.outcome = n.state === 'done' ? n.outcome : undefined
      draft.interrupted = n.state === 'done' ? n.interrupted : undefined
    }
    draft.sessionBoundary = n.sessionBoundary === true ? true : undefined
    if (n.newTurn) draft.turnStartedAt = ev.at
  }
  if (draft.outcome === undefined) delete draft.outcome
  if (draft.interrupted === undefined) delete draft.interrupted
  if (draft.sessionBoundary === undefined) delete draft.sessionBoundary

  applyFields(draft, n, !leadEvent || removedWaiting)

  if (ev.source === 'claude' && n.state === 'waiting' && n.permissionRequest && !n.fields.question) {
    held = {
      toolUseId: n.fields.toolUseId ?? null,
      toolName: capLine(n.fields.toolName, TOOL_NAME_CAP),
      input: capLine(n.fields.toolInput, CAPS.toolInput),
      childId: n.agentId ?? null
    }
  } else if (held) {
    const leadMovedOn = held.childId === null && leadEvent && n.state !== null
    const ownerGone = held.childId !== null && !draft.children.some((child) => child.id === held!.childId)
    if (leadMovedOn || ownerGone) held = undefined
  }
  if (held) draft.heldPermission = held
  else delete draft.heldPermission

  const waitingChild = draft.children.some((child) => child.state === 'waiting')
  if (waitingChild && draft.stashedState === undefined) draft.stashedState = draft.lead.state
  else if (!waitingChild) delete draft.stashedState

  const folded = foldLead(draft.lead.state, draft.children, false)
  draft.state = folded.state
  if (folded.workingMode) draft.workingMode = folded.workingMode
  else delete draft.workingMode

  const stateChanged = prev?.state !== draft.state
  if (stateChanged) draft.stateStartedAt = ev.at
  recordEvidence(draft, ev)
  draft.detail = readableDetail(draft)

  const settled = draft.state === 'working' ? null : draft.state
  return { row: draft, settled: stateChanged && !ev.replay && n.sessionBoundary !== true ? settled : null }
}
