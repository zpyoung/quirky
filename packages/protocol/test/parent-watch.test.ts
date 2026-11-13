import { afterEach, expect, test, vi } from 'bun:test'
import { parseExitWithParent, watchParent } from '../src/node/parent-watch'

const clock = vi as typeof vi & { advanceTimersByTime(milliseconds: number): void }

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

test('parseExitWithParent accepts an absent flag or one positive integer pid', () => {
  expect(parseExitWithParent(['x', 'y'])).toBeNull()
  expect(parseExitWithParent(['x', '--exit-with-parent=123', 'y'])).toBe(123)
})

for (const argv of [
  ['--exit-with-parent=0'], ['--exit-with-parent=-1'], ['--exit-with-parent=abc'],
  ['--exit-with-parent=1.5'], ['--exit-with-parent'],
  ['--exit-with-parent=123', '--exit-with-parent=456'],
  ['--exit-with-parent=9007199254740992']
]) {
  test(`parseExitWithParent rejects ${argv.join(' ')}`, () => {
    expect(() => parseExitWithParent(argv)).toThrow('invalid --exit-with-parent')
  })
}

test('watchParent reports a changed parent exactly once and stops reading', () => {
  vi.useFakeTimers()
  const values = [10, 10, 1, 1]
  let reads = 0
  let losses = 0
  cleanups.push(watchParent({
    parentPid: 10, intervalMs: 5,
    readPpid: () => { reads++; return values.shift() ?? 1 },
    onLost: () => { losses++ }
  }))
  clock.advanceTimersByTime(40)
  expect(losses).toBe(1)
  expect(reads).toBe(3)
})
test('watchParent detects an already lost parent on its first tick', () => {
  vi.useFakeTimers()
  let reads = 0
  let losses = 0
  cleanups.push(watchParent({
    parentPid: 10, intervalMs: 5,
    readPpid: () => { reads++; return 1 }, onLost: () => { losses++ }
  }))
  clock.advanceTimersByTime(5)
  expect(reads).toBe(1)
  expect(losses).toBe(1)
})
test('the returned disposer prevents further parent reads', () => {
  vi.useFakeTimers()
  let reads = 0
  let lost = false
  const stop = watchParent({
    parentPid: 10, intervalMs: 5,
    readPpid: () => { reads++; return 10 }, onLost: () => { lost = true }
  })
  cleanups.push(stop)
  stop()
  clock.advanceTimersByTime(25)
  expect(reads).toBe(0)
  expect(lost).toBe(false)
})
