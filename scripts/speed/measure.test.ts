import { afterEach, expect, test } from 'bun:test'
import {
  installBrowserObserver,
  waitForBrowserObserver,
  waitForDiagnosticStatusProbe,
  waitForFloodProgressAfterSnapshot,
  diagnosticFinding
} from './measure.ts'

type EventHandler = (event: { target: FakeElement; key?: string }) => void

class FakeElement {
  textContent = ''
  hidden = false
  disabled = false
  tabIndex = 0
  visible = true
  parent: FakeElement | null = null
  attributes = new Map<string, string>()
  children = new Map<string, FakeElement>()
  constructor(readonly selector: string) {}
  getClientRects(): unknown[] { return this.visible && !this.hidden ? [{}] : [] }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  querySelector(selector: string): FakeElement | null { return this.children.get(selector) ?? null }
  querySelectorAll(selector: string): FakeElement[] {
    const child = this.children.get(selector)
    return child ? [child] : []
  }
  matches(selector: string): boolean { return this.selector === selector || this.attributes.get('matches') === selector }
  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this
    const splitAt = selector.lastIndexOf(' ')
    if (splitAt > 0 && this.matches(selector.slice(splitAt + 1)) && this.parent?.closest(selector.slice(0, splitAt))) return this
    return this.parent?.closest(selector) ?? null
  }
}

class FakeDocument {
  readonly documentElement = new FakeElement('documentElement')
  readonly elements = new Map<string, FakeElement>()
  readonly listeners = new Map<string, EventHandler[]>()
  querySelector(selector: string): FakeElement | null { return this.elements.get(selector) ?? null }
  addEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }
  removeEventListener(type: string, handler: EventHandler): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== handler))
  }
  dispatch(type: string, target: FakeElement, key?: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ target, ...(key === undefined ? {} : { key }) })
  }
}

let document: FakeDocument
let clock: { now: number; frames: Array<(time: number) => void>; mutations: Array<() => void> }
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

function replaceGlobal(name: string, value: unknown): void {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

function environment(): void {
  document = new FakeDocument()
  clock = { now: 10, frames: [], mutations: [] }
  replaceGlobal('document', document)
  replaceGlobal('performance', { now: () => clock.now })
  replaceGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    clock.frames.push(callback)
    return clock.frames.length
  })
  replaceGlobal('cancelAnimationFrame', () => undefined)
  replaceGlobal('MutationObserver', class {
    constructor(private readonly callback: () => void) {}
    observe(): void { clock.mutations.push(this.callback) }
    disconnect(): void { clock.mutations = clock.mutations.filter((callback) => callback !== this.callback) }
  })
}

afterEach(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  savedGlobals.clear()
})

function mutate(): void { for (const observer of [...clock.mutations]) observer() }
function paint(): void {
  clock.now += 16
  const frames = clock.frames.splice(0)
  for (const frame of frames) frame(clock.now)
}
function pane(sessionId: string, rowsText = ''): { pane: FakeElement; rows: FakeElement; input: FakeElement } {
  const pane = new FakeElement(`.qt-pane[data-session="${sessionId}"]`)
  const rows = new FakeElement('.xterm-rows')
  rows.textContent = rowsText
  const input = new FakeElement('textarea.xterm-helper-textarea')
  rows.parent = pane
  input.parent = pane
  pane.children.set('.xterm-rows', rows)
  pane.children.set('textarea.xterm-helper-textarea', input)
  document.elements.set(`.qt-pane[data-session="${sessionId}"]`, pane)
  return { pane, rows, input }
}

function fakePage() {
  return {
    evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => await fn(argument)
  } as never
}

test('echo waits for its fresh worker/session/sequence/key acknowledgement, not stale replay', async () => {
  environment()
  const { rows, input } = pane('session-a', 'SPEED_ECHO worker-a session-a 4 a')
  const id = 'echo-1'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  let settled = false
  const result = waitForBrowserObserver(fakePage(), id, 50).then((value) => { settled = true; return value })
  document.dispatch('keydown', input, 'b')
  mutate()
  paint()
  await Promise.resolve()
  expect(settled).toBe(false)
  rows.textContent += ' SPEED_ECHO worker-a session-a 5 b'
  mutate()
  paint()
  expect(await result).toMatchObject({ startedAt: 10, endedAt: 42, durationMs: 32 })
})

