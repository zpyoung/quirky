import { expect, test } from 'bun:test'
import type { QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import { startAttentionBadge, type BadgeClock } from '../src/attention-badge'
import type { WorktreeControl } from '../src/control-types'

const PANEL = 'sidebar-section:quirky.worktree/worktrees'

const wt = (id: string, patch: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id,
  repoId: 'quirky',
  path: `/p/${id}`,
  branch: id,
  head: 'abc',
  isMain: false,
  name: id,
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'window',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  instanceId: `i-${id}`,
  manualOrder: 0,
  sleeping: false,
  sleepChangedAt: null,
  references: [],
  archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true,
  externalVisibility: 'show',
  externalInboxSuppressed: false,
  tagIds: [],
  ...patch
})

const failedSession = (worktreeId: string): Session =>
  ({
    id: `s-${worktreeId}`,
    worktreeId,
    status: 'running',
    agentStatus: { display: 'failed', label: 'failed', state: 'failed', evidenceAt: Date.now(), progress: null, restoredUnconfirmed: false }
  }) as unknown as Session

type World = {
  worktrees: WorktreeControl[]
  sessions: Session[] | null
  asks: { worktreeId: string; envelope: { status: string } }[]
  checks: Record<string, 'pending' | 'success' | 'failure' | 'neutral' | null>
  projection: 'ok' | 'missing'
}
type Badge = { panel: string; count: number | null; title: string | undefined; tone: string | undefined }

