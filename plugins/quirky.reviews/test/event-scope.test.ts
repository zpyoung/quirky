import type { PluginEvent, QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import type { HostingTest } from '../../quirky.hosting/test/helpers'
import { afterEach, describe, expect, test } from 'bun:test'
import { bootReviews } from './support'
import { checksFixtureState, checksGhSource, checksReview } from './checks-fixture'
import { checksMethods } from '../src/checks/methods'
import { createReviewsEnv, newChecksEntry } from '../src/env'

type ReviewsTestHost = HostingTest

const hosts: ReviewsTestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

async function boot() {
  const host = await bootReviews(checksGhSource, { branch: 'feature' })
  hosts.push(host)
  return host
}

async function addWorktree(host: ReviewsTestHost, branch: string): Promise<string> {
  const origin = await host.client.callAny('quirky.worktree/resolve', { selector: host.worktree }) as { repoId: string }
  const created = await host.client.callAny('quirky.worktree/create', {
    repo: origin.repoId,
    branchName: branch,
    name: branch,
    base: 'main',
    noParent: true,
    setup: 'skip',
    activate: false
  }) as { worktree: { id: string } }
  return created.worktree.id
}

async function subscribeForChanges(client: QuirkyClient): Promise<QuirkyEvent[]> {
  const events: QuirkyEvent[] = []
  client.onEvent((event) => events.push(event))
  await client.callAny('events.subscribe', {})
  return events
}

function reviewsChanged(events: QuirkyEvent[]): PluginEvent[] {
  return events.filter((event) => event.type === 'quirky.reviews/changed') as PluginEvent[]
}

function changeData(event: PluginEvent): { revision?: unknown; worktree?: unknown } {
  return event.data as { revision?: unknown; worktree?: unknown }
}

async function stateRevision(host: ReviewsTestHost): Promise<number> {
  const state = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree }) as { revision: number }
  return state.revision
}

async function waitForHeldRevision(client: QuirkyClient, events: QuirkyEvent[], revision: number): Promise<void> {
  if (!reviewsChanged(events).some((event) => changeData(event).revision === revision)) {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timeout = setTimeout(() => reject(new Error(`No reviews changed event carried revision ${revision}.`)), 2_000)
    client.onEvent((event) => {
      if (event.type === 'quirky.reviews/changed' && changeData(event as PluginEvent).revision === revision) resolve()
    })
    try {
      await promise
    } finally {
      clearTimeout(timeout)
    }
  }
  // This integration test observes the daemon's real 250ms per-tag coalescing hold.
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 300)
  await promise
}

type EmittedChange = { type: string; data: unknown }

function unitEnv() {
  const events: EmittedChange[] = []
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }),
    emit: (type: string, data: unknown) => events.push({ type, data }),
    error: (_kind: string, message: string) => new Error(message)
  } as never)
  return { env, events, methods: checksMethods(env) }
}

