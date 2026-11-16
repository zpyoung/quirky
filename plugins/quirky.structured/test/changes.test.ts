import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'

let chat: ChatBoot | undefined
afterEach(async () => {
  await teardownChat(chat)
  chat = undefined
})

const items = async (boot: ChatBoot, session: string, kind: string) =>
  (await boot.messages(session)).flatMap((message) => (message.item?.kind === kind ? [message.item] : []))

const settle = async (boot: ChatBoot, session: string, previousDone = 0) => {
  boot.runner.finish(session)
  await waitFor(() => boot.events.filter((event) => event.type === 'quirky.structured/settled').length > previousDone)
}

describe('turn changes', () => {
  test('snapshots at turn start and settle, and appends a changes item when the trees differ', async () => {
    chat = await bootChat({ git: true })
    const trees = ['tree-start', 'tree-end']
    chat.git.snapshotTree = () => ({ tree: trees.shift() })
    chat.git.treeChanges = () => ({ changes: [{ path: 'a.ts' }, { path: 'b.ts' }] })
    const session = await chat.create()
    await waitFor(() => chat!.git.calls.length === 1)
    await settle(chat, session.id)
    await waitFor(() => chat!.git.calls.length === 3)
    expect(chat.git.calls).toEqual([
      { method: 'snapshotTree', params: { worktree: 'wt_1' } },
      { method: 'snapshotTree', params: { worktree: 'wt_1' } },
      { method: 'treeChanges', params: { worktree: 'wt_1', from: 'tree-start', to: 'tree-end' } }
    ])
    await waitForAsync(async () => (await items(chat!, session.id, 'changes')).length === 1)
    expect(await items(chat, session.id, 'changes')).toEqual([
      { kind: 'changes', worktree: 'wt_1', fromTree: 'tree-start', toTree: 'tree-end', files: 2 }
    ])
  })

  test('identical trees append nothing and call treeChanges never', async () => {
    chat = await bootChat({ git: true })
    const session = await chat.create()
    await waitFor(() => chat!.git.calls.length === 1)
    await settle(chat, session.id)
    await waitFor(() => chat!.git.calls.length === 2)
    await Bun.sleep(50)
    expect(chat.git.calls.map((call) => call.method)).toEqual(['snapshotTree', 'snapshotTree'])
    expect(await items(chat, session.id, 'changes')).toEqual([])
  })

  test('each turn is compared against its own start', async () => {
    chat = await bootChat({ git: true })
    const trees = ['t0', 't1', 't1', 't2']
    chat.git.snapshotTree = () => ({ tree: trees.shift() })
    chat.git.treeChanges = (params) => ({ changes: [{ path: String(params.to) }] })
    const session = await chat.create()
    await settle(chat, session.id)
    await waitForAsync(async () => (await items(chat!, session.id, 'changes')).length === 1)
    await chat.call('quirky.structured/send', { session: session.id, text: 'again' })
    await settle(chat, session.id, 1)
    await waitForAsync(async () => (await items(chat!, session.id, 'changes')).length === 2)
    expect(await items(chat, session.id, 'changes')).toEqual([
      expect.objectContaining({ fromTree: 't0', toTree: 't1' }),
      expect.objectContaining({ fromTree: 't1', toTree: 't2' })
    ])
  })

  test('a missing quirky.git appends nothing and the turn still settles', async () => {
    chat = await bootChat()
    const session = await chat.create()
    await settle(chat, session.id)
    await waitFor(() => chat!.world.statusLog.some((entry) => entry.status === 'done'))
    expect(await items(chat, session.id, 'changes')).toEqual([])
  })

  test('a failing snapshot or treeChanges appends nothing and never fails the turn', async () => {
    chat = await bootChat({ git: true })
    chat.git.snapshotTree = (_params, context) => {
      throw context.error('invalid-params', 'not a git work tree')
    }
    const session = await chat.create()
    await settle(chat, session.id)
    await waitFor(() => chat!.world.statusLog.some((entry) => entry.status === 'done'))
    expect(await items(chat, session.id, 'changes')).toEqual([])

    const trees = ['a', 'b']
    chat.git.snapshotTree = () => ({ tree: trees.shift() })
    chat.git.treeChanges = (_params, context) => {
      throw context.error('invalid-params', 'unknown tree')
    }
    await chat.call('quirky.structured/send', { session: session.id, text: 'again' })
    await settle(chat, session.id, 1)
    await waitFor(() => chat!.git.calls.some((call) => call.method === 'treeChanges'))
    await Bun.sleep(50)
    expect(await items(chat, session.id, 'changes')).toEqual([])
  })

  test('the queue flushes after the changes item, once the turn is recorded', async () => {
    chat = await bootChat({ git: true })
    const trees = ['s', 'e', 's2']
    chat.git.snapshotTree = () => ({ tree: trees.shift() })
    chat.git.treeChanges = () => ({ changes: [{ path: 'a' }] })
    const session = await chat.create()
    await chat.call('quirky.structured/send', { session: session.id, text: 'queued', when: 'idle' })
    await settle(chat, session.id)
    await waitFor(() => chat!.runner.sent.length === 1)
    const kinds = (await chat.messages(session.id)).map((message) => message.item?.kind)
    expect(kinds.indexOf('changes')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('changes')).toBeLessThan(kinds.lastIndexOf('user'))
  })
})

describe('views', () => {
  test('journals one view item per new view id, for live sessions only', async () => {
    chat = await bootChat({ view: true })
    const session = await chat.create()
    chat.emitView('changed', { sessionId: session.id, viewId: 'v1' })
    chat.emitView('changed', { sessionId: session.id, viewId: 'v1' })
    chat.emitView('changed', { sessionId: session.id, viewId: 'v2' })
    chat.emitView('changed', { sessionId: 's_unknown', viewId: 'v3' })
    chat.emitView('changed', { sessionId: session.id })
    await waitForAsync(async () => (await items(chat!, session.id, 'view')).length === 2)
    await Bun.sleep(50)
    expect(await items(chat, session.id, 'view')).toEqual([
      { kind: 'view', viewId: 'v1' },
      { kind: 'view', viewId: 'v2' }
    ])
  })

  test('a rejected spec becomes a view-error item with its source capped at 64 KiB', async () => {
    chat = await bootChat({ view: true })
    const session = await chat.create()
    chat.emitView('rejected', { sessionId: session.id, title: 'Module map', errors: ['root: unknown component "Treemap"', 7], source: 'x'.repeat(70_000) })
    chat.emitView('rejected', { sessionId: session.id, errors: ['bad'], source: '{' })
    await waitForAsync(async () => (await items(chat!, session.id, 'view-error')).length === 2)
    const [first, second] = (await items(chat, session.id, 'view-error')) as { kind: string; title: string; errors: string[]; source: string }[]
    expect(first!.title).toBe('Module map')
    expect(first!.errors).toEqual(['root: unknown component "Treemap"'])
    expect(first!.source).toHaveLength(64 * 1024)
    expect(second).toEqual({ kind: 'view-error', title: 'Untitled view', errors: ['bad'], source: '{' })
  })
})