test('switch does not complete on premature sidebar selection while the old terminal remains', async () => {
  environment()
  const button = new FakeElement('.worktree-row__main')
  button.setAttribute('matches', '[data-worktree-id="worktree-b"] .worktree-row__main')
  button.setAttribute('aria-pressed', 'true')
  document.elements.set('[data-worktree-id="worktree-b"] .worktree-row__main', button)
  const { pane: oldPane } = pane('session-old')
  const id = 'switch-1'
  installBrowserObserver({ id, kind: 'switch', targetId: 'worktree-b', sessionId: 'session-b' })
  let settled = false
  const result = waitForBrowserObserver(fakePage(), id, 50).then((value) => { settled = true; return value })
  document.dispatch('click', button)
  mutate()
  paint()
  await Promise.resolve()
  expect(settled).toBe(false)
  document.elements.delete('.qt-pane[data-session="session-old"]')
  pane('session-b')
  mutate()
  paint()
  expect(await result).toMatchObject({ durationMs: 32 })
  expect(oldPane.getClientRects()).toHaveLength(1)
})

test('diff waits for visible CodeMirror content containing the fixture line', async () => {
  environment()
  const row = new FakeElement('li.git-row')
  row.setAttribute('matches', 'li.git-row[data-row-path="speed-diff.txt"]')
  document.elements.set('li.git-row[data-row-path="speed-diff.txt"]', row)
  const card = new FakeElement('.git-review__card')
  const body = new FakeElement('[data-review-body]')
  const editor = new FakeElement('[data-diff-editor] .cm-content')
  card.children.set('[data-review-body]', body)
  card.children.set('[data-diff-editor] .cm-content', editor)
  document.elements.set('.git-review__card[data-path="speed-diff.txt"]', card)
  const id = 'diff-1'
  installBrowserObserver({ id, kind: 'diff', diffPath: 'speed-diff.txt', firstLine: 'SPEED FIXTURE LINE 0001' })
  let settled = false
  const result = waitForBrowserObserver(fakePage(), id, 50).then((value) => { settled = true; return value })
  document.dispatch('click', row)
  mutate()
  paint()
  await Promise.resolve()
  expect(settled).toBe(false)
  editor.textContent = 'SPEED FIXTURE LINE 0001'
  mutate()
  paint()
  expect(await result).toMatchObject({ durationMs: 32 })
})

test('flood progress requires a newer rendered counter from the expected visible worker', async () => {
  environment()
  const { rows } = pane('flood-session', 'SPEED_FLOOD other-worker flood-session 90 65536')
  const id = 'flood-1'
  installBrowserObserver({ id, kind: 'flood', workerId: 'flood-worker', sessionId: 'flood-session', afterCounter: 8, offeredBytes: 65536 })
  let settled = false
  const result = waitForBrowserObserver(fakePage(), id, 50).then((value) => { settled = true; return value })
  mutate()
  paint()
  await Promise.resolve()
  expect(settled).toBe(false)
  rows.textContent = 'SPEED_FLOOD flood-worker flood-session 8 65536'
  mutate()
  paint()
  await Promise.resolve()
  expect(settled).toBe(false)
  rows.textContent += ' SPEED_FLOOD flood-worker flood-session 9 65536'
  mutate()
  paint()
  expect(await result).toMatchObject({ counter: 9, durationMs: 48 })
})

test('observer deadline rejects and removes observers when no rendered acknowledgement arrives', async () => {
  environment()
  const { input } = pane('session-timeout')
  const id = 'timeout-1'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker', sessionId: 'session-timeout', sequence: 1, key: 'z' })
  const result = waitForBrowserObserver(fakePage(), id, 5)
  document.dispatch('keydown', input, 'z')
  await expect(result).rejects.toThrow('timed out after 5ms')
  expect((globalThis as unknown as { __quirkySpeedObservers?: Map<string, unknown> }).__quirkySpeedObservers?.has(id)).toBe(false)
})

test('bounds hung observer teardown on timeout and abort, closing the owned renderer context', async () => {
  for (const mode of ['timeout', 'abort'] as const) {
    let evaluations = 0
    let closed = 0
    const pending = new Promise<never>(() => undefined)
    const page = { evaluate: () => { evaluations++; return pending } } as never
    const controller = new AbortController()
    const result = waitForBrowserObserver(
      page,
      `hung-${mode}`,
      mode === 'timeout' ? 5 : 100,
      mode === 'abort' ? controller.signal : undefined,
      async () => { closed++ },
      5
    )
    if (mode === 'abort') controller.abort(new Error('run interrupted'))
    await expect(result).rejects.toThrow('teardown timed out')
    expect(evaluations).toBe(2)
    expect(closed).toBe(1)
  }
})
test('flood echo fails when the visible renderer stops after the final echo snapshot', async () => {
  environment()
  pane('flood-session', 'SPEED_FLOOD flood-worker flood-session 12 65536')
  const worktree = {
    id: 'worktree-a',
    path: '/repo-a',
    tabId: 'tab-a',
    sessions: ['echo-session', 'flood-session'] as [string, string],
    panes: ['pane-a', 'pane-b'] as [string, string],
    workerIds: ['echo-worker', 'flood-worker'] as [string, string]
  }
  const flood = {
    runId: 'flood-run',
    workerId: 'flood-worker',
    sessionId: 'flood-session',
    offeredBytesPerChunk: 65_536,
    intervalMs: 16,
    offeredBytesPerSecond: 4_096_000,
    startedAt: 1
  } as const
  await expect(waitForFloodProgressAfterSnapshot(fakePage(), worktree, flood, new AbortController().signal, undefined, 5))
    .rejects.toThrow('timed out after 5ms')
})

