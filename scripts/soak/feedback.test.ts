import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import type { act as ReactAct } from '../../packages/ui/node_modules/@types/react'

// the script has no dependency links, so the loader uses the UI workspace's installed packages
const uiDir = resolve(import.meta.dir, '../../packages/ui')
const { GlobalRegistrator } = await import(Bun.resolveSync('@happy-dom/global-registrator', uiDir))
const { act }: { act: typeof ReactAct } = await import(Bun.resolveSync('react', uiDir))
const uiBuildDir = mkdtempSync(join(tmpdir(), 'quirky-soak-feedback-ui-test-'))
symlinkSync(join(uiDir, 'node_modules'), join(uiBuildDir, 'node_modules'), 'dir')
const ownsDom = typeof document === 'undefined'
if (ownsDom) GlobalRegistrator.register()
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

async function restoreEnvironment(): Promise<void> {
  if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT
  else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  if (ownsDom) await GlobalRegistrator.unregister()
}
const activate: (context: UiPluginContext) => void = await (async () => {
  try {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, 'faults/ui.tsx')],
      target: 'bun',
      format: 'esm',
      outdir: uiBuildDir,
      naming: 'ui.js',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('feedback UI test bundle was empty')
    // the generated module path and its dependency links preserve the act helper's React instance
    const module = await import(pathToFileURL(output.path).href)
    return module.activate as (context: UiPluginContext) => void
  } catch (error) {
    await restoreEnvironment()
    rmSync(uiBuildDir, { recursive: true, force: true })
    throw error
  }
})()

const PANEL = 'panel:soak.faults/feedback'
const FLOOD_PANEL = 'panel:soak.faults/flood'
type SlotReport = { ready: boolean; worktree: string | null; sequence?: number; sent?: number; error: string | null }
type Call = { method: string; params: Record<string, unknown> }
type Subscription = {
  listener: (event: QuirkyEvent) => void | Promise<void>
  options?: { worktreeId?: string | null }
  active: boolean
}
type Shared = {
  calls: Call[]
  sequence: number
  floodCalls?: number
  outstanding?: number
  maxOutstanding?: number
  floodReply?: (params: Record<string, unknown>, index: number) => unknown | Promise<unknown>
}
type WindowHarness = {
  reports: (SlotReport & { activeSubscriptions: number })[]
  subscriptions: Subscription[]
  activeSubscriptions(): number
  bounceWorktree(next: string, back: string): Promise<void>
  changeWorktree(next: string): Promise<void>
  emit(type: string, data: unknown): void
  unmount(): Promise<void>
}

const windows: WindowHarness[] = []

afterEach(async () => {
  for (const window of windows.splice(0).reverse()) await window.unmount()
})

afterAll(async () => {
  await restoreEnvironment()
  rmSync(uiBuildDir, { recursive: true, force: true })
})

function makeWindow(worktree: string, shared: Shared, panel = PANEL) {
  let layout = { worktree } as UiLayout
  const layouts = new Set<(next: UiLayout) => void>()
  const subscriptions: Subscription[] = []
  const reports: (SlotReport & { activeSubscriptions: number })[] = []
  let mount: MountFunction | undefined
  const context = {
    pluginId: 'soak.faults',
    provide: (id: string, implementation: unknown) => {
      if (id === panel) mount = implementation as MountFunction
    },
    getLayout: () => layout,
    onLayout: (listener: (next: UiLayout) => void) => {
      layouts.add(listener)
      return () => layouts.delete(listener)
    },
    subscribe: (listener: Subscription['listener'], options?: Subscription['options']) => {
      const subscription: Subscription = { listener, options, active: true }
      subscriptions.push(subscription)
      return () => { subscription.active = false }
    },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      shared.calls.push({ method, params })
      if (method === 'soak.faults/floodTick') {
        const index = shared.floodCalls ?? 0
        shared.floodCalls = index + 1
        shared.outstanding = (shared.outstanding ?? 0) + 1
        shared.maxOutstanding = Math.max(shared.maxOutstanding ?? 0, shared.outstanding)
        try {
          return await (shared.floodReply
            ? shared.floodReply(params, index)
            : { owner: params.owner, sequence: params.sequence })
        } finally {
          shared.outstanding = (shared.outstanding ?? 1) - 1
        }
      }
      shared.sequence += 1
      return { owner: params.owner, sequence: shared.sequence }
    }
  } as unknown as UiPluginContext

  activate(context)
  if (!mount) throw new Error(`${panel} mount was not registered`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mount!(element, {
      report: (value) => {
        reports.push({
          ...(value as SlotReport),
          activeSubscriptions: subscriptions.filter((subscription) => subscription.active).length
        })
      }
    })
  })

  return {
    element,
    reports,
    subscriptions,
    activeSubscriptions: () => subscriptions.filter((subscription) => subscription.active).length,
    async bounceWorktree(next: string, back: string) {
      await act(async () => {
        layout = { ...layout, worktree: next }
        for (const listener of [...layouts]) listener(layout)
        layout = { ...layout, worktree: back }
        for (const listener of [...layouts]) listener(layout)
        await Promise.resolve()
      })
    },
    async changeWorktree(next: string) {
      await act(async () => {
        layout = { ...layout, worktree: next }
        for (const listener of [...layouts]) listener(layout)
        await Promise.resolve()
      })
    },
    emit(type: string, data: unknown) {
      for (const subscription of subscriptions) {
        if (subscription.active) void subscription.listener({ type, data } as QuirkyEvent)
      }
    },
    async unmount() {
      if (!cleanup) return
      const dispose = cleanup
      cleanup = undefined
      await act(async () => { dispose?.() })
      element.remove()
    }
  }
}


