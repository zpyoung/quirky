import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'
import { queuedMessageReorderMoves } from './queued-message-positions'

describe('queuedMessageReorderMoves', () => {
  const cards = [
    { messageId: 'a', position: 1 },
    { messageId: 'b', position: 2 },
    { messageId: 'c', position: 4 }
  ]

  it('trades the positions the cards already hold', () => {
    expect(queuedMessageReorderMoves(cards, 'c', 0)).toEqual([
      { messageId: 'c', position: 1 },
      { messageId: 'a', position: 2 },
      { messageId: 'b', position: 4 }
    ])
  })

  it('clamps an index past the end', () => {
    expect(queuedMessageReorderMoves(cards, 'a', 99)).toEqual([
      { messageId: 'b', position: 1 },
      { messageId: 'c', position: 2 },
      { messageId: 'a', position: 4 }
    ])
  })

  it('moves nothing when the card is already there or unknown', () => {
    expect(queuedMessageReorderMoves(cards, 'b', 1)).toEqual([])
    expect(queuedMessageReorderMoves(cards, 'zzz', 0)).toEqual([])
  })
})

describe('queued card move', () => {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-move',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }
  const journals = createTrackedJournalOpener()
  let root: string
  let clock = 1_000

  const message = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

  async function open(): Promise<AgentSessionJournal> {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => `epoch-${clock}`
    })
  }

  async function queue(journal: AgentSessionJournal, ...ids: string[]) {
    for (const messageId of ids) {
      await journal.queuedMessages.insert({
        messageId,
        body: message(messageId),
        fingerprint: `fp-${messageId}`,
        hostInstance: 'proc-1'
      })
    }
  }

  const order = (journal: AgentSessionJournal) =>
    journal.queuedMessages.list().map((row) => row.messageId)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quirky-queued-move-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  it('reorders the waiting cards and clamps the index', async () => {
    const journal = await open()
    await queue(journal, 'a', 'b', 'c')
    expect(await journal.queuedMessages.move({ messageId: 'c', toIndex: 0 })).toBe('moved')
    expect(order(journal)).toEqual(['c', 'a', 'b'])
    expect(await journal.queuedMessages.move({ messageId: 'c', toIndex: 50 })).toBe('moved')
    expect(order(journal)).toEqual(['a', 'b', 'c'])
  })

  it('answers not-found for an unknown card', async () => {
    const journal = await open()
    await queue(journal, 'a')
    expect(await journal.queuedMessages.move({ messageId: 'nope', toIndex: 0 })).toBe('not-found')
  })

  it('moves nothing on a stale revision', async () => {
    const journal = await open()
    await queue(journal, 'a', 'b')
    const stale = journal.queuedMessages.revision() - 1
    expect(
      await journal.queuedMessages.move({ messageId: 'b', toIndex: 0, expectedRevision: stale })
    ).toBe('stale')
    expect(order(journal)).toEqual(['a', 'b'])
    expect(
      await journal.queuedMessages.move({
        messageId: 'b',
        toIndex: 0,
        expectedRevision: journal.queuedMessages.revision()
      })
    ).toBe('moved')
    expect(order(journal)).toEqual(['b', 'a'])
  })

  it('refuses a card that is already being sent', async () => {
    const journal = await open()
    await queue(journal, 'a', 'b')
    const draft = journal.queuedMessages.get('a')
    await journal.appendSubmission(
      {
        clientMessageId: 'sub-a',
        payloadFingerprint: draft?.fingerprint ?? 'fp-a',
        body: draft?.body ?? message('a'),
        fence: 0,
        handoverRecorded: true
      },
      { messageId: 'a', expect: 'waiting', settledByOp: null }
    )
    expect(await journal.queuedMessages.move({ messageId: 'a', toIndex: 1 })).toBe('sending')
  })
})