describe('reviews Checks refresh event scope', () => {
  test('catalog declares a worktree-tagged, coalesced changed event at API 1.5.0', async () => {
    const host = await boot()
    const catalog = await host.client.callAny('api.describe', {}) as {
      events: { name: string; plugin: string | null; coalesce?: string[]; worktree?: string }[]
    }
    const changed = catalog.events.find((event) => event.plugin === 'quirky.reviews' && event.name === 'quirky.reviews/changed')

    expect(changed?.worktree).toBe('worktree')
    expect(changed?.coalesce).toEqual([])

    const plugins = await host.client.callAny('plugin.list', {}) as { id: string; apiVersion?: string }[]
    expect(plugins.find((plugin) => plugin.id === 'quirky.reviews')?.apiVersion).toBe('1.5.0')
  })

  test('coalesces a burst while delivering the final revision', async () => {
    const host = await boot()
    const events = await subscribeForChanges(host.client)
    const start = events.length

    await Promise.all(Array.from({ length: 20 }, (_, index) => host.call('checksSetHeight', { height: 400 + index })))

    const revision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, revision)
    const changes = reviewsChanged(events.slice(start))
    expect(changes.length).toBeGreaterThanOrEqual(2)
    expect(changes.length).toBeLessThanOrEqual(5)
    expect(changeData(changes.at(-1)!).revision).toBe(revision)
  }, 60_000)

  test('coalesces linked title and global height events separately', async () => {
    const host = await boot()
    const events = await subscribeForChanges(host.client)
    host.writeState(checksFixtureState([checksReview(12)]))
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksRefresh', { worktree: host.worktree, force: true })

    const setupRevision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, setupRevision)
    const start = events.length

    await Promise.all([
      ...Array.from({ length: 10 }, (_, index) => host.call('checksSetTitleDraft', {
        worktree: host.worktree, number: 12, title: `Draft ${index}`
      })),
      ...Array.from({ length: 10 }, (_, index) => host.call('checksSetHeight', { height: 350 + index }))
    ])

    const revision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, revision)
    const changes = reviewsChanged(events.slice(start))
    const revisions = changes.map((event) => changeData(event).revision).filter((value): value is number => typeof value === 'number')
    expect(changes.some((event) => event.worktreeId === host.worktree)).toBe(true)
    expect(changes.some((event) => event.worktreeId === undefined)).toBe(true)
    expect(Math.max(...revisions)).toBe(revision)
  }, 60_000)

  test('one refresh tags every changed event and ends at the state revision', async () => {
    const host = await boot()
    const events = await subscribeForChanges(host.client)
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    const secondWorktree = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksLink', { worktree: secondWorktree, number: 13 })

    const setupRevision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, setupRevision)
    const start = events.length

    await host.call('checksRefresh', { worktree: host.worktree, force: true })

    const revision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, revision)
    const changes = reviewsChanged(events.slice(start))
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((event) => event.worktreeId === host.worktree && changeData(event).worktree === host.worktree)).toBe(true)
    expect(changeData(changes.at(-1)!).revision).toBe(revision)
  }, 60_000)

  test('concurrent worktree refreshes emit only their respective tags', async () => {
    const host = await boot()
    const events = await subscribeForChanges(host.client)
    host.writeState(checksFixtureState([checksReview(12), checksReview(13, 'feature-next')]))
    const secondWorktree = await addWorktree(host, 'feature-next')
    await host.call('checksLink', { worktree: host.worktree, number: 12 })
    await host.call('checksLink', { worktree: secondWorktree, number: 13 })

    const setupRevision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, setupRevision)
    const start = events.length

    await Promise.all([
      host.call('checksRefresh', { worktree: host.worktree, force: true }),
      host.call('checksRefresh', { worktree: secondWorktree, force: true })
    ])

    const revision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, revision)
    const changes = reviewsChanged(events.slice(start))
    const tags = changes.map((event) => event.worktreeId)
    expect(changes.length).toBeGreaterThan(0)
    expect(tags.every((tag) => tag === host.worktree || tag === secondWorktree)).toBe(true)
    expect(changes.every((event) => changeData(event).worktree === event.worktreeId)).toBe(true)
    expect(tags).toContain(host.worktree)
    expect(tags).toContain(secondWorktree)
  }, 60_000)

  test('linking stays globally visible while its Checks refresh is scoped, and height stays global', async () => {
    const host = await boot()
    host.writeState(checksFixtureState([checksReview(12)]))
    const events = await subscribeForChanges(host.client)
    const linkStart = events.length

    await host.call('checksLink', { worktree: host.worktree, number: 12 })

    const linkRevision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, linkRevision)
    const linkChanges = reviewsChanged(events.slice(linkStart))
    const globalChanges = linkChanges.filter((event) => event.worktreeId === undefined)
    const localChanges = linkChanges.filter((event) => event.worktreeId !== undefined)
    expect(globalChanges.length).toBeGreaterThan(0)
    expect(globalChanges.every((event) => changeData(event).worktree === undefined)).toBe(true)
    expect(localChanges.length).toBeGreaterThan(0)
    expect(localChanges.every((event) => event.worktreeId === host.worktree && changeData(event).worktree === host.worktree)).toBe(true)

    const heightStart = events.length
    await host.call('checksSetHeight', { height: 480 })
    const heightRevision = await stateRevision(host)
    await waitForHeldRevision(host.client, events, heightRevision)
    const heightChanges = reviewsChanged(events.slice(heightStart))
    expect(heightChanges.length).toBeGreaterThan(0)
    expect(heightChanges.every((event) => event.worktreeId === undefined && changeData(event).worktree === undefined)).toBe(true)
    for (const event of heightChanges) expect(event.data).toEqual({ revision: expect.any(Number) })
  }, 60_000)


  test('eviction discards the local tag, local updates retain it, and omitted tags remain global', () => {
    const { env, events } = unitEnv()
    for (let index = 0; index < 16; index += 1) {
      const id = `w${index}`
      env.update((state) => { state.checksByWorktree[id] = newChecksEntry(id) })
    }

    events.length = 0
    env.update((state) => { state.checksByWorktree.w17 = newChecksEntry('w17') }, 'w17')
    expect(events).toEqual([{ type: 'changed', data: { revision: 17 } }])
    expect(env.read().checksByWorktree.w0).toBeUndefined()
    expect(env.read().checksByWorktree.w17).toBeDefined()
    expect(Object.keys(env.read().checksByWorktree)).toHaveLength(16)

    events.length = 0
    env.update((state) => { state.checksByWorktree.w17!.error = 'refreshed' }, 'w17')
    expect(events).toEqual([{ type: 'changed', data: { revision: 18, worktree: 'w17' } }])

    events.length = 0
    env.update((state) => { state.checksHeight = 480 })
    expect(events).toEqual([{ type: 'changed', data: { revision: 19 } }])
  })

  test('stale first refreshes do not emit beyond the newer tagged result', async () => {
    const { env, events, methods } = unitEnv()
    const resolvers: ((value: never) => void)[] = []
    env.resolve = () => {
      const { promise, resolve } = Promise.withResolvers<never>()
      resolvers.push(resolve)
      return promise
    }

    const older = methods.checksRefresh({ worktree: 'wt_1' }, {} as never)
    const newer = methods.checksRefresh({ worktree: 'wt_1' }, {} as never)
    const folder = { id: 'wt_1', kind: 'folder' } as never
    resolvers[1]!(folder)
    expect(await newer).toMatchObject({ ok: true, kind: 'folder' })
    expect(events).toEqual([
      { type: 'changed', data: { revision: 1, worktree: 'wt_1' } },
      { type: 'changed', data: { revision: 2, worktree: 'wt_1' } }
    ])

    resolvers[0]!(folder)
    expect(await older).toMatchObject({ ok: false, stale: true })
    expect(events).toHaveLength(2)
    expect(env.read().revision).toBe(2)
  })
})