async function emitToAll(type: string, data: unknown): Promise<void> {
  await act(async () => {
    for (const window of windows) window.emit(type, data)
    await Promise.resolve()
  })
}

test('reports ready only after the worktree-scoped subscription is installed and cleans it up', async () => {
  const window = makeWindow('worktree-a', { calls: [], sequence: 0 })
  windows.push(window)

  await act(async () => { await Promise.resolve() })
  expect(window.reports.at(-1)).toMatchObject({
    ready: true, worktree: 'worktree-a', sequence: 0, error: null, activeSubscriptions: 1
  })
  expect(window.subscriptions.map(({ options }) => options)).toEqual([{ worktreeId: 'worktree-a' }])

  await window.unmount()
  expect(window.activeSubscriptions()).toBe(0)
})

test('mounted panels ignore foreign pairs, alternate exactly seventeen refreshes, and leave a third window idle', async () => {
  const shared: Shared = { calls: [], sequence: 0 }
  const a = makeWindow('a', shared)
  const b = makeWindow('b', shared)
  const c = makeWindow('c', shared)
  windows.push(a, b, c)

  await emitToAll('soak.faults/feedbackStarted', { worktrees: ['x', 'y'], first: 'x' })
  expect(shared.calls).toEqual([])

  await emitToAll('soak.faults/feedbackStarted', { worktrees: ['a', 'b'], first: 'a' })
  expect(shared.calls).toEqual([{ method: 'soak.faults/feedbackRefresh', params: { owner: 'a' } }])

  for (let sequence = 1; sequence <= 17; sequence += 1) {
    await emitToAll('soak.faults/feedbackChanged', {
      worktrees: ['a', 'b'], owner: sequence % 2 === 1 ? 'a' : 'b', sequence
    })
  }

  expect(shared.calls).toHaveLength(17)
  expect(shared.calls.map(({ params }) => params.owner)).toEqual(
    Array.from({ length: 17 }, (_, index) => index % 2 === 0 ? 'a' : 'b')
  )
  expect(shared.calls.map(({ method }) => method)).toEqual(Array(17).fill('soak.faults/feedbackRefresh'))
  expect(a.reports.at(-1)).toMatchObject({ sequence: 17 })
  expect(b.reports.at(-1)).toMatchObject({ sequence: 16 })
  expect([a.reports.length, b.reports.length, c.reports.length]).toEqual([10, 9, 1])
  expect(a.reports.length + b.reports.length + c.reports.length).toBe(20)
  expect(c.reports.at(-1)).toMatchObject({ ready: true, worktree: 'c', sequence: 0, error: null })
})

test('a worktree round trip invalidates old callbacks and resubscribes at the committed worktree', async () => {
  const shared: Shared = { calls: [], sequence: 0 }
  const window = makeWindow('a', shared)
  windows.push(window)
  await act(async () => { await Promise.resolve() })
  const old = window.subscriptions[0]!

  await window.bounceWorktree('b', 'a')
  expect(old.active).toBe(false)
  expect(window.subscriptions.map(({ options }) => options)).toEqual([
    { worktreeId: 'a' }, { worktreeId: 'a' }
  ])
  expect(window.reports.at(-1)).toMatchObject({ ready: true, worktree: 'a', activeSubscriptions: 1 })

  await act(async () => {
    await old.listener({
      type: 'soak.faults/feedbackStarted', data: { worktrees: ['a', 'b'], first: 'a' }
    } as QuirkyEvent)
    await Promise.resolve()
  })
  expect(shared.calls).toEqual([])
})

