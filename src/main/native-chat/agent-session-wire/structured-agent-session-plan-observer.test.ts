import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalResolution,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import { modeIdentity, planIdentity } from '../agent-session-timeline/plan-mode-items'
import {
  StructuredAgentSessionPlanObserver,
  type PlanObserverJournal
} from './structured-agent-session-plan-observer'

const SESSION = 'session-1'
const TURN_ITEM = 'turn-item-t1'
const PENDING: AgentJournalResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

type Row = {
  body: AgentJournalItemBody
  sequence: number
  turnScope: AgentJournalTurnScope
  agentId?: string
}

class FakeJournal implements PlanObserverJournal {
  readonly rows = new Map<string, Row>()
  epoch = 'epoch-1'
  last = 0

  cursor = () => ({ epoch: this.epoch, sequence: this.last })
  itemBody = (itemId: string) => this.rows.get(itemId)?.body ?? null
  visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const [itemId, row] of this.rows) {
      visit(itemId, row.sequence, row.body, {
        turnScope: row.turnScope,
        ...(row.agentId ? { agentId: row.agentId } : {})
      })
    }
  }
  appendItem = async (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: { fence: number; turnScope: AgentJournalTurnScope }
  ) => {
    this.put(agentJournalItemKey(identity), body, options.turnScope)
  }

  put(itemId: string, body: AgentJournalItemBody, turnScope: AgentJournalTurnScope): void {
    this.last += 1
    const held = this.rows.get(itemId)
    this.rows.set(itemId, { body, turnScope, sequence: held?.sequence ?? this.last })
  }

  markSubagent(itemId: string, agentId: string): void {
    const row = this.rows.get(itemId)
    if (row) {
      row.agentId = agentId
    }
  }

  turn(state: 'running' | 'completed'): void {
    this.put(
      TURN_ITEM,
      agentJournalTurnBody({
        turnId: 't1',
        state,
        userItemId: 'user',
        startedAt: 1,
        ...(state === 'completed' ? { completedAt: 2, outcome: 'success' } : {})
      }),
      { kind: 'thread' }
    )
  }

  approval(key: string, text: string | null, resolution = PENDING): void {
    const body: AgentJournalApprovalItem = {
      kind: 'approval',
      title: 'Review proposed plan',
      ...(text === null ? {} : { subject: { kind: 'plan', text, filePath: '/plans/p.md' } }),
      detail: text,
      options: [
        { id: 'allow', label: 'Approve plan' },
        { id: 'deny', label: 'Keep planning' }
      ],
      resolution
    }
    this.put(key, body, { kind: 'turn', turnItemId: TURN_ITEM })
  }

  resolve(key: string, resolution: AgentJournalResolution): void {
    const held = this.rows.get(key)
    if (held?.body.kind === 'approval') {
      this.put(key, { ...held.body, resolution }, held.turnScope)
    }
  }

  plan(version: number) {
    return this.rows.get(agentJournalItemKey(planIdentity(version)))?.body
  }

  modes() {
    return [...this.rows.entries()]
      .filter(([, row]) => row.body.kind === 'mode')
      .map(([, row]) => row.body)
  }
}

