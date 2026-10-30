import { describe, expect, test } from 'bun:test'
import {
  DROP_SOURCE_PATHS_RETAIN_MS,
  DROP_SOURCE_PATHS_WAIT_MS,
  createDropSourcePathsInbox,
  dropSourcePathsFromEvent,
  matchDropSourcePaths
} from '../src/bun/drop-source-paths'

function fakeTimers() {
  let now = 1_000
  const pending = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number) {
      const id = next++
      pending.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle as number)
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue
        pending.delete(id)
        timer.callback()
      }
    }
  }
}

describe('dropSourcePathsFromEvent', () => {
  test('reads absolute paths from the Electrobun event detail', () => {
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: ['/Users/me/a.md', '/tmp/b c.txt'] } } }))
      .toEqual(['/Users/me/a.md', '/tmp/b c.txt'])
  })

  test('rejects malformed, relative, empty and oversized reports', () => {
    expect(dropSourcePathsFromEvent(null)).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: '{"paths":["/a"]}' } })).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: [] } } })).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: ['relative.md'] } } })).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: ['/a\0b'] } } })).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: [1] } } })).toBeNull()
    expect(dropSourcePathsFromEvent({ data: { detail: { paths: Array.from({ length: 257 }, (_, i) => `/f${i}`) } } })).toBeNull()
  })
})

describe('matchDropSourcePaths', () => {
  test('returns the paths in the order of the page files', () => {
    expect(matchDropSourcePaths(['b.txt', 'a.md'], ['/x/a.md', '/y/b.txt'])).toEqual(['/y/b.txt', '/x/a.md'])
  })

  test('pairs same-named files from different folders one to one', () => {
    expect(matchDropSourcePaths(['README.md', 'README.md'], ['/one/README.md', '/two/README.md']))
      .toEqual(['/one/README.md', '/two/README.md'])
  })

  test('treats composed and decomposed Unicode names as the same file name', () => {
    expect(matchDropSourcePaths(['résumé.txt'], ['/docs/résumé.txt'])).toEqual(['/docs/résumé.txt'])
  })

  test('refuses a drop whose files and paths differ', () => {
    expect(matchDropSourcePaths(['a.md'], ['/x/b.md'])).toBeNull()
    expect(matchDropSourcePaths(['a.md'], ['/x/a.md', '/x/b.md'])).toBeNull()
    expect(matchDropSourcePaths([], [])).toBeNull()
  })
})

describe('createDropSourcePathsInbox', () => {
  test('a native report that arrives before the page drop is claimed once', async () => {
    const timers = fakeTimers()
    const inbox = createDropSourcePathsInbox(timers)
    inbox.receive(['/repo/a.md'])
    expect(await inbox.take(['a.md'])).toEqual(['/repo/a.md'])
    const second = inbox.take(['a.md'])
    timers.advance(DROP_SOURCE_PATHS_WAIT_MS)
    expect(await second).toBeNull()
  })

  test('a page drop waits for a native report that arrives after it', async () => {
    const timers = fakeTimers()
    const inbox = createDropSourcePathsInbox(timers)
    const pending = inbox.take(['a.md'])
    timers.advance(DROP_SOURCE_PATHS_WAIT_MS - 1)
    inbox.receive(['/repo/a.md'])
    expect(await pending).toEqual(['/repo/a.md'])
  })

  test('a page drop with no matching native report resolves null after the wait', async () => {
    const timers = fakeTimers()
    const inbox = createDropSourcePathsInbox(timers)
    inbox.receive(['/repo/other.md'])
    const pending = inbox.take(['a.md'])
    timers.advance(DROP_SOURCE_PATHS_WAIT_MS)
    expect(await pending).toBeNull()
  })

  test('a stale native report is not paired with a later drop', async () => {
    const timers = fakeTimers()
    const inbox = createDropSourcePathsInbox(timers)
    inbox.receive(['/repo/a.md'])
    timers.advance(DROP_SOURCE_PATHS_RETAIN_MS + 1)
    const pending = inbox.take(['a.md'])
    timers.advance(DROP_SOURCE_PATHS_WAIT_MS)
    expect(await pending).toBeNull()
  })
})