async function waitForFloodReport(
  window: WindowHarness,
  predicate: (report: SlotReport) => boolean
): Promise<SlotReport> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const report = window.reports.at(-1)
    if (report && predicate(report)) return report
    await act(async () => { await Promise.resolve() })
  }
  throw new Error('timed out waiting for the flood panel report')
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) await Promise.resolve()
  })
}

test('mounted flood panels send each bounded tick only from the selected worktree', async () => {
  const shared: Shared = { calls: [], sequence: 0 }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  const b = makeWindow('b', shared, FLOOD_PANEL)
  const c = makeWindow('c', shared, FLOOD_PANEL)
  windows.push(a, b, c)


  await act(async () => { await Promise.resolve() })

  expect([a, b, c].map((window) => window.reports.at(-1))).toEqual([
    expect.objectContaining({ ready: true, worktree: 'a', sent: 0, error: null, activeSubscriptions: 1 }),
    expect.objectContaining({ ready: true, worktree: 'b', sent: 0, error: null, activeSubscriptions: 1 }),
    expect.objectContaining({ ready: true, worktree: 'c', sent: 0, error: null, activeSubscriptions: 1 })
  ])
  expect([a, b, c].map((window) => window.subscriptions[0]?.options)).toEqual([
    { worktreeId: 'a' }, { worktreeId: 'b' }, { worktreeId: 'c' }
  ])

  const start = { worktree: 'a', requests: 3000 }
  await emitToAll('soak.faults/floodStarted', start)
  await emitToAll('soak.faults/floodStarted', start)
  const complete = await waitForFloodReport(a, (report) => report.sent === 3000)

  expect(shared.calls).toHaveLength(3000)
  expect(shared.calls.every(({ method, params }) => method === 'soak.faults/floodTick' && params.owner === 'a')).toBe(true)
  const sequences = shared.calls.map(({ params }) => params.sequence)
  expect(sequences).toEqual(Array.from({ length: 3000 }, (_, index) => index + 1))
  expect(new Set(sequences).size).toBe(3000)
  expect(shared.maxOutstanding).toBe(50)
  expect(complete).toMatchObject({ ready: true, worktree: 'a', sent: 3000, error: null })
  expect(a.reports).toHaveLength(3)
  expect([b.reports.length, c.reports.length]).toEqual([1, 1])
  expect(b.reports.at(-1)).toMatchObject({ ready: true, worktree: 'b', sent: 0, error: null })
  expect(c.reports.at(-1)).toMatchObject({ ready: true, worktree: 'c', sent: 0, error: null })
})

test('a flood waits for every reply in a batch before sending the next batch', async () => {
  const pending: { params: Record<string, unknown>; resolve(value: unknown): void }[] = []
  const shared: Shared = {
    calls: [], sequence: 0,
    floodReply: (params) => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      pending.push({ params, resolve })
      return promise
    },
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)
  await emitToAll('soak.faults/floodStarted', { worktree: 'a', requests: 51 })
  expect(pending).toHaveLength(50)
  for (const request of pending.slice(0, 49)) request.resolve(request.params)
  await flushMicrotasks()
  expect(shared.calls).toHaveLength(50)
  pending[49]!.resolve(pending[49]!.params)
  await flushMicrotasks()
  expect(pending).toHaveLength(51)
  expect(shared.maxOutstanding).toBe(50)
  pending[50]!.resolve(pending[50]!.params)
  expect(await waitForFloodReport(a, (report) => report.sent === 51)).toMatchObject({ sent: 51, error: null })
  expect(shared.calls).toHaveLength(51)
})

test('flood panels ignore malformed and foreign start events', async () => {
  const shared: Shared = { calls: [], sequence: 0 }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)

  for (const data of [
    null,
    {},
    { worktree: '', requests: 3000 },
    { worktree: 'a', requests: 0 },
    { worktree: 'a', requests: 10_001 },
    { worktree: 'other', requests: 3000 }
  ]) {
    await emitToAll('soak.faults/floodStarted', data)
  }

  expect(shared.calls).toEqual([])
  expect(a.reports).toHaveLength(1)
  expect(a.reports.at(-1)).toMatchObject({ ready: true, worktree: 'a', sent: 0, error: null })
})

