import { registerUiDom, unregisterUiDom } from './ui-dom'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root, createRoot as createRootFactory } from 'react-dom/client'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { IterationDetail, LoopConfig, LoopSnapshot, QueueItem } from '../src/types'
import type { SurfaceHandle } from '../window/contracts'
import { LoopView } from '../window/LoopView'
let createRoot: typeof createRootFactory

type Call = { method: string; params: Record<string, unknown> }
type CommandCall = { id: string; args: unknown }
type Listener = (event: QuirkyEvent) => void | Promise<void>
type ConnectionListener = (status: 'connected' | 'reconnecting') => void

const config: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'Complete the task.' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: { maxIterations: 10 },
  noProgress: true,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

function loop(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    id: 'loop-1',
    name: 'Feature loop',
    slug: 'feature-loop',
    worktreeId: 'worktree-1',
    cwd: '/worktree',
    workspaceKind: 'git',
    agent: 'claude',
    preset: 'until-done',
    config,
    state: 'running',
    pauseReason: null,
    pauseDetail: null,
    sessionId: 'session-1',
    iterationsCompleted: 2,
    activeMs: 65_000,
    costUsd: null,
    phase: 'working',
    nextIterationAt: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    endedAt: null,
    notesPath: '/worktree/.quirky/loop.md',
    warnings: [],
    recentIterations: [],
    queueItems: [],
    skippedTicks: 0,
    ...overrides
  }
}

function iteration(overrides: Partial<IterationDetail> = {}): IterationDetail {
  return {
    loopId: 'loop-1',
    n: 1,
    attempt: 1,
    sessionId: 'session-1',
    promptSent: 'Complete the task.',
    startedAt: 1_000,
    endedAt: 4_500,
    endReason: 'settled',
    doneConfig: {},
    check: null,
    evaluator: null,
    markers: { done: false },
    diff: null,
    treeBefore: null,
    treeAfter: null,
    protectedPathHits: [],
    checkpointCommit: null,
    costUsd: null,
    usageLimit: null,
    outputTail: '',
    ...overrides
  }
}


function queueItem(id: string, position: number, state: QueueItem['state'], body = id): QueueItem {
  return { id, position, state, body }
}

function harness(initial = loop(), options: {
  history?: IterationDetail[]
  messages?: unknown[]
  pendingGet?: Promise<unknown>
  pendingRefreshGet?: Promise<unknown>
  pendingMessages?: Promise<unknown>
  pendingPause?: Promise<unknown>
  failGet?: Error
  failRefreshGet?: Error
  malformedGet?: boolean
  failHistory?: Error
  failMessages?: Error
  failPause?: Error
  failSteer?: Error
  failEdit?: Error
  failQueue?: Error
  failCommandAction?: string
  queueConflictItem?: string
} = {}) {
  let current = initial
  let history = options.history ?? []
  let messages = options.messages ?? [{ sessionId: 'session-1', seq: 1, role: 'assistant', text: 'Working through the task.', at: 2_000 }]
  const calls: Call[] = []
  const commandCalls: CommandCall[] = []
  const eventListeners = new Set<Listener>()
  const connectionListeners = new Set<ConnectionListener>()
  let handle: SurfaceHandle | null = null
  let getCalls = 0
  let failSteer = options.failSteer
  let failQueue = options.failQueue

  const context = {
    async executeCommand(id: string, args?: unknown) {
      commandCalls.push({ id, args })
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Loop command arguments must be an object.')
      }
      const command = args as { action?: unknown; params?: unknown }
      if (options.failCommandAction === command.action) throw new Error('bridge refused')
      if (id !== 'command:quirky.loops/action' || typeof command.action !== 'string') {
        throw new Error(`Unexpected UI command ${id}`)
      }
      const params = typeof command.params === 'object' && command.params !== null && !Array.isArray(command.params)
        ? command.params as Record<string, unknown>
        : {}
      if (handle === null) throw new Error('Loop surface is unavailable.')
      await handle.dispatch(command.action, params)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/get') {
        getCalls++
        if (getCalls === 1 && options.failGet) throw options.failGet
        if (getCalls === 1 && options.pendingGet) return options.pendingGet
        if (getCalls === 1 && options.malformedGet) return { id: initial.id }
        if (getCalls > 1 && options.failRefreshGet) throw options.failRefreshGet
        if (getCalls > 1 && options.pendingRefreshGet) return options.pendingRefreshGet
        return current
      }
      if (method === 'quirky.loops/iterations') {
        if (options.failHistory) throw options.failHistory
        return history
      }
      if (method === 'quirky.structured/messages') {
        if (options.failMessages) throw options.failMessages
        if (options.pendingMessages) return options.pendingMessages
        return params.session === current.sessionId ? messages : []
      }
      if (method === 'quirky.loops/pause') {
        if (options.failPause) throw options.failPause
        if (options.pendingPause) return options.pendingPause
        current = { ...current, state: 'paused', pauseReason: 'user' }
        return current
      }
      if (method === 'quirky.loops/resume') {
        const add = params.addIterations
        current = {
          ...current,
          state: 'running',
          pauseReason: null,
          config: add === undefined
            ? current.config
            : { ...current.config, caps: { ...current.config.caps, maxIterations: (current.config.caps.maxIterations ?? 0) + Number(add) } }
        }
        return current
      }
      if (method === 'quirky.loops/stop') {
        current = { ...current, state: 'stopped', endedAt: 5_000 }
        return current
      }
      if (method === 'quirky.loops/steer') {
        if (failSteer) {
          const error = failSteer
          failSteer = undefined
          throw error
        }
        return current
      }
      if (method === 'quirky.loops/edit') {
        if (options.failEdit) throw options.failEdit
        return current
      }
      if (method === 'quirky.loops/queue') {
        if (failQueue !== undefined) {
          const error = failQueue
          failQueue = undefined
          if (options.queueConflictItem !== undefined) {
            current = {
              ...current,
              queueItems: current.queueItems.map((item) => item.id === options.queueConflictItem ? { ...item, state: 'in-flight' } : item)
            }
          }
          throw error
        }
        return current
      }
      throw new Error(`Unexpected method ${method}`)
    },
    subscribe(listener: Listener) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    onConnection(listener: ConnectionListener) {
      connectionListeners.add(listener)
      return () => void connectionListeners.delete(listener)
    }
  } as unknown as UiPluginContext

  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const props = {
    context,
    loopId: initial.id,
    onHandle(next: SurfaceHandle | null) { handle = next }
  }

  return {
    container,
    calls,
    commandCalls,
    get handle() { return handle },
    setLoop(value: LoopSnapshot) { current = value },
    setMessages(value: unknown[]) { messages = value },
    async mount() {
      await act(async () => root.render(createElement(LoopView, props)))
      await settle()
    },
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
    async emit(event: Record<string, unknown>) {
      await act(async () => {
        await Promise.all([...eventListeners].map((listener) => listener(event as QuirkyEvent)))
      })
      await settle()
    },
    async reconnect(status: 'connected' | 'reconnecting' = 'connected') {
      await act(async () => {
        for (const listener of connectionListeners) listener(status)
      })
      await settle()
    }
  }
}

