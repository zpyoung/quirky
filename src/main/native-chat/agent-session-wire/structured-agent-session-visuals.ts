// Writes the `visual` journal items an agent opens with `quirky view`. One item per view, revised
// in place: a revision carries the next `version`, so the newest revision wins and `version` only
// increases. The host writes them outside any provider event, so they work for every agent.
//
// Every revision reads the item at its own place in the journal's write queue, so two concurrent
// patches of one view apply one after the other instead of both starting from the same version.

import { randomUUID } from 'node:crypto'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentJournalVisualItem } from '../../../shared/agent-session-journal-v1-items'
import {
  applyViewPatch,
  checkViewSpec,
  parseViewPatch,
  validateViewSpec,
  ViewPatchError
} from '../../../shared/view-spec/view-spec-validation'
import type { ViewSpec } from '../../../shared/view-spec/view-spec-types'
import { journalPayload } from '../agent-session-journal/journal-payload-bounds'
import type { JournalItemAppendOptions } from '../agent-session-journal/journal-store-contracts'
import type { JournalResolvedItem } from '../agent-session-journal/journal-item-appender'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** The part of a journal the visual writer reads and writes. */
export type VisualJournal = {
  itemBody(itemId: string): AgentJournalItemBody | null
  item(itemId: string): Pick<AgentJournalRenderItem, 'turnScope'> | null
  runningTurn(): { item: { itemId: string } } | null
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions
  ): Promise<unknown>
  appendResolvedItem(
    resolve: () => JournalResolvedItem | null,
    options: JournalItemAppendOptions
  ): Promise<unknown>
}

export type VisualRefusal =
  | { ok: false; reason: 'invalid-spec'; errors: string[] }
  | { ok: false; reason: 'not-found' | 'closed' | 'unwritable' }

export type VisualOpenResult = { ok: true; viewId: string; version: number } | VisualRefusal
export type VisualVersionResult = { ok: true; version: number } | VisualRefusal
export type VisualCloseResult = { ok: true } | VisualRefusal
export type VisualReadResult =
  | { ok: true; spec: unknown; version: number; closed: boolean }
  | VisualRefusal

export type VisualOpenInput = { spec: unknown; title?: string; placement?: 'inline' | 'pane' }
export type VisualUpdateInput = { viewId: string; spec: unknown }
export type VisualPatchInput = { viewId: string; patch: unknown }
export type VisualViewInput = { viewId: string }

export type StructuredAgentSessionVisualsDeps = {
  /** The fence a host-written row is stamped with. */
  fence: (sessionId: string) => number
  /** False when this process may not write the journal. */
  canWrite?: () => boolean
  newViewId?: () => string
}

export function visualIdentity(viewId: string): AgentJournalItemIdentity {
  return { provider: 'quirky', clientMessageId: `visual:${viewId}` }
}

type VisualBody = AgentJournalVisualItem

export class StructuredAgentSessionVisuals {
  constructor(private readonly deps: StructuredAgentSessionVisualsDeps) {}

  async open(
    sessionId: string,
    journal: VisualJournal,
    input: VisualOpenInput
  ): Promise<VisualOpenResult> {
    const checked = validateViewSpec(input.spec)
    if (!checked.ok) {
      return { ok: false, reason: 'invalid-spec', errors: checked.errors }
    }
    if (!this.canWrite()) {
      return { ok: false, reason: 'unwritable' }
    }
    const viewId = this.deps.newViewId?.() ?? randomUUID()
    const body = visualBody({
      viewId,
      version: 1,
      placement: input.placement ?? 'inline',
      spec: checked.spec,
      ...(input.title ? { title: input.title } : {})
    })
    await journal.appendItem(visualIdentity(viewId), body, {
      fence: this.deps.fence(sessionId),
      turnScope: runningTurnScope(journal)
    })
    return { ok: true, viewId, version: 1 }
  }

  async update(
    sessionId: string,
    journal: VisualJournal,
    input: VisualUpdateInput
  ): Promise<VisualVersionResult> {
    const checked = validateViewSpec(input.spec)
    if (!checked.ok) {
      return { ok: false, reason: 'invalid-spec', errors: checked.errors }
    }
    return this.revise(sessionId, journal, input.viewId, () => ({
      ok: true,
      spec: checked.spec
    }))
  }