test('a flood panel stops after an invalid tick reply without publishing per-tick reports', async () => {
  const shared: Shared = {
    calls: [],
    sequence: 0,
    floodReply: (params) => params.sequence === 3
      ? { owner: params.owner, sequence: 4 }
      : { owner: params.owner, sequence: params.sequence }
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)

  await emitToAll('soak.faults/floodStarted', { worktree: 'a', requests: 3000 })
  const failed = await waitForFloodReport(a, (report) => report.error !== null)

  expect(shared.calls).toHaveLength(50)
  expect(shared.maxOutstanding).toBe(50)
  expect(failed).toMatchObject({ ready: true, worktree: 'a', sent: 0 })
  expect(failed.error).toContain('tick 3')
  expect(a.reports).toHaveLength(3)
})

test('a flood panel stops after an RPC rejection without starting another batch', async () => {
  const shared: Shared = {
    calls: [],
    sequence: 0,
    floodReply: (params) => {
      if (params.sequence === 7) return Promise.reject(new Error('fixture offline'))
      return { owner: params.owner, sequence: params.sequence }
    }
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)

  await emitToAll('soak.faults/floodStarted', { worktree: 'a', requests: 3000 })
  const failed = await waitForFloodReport(a, (report) => report.error !== null)

  expect(shared.calls).toHaveLength(50)
  expect(failed).toMatchObject({ ready: true, worktree: 'a', sent: 0, error: 'fixture offline' })
  expect(a.reports).toHaveLength(3)
})

test('a worktree change invalidates a pending flood batch and its late report', async () => {
  const pending: { params: Record<string, unknown>; resolve(value: unknown): void }[] = []
  const shared: Shared = {
    calls: [],
    sequence: 0,
    floodReply: (params) => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      pending.push({ params, resolve })
      return promise
    }
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)
  const oldSubscription = a.subscriptions[0]!

  await emitToAll('soak.faults/floodStarted', { worktree: 'a', requests: 3000 })
  expect(shared.calls).toHaveLength(50)
  expect(pending).toHaveLength(50)

  await a.changeWorktree('b')
  expect(oldSubscription.active).toBe(false)
  expect(a.subscriptions.map(({ options }) => options)).toEqual([
    { worktreeId: 'a' }, { worktreeId: 'b' }
  ])
  expect(a.reports.at(-1)).toMatchObject({ ready: true, worktree: 'b', sent: 0, error: null })
  const reportsAfterChange = a.reports.length

  for (const request of pending) {
    request.resolve({ owner: request.params.owner, sequence: request.params.sequence })
  }
  await flushMicrotasks()

  expect(shared.calls).toHaveLength(50)
  expect(a.reports).toHaveLength(reportsAfterChange)
  expect(a.activeSubscriptions()).toBe(1)
})

test('a worktree round trip cannot restart the armed flood while its original batch is pending', async () => {
  const pending: { params: Record<string, unknown>; resolve(value: unknown): void }[] = []
  const shared: Shared = {
    calls: [], sequence: 0,
    floodReply: (params) => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      pending.push({ params, resolve })
      return promise
    },
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)
  const start = { worktree: 'a', requests: 3000 }
  await emitToAll('soak.faults/floodStarted', start)
  expect(shared.calls).toHaveLength(50)
  await a.bounceWorktree('b', 'a')
  const reportsAfterChange = a.reports.length
  await emitToAll('soak.faults/floodStarted', start)
  expect(shared.calls).toHaveLength(50)
  expect(shared.maxOutstanding).toBe(50)
  for (const request of pending) request.resolve(request.params)
  await flushMicrotasks()
  expect(shared.calls).toHaveLength(50)
  expect(a.reports).toHaveLength(reportsAfterChange)
  expect(a.activeSubscriptions()).toBe(1)
})

test('unmounting invalidates a pending flood batch and suppresses late reports', async () => {
  const pending: { params: Record<string, unknown>; resolve(value: unknown): void }[] = []
  const shared: Shared = {
    calls: [],
    sequence: 0,
    floodReply: (params) => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      pending.push({ params, resolve })
      return promise
    }
  }
  const a = makeWindow('a', shared, FLOOD_PANEL)
  windows.push(a)

  await emitToAll('soak.faults/floodStarted', { worktree: 'a', requests: 3000 })
  expect(shared.calls).toHaveLength(50)
  await a.unmount()
  const reportsAtUnmount = a.reports.length

  for (const request of pending) {
    request.resolve({ owner: request.params.owner, sequence: request.params.sequence })
  }
  await flushMicrotasks()

  expect(shared.calls).toHaveLength(50)
  expect(a.reports).toHaveLength(reportsAtUnmount)
  expect(a.activeSubscriptions()).toBe(0)
})