async function settle() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
  })
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

let unmountCurrent: (() => Promise<void>) | null = null

beforeAll(async () => {
  registerUiDom()
  // React DOM feature-detects the DOM during import; register happy-dom first.
  const reactDom = await import('react-dom/client')
  createRoot = reactDom.createRoot
})

afterEach(async () => {
  await unmountCurrent?.()
  unmountCurrent = null
})

afterAll(async () => {
  await unregisterUiDom()
})

test('shows durable state and structured output without inventing a cost or composer', async () => {
  const h = harness(loop({ state: 'needs-you', pauseReason: 'agent-blocked', pauseDetail: 'Waiting for the test credentials.' }))
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.textContent).toContain('Needs you')
  expect(h.container.textContent).toContain('Waiting for the test credentials.')
  expect(h.container.textContent).toContain('2 of 10 iterations done')
  expect(h.container.textContent).toContain('Working through the task.')
  expect(h.container.textContent).not.toContain('$0.00')
  expect(h.container.querySelector('textarea')).toBeNull()
})
test('renders an empty journal without synthetic transcript messages', async () => {
  const h = harness(loop(), { messages: [] })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('[aria-label="Structured session journal"]')?.querySelectorAll('pre')).toHaveLength(0)
  expect(h.container.querySelector('.ui-empty-state')?.textContent).toContain('No messages recorded.')
  expect(h.container.querySelector('section[aria-label="Iteration history"] .ui-empty-state')?.textContent)
    .toContain('No finished iterations.')
  expect(h.container.textContent).toContain('No messages recorded.')
  expect(h.container.textContent).not.toContain('Working through the task.')
})

test('uses a shared notice while the initial loop snapshot is pending', async () => {
  const pending = Promise.withResolvers<unknown>()
  const h = harness(loop(), { pendingGet: pending.promise })
  unmountCurrent = h.unmount
  await h.mount()

  const notice = h.container.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toContain('Loading loop…')
  expect(notice?.querySelector('[role="status"]')?.textContent).toBe('Loading loop…')
  expect(h.container.querySelector('[aria-label="Loop lifecycle controls"]')).toBeNull()

  await act(async () => {
    pending.resolve(loop())
    await pending.promise
  })
})