  async patch(
    sessionId: string,
    journal: VisualJournal,
    input: VisualPatchInput
  ): Promise<VisualVersionResult> {
    const parsed = parseViewPatch(input.patch)
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid-spec', errors: parsed.errors }
    }
    return this.revise(sessionId, journal, input.viewId, (current) => {
      let patched: ViewSpec
      try {
        patched = applyViewPatch(current, parsed.patch)
      } catch (error) {
        if (error instanceof ViewPatchError) {
          return {
            ok: false,
            reason: 'invalid-spec',
            errors: error.errors.map((each) => `${each.path}: ${each.message}`)
          }
        }
        throw error
      }
      const checked = validateViewSpec(patched)
      return checked.ok
        ? { ok: true, spec: checked.spec }
        : { ok: false, reason: 'invalid-spec', errors: checked.errors }
    })
  }

  /** Closing a closed view succeeds without writing again. */
  async close(
    sessionId: string,
    journal: VisualJournal,
    input: VisualViewInput
  ): Promise<VisualCloseResult> {
    const itemId = agentJournalItemKey(visualIdentity(input.viewId))
    if (!isVisual(journal.itemBody(itemId))) {
      return { ok: false, reason: 'not-found' }
    }
    if (!this.canWrite()) {
      return { ok: false, reason: 'unwritable' }
    }
    let outcome: VisualCloseResult = { ok: false, reason: 'not-found' }
    await journal.appendResolvedItem(
      () => {
        const current = journal.itemBody(itemId)
        if (!isVisual(current)) {
          outcome = { ok: false, reason: 'not-found' }
          return null
        }
        outcome = { ok: true }
        if (current.closed === true) {
          return null
        }
        return {
          identity: visualIdentity(input.viewId),
          body: { ...current, version: current.version + 1, closed: true }
        }
      },
      this.revisionOptions(sessionId, journal, itemId)
    )
    return outcome
  }

  read(journal: VisualJournal, input: VisualViewInput): VisualReadResult {
    const current = journal.itemBody(agentJournalItemKey(visualIdentity(input.viewId)))
    if (!isVisual(current)) {
      return { ok: false, reason: 'not-found' }
    }
    return {
      ok: true,
      spec: JSON.parse(current.spec.head),
      version: current.version,
      closed: current.closed === true
    }
  }

  private async revise(
    sessionId: string,
    journal: VisualJournal,
    viewId: string,
    next: (current: ViewSpec) => { ok: true; spec: ViewSpec } | VisualRefusal
  ): Promise<VisualVersionResult> {
    const itemId = agentJournalItemKey(visualIdentity(viewId))
    if (!isVisual(journal.itemBody(itemId))) {
      return { ok: false, reason: 'not-found' }
    }
    if (!this.canWrite()) {
      return { ok: false, reason: 'unwritable' }
    }
    let outcome: VisualVersionResult = { ok: false, reason: 'not-found' }
    await journal.appendResolvedItem(
      () => {
        const current = journal.itemBody(itemId)
        if (!isVisual(current)) {
          outcome = { ok: false, reason: 'not-found' }
          return null
        }
        if (current.closed === true) {
          outcome = { ok: false, reason: 'closed' }
          return null
        }
        const revised = next(readSpec(current))
        if (!revised.ok) {
          outcome = revised
          return null
        }
        const version = current.version + 1
        outcome = { ok: true, version }
        return {
          identity: visualIdentity(viewId),
          body: visualBody({
            viewId,
            version,
            placement: current.placement,
            spec: revised.spec,
            ...(current.title ? { title: current.title } : {})
          })
        }
      },
      this.revisionOptions(sessionId, journal, itemId)
    )
    return outcome
  }

  private revisionOptions(
    sessionId: string,
    journal: VisualJournal,
    itemId: string
  ): JournalItemAppendOptions {
    return {
      fence: this.deps.fence(sessionId),
      turnScope: journal.item(itemId)?.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    }
  }

  private canWrite(): boolean {
    return this.deps.canWrite?.() !== false
  }
}

function isVisual(body: AgentJournalItemBody | null): body is VisualBody {
  return body?.kind === 'visual'
}

function visualBody(input: {
  viewId: string
  version: number
  placement: 'inline' | 'pane'
  spec: ViewSpec
  title?: string
}): VisualBody {
  return {
    kind: 'visual',
    viewId: input.viewId,
    version: input.version,
    placement: input.placement,
    spec: journalPayload(JSON.stringify(input.spec)),
    ...(input.title ? { title: input.title } : {})
  }
}

function readSpec(body: VisualBody): ViewSpec {
  const checked = checkViewSpec(JSON.parse(body.spec.head))
  if (!checked.ok) {
    throw new Error('a stored visual no longer validates as a view spec')
  }
  return checked.spec
}

/** A visual opened mid-turn belongs to that turn, so its chip sits beside the turn's work. */
function runningTurnScope(journal: VisualJournal): AgentJournalTurnScope {
  const running = journal.runningTurn()
  return running ? { kind: 'turn', turnItemId: running.item.itemId } : AGENT_JOURNAL_THREAD_SCOPE
}

/** The writer a host runs: rows are stamped with the conversation's current fence. */
export function createHostVisuals(
  deps: () => Pick<StructuredAgentSessionHostDeps, 'store'>
): StructuredAgentSessionVisuals {
  return new StructuredAgentSessionVisuals({
    fence: (sessionId) => structuredAgentSessionConversationFence(deps().store, sessionId),
    canWrite: () => !deps().store.readOnly
  })
}
