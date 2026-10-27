import { describe, expect, test } from 'bun:test'
import { SectionLoader } from '../../src/view/loader'

const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

describe('SectionLoader', () => {
  test('SC-62: runs one load at a time, in request order', async () => {
    const started: string[] = []
    const gates = new Map<string, ReturnType<typeof gate>>()
    const loader = new SectionLoader((key) => {
      started.push(key)
      gates.set(key, gate())
      return gates.get(key)!.promise
    })
    const done = ['a', 'b', 'c'].map((key) => loader.request(key))
    expect(started).toEqual(['a'])
    gates.get('a')!.open()
    await done[0]
    expect(started).toEqual(['a', 'b'])
    gates.get('b')!.open()
    await done[1]
    gates.get('c')!.open()
    await done[2]
    expect(started).toEqual(['a', 'b', 'c'])
  })

  test('SC-62: an explicit request jumps the queue, and asking twice shares one load', async () => {
    const started: string[] = []
    const gates: Array<ReturnType<typeof gate>> = []
    const loader = new SectionLoader((key) => {
      started.push(key)
      gates.push(gate())
      return gates.at(-1)!.promise
    })
    void loader.request('a')
    void loader.request('b')
    const c = loader.request('c')
    expect(loader.request('c', true)).toBe(c)
    for (let i = 0; i < 3; i++) {
      gates[i]?.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(started).toEqual(['a', 'c', 'b'])
  })

  test('a failing load does not stop the queue', async () => {
    const started: string[] = []
    const loader = new SectionLoader(async (key) => {
      started.push(key)
      if (key === 'a') throw new Error('boom')
    })
    await Promise.all([loader.request('a'), loader.request('b')])
    expect(started).toEqual(['a', 'b'])
  })

  test('clear drops what has not started', async () => {
    const started: string[] = []
    const first = gate()
    const loader = new SectionLoader((key) => {
      started.push(key)
      return first.promise
    })
    const a = loader.request('a')
    const b = loader.request('b')
    loader.clear()
    first.open()
    await Promise.all([a, b])
    expect(started).toEqual(['a'])
  })
})