test('marks a failed snapshot read unverifiable with a shared error and no controls', async () => {
  const h = harness(loop(), { failGet: new Error('snapshot unavailable') })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.textContent).toContain('Unverifiable')
  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('snapshot unavailable')
  expect(h.container.querySelector('[aria-label="Loop lifecycle controls"]')).toBeNull()
})

test('renders a malformed snapshot as a shared unverifiable error', async () => {
  const h = harness(loop(), { malformedGet: true })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.textContent).toContain('Unverifiable')
  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe(
    'The loop service returned an unverifiable snapshot.'
  )
  expect(h.container.querySelector('[aria-label="Loop lifecycle controls"]')).toBeNull()
})

test('a failed refresh preserves output and makes queue controls read-only', async () => {
  const initial = loop({
    preset: 'queue',
    config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
    queueItems: [queueItem('q1', 0, 'pending', 'Next task')]
  })
  const h = harness(initial, { failRefreshGet: new Error('refresh unavailable') })
  unmountCurrent = h.unmount
  await h.mount()
  await h.emit({ type: 'quirky.loops/changed', data: initial })

  expect(h.container.textContent).toContain('Working through the task.')
  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('refresh unavailable')
  expect(h.container.querySelector('[aria-label="Loop lifecycle controls"]')).toBeNull()
  expect(h.container.querySelector('[aria-label="Loop queue history"] button')).toBeNull()
})

test('refreshing a loaded view does not replace it or discard an open draft', async () => {
  const pending = Promise.withResolvers<unknown>()
  const h = harness(loop(), { pendingRefreshGet: pending.promise })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Steer').click())
  const guidance = h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement
  await act(async () => setValue(guidance, 'keep this guidance'))
  await h.emit({ type: 'quirky.loops/changed', data: loop() })

  expect(h.container.textContent).not.toContain('Loading loop…')
  expect((h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement).value)
    .toBe('keep this guidance')

  await act(async () => {
    pending.resolve(loop())
    await pending.promise
  })
})

test('uses a shared notice while structured output is pending', async () => {
  const pending = Promise.withResolvers<unknown>()
  const h = harness(loop(), { pendingMessages: pending.promise })
  unmountCurrent = h.unmount
  await h.mount()

  const notice = h.container.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toContain('Loading output…')
  expect(notice?.querySelector('[role="status"]')?.textContent).toBe('Loading output…')
  pending.resolve([])
  await pending.promise
  await settle()
})

test('renders history failures as shared errors in the history section', async () => {
  const h = harness(loop(), { failHistory: new Error('history unavailable') })
  unmountCurrent = h.unmount
  await h.mount()

  const history = h.container.querySelector('section[aria-label="Iteration history"]')
  expect(history?.querySelector('.ui-inline-error[role="alert"]')?.textContent)
    .toBe('Iteration history unavailable: history unavailable')
  expect(h.container.textContent).not.toContain('No finished iterations.')
  expect([...h.container.querySelectorAll('.ui-inline-error')].filter((item) => item.textContent?.includes('history unavailable')))
    .toHaveLength(1)
})

test('renders journal failures as shared errors instead of successful emptiness', async () => {
  const h = harness(loop(), { failMessages: new Error('journal unavailable') })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent)
    .toBe('Output unavailable: journal unavailable')
  expect(h.container.textContent).not.toContain('No messages recorded.')
})

test('keeps the empty state for a loop without a structured session', async () => {
  const h = harness(loop({ sessionId: null }))
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('.ui-empty-state')?.textContent).toBe('No structured session is attached.')
})

test('renders saved iteration errors through InlineError and keeps missing output empty', async () => {
  const saved = iteration({ error: 'saved output unavailable' })
  const h = harness(loop({ state: 'completed', endedAt: 5_000, recentIterations: [saved] }))
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('saved output unavailable')
  expect(h.container.querySelector('.ui-empty-state')?.textContent).toBe('No output recorded for this iteration.')
})

test('keeps the empty state when a completed loop has no saved iteration output', async () => {
  const h = harness(loop({ state: 'completed', endedAt: 5_000 }))
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('.ui-empty-state')?.textContent).toBe('No output recorded for this iteration.')
})

test('uses shared notices for pending lifecycle work and reconnection', async () => {
  const pending = Promise.withResolvers<unknown>()
  const h = harness(loop(), { pendingPause: pending.promise })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Pause after this iteration').click())

  const working = h.container.querySelector<HTMLElement>('.ui-notice-line')
  expect(working?.textContent).toContain('Working…')
  expect(working?.querySelector('[role="status"]')?.textContent).toBe('Working…')
  pending.resolve(loop({ state: 'paused', pauseReason: 'user' }))
  await pending.promise
  await settle()

  await h.reconnect('reconnecting')
  const reconnecting = h.container.querySelector<HTMLElement>('.ui-notice-line')
  expect(reconnecting?.textContent).toContain('Reconnecting to loop state…')
  expect(reconnecting?.querySelector('[role="status"]')?.textContent).toBe('Reconnecting to loop state…')
})

