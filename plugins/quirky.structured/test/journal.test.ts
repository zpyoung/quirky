import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginStore } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { Journal, journalMigrations } from '../journal'

let home: string
let store: PluginStore
let journal: Journal
let close: () => void

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'quirky-native-journal-'))
  const opened = openPluginStore({ home, pluginId: 'quirky.structured', migrations: journalMigrations(home), isActive: () => true })
  store = opened.store
  close = opened.close
  journal = new Journal(store)
})

afterEach(() => {
  close?.()
  if (home) rmSync(home, { recursive: true, force: true })
})

test('removing a session deletes its messages and send receipts without touching another session', () => {
  journal.append({ sessionId: 'removed', role: 'user', text: 'Remove this conversation', at: 1000 })
  const retained = journal.append({ sessionId: 'retained', role: 'assistant', text: 'Keep this conversation', at: 1001 })
  journal.reserveSendReceipt({ operationId: 'remove-operation', sessionId: 'removed', payloadHash: 'removed-payload' }, 1002)
  journal.completeSendReceipt('remove-operation', 1003)
  journal.reserveSendReceipt({ operationId: 'retain-operation', sessionId: 'retained', payloadHash: 'retained-payload' }, 1004)

  journal.remove('removed')

  expect(journal.list('removed')).toEqual([])
  expect(journal.sendReceipt('remove-operation')).toBeNull()
  expect(journal.list('retained')).toEqual([retained])
  expect(journal.sendReceipt('retain-operation')?.state).toBe('pending')
})

test('a failed receipt cleanup rolls back message removal', () => {
  const message = journal.append({ sessionId: 'retained-on-failure', role: 'assistant', text: 'Still available after failed cleanup', at: 1000 })
  store.exec('DROP TABLE structured_send_receipts')

  expect(() => journal.remove('retained-on-failure')).toThrow()
  expect(journal.list('retained-on-failure')).toEqual([message])
})

test('a chat item is stored beside the message and comes back from list', () => {
  const item = { kind: 'activity' as const, callId: 'c1', tool: 'Read', summary: '/a', state: 'running' as const }
  const stored = journal.append({ sessionId: 's', role: 'tool', text: 'Read: /a', data: { raw: 1 }, item, at: 1 })
  journal.append({ sessionId: 's', role: 'system', text: 'legacy', at: 2 })
  expect(stored.item).toEqual(item)
  const [withItem, without] = journal.list('s')
  expect(withItem).toEqual(stored)
  expect(without).not.toHaveProperty('item')
})

const agent = (id: string, state: 'working' | 'needs-you' | 'done' | 'stopped', extra: Record<string, unknown> = {}) =>
  ({ kind: 'agent' as const, id, name: id, task: `task ${id}`, state, startedAt: 1, steps: 'full' as const, ...extra })

test('liveAgents returns the latest working or needs-you snapshot per session and agent', () => {
  journal.append({ sessionId: 's1', role: 'tool', text: 'a', item: agent('a', 'working'), at: 1 })
  journal.append({ sessionId: 's1', role: 'tool', text: 'a', item: { ...agent('a', 'needs-you', { tokens: 4 }), agent: 'parent' }, at: 2 })
  journal.append({ sessionId: 's1', role: 'tool', text: 'b', item: agent('b', 'working'), at: 3 })
  journal.append({ sessionId: 's1', role: 'tool', text: 'b', item: agent('b', 'done', { endedAt: 5 }), at: 4 })
  journal.append({ sessionId: 's1', role: 'assistant', text: 'prose', item: { kind: 'prose', text: 'x' }, at: 5 })
  journal.append({ sessionId: 's1', role: 'system', text: 'legacy', at: 6 })
  journal.append({ sessionId: 's2', role: 'tool', text: 'a', item: agent('a', 'working'), at: 7 })

  const live = journal.liveAgents()
  expect(live.map((row) => [row.sessionId, row.item.id, row.item.state])).toEqual([
    ['s1', 'a', 'needs-you'],
    ['s2', 'a', 'working']
  ])
  expect(live[0]!.item).toMatchObject({ tokens: 4, agent: 'parent' })
})

test('liveAgents is empty when every agent ended or none exist', () => {
  expect(journal.liveAgents()).toEqual([])
  journal.append({ sessionId: 's', role: 'tool', text: 'a', item: agent('a', 'working'), at: 1 })
  journal.append({ sessionId: 's', role: 'tool', text: 'a', item: agent('a', 'stopped', { cutOff: true }), at: 2 })
  expect(journal.liveAgents()).toEqual([])
})

test('agentItems returns the latest snapshot of each agent in one session only', () => {
  journal.append({ sessionId: 's', role: 'tool', text: 'a', item: agent('a', 'working', { tokens: 1 }), at: 1 })
  journal.append({ sessionId: 's', role: 'tool', text: 'b', item: agent('b', 'working'), at: 2 })
  journal.append({ sessionId: 's', role: 'tool', text: 'a', item: agent('a', 'done', { tokens: 9 }), at: 3 })
  journal.append({ sessionId: 'other', role: 'tool', text: 'c', item: agent('c', 'working', { tokens: 100 }), at: 4 })

  const items = journal.agentItems('s')
  expect(items.map((item) => [item.id, item.state, item.tokens])).toEqual([
    ['b', 'working', undefined],
    ['a', 'done', 9]
  ])
  expect(journal.agentItems('none')).toEqual([])
})
