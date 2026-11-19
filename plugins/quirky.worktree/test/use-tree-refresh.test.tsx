import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { WorktreeControl } from '../src/control-types'
import type { TreeData, useTree as UseTree } from '../src/useTree'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

type FakeContext = {
  context: UiPluginContext
  listPending: Deferred<WorktreeControl[]>[]
  originsPending: Deferred<unknown>[]
  logs: string[]
  armList(): void
  armOrigins(): void
  count(method: string): number
  emit(type: string, data?: unknown): void
}

function fakeContext(): FakeContext {
  const counts = new Map<string, number>()
  const listPending: Deferred<WorktreeControl[]>[] = []
  const originsPending: Deferred<unknown>[] = []
  const logs: string[] = []
  let listArmed = false
  let originsArmed = false
  let listener: ((event: QuirkyEvent) => void) | null = null

  const context = {
    call(method: string) {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      if (method === 'quirky.worktree/list' && listArmed) {
        const request = deferred<WorktreeControl[]>()
        listPending.push(request)
        return request.promise
      }
      if (method === 'quirky.worktree/origins' && originsArmed) {
        const request = deferred<unknown>()
        originsPending.push(request)
        return request.promise
      }
      return Promise.resolve([])
    },
    log(message: string) {
      logs.push(message)
    },
    toast() {},
    subscribe(callback: (event: QuirkyEvent) => void) {
      listener = callback
      return () => {
        if (listener === callback) listener = null
      }
    },
    onConnection() {
      return () => {}
    }
  } as unknown as UiPluginContext

  return {
    context,
    listPending,
    originsPending,
    logs,
    armList: () => { listArmed = true },
    armOrigins: () => { originsArmed = true },
    count: (method) => counts.get(method) ?? 0,
    emit: (type, data) => listener?.({ type, data } as unknown as QuirkyEvent)
  }
}

function worktree(id: string): WorktreeControl {
  return { id } as unknown as WorktreeControl
}

let useTree: typeof UseTree
let createRoot: typeof CreateRoot
let root: Root | null = null
let host: HTMLElement
let tree!: TreeData

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The hook and ReactDOM are loaded after happy-dom installs browser globals.
  useTree = (await import('../src/useTree')).useTree
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mountProbe(fake: FakeContext) {
  host = document.createElement('div')
  document.body.append(host)
  function Probe() {
    tree = useTree(fake.context)
    return null
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Probe)))
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
  return () => tree
}

function snapshot(fake: FakeContext, methods: readonly string[]): Record<string, number> {
  return Object.fromEntries(methods.map((method) => [method, fake.count(method)]))
}

function expectDelta(fake: FakeContext, before: Record<string, number>, method: string, delta: number) {
  expect(fake.count(method)).toBe(before[method] + delta)
}

const TREE_METHODS = ['quirky.repo/list', 'quirky.repo/groupList', 'quirky.worktree/list'] as const

test('coalesces a worktree burst with independent tree and origins reruns', async () => {
  const fake = fakeContext()
  const getTree = await mountProbe(fake)
  fake.armList()
  fake.armOrigins()
  const methods = [...TREE_METHODS, 'ui.window.self', 'quirky.worktree/origins']
  const before = snapshot(fake, methods)

  await act(async () => {
    for (let i = 0; i < 30; i++) fake.emit('quirky.worktree/changed', { worktreeId: `w${i}` })
  })

  for (const method of methods) expectDelta(fake, before, method, 1)
  expect(fake.listPending).toHaveLength(1)
  expect(fake.originsPending).toHaveLength(1)

  await act(async () => fake.originsPending[0].resolve([]))
  expectDelta(fake, before, 'ui.window.self', 2)
  expectDelta(fake, before, 'quirky.worktree/origins', 2)
  for (const method of TREE_METHODS) expectDelta(fake, before, method, 1)

  await act(async () => fake.originsPending[1].resolve([]))
  expectDelta(fake, before, 'ui.window.self', 2)
  expectDelta(fake, before, 'quirky.worktree/origins', 2)

  await act(async () => fake.listPending[0].resolve([worktree('a')]))
  for (const method of TREE_METHODS) expectDelta(fake, before, method, 2)
  expectDelta(fake, before, 'quirky.worktree/origins', 2)

  await act(async () => fake.listPending[1].resolve([worktree('a'), worktree('b')]))
  expect(getTree().worktrees.map(({ id }) => id)).toEqual(['a', 'b'])
  for (const method of TREE_METHODS) expectDelta(fake, before, method, 2)

  await act(async () => fake.emit('quirky.worktree/changed', { worktreeId: 'w30' }))
  expectDelta(fake, before, 'quirky.worktree/list', 3)
  expectDelta(fake, before, 'quirky.worktree/origins', 3)
  await act(async () => fake.listPending[2].resolve([worktree('a'), worktree('b')]))
  await act(async () => fake.originsPending[2].resolve([]))
})