test('marks an unreachable loop unverifiable and omits controls', async () => {
  const h = harness(loop(), { failGet: new Error('daemon disconnected') })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.textContent).toContain('Unverifiable')
  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('daemon disconnected')
  expect(h.container.querySelector('button')).toBeNull()
})

test('routes DOM pause through the public command once while explicit dispatch stays internal', async () => {
  const dom = harness()
  unmountCurrent = dom.unmount
  await dom.mount()
  await act(async () => button(dom.container, 'Pause after this iteration').click())

  expect(dom.commandCalls).toEqual([{
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'pause', params: {} }
  }])
  expect(dom.calls.filter(({ method }) => method === 'quirky.loops/pause'))
    .toEqual([{ method: 'quirky.loops/pause', params: { loopId: 'loop-1', mode: 'after-iteration' } }])
  expect(dom.handle!.read()).toMatchObject({ snapshot: { state: 'paused' } })

  await dom.unmount()
  unmountCurrent = null

  const direct = harness()
  unmountCurrent = direct.unmount
  await direct.mount()
  await act(async () => { await direct.handle!.dispatch('pause') })

  expect(direct.commandCalls).toEqual([])
  expect(direct.calls.filter(({ method }) => method === 'quirky.loops/pause'))
    .toEqual([{ method: 'quirky.loops/pause', params: { loopId: 'loop-1', mode: 'after-iteration' } }])
  expect(direct.handle!.read()).toMatchObject({ snapshot: { state: 'paused' } })
})

test('routes stop opening and cancellation through the public command', async () => {
  const h = harness()
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Stop').click())
  await act(async () => button(h.container, 'Cancel').click())

  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'stop-open', params: {} } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'stop-cancel', params: {} } }
  ])
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/stop')).toEqual([])
})

test('routes a stop choice through the public command with its selected mode', async () => {
  const h = harness()
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Stop').click())
  await act(async () => button(h.container, 'After this iteration').click())

  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'stop-open', params: {} } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'stop', params: { mode: 'after-iteration' } } }
  ])
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/stop')).toEqual([{
    method: 'quirky.loops/stop',
    params: { loopId: 'loop-1', mode: 'after-iteration' }
  }])
})

test('a rejected bridge action shows a shared error without dispatching or losing guidance', async () => {
  const h = harness(loop(), { failCommandAction: 'steer' })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Steer').click())
  const note = h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement
  await act(async () => setValue(note, 'keep this guidance'))
  await act(async () => button(h.container, 'Send').click())
  await settle()

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('bridge refused')
  expect((h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement).value)
    .toBe('keep this guidance')
  expect(h.handle!.read()).toMatchObject({ activeForm: 'steer', steerDraft: 'keep this guidance' })
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/steer')).toEqual([])
  expect(h.commandCalls.at(-1)).toEqual({
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'steer', params: { text: 'keep this guidance' } }
  })
  await act(async () => button(h.container, 'Cancel').click())
  expect(h.commandCalls.at(-1)).toEqual({
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'steer-cancel', params: {} }
  })
})

test('resumes a capped paused loop with the positive requested iteration increase', async () => {
  const capped = loop({ state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 10 })
  const h = harness(capped)
  unmountCurrent = h.unmount
  await h.mount()
  const input = h.container.querySelector('[aria-label="Iterations to add"]') as HTMLInputElement
  expect(input.value).toBe('5')
  await act(async () => setValue(input, '1'))
  await act(async () => button(h.container, 'Resume').click())

  expect(h.handle!.read()).toMatchObject({
    snapshot: { state: 'running', config: { caps: { maxIterations: 11 } } }
  })
  expect(button(h.container, 'Pause after this iteration').disabled).toBe(false)
  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'resume-update', params: { value: '1' } } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'resume', params: {} } }
  ])
})

test('rejects an invalid resume increment before making a lifecycle request', async () => {
  const h = harness(loop({ state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 10 }))
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => setValue(h.container.querySelector('[aria-label="Iterations to add"]') as HTMLInputElement, '0'))
  expect(button(h.container, 'Resume').disabled).toBe(true)
  expect(h.calls.some(({ method }) => method === 'quirky.loops/resume')).toBe(false)
  expect(h.commandCalls).toEqual([{
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'resume-update', params: { value: '0' } }
  }])
})
test('keeps steer guidance and displays the backend failure through the shared error', async () => {
  const h = harness(loop(), { failSteer: new Error('steer refused') })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Steer').click())
  const note = h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement
  await act(async () => setValue(note, 'keep this guidance'))
  await act(async () => button(h.container, 'Send').click())

  expect((h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement).value)
    .toBe('keep this guidance')
  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('steer refused')
  expect(h.handle!.read()).toMatchObject({ activeForm: 'steer', errors: { action: 'steer refused' } })
  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'steer-open', params: {} } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'steer-update', params: { text: 'keep this guidance' } } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'steer', params: { text: 'keep this guidance' } } }
  ])
})