function setup(patch: Partial<World> = {}) {
  const world: World = { worktrees: [], sessions: [], asks: [], checks: {}, projection: 'ok', ...patch }
  const badges: Badge[] = []
  const calls: { method: string; params: unknown }[] = []
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const connectionListeners = new Set<(status: string) => void>()
  const context = {
    log() {},
    async call(method: string, params?: unknown) {
      calls.push({ method, params })
      switch (method) {
        case 'quirky.worktree/list':
          return world.worktrees
        case 'quirky.session/list':
          if (world.sessions === null) throw new Error('method not found')
          return world.sessions
        case 'quirky.ask/list':
          return world.asks
        case 'quirky.sidebar-extras/projection':
          if (world.projection === 'missing') throw new Error('method not found')
          return {
            visibleIds: [],
            workspaces: Object.entries(world.checks).map(([worktreeId, checks]) => ({ worktreeId, checks }))
          }
        default:
          throw new Error(`unexpected call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection(listener: (status: string) => void) {
      connectionListeners.add(listener)
      return () => void connectionListeners.delete(listener)
    },
    setPanelBadge(panel: string, count: number | null, title?: string, tone?: string) {
      badges.push({ panel, count, title, tone })
    }
  } as unknown as UiPluginContext
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    world,
    badges,
    calls,
    context,
    settle,
    last: () => badges[badges.length - 1],
    emit: async (type: string) => {
      for (const listener of [...listeners]) listener({ type } as QuirkyEvent)
      await settle()
    },
    connect: async () => {
      for (const listener of [...connectionListeners]) listener('connected')
      await settle()
    },
    listenerCount: () => listeners.size + connectionListeners.size
  }
}

const ask = (worktreeId: string) => ({ worktreeId, envelope: { status: 'pending' } })

test('three worktrees needing you with one errored badge the section with the failing tone', async () => {
  const h = setup({
    worktrees: [wt('w1'), wt('w2'), wt('w3'), wt('w4')],
    asks: [ask('w1')],
    sessions: [failedSession('w2')],
    checks: { w3: 'failure', w4: 'success' }
  })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last()).toEqual({ panel: PANEL, count: 3, title: '3 worktrees need you, 1 errored', tone: 'failing' })
  dispose()
})

test('one worktree needing you says so in the singular with the needs-you tone', async () => {
  const h = setup({ worktrees: [wt('w1'), wt('w2', { unread: true })] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last()).toEqual({ panel: PANEL, count: 1, title: '1 worktree needs you', tone: 'needs-you' })
  dispose()
})

test('a worktree needing you from failing checks alone is not counted as errored', async () => {
  const h = setup({ worktrees: [wt('w1'), wt('w2')], checks: { w1: 'failure', w2: 'failure' } })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last()).toEqual({ panel: PANEL, count: 2, title: '2 worktrees need you', tone: 'needs-you' })
  dispose()
})

test('nothing needing you clears the badge', async () => {
  const h = setup({ worktrees: [wt('w1'), wt('w2')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last().count).toBeNull()
  dispose()
})

test('a sleeping pinned worktree with a pending ask still counts', async () => {
  const h = setup({ worktrees: [wt('w1', { sleeping: true, pinned: true })], asks: [ask('w1')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last().count).toBe(1)
  dispose()
})

test('the badge reads the unfiltered projection and passes no preferences override', async () => {
  const h = setup({ worktrees: [wt('w1')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.calls.filter((call) => call.method === 'quirky.sidebar-extras/projection')).toEqual([
    { method: 'quirky.sidebar-extras/projection', params: undefined }
  ])
  dispose()
})

test('ask, worktree, session and connection events refresh the count', async () => {
  const h = setup({ worktrees: [wt('w1')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last().count).toBeNull()

  h.world.asks = [ask('w1')]
  await h.emit('quirky.ask/created')
  expect(h.last().count).toBe(1)

  h.world.asks = []
  h.world.worktrees = [wt('w1', { unread: true })]
  await h.emit('quirky.worktree/changed')
  expect(h.last().count).toBe(1)

  h.world.worktrees = [wt('w1')]
  h.world.sessions = [failedSession('w1')]
  await h.emit('quirky.session/changed')
  expect(h.last()).toMatchObject({ count: 1, tone: 'failing' })

  h.world.sessions = []
  await h.connect()
  expect(h.last().count).toBeNull()
  dispose()
})

test('an unrelated event does not reload anything', async () => {
  const h = setup({ worktrees: [wt('w1')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  const before = h.calls.length
  await h.emit('quirky.unrelated/changed')
  expect(h.calls.length).toBe(before)
  dispose()
})

test('without the session plugin or the projection, pending asks still badge and rows read idle', async () => {
  const h = setup({ worktrees: [wt('w1'), wt('w2')], asks: [ask('w1')], sessions: null, projection: 'missing' })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.last()).toEqual({ panel: PANEL, count: 1, title: '1 worktree needs you', tone: 'needs-you' })
  dispose()
})

test('dispose stops listening and stops badging', async () => {
  const h = setup({ worktrees: [wt('w1')] })
  const dispose = startAttentionBadge(h.context)
  await h.settle()
  expect(h.listenerCount()).toBeGreaterThan(0)
  dispose()
  expect(h.listenerCount()).toBe(0)
  const before = h.badges.length
  h.world.asks = [ask('w1')]
  await h.emit('quirky.ask/created')
  expect(h.badges.length).toBe(before)
})

function fakeClock(start = Date.now()) {
  let now = start
  let timer: (() => void) | null = null
  let cleared = 0
  const clock: BadgeClock = {
    now: () => now,
    setInterval(callback) {
      timer = callback
      return 'timer'
    },
    clearInterval() {
      timer = null
      cleared++
    }
  }
  return {
    clock,
    advance(ms: number) {
      now += ms
      timer?.()
    },
    running: () => timer !== null,
    cleared: () => cleared
  }
}

test('a stale agent error ages out on the clock without refetching', async () => {
  const h = setup({ worktrees: [wt('w1')], sessions: [failedSession('w1')] })
  const time = fakeClock()
  const dispose = startAttentionBadge(h.context, time.clock)
  await h.settle()
  expect(h.last()).toMatchObject({ count: 1, tone: 'failing' })

  const loads = h.calls.length
  time.advance(31 * 60_000)
  expect(h.last()).toEqual({ panel: PANEL, count: null, title: undefined, tone: 'needs-you' })
  expect(h.calls.length).toBe(loads)

  dispose()
  expect(time.running()).toBe(false)
  expect(time.cleared()).toBe(1)
})

test('a refresh resolving after dispose raises no unhandled rejection and sets no badge', async () => {
  const h = setup({ worktrees: [wt('w1', { unread: true })] })
  const time = fakeClock()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let revoked = false
  const context = {
    ...h.context,
    async call(method: string, params?: unknown) {
      await gate
      if (revoked) throw new Error('quirky.worktree is not active')
      return (h.context as unknown as { call(m: string, p?: unknown): Promise<unknown> }).call(method, params)
    },
    setPanelBadge(...args: unknown[]) {
      if (revoked) throw new Error('quirky.worktree is not active')
      ;(h.context.setPanelBadge as (...a: unknown[]) => void)(...args)
    }
  } as unknown as UiPluginContext

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const dispose = startAttentionBadge(context, time.clock)
    dispose()
    revoked = true
    release()
    await h.settle()
    await h.settle()
    time.advance(60_000)
    await h.settle()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(unhandled).toEqual([])
  expect(h.badges).toEqual([])
})

test('a revoked context during a live refresh is swallowed', async () => {
  const h = setup({ worktrees: [wt('w1', { unread: true })] })
  const context = {
    ...h.context,
    setPanelBadge() {
      throw new Error('quirky.worktree is not active')
    }
  } as unknown as UiPluginContext
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const dispose = startAttentionBadge(context, fakeClock().clock)
    await h.settle()
    await h.settle()
    dispose()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(unhandled).toEqual([])
})