const resolved = (selectedOptionId: string): AgentJournalResolution => ({
  state: 'resolved',
  selectedOptionId,
  resolvedBy: 'client',
  resolvedAt: 5
})
const CANCELLED: AgentJournalResolution = {
  state: 'cancelled',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

function observerFor(permissionMode: 'ask' | 'accept-edits' | undefined = 'ask') {
  return new StructuredAgentSessionPlanObserver({
    fence: () => 1,
    permissionMode: () => permissionMode,
    logger: { warn: vi.fn(), error: vi.fn() }
  })
}

function started(observer: StructuredAgentSessionPlanObserver): FakeJournal {
  const journal = new FakeJournal()
  journal.put('submission', { kind: 'status', text: 'hi', tone: 'muted' }, { kind: 'thread' })
  observer.observe(SESSION, journal)
  journal.turn('running')
  observer.observe(SESSION, journal)
  return journal
}

async function settle(observer: StructuredAgentSessionPlanObserver, journal: FakeJournal) {
  observer.observe(SESSION, journal)
  await observer.idle()
}

describe('plan versions', () => {
  it('writes a waiting plan for a plan approval and settles it approved', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    expect(journal.plan(1)).toEqual({
      kind: 'plan',
      version: 1,
      status: 'waiting',
      text: 'Step one',
      filePath: '/plans/p.md',
      approvalItemId: 'approval-1'
    })

    journal.resolve('approval-1', resolved('allow'))
    await settle(observer, journal)
    expect(journal.plan(1)).toMatchObject({ version: 1, status: 'approved' })
    expect(journal.rows.get('approval-1')?.body).toMatchObject({ kind: 'approval' })
  })

  it('marks a kept-planning plan revised and flags a repeated text unchanged', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    journal.resolve('approval-1', resolved('deny'))
    await settle(observer, journal)
    expect(journal.plan(1)).toMatchObject({ status: 'revised' })

    journal.approval('approval-2', 'Step one')
    await settle(observer, journal)
    expect(journal.plan(2)).toMatchObject({ version: 2, status: 'waiting', unchanged: true })
  })

  it('does not flag a plan unchanged when an empty version came between', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    journal.resolve('approval-1', resolved('deny'))
    journal.approval('approval-2', '')
    await settle(observer, journal)
    journal.resolve('approval-2', resolved('deny'))
    journal.approval('approval-3', 'Step one')
    await settle(observer, journal)
    expect(journal.plan(3)).toMatchObject({ version: 3, status: 'waiting' })
    expect(journal.plan(3)).not.toHaveProperty('unchanged')
  })

  it('does not flag a plan unchanged after an empty version across a reopen', async () => {
    const first = observerFor()
    const journal = started(first)
    journal.approval('approval-1', 'Step one')
    await settle(first, journal)
    journal.resolve('approval-1', resolved('deny'))
    journal.approval('approval-2', '')
    await settle(first, journal)
    journal.resolve('approval-2', resolved('deny'))
    await settle(first, journal)

    const second = observerFor()
    second.observe(SESSION, journal)
    journal.approval('approval-3', 'Step one')
    await settle(second, journal)
    expect(journal.plan(3)).not.toHaveProperty('unchanged')
  })

  it('writes no plan or mode for a subagent plan approval pending at open', async () => {
    const journal = new FakeJournal()
    journal.turn('running')
    journal.approval('approval-1', 'Child plan')
    journal.markSubagent('approval-1', 'child-1')
    const observer = observerFor()
    observer.observe(SESSION, journal)
    await observer.idle()
    expect(journal.plan(1)).toBeUndefined()
    expect(journal.modes()).toEqual([])
  })

  it('settles a cancelled approval not-answered, stopped', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    journal.resolve('approval-1', CANCELLED)
    await settle(observer, journal)
    expect(journal.plan(1)).toMatchObject({ status: 'not-answered', reason: 'stopped' })
  })

  it('settles a plan still pending when its turn ends', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    journal.turn('completed')
    await settle(observer, journal)
    expect(journal.plan(1)).toMatchObject({ status: 'not-answered', reason: 'stopped' })
  })

  it('settles a plan left waiting by a restart, and numbers the next version after it', async () => {
    const first = observerFor()
    const journal = started(first)
    journal.approval('approval-1', 'Step one')
    await settle(first, journal)
    journal.turn('completed')
    journal.resolve('approval-1', CANCELLED)

    const second = observerFor()
    second.observe(SESSION, journal)
    await second.idle()
    expect(journal.plan(1)).toMatchObject({ status: 'not-answered', reason: 'restarted' })

    journal.turn('running')
    journal.approval('approval-2', 'Step two')
    await settle(second, journal)
    expect(journal.plan(2)).toMatchObject({ version: 2, status: 'waiting' })
  })

  it('writes no plan for an approval that is not a plan', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', null)
    await settle(observer, journal)
    expect(journal.plan(1)).toBeUndefined()
  })

  it('marks an empty plan', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', '')
    await settle(observer, journal)
    expect(journal.plan(1)).toMatchObject({ empty: true, status: 'waiting' })
  })
})

describe('mode markers', () => {
  it('marks plan mode on a proposal and the mode an approved plan returns to', async () => {
    const observer = observerFor('accept-edits')
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    journal.resolve('approval-1', resolved('allow'))
    await settle(observer, journal)
    expect(journal.modes()).toEqual([
      { kind: 'mode', mode: 'plan', previous: 'accept-edits' },
      { kind: 'mode', mode: 'accept-edits', previous: 'plan' }
    ])
    expect(journal.rows.has(agentJournalItemKey(modeIdentity(2)))).toBe(true)
  })

  it('marks plan mode when Claude enters it', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.put(
      'tool-1',
      { kind: 'tool-call', name: 'EnterPlanMode', input: {}, callId: 'c1', state: 'completed' },
      { kind: 'turn', turnItemId: TURN_ITEM }
    )
    await settle(observer, journal)
    expect(journal.modes()).toEqual([{ kind: 'mode', mode: 'plan', previous: 'ask' }])
  })

  it('writes a marker per permission-mode change and skips a repeat', async () => {
    const observer = observerFor()
    const journal = started(observer)
    observer.recordPermissionMode(SESSION, journal, 'auto', 'ask')
    observer.recordPermissionMode(SESSION, journal, 'auto', 'ask')
    observer.recordPermissionMode(SESSION, journal, 'full-access', 'auto')
    await settle(observer, journal)
    expect(journal.modes()).toEqual([
      { kind: 'mode', mode: 'auto', previous: 'ask' },
      { kind: 'mode', mode: 'full-access', previous: 'auto' }
    ])
  })

  it('names plan as the previous mode when the permission mode changes in plan mode', async () => {
    const observer = observerFor()
    const journal = started(observer)
    journal.approval('approval-1', 'Step one')
    await settle(observer, journal)
    observer.recordPermissionMode(SESSION, journal, 'auto', 'ask')
    await settle(observer, journal)
    expect(journal.modes().at(-1)).toEqual({ kind: 'mode', mode: 'auto', previous: 'plan' })
  })

  it('writes nothing for the mode the chat already held', async () => {
    const observer = observerFor()
    const journal = started(observer)
    observer.recordPermissionMode(SESSION, journal, 'ask', 'ask')
    await settle(observer, journal)
    expect(journal.modes()).toEqual([])
  })

  it('keeps counting from the markers a journal already holds', async () => {
    const first = observerFor()
    const journal = started(first)
    first.recordPermissionMode(SESSION, journal, 'auto', 'ask')
    await settle(first, journal)

    const second = observerFor()
    second.recordPermissionMode(SESSION, journal, 'full-access', 'auto')
    await settle(second, journal)
    expect(journal.rows.has(agentJournalItemKey(modeIdentity(2)))).toBe(true)
    expect(journal.modes()).toHaveLength(2)
  })
})
