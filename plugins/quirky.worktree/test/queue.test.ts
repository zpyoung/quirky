import { describe, expect, test } from 'bun:test'
import { KeyedQueue } from '../src/daemon/queue'

describe('KeyedQueue', () => {
  test('tasks of one key run one at a time in the order queued; other keys run alongside', async () => {
    const queue = new KeyedQueue()
    const events: string[] = []
    const task = (label: string, ms: number) => async () => {
      events.push(`start ${label}`)
      await Bun.sleep(ms)
      events.push(`end ${label}`)
      return label
    }
    const results = await Promise.all([queue.run('a', task('a1', 40)), queue.run('a', task('a2', 5)), queue.run('b', task('b1', 5))])
    expect(results).toEqual(['a1', 'a2', 'b1'])
    expect(events.indexOf('end a1')).toBeLessThan(events.indexOf('start a2'))
    expect(events.indexOf('end b1')).toBeLessThan(events.indexOf('end a1'))
  })

  test('a task that throws rejects its caller and lets the next one run', async () => {
    const queue = new KeyedQueue()
    const first = queue.run('k', async () => {
      throw new Error('boom')
    })
    const second = queue.run('k', async () => 'ok')
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe('ok')
  })
})