test('flood liveness waits through a blank viewport then requires another fresh counter', async () => {
  environment()
  const { rows } = pane('flood-session')
  const worktree = {
    id: 'worktree-a', path: '/repo-a', tabId: 'tab-a',
    sessions: ['echo-session', 'flood-session'] as [string, string],
    panes: ['pane-a', 'pane-b'] as [string, string],
    workerIds: ['echo-worker', 'flood-worker'] as [string, string]
  }
  const flood = {
    runId: 'flood-run', workerId: 'flood-worker', sessionId: 'flood-session',
    offeredBytesPerChunk: 65_536, intervalMs: 16, offeredBytesPerSecond: 4_096_000, startedAt: 1
  } as const
  let installed = 0
  const page = {
    async evaluate(fn: (argument: unknown) => unknown, argument: unknown) {
      const value = fn(argument)
      if (fn === installBrowserObserver) {
        const counter = 12 + installed++
        queueMicrotask(() => {
          rows.textContent = `SPEED_FLOOD flood-worker flood-session ${counter} 65536`
          mutate()
          paint()
        })
      }
      return await value
    }
  } as never
  await expect(waitForFloodProgressAfterSnapshot(page, worktree, flood, new AbortController().signal, undefined, 1000))
    .resolves.toEqual({ beforeCounter: 12, afterCounter: 13 })
})

test('diagnostic status evidence requires a successful status.get callback', async () => {
  const state = { successful: false, ptyHostPid: null as number | null }
  const probe = { daemonExited: () => false, probes: [{ at: 0, ms: 1, ownLagMs: 0, timedOut: false }] } as never
  await expect(waitForDiagnosticStatusProbe(probe, state, new AbortController().signal, 5))
    .rejects.toThrow('successful status.get')

  const recovered = { successful: false, ptyHostPid: null as number | null }
  const connected = waitForDiagnosticStatusProbe(probe, recovered, new AbortController().signal, 50)
  queueMicrotask(() => {
    recovered.successful = true
    recovered.ptyHostPid = 987
  })
  await expect(connected).resolves.toBe(987)
})

test('startup findings use spawn-to-paint duration and include every phase and probe statistic', () => {
  const finding = diagnosticFinding('startup', 7, {
    daemonHealthAndControlMs: 900,
    rendererNavigationAndAttachMs: 2450,
    readinessInputToPaintMs: 7,
    controllerUntilFreshPaintMs: 3400
  }, [
    { at: 0, ms: 4, ownLagMs: 2, timedOut: false },
    { at: 1, ms: 12, ownLagMs: 1, timedOut: false },
    { at: 2, ms: 6, ownLagMs: 4, timedOut: false }
  ])
  expect(finding).toContain('startup durationMs=3400 ms')
  expect(finding).not.toContain('startup durationMs=7 ms')
  expect(finding).toContain('daemonHealthAndControlMs=900 ms')
  expect(finding).toContain('rendererNavigationAndAttachMs=2450 ms')
  expect(finding).toContain('readinessInputToPaintMs=7 ms')
  expect(finding).toContain('controllerUntilFreshPaintMs=3400 ms')
  expect(finding).toContain('status.get probe count=3')
  expect(finding).toContain('maxLatencyMs=12 ms')
  expect(finding).toContain('maxOwnLagMs=4 ms')
  expect(finding).toContain('do not establish a root cause')
})

test('findings distinguish timed phases from flood counters and do not fabricate missing probe values', () => {
  const finding = diagnosticFinding('floodEcho', 83, { browserEventToPaintMs: 83, renderedEndCounter: 42 }, [])
  expect(finding).toContain('floodEcho durationMs=83 ms')
  expect(finding).toContain('renderedEndCounter=42')
  expect(finding).not.toContain('renderedEndCounter=42 ms')
  expect(finding).toContain('status.get probe count=0')
  expect(finding).toContain('maxLatencyMs=unavailable')
  expect(finding).toContain('maxOwnLagMs=unavailable')
  expect(() => diagnosticFinding('startup', 7, {}, [])).toThrow('startup duration')
})
