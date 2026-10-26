import { describe, expect, test } from 'bun:test'
import { load, next, setStatus, type Item } from './queue'

const item = (id: string, deps: string[] = [], status: Item['status'] = 'todo'): Item => ({
  id,
  milestone: 'M0',
  title: id,
  docs: [],
  deps,
  status,
})

describe('next', () => {
  test('takes the first ready item in file order', () => {
    const result = next([item('a', [], 'done'), item('b', ['c']), item('c', ['a']), item('d', ['a'])])
    expect(result).toEqual({ kind: 'item', item: item('c', ['a']) })
  })

  test('resumes an in-progress item before anything else', () => {
    const result = next([item('a'), item('b', [], 'in-progress')])
    expect(result.kind === 'item' && result.item.id).toBe('b')
  })

  test("leaves another lane's in-progress item alone", () => {
    const items = [{ ...item('a', [], 'in-progress'), lane: 2 }, item('b')]
    expect(next(items, 1)).toEqual({ kind: 'item', item: item('b') })
    expect(next(items, 2)).toEqual({ kind: 'item', item: items[0] })
  })

  test('reports busy when nothing is ready but other lanes hold work', () => {
    const held = { ...item('a', [], 'in-progress'), lane: 2 }
    expect(next([held, item('b', ['a'])], 1)).toEqual({ kind: 'busy', running: [held] })
  })

  test('halts on a waiting gate', () => {
    const result = next([item('gate', [], 'waiting'), item('b')])
    expect(result.kind).toBe('waiting')
  })

  test('skips items that depend on a blocked item', () => {
    const result = next([item('a', [], 'blocked'), item('b', ['a']), item('c')])
    expect(result.kind === 'item' && result.item.id).toBe('c')
  })

  test('reports stuck when only blocked work remains', () => {
    expect(next([item('a', [], 'blocked'), item('b', ['a'])])).toEqual({ kind: 'stuck', blocked: ['a'] })
  })

  test('a * dependency waits for every other item', () => {
    const items = [item('a', [], 'done'), item('b'), item('sweep', ['*'])]
    expect(next(items)).toEqual({ kind: 'item', item: item('b') })
    expect(next(setStatus(items, 'b', 'done'))).toEqual({ kind: 'item', item: item('sweep', ['*']) })
  })

  test('reports done when every item is done', () => {
    expect(next([item('a', [], 'done')])).toEqual({ kind: 'done' })
  })
})

describe('setStatus', () => {
  test('records the lane only while an item is in progress', () => {
    const claimed = setStatus([item('a')], 'a', 'in-progress', 3)
    expect(claimed[0].lane).toBe(3)
    expect(setStatus(claimed, 'a', 'done')[0]).toEqual(item('a', [], 'done'))
  })

  test('rejects unknown ids and statuses', () => {
    expect(() => setStatus([item('a')], 'z', 'done')).toThrow('unknown item')
    expect(() => setStatus([item('a')], 'a', 'finished' as Item['status'])).toThrow('unknown status')
  })
})

describe('docs/loop/queue.json', () => {
  const items = load()

  test('ids are unique and every dependency exists', () => {
    const ids = new Set(items.map((entry) => entry.id))
    expect(ids.size).toBe(items.length)
    for (const entry of items) for (const dep of entry.deps) if (dep !== '*') expect(ids.has(dep)).toBe(true)
  })

  test('every dependency comes earlier in the file, so file order is a valid build order', () => {
    const seen = new Set<string>()
    for (const entry of items) {
      for (const dep of entry.deps) if (dep !== '*') expect(seen.has(dep)).toBe(true)
      seen.add(entry.id)
    }
  })

  test('starts at the plugin kernel', () => {
    expect(items[0].id).toBe('m0-registry')
    expect(items[0].deps).toEqual([])
  })
})
