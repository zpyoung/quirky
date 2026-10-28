import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { FederationMailStore, federationMailMigrations } from '../src/federation/mail-store'

function freshMailStore(home: string) {
  const handle = openPluginStore({
    home,
    pluginId: 'quirky.orchestration',
    migrations: federationMailMigrations,
    isActive: () => true,
  })
  return { handle, mail: new FederationMailStore(handle.store) }
}

test('fresh-home relay queues preserve order, refuse gaps, and replay imports after reopening the store', () => {
  const home = mkdtempSync(join(tmpdir(), 'quirky-federation-mail-'))
  let handle: ReturnType<typeof freshMailStore>['handle'] | null = null
  try {
    const firstOpen = freshMailStore(home)
    handle = firstOpen.handle
    const first = firstOpen.mail.enqueue('binding-a', 'to_home', 'item-1', 'message', { body: 'first' })
    const second = firstOpen.mail.enqueue('binding-a', 'to_home', 'item-2', 'message', { body: 'second' })
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(firstOpen.mail.listOutbox('binding-a', 'to_home', 0, 50).map((item) => item.id)).toEqual(['item-1', 'item-2'])

    const gap = { ...second, sequence: 3 }
    expect(() => firstOpen.mail.prepareImport(gap)).toThrow('sequence gap')
    expect(firstOpen.mail.cursor('binding-a', 'to_home')).toBe(0)

    expect(firstOpen.mail.prepareImport(first)).toEqual({ duplicate: false })
    firstOpen.mail.commitImport(first, { kind: 'accepted' })
    expect(firstOpen.mail.prepareImport(first)).toEqual({ duplicate: true, result: { kind: 'accepted' } })
    firstOpen.mail.complete('binding-a', 'to_home', 'item-1', { kind: 'accepted' })
    expect(firstOpen.mail.acknowledge('binding-a', 'to_home', 1)).toBe(1)
    expect(firstOpen.mail.outboxCursor('binding-a', 'to_home')).toBe(1)
    expect(firstOpen.mail.listOutbox('binding-a', 'to_home', 1, 50)).toMatchObject([{ sequence: 2, id: 'item-2' }])

    handle.close()
    handle = null
    const reopened = freshMailStore(home)
    handle = reopened.handle
    expect(reopened.mail.cursor('binding-a', 'to_home')).toBe(1)
    expect(reopened.mail.outboxCursor('binding-a', 'to_home')).toBe(1)
    expect(reopened.mail.result('binding-a', 'to_home', 'item-1')).toEqual({ kind: 'accepted' })
    expect(reopened.mail.listOutbox('binding-a', 'to_home', 1, 50)).toMatchObject([{ sequence: 2, id: 'item-2' }])
    expect(reopened.mail.prepareImport(first)).toEqual({ duplicate: true, result: { kind: 'accepted' } })
  } finally {
    handle?.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('mail retries keep one sequence for an identical item and reject changed replay content', () => {
  const home = mkdtempSync(join(tmpdir(), 'quirky-federation-mail-'))
  const { handle, mail } = freshMailStore(home)
  try {
    const first = mail.enqueue('binding-b', 'to_worker', 'question-1', 'question', { question: 'Choose a value' })
    const replay = mail.enqueue('binding-b', 'to_worker', 'question-1', 'question', { question: 'Choose a value' })
    expect(replay).toEqual(first)
    expect(mail.prepareImport(first)).toEqual({ duplicate: false })
    mail.commitImport(first, { kind: 'accepted' }, 'question-1')
    expect(mail.cursor('binding-b', 'to_worker')).toBe(1)
    expect(mail.questionBinding('question-1')).toEqual({ binding_id: 'binding-b', direction: 'to_worker' })
    expect(mail.prepareImport(first)).toEqual({ duplicate: true, result: { kind: 'accepted' } })
    expect(() => mail.enqueue('binding-b', 'to_worker', 'question-1', 'question', { question: 'Changed question' }))
      .toThrow('conflicting content')
    expect(() => mail.acknowledge('binding-b', 'to_worker', 2)).toThrow('exceeds queued sequence')
    expect(mail.outboxCursor('binding-b', 'to_worker')).toBe(0)
  } finally {
    handle.close()
    rmSync(home, { recursive: true, force: true })
  }
})