test('renders a failed lifecycle action through the shared error', async () => {
  const h = harness(loop(), { failPause: new Error('pause refused') })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Pause after this iteration').click())

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('pause refused')
  expect(h.handle!.read()).toMatchObject({ errors: { action: 'pause refused' } })
  expect(h.commandCalls).toEqual([{
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'pause', params: {} }
  }])
})

test('renders a failed configuration edit through the shared error', async () => {
  const h = harness(loop(), { failEdit: new Error('edit refused') })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Edit configuration').click())
  await act(async () => setValue(h.container.querySelector('[aria-label="Loop prompt"]') as HTMLTextAreaElement, 'Changed prompt'))
  await act(async () => button(h.container, 'Save').click())

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('edit refused')
  expect((h.container.querySelector('[aria-label="Loop prompt"]') as HTMLTextAreaElement).value).toBe('Changed prompt')
  expect(h.handle!.read()).toMatchObject({ activeForm: 'edit', errors: { action: 'edit refused' } })
  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'edit-open', params: {} } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'edit-update', params: { patch: { prompt: 'Changed prompt' } } } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'edit-save', params: {} } }
  ])
  await act(async () => button(h.container, 'Cancel').click())
  expect(h.commandCalls.at(-1)).toEqual({
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'edit-cancel', params: {} }
  })
})

test('shows retained attempts with honest missing evidence and opens their detail', async () => {
  const pass = iteration({
    n: 1,
    check: { ran: true, pass: true, exitCode: 0, timedOut: false, stdoutTail: 'ok', stderrTail: '', durationMs: 10 },
    diff: { added: 1, removed: 0, files: ['README.md'] },
    costUsd: 0.25
  })
  const fail = iteration({
    n: 2,
    attempt: 1,
    check: { ran: true, pass: false, exitCode: 1, timedOut: false, stdoutTail: '', stderrTail: 'failed', durationMs: 20 },
    evaluator: { verdict: 'not-met', reason: 'The requirement remains incomplete.' }
  })
  const older = Array.from({ length: 50 }, (_, index) => iteration({
    n: index + 3,
    startedAt: 3_000 + index * 1_000,
    endedAt: 4_000 + index * 1_000
  }))
  const retained = iteration({ n: 52, attempt: 2, startedAt: 53_000, endedAt: 56_500, outputTail: 'The attempt output.' })
  const fullHistory = [pass, fail, ...older, retained]
  const h = harness(loop({ iterationsCompleted: 52, recentIterations: fullHistory.slice(-50) }), { history: fullHistory })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelectorAll('[aria-label="Iteration history"] ol > li')).toHaveLength(53)
  expect(h.container.textContent).toContain('Pass')
  expect(h.container.textContent).toContain('Fail')
  expect(h.container.textContent).toContain('No check')
  expect(h.container.querySelector('button[aria-label="Iteration 1"]')).not.toBeNull()
  const entry = [...h.container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('#52') && candidate.textContent.includes('Attempt 2'))
  expect(entry).toBeDefined()
  expect(h.container.textContent).toContain('Diff unavailable')
  await act(async () => entry!.click())

  expect(h.handle!.read().selectedDetail).toEqual(retained)
  expect([...h.container.querySelectorAll('section[aria-labelledby="loop-iteration-title"] dl dd')].map((item) => item.textContent)).toContain('Unavailable')
  expect(h.container.textContent).toContain('The attempt output.')
  expect(h.container.querySelector('section[aria-label="Errors"] .ui-empty-state')?.textContent).toContain('None recorded.')
  expect(h.container.querySelector('section[aria-label="Iteration output tail"] .ui-readout')?.textContent)
    .toBe('The attempt output.')
  expect(h.container.textContent).not.toContain('$0.00')
  await act(async () => button(h.container, 'Back').click())
  expect(h.handle!.read().selectedDetail).toBeNull()
  expect(h.commandCalls).toEqual([
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'iteration', params: { n: 52, attempt: 2 } } },
    { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'back', params: {} } }
  ])
})
test('deduplicates iteration and check errors through the shared error and marks an empty output tail', async () => {
  const detail = iteration({
    error: 'Check runner failed.',
    check: {
      ran: true,
      pass: false,
      exitCode: 1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 5,
      error: 'Check runner failed.'
    }
  })
  const h = harness(loop({ recentIterations: [detail] }), { history: [detail] })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => (h.container.querySelector('button[aria-label=\"Iteration 1\"]') as HTMLButtonElement).click())

  expect(h.container.querySelector('[aria-label=\"Check output\"]')).toBeNull()
  const errors = h.container.querySelector('section[aria-label="Errors"]')
  expect(errors?.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('Check runner failed.')
  expect(errors?.querySelectorAll('.ui-inline-error')).toHaveLength(1)
  expect(h.container.querySelector('section[aria-label="Iteration output tail"] .ui-empty-state')?.textContent)
    .toContain('No output recorded.')
})

