import { expect, test } from 'bun:test'
import { readSelection, writeSelection, type KeyValueStorage } from '../src/lib/persist'

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const throwing: KeyValueStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('blocked')
  },
  removeItem() {
    throw new Error('blocked')
  }
}

test('round-trips the selection', () => {
  const storage = memory()
  writeSelection(storage, { worktreeId: 'w1', sessionId: 's1' })
  expect(readSelection(storage)).toEqual({ worktreeId: 'w1', sessionId: 's1' })
})

test('missing values read as null', () => {
  expect(readSelection(memory())).toEqual({ worktreeId: null, sessionId: null })
})

test('a null id removes the stored value', () => {
  const storage = memory()
  writeSelection(storage, { worktreeId: 'w1', sessionId: 's1' })
  writeSelection(storage, { worktreeId: 'w1', sessionId: null })
  expect(readSelection(storage)).toEqual({ worktreeId: 'w1', sessionId: null })
})

test('unavailable storage neither throws nor restores anything', () => {
  expect(() => writeSelection(throwing, { worktreeId: 'w1', sessionId: 's1' })).not.toThrow()
  expect(readSelection(throwing)).toEqual({ worktreeId: null, sessionId: null })
  expect(readSelection(null)).toEqual({ worktreeId: null, sessionId: null })
})
