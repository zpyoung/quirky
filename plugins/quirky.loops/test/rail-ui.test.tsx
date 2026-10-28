import { registerUiDom, unregisterUiDom } from './ui-dom'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root, createRoot as createRootFactory } from 'react-dom/client'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { IterationDetail, LoopConfig, LoopSnapshot, PauseReason, QueueItem } from '../src/types'
import type { SurfaceHandle } from '../window/contracts'
import { LoopView } from '../window/LoopView'
let createRoot: typeof createRootFactory

type Call = { method: string; params: Record<string, unknown> }
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

function harness(initial = loop(), options: { history?: IterationDetail[]; messages?: unknown[]; failGet?: Error; failSteer?: Error; failQueue?: Error; queueConflictItem?: string } = {}) {
  let current = initial
  let history = options.history ?? []
  let messages = options.messages ?? [{ sessionId: 'session-1', seq: 1, role: 'assistant', text: 'Working through the task.', at: 2_000 }]
  const calls: Call[] = []
  const eventListeners = new Set<Listener>()
  const connectionListeners = new Set<ConnectionListener>()
  let handle: SurfaceHandle | null = null
  let failSteer = options.failSteer
  let failQueue = options.failQueue

  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/get') {
        if (options.failGet) throw options.failGet
        return current
      }
      if (method === 'quirky.loops/iterations') return history
      if (method === 'quirky.structured/messages') return params.session === current.sessionId ? messages : []
      if (method === 'quirky.loops/pause') {
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
      if (method === 'quirky.loops/edit') return current
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
test('maps every durable pause reason to the documented rail text', async () => {
  const labels: [PauseReason, string][] = [
    ['user', 'Paused by you'],
    ['cap-iterations', 'Iteration cap reached'],
    ['cap-time', 'Time cap reached'],
    ['cap-cost', 'Cost cap reached'],
    ['no-progress', 'No progress in recent iterations'],
    ['protected-path', 'Touched a protected path'],
    ['agent-blocked', 'The agent is blocked'],
    ['agent-decide', 'The agent needs a decision'],
    ['crashed', 'The agent kept crashing'],
    ['usage-limit', 'Agent usage limit reached'],
    ['interrupted-by-restart', 'Interrupted by an app restart'],
    ['unverifiable', 'Lost contact with the agent host'],
    ['ask-before-next', 'Waiting for your go-ahead'],
    ['queue-exhausted', 'The queue is empty']
  ]
  const h = harness(loop({ state: 'paused', pauseReason: 'user' }))
  unmountCurrent = h.unmount
  await h.mount()
  for (const [reason, label] of labels) {
    const updated = loop({ state: 'paused', pauseReason: reason })
    h.setLoop(updated)
    await h.emit({ type: 'quirky.loops/changed', data: updated })
    expect(h.container.querySelector('.loop-status-strip')?.textContent).toBe(label)
  }
})
test('renders an empty journal without synthetic transcript messages', async () => {
  const h = harness(loop(), { messages: [] })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.querySelectorAll('.loop-output-message')).toHaveLength(0)
  expect(h.container.textContent).toContain('No messages recorded.')
  expect(h.container.textContent).not.toContain('Working through the task.')
})

test('marks an unreachable loop unverifiable and omits controls', async () => {
  const h = harness(loop(), { failGet: new Error('daemon disconnected') })
  unmountCurrent = h.unmount
  await h.mount()

  expect(h.container.textContent).toContain('Unverifiable')
  expect(h.container.textContent).toContain('daemon disconnected')
  expect(h.container.querySelector('button')).toBeNull()
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
})

test('rejects an invalid resume increment before making a lifecycle request', async () => {
  const h = harness(loop({ state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 10 }))
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => setValue(h.container.querySelector('[aria-label="Iterations to add"]') as HTMLInputElement, '0'))
  expect(button(h.container, 'Resume').disabled).toBe(true)
  expect(h.calls.some(({ method }) => method === 'quirky.loops/resume')).toBe(false)
})
test('keeps steer guidance and displays the backend failure without a success message', async () => {
  const h = harness(loop(), { failSteer: new Error('guidance was rejected') })
  unmountCurrent = h.unmount
  await h.mount()
  await act(async () => button(h.container, 'Steer').click())
  const note = h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement
  await act(async () => setValue(note, 'Keep the public API stable.'))
  await act(async () => button(h.container, 'Send').click())

  expect((h.container.querySelector('[aria-label="Guidance for the next iteration"]') as HTMLTextAreaElement).value).toBe('Keep the public API stable.')
  expect(h.container.textContent).toContain('guidance was rejected')
  expect(h.handle!.read()).toMatchObject({ activeForm: 'steer', errors: { action: 'guidance was rejected' } })
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

  expect(h.container.querySelectorAll('.loop-iteration-list li')).toHaveLength(53)
  expect(h.container.textContent).toContain('Pass')
  expect(h.container.textContent).toContain('Fail')
  expect(h.container.textContent).toContain('No check')
  expect(h.container.querySelector('button[aria-label="Iteration 1"]')).not.toBeNull()
  const entry = [...h.container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('#52') && candidate.textContent.includes('Attempt 2'))
  expect(entry).toBeDefined()
  expect(h.container.textContent).toContain('Diff unavailable')
  await act(async () => entry!.click())

  expect(h.handle!.read().selectedDetail).toEqual(retained)
  expect([...h.container.querySelectorAll('.loop-detail-facts dd')].map((item) => item.textContent)).toContain('Unavailable')
  expect(h.container.textContent).toContain('The attempt output.')
  expect(h.container.textContent).not.toContain('$0.00')
  await act(async () => button(h.container, 'Back').click())
  expect(h.handle!.read().selectedDetail).toBeNull()
})
test('omits empty check output while retaining the actual check error', async () => {
  const detail = iteration({
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
  expect(h.container.querySelector('[aria-label=\"Errors\"]')?.textContent).toContain('Check runner failed.')
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

  expect(h.container.textContent).toContain('queue item is already in progress')
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