test('keeps queue identities and exposes no mutation controls for the in-flight item', async () => {
  const items = [queueItem('q1', 0, 'in-flight', 'Running task'), queueItem('q2', 1, 'pending', 'Next task'), queueItem('q3', 2, 'done', 'Finished task')]
  const h = harness(loop({ preset: 'queue', config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } }, queueItems: items }))
  unmountCurrent = h.unmount
  await h.mount()

  const running = h.container.querySelector('[data-queue-id="q1"]') as HTMLElement
  const finished = h.container.querySelector('[data-queue-id="q3"]') as HTMLElement
  expect(running.textContent).toContain('In progress')
  expect(running.querySelectorAll('button')).toHaveLength(0)
  expect(finished.textContent).toContain('Done')
  expect(finished.querySelector('button')).not.toBeNull()
})

test('shows an empty state for read-only queues without mutation controls', async () => {
  const emptyQueue = loop({
    state: 'completed',
    endedAt: 5_000,
    preset: 'queue',
    config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
    queueItems: []
  })
  const h = harness(emptyQueue)
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelector('section[aria-label="Loop queue history"] .ui-empty-state')?.textContent)
    .toBe('No prompts queued.')
  expect(h.container.querySelector('section[aria-label="Loop queue history"] button')).toBeNull()
})

test('routes queue move through the public action command with its stable item identity', async () => {
  const initial = loop({
    preset: 'queue',
    config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
    queueItems: [queueItem('q1', 0, 'pending'), queueItem('q2', 1, 'pending')]
  })
  const h = harness(initial)
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Move down q1').click())

  expect(h.commandCalls).toEqual([{
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'queue-move', params: { id: 'q1', position: 1 } }
  }])
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/queue')).toEqual([{
    method: 'quirky.loops/queue',
    params: { loopId: 'loop-1', op: { kind: 'move', id: 'q1', position: 1 } }
  }])
  h.commandCalls.length = 0
  await act(async () => button(h.container, 'Remove q1').click())
  expect(h.commandCalls).toEqual([{
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'queue-remove', params: { id: 'q1' } }
  }])
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/queue').at(-1)).toEqual({
    method: 'quirky.loops/queue',
    params: { loopId: 'loop-1', op: { kind: 'remove', id: 'q1' } }
  })
})

test('a rejected queue bridge action displays the error and retains the add draft', async () => {
  const initial = loop({
    preset: 'queue',
    config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
    queueItems: []
  })
  const h = harness(initial, { failCommandAction: 'queue-add' })
  unmountCurrent = h.unmount
  await h.mount()
  const draft = h.container.querySelector<HTMLTextAreaElement>('[aria-label="Describe the next task"]')!
  await act(async () => setValue(draft, 'keep this queue draft'))
  await settle()
  await act(async () => button(h.container, 'Add prompt').click())
  await settle()

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('bridge refused')
  expect(h.handle!.read()).toMatchObject({ queueDraft: { addDraft: 'keep this queue draft' } })
  expect(h.calls.filter(({ method }) => method === 'quirky.loops/queue')).toEqual([])
  expect(h.commandCalls.at(-1)).toEqual({
    id: 'command:quirky.loops/action',
    args: { loopId: 'loop-1', action: 'queue-add', params: { body: 'keep this queue draft' } }
  })
})

test('queue add forms prevent native submission and route once for the button or Enter', async () => {
  for (const submitMode of ['button', 'enter'] as const) {
    const initial = loop({
      preset: 'queue',
      config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
      queueItems: []
    })
    const h = harness(initial)
    unmountCurrent = h.unmount
    await h.mount()
    expect(h.container.querySelector('section[aria-label="Loop queue"] .ui-empty-state')?.textContent)
      .toBe('No prompts queued.')
    const draft = h.container.querySelector<HTMLTextAreaElement>('[aria-label="Describe the next task"]')!
    await act(async () => setValue(draft, 'Queue task'))
    await settle()
    expect(h.commandCalls).toEqual([{
      id: 'command:quirky.loops/action',
      args: { loopId: 'loop-1', action: 'queue-draft', params: { body: 'Queue task' } }
    }])
    h.commandCalls.length = 0

    const form = draft.closest('form')!
    const submitEvent = submitMode === 'enter' ? new Event('submit', { bubbles: true, cancelable: true }) : null
    await act(async () => {
      if (submitEvent === null) button(h.container, 'Add prompt').click()
      else form.dispatchEvent(submitEvent)
    })
    await settle()

    if (submitEvent !== null) expect(submitEvent.defaultPrevented).toBe(true)
    expect(h.commandCalls).toEqual([{
      id: 'command:quirky.loops/action',
      args: { loopId: 'loop-1', action: 'queue-add', params: { body: 'Queue task' } }
    }])
    expect(h.calls.filter(({ method }) => method === 'quirky.loops/queue')).toEqual([{
      method: 'quirky.loops/queue',
      params: { loopId: 'loop-1', op: { kind: 'add', body: 'Queue task' } }
    }])
    expect(h.handle!.read()).toMatchObject({ queueDraft: { addDraft: '' } })

    await h.unmount()
    unmountCurrent = null
  }
})

