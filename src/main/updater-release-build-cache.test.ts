import { describe, expect, it, vi } from 'vitest'
import type { ReleaseBuild } from '../shared/release-channel'
import { ReleaseBuildListCache } from './updater-release-build-cache'

const build = (tag: string): ReleaseBuild => ({
  tag,
  version: tag.slice(1),
  channel: 'rc',
  name: null,
  publishedAt: null,
  releaseUrl: `https://github.com/zpyoung/quirky/releases/tag/${tag}`
})

const TTL_MS = 5 * 60_000

function createCache(load = vi.fn().mockResolvedValue([build('v1.4.160-rc.1')])) {
  let now = 1_000_000
  const cache = new ReleaseBuildListCache(load, TTL_MS, () => now)
  return { cache, load, advance: (ms: number) => (now += ms) }
}

describe('ReleaseBuildListCache', () => {
  it('serves a repeat request within the TTL without loading again', async () => {
    const { cache, load } = createCache()

    await cache.list('rc')
    await cache.list('rc')

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads once the TTL has passed', async () => {
    const { cache, load, advance } = createCache()

    await cache.list('rc')
    advance(TTL_MS + 1)
    await cache.list('rc')

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reloads on force even inside the TTL', async () => {
    const { cache, load } = createCache()

    await cache.list('rc')
    await cache.list('rc', { force: true })

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight load between concurrent callers', async () => {
    const { cache, load } = createCache()

    const [first, second] = await Promise.all([cache.list('rc'), cache.list('rc')])

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('keys by channel', async () => {
    const { cache, load } = createCache()

    await cache.list('rc')
    await cache.list('stable')
    await cache.list('rc')

    expect(load.mock.calls).toEqual([['rc'], ['stable']])
  })

  it('does not cache a failed load', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub rate limit reached.'))
      .mockResolvedValueOnce([build('v1.4.160-rc.1')])
    const { cache } = createCache(load)

    await expect(cache.list('rc')).rejects.toThrow(/rate limit/)
    await expect(cache.list('rc')).resolves.toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps a forced reload that replaced a failing entry', async () => {
    let failFirst: (error: Error) => void = () => {}
    const load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failFirst = reject
        })
      )
      .mockResolvedValueOnce([build('v1.4.160-rc.1')])
    const { cache } = createCache(load)

    const failing = cache.list('rc')
    const forced = cache.list('rc', { force: true })
    failFirst(new Error('timed out'))
    await expect(failing).rejects.toThrow(/timed out/)
    await forced

    await cache.list('rc')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
