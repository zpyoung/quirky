import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { RpcErrorCode, type Session } from '@quirky/protocol'
import { HandoffRig } from './support'

let rig: HandoffRig
let stopReady: (() => void) | undefined
afterEach(async () => {
  stopReady?.()
  stopReady = undefined
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

type Record_ = {
  id: string
  createdAt: number
  relationship: string
  parent: Record<string, string | null>
  child: Record<string, string | null>
}
type Started = { child: { session: string; tab: string; worktreeId: string }; lineageId: string | null }

const start = (params: Record<string, unknown>) => rig.call('quirky.handoff/start', params) as Promise<Started>
const lineage = (params: Record<string, unknown> = {}) => rig.call('quirky.handoff/lineage', params) as Promise<{ records: Record_[] }>
const sessionOf = (id: string) => rig.call('quirky.session/get', { session: id }) as Promise<Session>
const jump = (params: Record<string, unknown>) => rig.call('quirky.handoff/jump', params) as Promise<{ focused: { session: string; pane: string }; lineageId: string }>

async function opened(name = 'w') {
  rig = await HandoffRig.start()
  const s = await rig.session(name)
  rig.setHistory(['some output'])
  stopReady = rig.autoReady()
  return s
}

const handoff = (from: Session, controls: Record<string, unknown> = {}) =>
  start({ source: { session: from.id }, controls: { agent: 'gemini', ...controls }, wait: true })

describe('SC-52: one record holds both ends, and the child fills in later', () => {
  test('the record names parent and child, and the child provider session is set once', async () => {
    const s = await opened()
    const path = rig.claudeTranscript('w', 'P')
    await rig.reportTranscript(s.id, 'P', path)
    const result = await handoff(s, { relationship: 'reviews' })

    await rig.reportTranscript(result.child.session, 'Q')
    await rig.reportTranscript(result.child.session, 'R')

    const { records } = await lineage({ session: result.child.session })
    expect(records).toHaveLength(1)
    const source = await sessionOf(s.id)
    expect(records[0]).toEqual({
      id: result.lineageId!,
      createdAt: expect.any(Number),
      relationship: 'reviews',
      parent: { session: s.id, agent: 'claude', providerSessionId: 'P', transcriptPath: path, worktreeId: s.worktreeId, title: source.title },
      child: {
        session: result.child.session,
        agent: 'gemini',
        providerSessionId: 'Q',
        transcriptPath: null,
        worktreeId: s.worktreeId,
        title: expect.anything(),
        tab: result.child.tab
      }
    })
    expect(await lineage({ session: s.id })).toEqual({ records })
    expect(rig.pluginEvents('changed').filter((data) => data.kind === 'lineage').length).toBeGreaterThanOrEqual(2)
  })

  test('a provider session the child reported before the record was written is picked up', async () => {
    const s = await opened()
    const stop = rig.onSpawn((id) => {
      void rig.call('quirky.session/setProviderSession', { session: id, id: 'early' })
    })
    try {
      const result = await handoff(s)
      await rig.settle()
      expect((await lineage({ session: result.child.session })).records[0]!.child.providerSessionId).toBe('early')
    } finally {
      stop()
    }
  })

  test('the list is newest first and an unfiltered call lists every record', async () => {
    const s = await opened()
    const other = await rig.session('w')
    const first = await handoff(s)
    await Bun.sleep(5)
    const second = await handoff(other)
    await Bun.sleep(5)
    const third = await handoff(s, { relationship: 'branches-from' })
    expect((await lineage()).records.map((record) => record.id)).toEqual([third.lineageId!, second.lineageId!, first.lineageId!])
    expect((await lineage({ session: s.id })).records.map((record) => record.id)).toEqual([third.lineageId!, first.lineageId!])
    expect((await lineage({ session: 's_nobody' })).records).toEqual([])
  })
})

describe('SC-53: both tabs show their badge', () => {
  test('S gets Handed off, C gets From handoff, and a second handoff adds a second badge', async () => {
    const s = await opened()
    const first = await handoff(s, { relationship: 'reviews' })

    const keyOf = (id: string | null) => `quirky.handoff/lineage:${id}`
    const parentBadges = (await sessionOf(s.id)).badges!
    const childBadges = (await sessionOf(first.child.session)).badges!
    expect(parentBadges[keyOf(first.lineageId)]).toEqual({
      label: 'Handed off · reviews',
      tooltip: expect.any(String),
      command: 'command:quirky.handoff/jump',
      args: { session: s.id, lineage: first.lineageId }
    })
    expect(childBadges[keyOf(first.lineageId)]).toEqual({
      label: 'From handoff · reviews',
      tooltip: expect.any(String),
      command: 'command:quirky.handoff/jump',
      args: { session: first.child.session, lineage: first.lineageId }
    })

    const second = await handoff(s, { relationship: 'continues' })
    const both = (await sessionOf(s.id)).badges!
    expect(Object.entries(both).map(([key, badge]) => [key, badge.label])).toEqual([
      [keyOf(first.lineageId), 'Handed off · reviews'],
      [keyOf(second.lineageId), 'Handed off · continues']
    ])
  })

  test('branches-from reads as two words', async () => {
    const s = await opened()
    const result = await handoff(s, { relationship: 'branches-from' })
    const badges = Object.values((await sessionOf(result.child.session)).badges!)
    expect(badges.map((badge) => badge.label)).toEqual(['From handoff · branches from'])
  })
})

describe('SC-54: the badge jumps to the other end', () => {
  async function twoHandoffs() {
    const s = await opened()
    const w2 = await rig.worktree('w2')
    await rig.layout(s.worktreeId)
    const first = await handoff(s, { target: { worktree: w2.id }, relationship: 'reviews' })
    const second = await handoff(s, { relationship: 'continues' })
    return { s, w2, first, second }
  }

  const activeTab = async (worktreeId: string) => (await rig.layout(worktreeId)).root.activeTab as string

  test('each badge focuses its own other end, and the newest wins without a lineage', async () => {
    const { s, w2, first, second } = await twoHandoffs()

    const toFirst = await jump({ session: s.id, lineage: first.lineageId })
    expect(toFirst.lineageId).toBe(first.lineageId!)
    expect(toFirst.focused.session).toBe(first.child.session)
    expect(await activeTab(w2.id)).toBe(first.child.tab)

    const back = await jump({ session: first.child.session, lineage: first.lineageId })
    expect(back.focused.session).toBe(s.id)
    const sourceLayout = await rig.layout(s.worktreeId)
    expect(sourceLayout.root.tabs.find((tab: { id: string }) => tab.id === sourceLayout.root.activeTab).root.session).toBe(s.id)

    const newest = await jump({ session: s.id })
    expect(newest.lineageId).toBe(second.lineageId!)
    expect(newest.focused.session).toBe(second.child.session)
    expect(await activeTab(s.worktreeId)).toBe(second.child.tab)
    const pane = (await rig.call('quirky.terminal/paneOf', { session: second.child.session })) as { pane: string }
    expect(newest.focused.pane).toBe(pane.pane)
  })

  test('a lineage that does not name the session, or no lineage at all, is no-lineage', async () => {
    const { s, first, second } = await twoHandoffs()
    const lone = await rig.session('w')
    for (const params of [{ session: lone.id }, { session: first.child.session, lineage: second.lineageId }, { session: s.id, lineage: randomUUID() }]) {
      const error = await rig.failure('quirky.handoff/jump', params)
      expect(error.data).toEqual({ reason: 'no-lineage' })
    }
  })
})

describe('SC-55: a jump with nothing to jump to says why', () => {
  test('a closed child has no live pane; a removed worktree is reported as removed', async () => {
    const s = await opened()
    const w2 = await rig.worktree('w2')
    const result = await handoff(s, { target: { worktree: w2.id } })

    await rig.call('quirky.session/close', { session: result.child.session })
    const closed = await rig.failure('quirky.handoff/jump', { session: s.id })
    expect(closed.code).toBe(RpcErrorCode.Conflict)
    expect(closed.message).toBe('No live pane is available.')
    expect(closed.data).toEqual({ reason: 'no-live-pane' })

    await rig.call('quirky.worktree/remove', { worktree: w2.id, force: true, yes: true })
    const removed = await rig.failure('quirky.handoff/jump', { session: s.id })
    expect(removed.message).toBe('worktree removed')
    expect(removed.data).toEqual({ reason: 'worktree-removed' })
  })

  test('an exited child has no live pane either', async () => {
    const s = await opened()
    const result = await handoff(s)
    rig.h.pty.exit(result.child.session, 0)
    await rig.settle(150)
    const error = await rig.failure('quirky.handoff/jump', { session: s.id })
    expect(error.data).toEqual({ reason: 'no-live-pane' })
  })

  test('the other end can be an archived source with no session', async () => {
    rig = await HandoffRig.start()
    stopReady = rig.autoReady()
    const archived = { agent: 'codex', providerSessionId: 'X', lastMessage: 'half done', worktree: rig.worktrees.main!.id }
    const result = await start({ source: { archived }, controls: { agent: 'gemini' }, wait: true })
    const error = await rig.failure('quirky.handoff/jump', { session: result.child.session })
    expect(error.data).toEqual({ reason: 'no-live-pane' })
  })
})

describe('SC-56: lineage keeps the newest 500 and skips bad rows', () => {
  const end = (session: string | null) => ({
    session,
    agent: 'claude',
    providerSessionId: null,
    transcriptPath: null,
    worktreeId: null,
    title: null
  })
  const row = (createdAt: number) => {
    const id = randomUUID()
    return { id, createdAt, record: { id, createdAt, relationship: 'continues', parent: end(`p${createdAt}`), child: { ...end(`c${createdAt}`), tab: null } } }
  }

  test('the oldest record is dropped, the newest kept, the malformed row skipped and 500 listed', async () => {
    const s = await opened()
    const rows = Array.from({ length: 500 }, (_, index) => row(1000 + index))
    rig.seedLineage(rows)
    rig.seedLineage([{ id: 'not-a-uuid', createdAt: 5000, record: '{broken' }])
    expect((await lineage()).records).toHaveLength(500)

    const result = await handoff(s)

    const { records } = await lineage()
    expect(records).toHaveLength(500)
    expect(records[0]!.id).toBe(result.lineageId!)
    const ids = new Set(records.map((record) => record.id))
    expect(ids.has(rows[0]!.id)).toBe(false)
    expect(ids.has(rows[499]!.id)).toBe(true)
  })

  test('rows that fail validation are skipped on read', async () => {
    rig = await HandoffRig.start()
    const good = row(2000)
    const bad = [
      { id: 'not-a-uuid', createdAt: 1, record: { ...good.record, id: 'not-a-uuid' } },
      { id: randomUUID(), createdAt: 2, record: { ...good.record, createdAt: -1 } },
      { id: randomUUID(), createdAt: 3, record: { ...good.record, createdAt: 1.5 } },
      { id: randomUUID(), createdAt: 4, record: { ...good.record, relationship: 'copies' } },
      { id: randomUUID(), createdAt: 5, record: { ...good.record, parent: { ...good.record.parent, agent: 7 } } },
      { id: randomUUID(), createdAt: 6, record: '"just a string"' },
      { id: randomUUID(), createdAt: 7, record: { ...good.record, child: null } }
    ].map((item) => (typeof item.record === 'string' ? item : { ...item, record: { ...item.record, id: item.id } }))
    rig.seedLineage([good, ...bad])
    expect((await lineage()).records.map((record) => record.id)).toEqual([good.id])
  })

  test('a record whose agent is null is valid', async () => {
    rig = await HandoffRig.start()
    const item = row(3000)
    item.record.parent.agent = null as unknown as string
    rig.seedLineage([item])
    expect((await lineage()).records.map((record) => record.id)).toEqual([item.id])
  })
})