test('queue edit forms prevent native submission and route once for the button or Enter', async () => {
  for (const submitMode of ['button', 'enter'] as const) {
    const initial = loop({
      preset: 'queue',
      config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } },
      queueItems: [queueItem('q1', 0, 'pending'), queueItem('q2', 1, 'pending')]
    })
    const h = harness(initial)
    unmountCurrent = h.unmount
    await h.mount()
    const row = h.container.querySelector<HTMLElement>('[data-queue-id="q2"]')!
    await act(async () => button(row, 'Edit q2').click())
    const draft = row.querySelector<HTMLTextAreaElement>('[aria-label="Prompt for queue item 2"]')!
    await act(async () => setValue(draft, 'Edited task'))
    await settle()
    expect(h.commandCalls).toEqual([
      { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'queue-edit-open', params: { id: 'q2' } } },
      { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'queue-edit-update', params: { body: 'Edited task' } } }
    ])
    h.commandCalls.length = 0

    const form = draft.closest('form')!
    const submitEvent = submitMode === 'enter' ? new Event('submit', { bubbles: true, cancelable: true }) : null
    await act(async () => {
      if (submitEvent === null) button(row, 'Save').click()
      else form.dispatchEvent(submitEvent)
    })
    await settle()

    if (submitEvent !== null) expect(submitEvent.defaultPrevented).toBe(true)
    expect(h.commandCalls).toEqual([{
      id: 'command:quirky.loops/action',
      args: { loopId: 'loop-1', action: 'queue-edit', params: { id: 'q2', body: 'Edited task' } }
    }])
    expect(h.calls.filter(({ method }) => method === 'quirky.loops/queue')).toEqual([{
      method: 'quirky.loops/queue',
      params: { loopId: 'loop-1', op: { kind: 'edit', id: 'q2', body: 'Edited task' } }
    }])
    expect(h.handle!.read()).toMatchObject({ queueDraft: { editingId: null, editingBody: '' } })

    h.commandCalls.length = 0
    const restoredRow = h.container.querySelector<HTMLElement>('[data-queue-id="q2"]')!
    await act(async () => button(restoredRow, 'Edit q2').click())
    await act(async () => button(restoredRow, 'Cancel').click())
    expect(h.commandCalls).toEqual([
      { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'queue-edit-open', params: { id: 'q2' } } },
      { id: 'command:quirky.loops/action', args: { loopId: 'loop-1', action: 'queue-edit-cancel', params: {} } }
    ])
    await h.unmount()
    unmountCurrent = null
  }
})