test('coalesces mixed refresh events into one trailing tree load', async () => {
  const fake = fakeContext()
  await mountProbe(fake)
  fake.armList()
  const before = snapshot(fake, ['quirky.worktree/list'])

  await act(async () => {
    for (let i = 0; i < 10; i++) fake.emit('quirky.repo/changed')
    for (let i = 0; i < 10; i++) fake.emit('quirky.worktree/changed', { worktreeId: `w${i}` })
    for (let i = 0; i < 5; i++) fake.emit('quirky.worktree/tagsChanged')
    for (let i = 0; i < 5; i++) fake.emit('plugin.changed')
  })

  expectDelta(fake, before, 'quirky.worktree/list', 1)
  expect(fake.listPending).toHaveLength(1)
  await act(async () => fake.listPending[0].resolve([worktree('a')]))
  expectDelta(fake, before, 'quirky.worktree/list', 2)
  expect(fake.listPending).toHaveLength(2)
  await act(async () => fake.listPending[1].resolve([worktree('b')]))
  expectDelta(fake, before, 'quirky.worktree/list', 2)
})

test('logs a failed tree load and still runs its trailing load', async () => {
  const fake = fakeContext()
  const getTree = await mountProbe(fake)
  fake.armList()
  const before = snapshot(fake, ['quirky.worktree/list'])

  await act(async () => {
    for (let i = 0; i < 30; i++) fake.emit('quirky.worktree/changed', { worktreeId: `w${i}` })
  })
  expectDelta(fake, before, 'quirky.worktree/list', 1)

  await act(async () => fake.listPending[0].reject(new Error('list failed')))
  expect(fake.logs).toEqual(['could not load worktrees: list failed'])
  expectDelta(fake, before, 'quirky.worktree/list', 2)
  expect(fake.listPending).toHaveLength(2)

  await act(async () => fake.listPending[1].resolve([worktree('b')]))
  expect(getTree().worktrees.map(({ id }) => id)).toEqual(['b'])
  expectDelta(fake, before, 'quirky.worktree/list', 2)
})

test('does not start trailing tree or origins loads after unmount', async () => {
  const fake = fakeContext()
  await mountProbe(fake)
  fake.armList()
  fake.armOrigins()
  const methods = ['quirky.worktree/list', 'quirky.worktree/origins']
  const before = snapshot(fake, methods)

  await act(async () => {
    for (let i = 0; i < 30; i++) fake.emit('quirky.worktree/changed', { worktreeId: `w${i}` })
  })
  for (const method of methods) expectDelta(fake, before, method, 1)
  expect(fake.listPending).toHaveLength(1)
  expect(fake.originsPending).toHaveLength(1)

  await act(async () => root!.unmount())
  root = null
  await act(async () => {
    fake.listPending[0].resolve([])
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  await act(async () => {
    fake.originsPending[0].resolve([])
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  for (const method of methods) expectDelta(fake, before, method, 1)
})
