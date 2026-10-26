import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'

describe('kernel tables', () => {
  let dir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-kernel-tables-'))
    dbPath = join(dir, 'quirky.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('request log', () => {
    test('an unknown request ID is null', () => {
      expect(store.getRequest('r-1')).toBeNull()
    })

    test('stores a result outcome and reads it back', () => {
      store.putRequest({ requestId: 'r-1', digest: 'abc', outcome: { result: { id: 'wt_1' } }, createdAt: 100 })
      expect(store.getRequest('r-1')).toEqual({
        requestId: 'r-1',
        digest: 'abc',
        outcome: { result: { id: 'wt_1' } },
        createdAt: 100
      })
    })

    test('stores an error outcome with its data', () => {
      const outcome = { error: { code: -32010, message: 'confirm', data: { askId: 'ask_1', action: 'Remove?' } } }
      store.putRequest({ requestId: 'r-2', digest: 'd', outcome, createdAt: 5 })
      expect(store.getRequest('r-2')?.outcome).toEqual(outcome)
    })

    test('a null result survives the round trip', () => {
      store.putRequest({ requestId: 'r-3', digest: 'd', outcome: { result: null }, createdAt: 5 })
      expect(store.getRequest('r-3')?.outcome).toEqual({ result: null })
    })

    test('putting an existing ID replaces the record', () => {
      store.putRequest({ requestId: 'r-1', digest: 'a', outcome: { result: 1 }, createdAt: 1 })
      store.putRequest({ requestId: 'r-1', digest: 'b', outcome: { result: 2 }, createdAt: 2 })
      expect(store.getRequest('r-1')).toMatchObject({ digest: 'b', outcome: { result: 2 }, createdAt: 2 })
    })

    test('pruning deletes records created before the cutoff and reports how many', () => {
      store.putRequest({ requestId: 'old', digest: 'd', outcome: { result: 1 }, createdAt: 10 })
      store.putRequest({ requestId: 'edge', digest: 'd', outcome: { result: 1 }, createdAt: 50 })
      store.putRequest({ requestId: 'new', digest: 'd', outcome: { result: 1 }, createdAt: 90 })
      expect(store.pruneRequests(50)).toBe(1)
      expect(store.getRequest('old')).toBeNull()
      expect(store.getRequest('edge')).not.toBeNull()
      expect(store.getRequest('new')).not.toBeNull()
    })

    test('records survive reopening the database', () => {
      store.putRequest({ requestId: 'r-1', digest: 'd', outcome: { result: 'x' }, createdAt: 1 })
      store.close()
      store = new Store(dbPath)
      expect(store.getRequest('r-1')?.outcome).toEqual({ result: 'x' })
    })
  })

  describe('confirmations', () => {
    test('an unknown ask is null', () => {
      expect(store.getConfirmation('ask_1')).toBeNull()
    })

    test('a new confirmation is unused', () => {
      store.putConfirmation({ askId: 'ask_1', method: 'quirky.worktree/remove', digest: 'd', used: false, createdAt: 7 })
      expect(store.getConfirmation('ask_1')).toEqual({
        askId: 'ask_1',
        method: 'quirky.worktree/remove',
        digest: 'd',
        used: false,
        createdAt: 7
      })
    })

    test('marking used is single-shot and reports whether it changed the row', () => {
      store.putConfirmation({ askId: 'ask_1', method: 'm', digest: 'd', used: false, createdAt: 1 })
      expect(store.markConfirmationUsed('ask_1')).toBe(true)
      expect(store.getConfirmation('ask_1')?.used).toBe(true)
      expect(store.markConfirmationUsed('ask_1')).toBe(false)
      expect(store.markConfirmationUsed('missing')).toBe(false)
    })

    test('pruning deletes confirmations created before the cutoff', () => {
      store.putConfirmation({ askId: 'old', method: 'm', digest: 'd', used: true, createdAt: 10 })
      store.putConfirmation({ askId: 'new', method: 'm', digest: 'd', used: false, createdAt: 90 })
      expect(store.pruneConfirmations(50)).toBe(1)
      expect(store.getConfirmation('old')).toBeNull()
      expect(store.getConfirmation('new')).not.toBeNull()
    })
  })

  describe('distro', () => {
    const night = {
      id: 'night',
      manifest: { id: 'night', name: 'Night', version: '1.0.0', plugins: ['night.extras'], disable: ['quirky.git'] },
      plugins: ['night.extras'],
      installedAt: 1234
    }

    test('no distro installed is null', () => {
      expect(store.getDistro()).toBeNull()
    })

    test('stores the manifest and plugin IDs and reads them back', () => {
      store.putDistro(night)
      expect(store.getDistro()).toEqual(night)
    })

    test('deleting removes the row; deleting another ID keeps it', () => {
      store.putDistro(night)
      store.deleteDistro('other')
      expect(store.getDistro()?.id).toBe('night')
      store.deleteDistro('night')
      expect(store.getDistro()).toBeNull()
    })

    test('the distro survives reopening the database', () => {
      store.putDistro(night)
      store.close()
      store = new Store(dbPath)
      expect(store.getDistro()).toEqual(night)
    })
  })
})