test('updates the visible configuration draft from typed inputs', async () => {
  const h = harness()
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Edit configuration').click())
  expect(button(h.container, 'Save').disabled).toBe(true)
  const nameInput = h.container.querySelector('[aria-label="Loop name"]') as HTMLInputElement
  const promptInput = h.container.querySelector('[aria-label="Loop prompt"]') as HTMLTextAreaElement
  const iterationsInput = h.container.querySelector('[aria-label="Maximum iterations"]') as HTMLInputElement
  await act(async () => setValue(nameInput, 'Renamed loop'))
  await act(async () => setValue(promptInput, 'Keep the public API stable.'))
  await act(async () => setValue(iterationsInput, '12'))

  expect(h.handle!.read()).toMatchObject({
    activeForm: 'edit',
    editDraft: { name: 'Renamed loop', prompt: 'Keep the public API stable.', maxIterations: '12' }
  })
  expect(nameInput.value).toBe('Renamed loop')
  expect(promptInput.value).toBe('Keep the public API stable.')
  expect(iterationsInput.value).toBe('12')
  expect(button(h.container, 'Save').disabled).toBe(false)
})
test('edits pacing independently of the immutable creation preset', async () => {
  const h = harness(loop({ preset: 'until-done', config }))
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => { await h.handle!.dispatch('edit-open') })
  await act(async () => {
    await h.handle!.dispatch('edit-update', {
      patch: { pacingKind: 'interval', intervalMinutes: '30', anchor: 'from-end' }
    })
  })

  expect(h.handle!.read()).toMatchObject({
    activeForm: 'edit',
    editDraft: { pacingKind: 'interval', intervalMinutes: '30', anchor: 'from-end' }
  })
  expect((h.container.querySelector('[aria-label="Pacing"]') as HTMLSelectElement).value).toBe('interval')
  expect((h.container.querySelector('[aria-label="Run every (minutes)"]') as HTMLInputElement).value).toBe('30')
  const anchor = h.container.querySelector('[aria-label="Counted from"]') as HTMLSelectElement
  expect(anchor.value).toBe('from-end')
  await act(async () => setSelectValue(anchor, 'wall-clock'))
  expect(h.handle!.read()).toMatchObject({ editDraft: { pacingKind: 'interval', anchor: 'wall-clock' } })
  expect(anchor.value).toBe('wall-clock')
})
test('accepts a check timeout after adding the command to the edit draft', async () => {
  const h = harness()
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => { await h.handle!.dispatch('edit-open') })
  await act(async () => {
    await h.handle!.dispatch('edit-update', { patch: { advanced: true, checkCommand: 'bun test' } })
  })
  expect(h.handle!.read()).toMatchObject({ editDraft: { checkCommand: 'bun test' } })
  expect((h.container.querySelector('[aria-label="Done check command"]') as HTMLInputElement).value).toBe('bun test')
  const timeoutInput = h.container.querySelector('[aria-label="Check timeout (seconds)"]') as HTMLInputElement
  await act(async () => setValue(timeoutInput, '600'))

  expect(h.handle!.read()).toMatchObject({
    activeForm: 'edit',
    editDraft: { checkCommand: 'bun test', checkTimeout: '600' }
  })
  expect(timeoutInput.value).toBe('600')
})

test('refreshes a queue conflict without discarding its local edit draft', async () => {
  const items = [queueItem('q1', 0, 'pending', 'First task'), queueItem('q2', 1, 'pending', 'Next task')]
  const initial = loop({ preset: 'queue', config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } }, queueItems: items })
  const h = harness(initial, { failQueue: new Error('queue item is already in progress'), queueConflictItem: 'q2' })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => (h.container.querySelector('[data-queue-id=\"q2\"] button[aria-label=\"Edit q2\"]') as HTMLButtonElement).click())
  await act(async () => setValue(h.container.querySelector('[aria-label=\"Prompt for queue item 2\"]') as HTMLTextAreaElement, 'Keep this local draft'))
  await act(async () => (h.container.querySelector('[data-queue-id=\"q2\"] button[type=\"submit\"]') as HTMLButtonElement).click())
  await settle()

  expect(h.container.querySelector('.ui-inline-error[role="alert"]')?.textContent)
    .toBe('queue item is already in progress')
  expect(h.container.querySelector('[data-queue-id=\"q2\"]')?.textContent).toContain('In progress')
  expect(h.container.querySelector('[data-queue-id=\"q2\"] textarea')).toBeNull()
  expect(h.handle!.read()).toMatchObject({
    activeForm: null,
    queueDraft: { editingId: 'q2', editingBody: 'Keep this local draft' }
  })

  const restored = loop({ preset: 'queue', config: { ...config, promptSource: { kind: 'queue', repeatQueue: false } }, queueItems: items })
  h.setLoop(restored)
  await h.emit({ type: 'quirky.loops/changed', data: restored })
  expect((h.container.querySelector('[data-queue-id=\"q2\"] textarea') as HTMLTextAreaElement).value).toBe('Keep this local draft')
})

test('rebinds output to a fresh session and rehydrates after reconnect', async () => {
  const h = harness()
  unmountCurrent = h.unmount
  await h.mount()
  const fresh = loop({ sessionId: 'session-2', phase: 'relaunching' })
  h.setLoop(fresh)
  h.setMessages([{ sessionId: 'session-2', seq: 1, role: 'assistant', text: 'Fresh session output.', at: 3_000 }])
  await h.emit({ type: 'quirky.loops/changed', data: fresh })

  expect(h.container.textContent).toContain('Fresh session output.')
  expect(h.container.textContent).not.toContain('Working through the task.')

  h.setLoop({ ...fresh, state: 'paused', pauseReason: 'user' })
  await h.reconnect('reconnecting')
  expect(h.handle!.read().connectionStatus).toBe('reconnecting')
  expect(h.container.textContent).toContain('Reconnecting')
  expect(h.container.querySelector('[aria-label=\"Loop lifecycle controls\"]')).toBeNull()
  await h.reconnect('connected')
  expect(h.handle!.read().connectionStatus).toBe('connected')
  expect(h.container.textContent).toContain('Paused')
  expect(h.container.textContent).toContain('Paused by you')
})

