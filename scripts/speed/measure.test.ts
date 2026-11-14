import { afterEach, expect, test } from 'bun:test'
import {
  captureObservedFrameTiming,
  installBrowserObserver,
  installSpeedSocketObserver,
  waitForBrowserObserver,
  waitForDiagnosticStatusProbe,
  waitForFloodProgressAfterSnapshot,
  diagnosticFinding,
  summarizeFrameIntervals,
  measureBrowserFrameIntervals,
  coordinateStartupAttempt,
  pairSides,
  floodBlocks,
  joinFloodSleepTiming,
  shouldRunDiagnostic
} from './measure.ts'
import { createTimerProbe } from './runner-latency.ts'
import { BUDGETS, METRICS } from './contracts.ts'

type EventHandler = (event: { target: FakeElement; key?: string }) => void

class FakeElement {
  private text = ''
  readError: Error | null = null
  hidden = false
  disabled = false
  tabIndex = 0
  visible = true
  parent: FakeElement | null = null
  attributes = new Map<string, string>()
  children = new Map<string, FakeElement>()
  constructor(readonly selector: string) {}
  get textContent(): string {
    if (this.readError) throw this.readError
    return this.text
  }
  set textContent(value: string) { this.text = value }
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

type FakePort = {
  peer: FakePort
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(data?: unknown): void
  close(): void
}

class ControlledMessagePort implements FakePort {
  peer!: FakePort
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(data?: unknown): void {
    const receiver = this.peer
    clock.tasks.push(() => receiver.onmessage?.({ data }))
  }
  close(): void {}
}

class ControlledMessageChannel {
  readonly port1 = new ControlledMessagePort()
  readonly port2 = new ControlledMessagePort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

let document: FakeDocument
let clock: {
  now: number
  frames: Array<{ id: number; callback: (time: number) => void }>
  cancelledFrames: Set<number>
  tasks: Array<() => void>
  mutations: Array<() => void>
  marks: Map<string, number>
  nextFrameId: number
}
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

function replaceGlobal(name: string, value: unknown): void {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

function environment(): void {
  document = new FakeDocument()
  clock = { now: 10, frames: [], cancelledFrames: new Set(), tasks: [], mutations: [], marks: new Map(), nextFrameId: 1 }
  replaceGlobal('document', document)
  replaceGlobal('performance', {
    timeOrigin: 100_000,
    now: () => clock.now,
    mark: (name: string, options?: { startTime?: number }) => clock.marks.set(name, options?.startTime ?? clock.now),
    clearMarks: (name: string) => { clock.marks.delete(name) }
  })
  replaceGlobal('requestAnimationFrame', function (this: unknown, callback: (time: number) => void) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    const id = clock.nextFrameId++
    clock.frames.push({ id, callback })
    return id
  })
  replaceGlobal('cancelAnimationFrame', function (this: unknown, id: number) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    clock.cancelledFrames.add(id)
    clock.frames = clock.frames.filter((frame) => frame.id !== id)
  })
  replaceGlobal('MessageChannel', ControlledMessageChannel)
  replaceGlobal('MutationObserver', class {
    constructor(private readonly callback: () => void) {}
    observe(): void { clock.mutations.push(this.callback) }
    disconnect(): void { clock.mutations = clock.mutations.filter((callback) => callback !== this.callback) }
  })
}

afterEach(() => {
  const observerState = Reflect.get(globalThis, '__quirkySpeedObservers')
  if (observerState instanceof Map) {
    for (const entry of observerState.values()) {
      if (entry && typeof entry === 'object' && 'dispose' in entry && typeof entry.dispose === 'function') {
        entry.dispose(new Error('test cleanup'))
      }
    }
    observerState.clear()
  }
  Reflect.deleteProperty(globalThis, '__quirkySpeedSocketHook')
  for (const socket of FakeWebSocket.instances) socket.close()
  FakeWebSocket.instances = []
  Reflect.deleteProperty(globalThis, '__quirkySpeedObservers')
  Reflect.deleteProperty(globalThis, '__quirkySpeedFrameHook')
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  savedGlobals.clear()
})

function observerIsPresent(id: string): boolean {
  const state = Reflect.get(globalThis, '__quirkySpeedObservers')
  return state instanceof Map && state.has(id)
}

function watchObserverSettlement(id: string): () => boolean {
  const state = Reflect.get(globalThis, '__quirkySpeedObservers')
  if (!(state instanceof Map)) throw new Error('observer state is missing')
  const entry = state.get(id)
  if (!entry || typeof entry !== 'object' || !('promise' in entry) || !(entry.promise instanceof Promise)) {
    throw new Error(`observer ${id} has no promise`)
  }
  let settled = false
  void entry.promise.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

function mutate(): void { for (const observer of [...clock.mutations]) observer() }
function runFrameCallbacks(timestamp?: number): void {
  clock.now += 16
  const frames = clock.frames.splice(0)
  for (const frame of frames) {
    if (!clock.cancelledFrames.has(frame.id)) frame.callback(timestamp ?? clock.now)
    clock.cancelledFrames.delete(frame.id)
  }
}
function runPostFrameTask(): void { clock.tasks.shift()?.() }
function paint(): void {
  runFrameCallbacks()
  runPostFrameTask()
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

type SocketEvent = { data: unknown }
type SocketHandler = (event: SocketEvent) => void
type SocketListener = { handler: SocketHandler; capture: boolean }
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly listeners = new Map<string, SocketListener[]>()
  readonly sent: unknown[] = []
  readyState = 1
  binaryType = 'arraybuffer'
  onmessage: SocketHandler | null = null
  constructor(readonly url: string, readonly protocols?: string | string[]) { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, handler: SocketHandler, options?: boolean | { capture?: boolean }): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push({ handler, capture: options === true || (typeof options === 'object' && options.capture === true) })
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, handler: SocketHandler, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === 'object' && options.capture === true)
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate.handler !== handler || candidate.capture !== capture))
  }
  send(data: unknown): void { this.sent.push(data) }
  emit(type: string, data?: unknown): void {
    const event = { data }
    const listeners = [...(this.listeners.get(type) ?? [])].sort((left, right) => Number(right.capture) - Number(left.capture))
    for (const { handler } of listeners) handler(event)
    if (type === 'message') this.onmessage?.(event)
  }
  close(): void { this.readyState = 3; this.emit('close') }
}

function newObservedSocket(url: string): FakeWebSocket {
  const WebSocketConstructor = Reflect.get(globalThis, 'WebSocket') as typeof FakeWebSocket
  return new WebSocketConstructor(url)
}

function observedSocket(): FakeWebSocket {
  for (const socket of FakeWebSocket.instances) socket.close()
  FakeWebSocket.instances = []
  Reflect.deleteProperty(globalThis, '__quirkySpeedSocketHook')
  replaceGlobal('WebSocket', FakeWebSocket)
  installSpeedSocketObserver()
  return newObservedSocket('wss://fixture.invalid/socket')
}

function bindStream(socket: FakeWebSocket, sessionId: string, streamId: number, requestId = `attach-${sessionId}`): void {
  socket.send(JSON.stringify({
    jsonrpc: '2.0', id: requestId, method: 'quirky.terminal/attach', params: { session: sessionId }
  }))
  socket.emit('message', JSON.stringify({
    jsonrpc: '2.0', id: requestId, result: { streamId }
  }))
}

function terminalFrame(streamId: number, payload: string, kind = 1): ArrayBuffer {
  const bytes = new TextEncoder().encode(payload)
  const frame = new Uint8Array(5 + bytes.length)
  frame[0] = kind
  new DataView(frame.buffer).setUint32(1, streamId, false)
  frame.set(bytes, 5)
  return frame.buffer
}

function renderTerminal(socket: FakeWebSocket, rows: FakeElement, streamId: number): void {
  socket.addEventListener('message', ({ data }) => {
    if (!(data instanceof ArrayBuffer)) return
    const frame = new Uint8Array(data)
    if (frame.length < 5 || frame[0] !== 1 || new DataView(data).getUint32(1, false) !== streamId) return
    rows.textContent += new TextDecoder().decode(frame.subarray(5))
    mutate()
  })
}

function armSocketEcho(socket: FakeWebSocket, options: {
  id: string; workerId?: string; sessionId?: string; sequence?: number; key?: string; streamId: number; timeoutMs?: number
  signal?: AbortSignal
}) {
  const workerId = options.workerId ?? 'worker-a'
  const sessionId = options.sessionId ?? 'session-a'
  const sequence = options.sequence ?? 5
  const key = options.key ?? 'b'
  const { rows, input } = pane(sessionId)
  renderTerminal(socket, rows, options.streamId)
  installBrowserObserver({ id: options.id, kind: 'echo', workerId, sessionId, sequence, key })
  const settled = watchObserverSettlement(options.id)
  const result = waitForBrowserObserver(fakePage(), options.id, options.timeoutMs ?? 2000, options.signal)
  document.dispatch('keydown', input, key)
  return { rows, settled, result, workerId, sessionId, sequence, key }
}

function echoMarker(workerId: string, sessionId: string, sequence: number, key: string, readEpochMs?: string): string {
  return `SPEED_ECHO ${workerId} ${sessionId} ${sequence} ${key}${readEpochMs === undefined ? '' : ` readEpochMs=${readEpochMs}`}\r\n`
}

async function paintEcho(): Promise<void> {
  clock.now = 14
  runFrameCallbacks()
  await Promise.resolve()
  runPostFrameTask()
  await Promise.resolve()
}

test('discards duplicate timestamps and captures sixty positive native intervals with one scheduler', async () => {
  environment()
  const probe = {
    id: '',
    style: {} as Record<string, string>,
    removed: false,
    setAttribute(): void {},
    remove(): void { this.removed = true }
  }
  replaceGlobal('document', {
    createElement: () => probe,
    documentElement: { append(): void {} }
  })
  const timestamps = [0, 0, ...Array.from({ length: 60 }, (_, index) => (index + 1) * 16)]
  let schedulerCalls = 0
  replaceGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
    callback(timestamps[schedulerCalls++]!)
    return schedulerCalls
  })
  const page = { evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => await fn(argument) } as never

  const capture = await measureBrowserFrameIntervals(page, new AbortController().signal)

  expect(capture).toEqual({
    intervalsMs: Array<number>(60).fill(16),
    duplicateTimestamps: 1,
    invalidTimestamps: 0
  })
  expect(schedulerCalls).toBe(62)
  expect(summarizeFrameIntervals(capture.intervalsMs)).toEqual({
    frames: 60, medianIntervalMs: 16, p90IntervalMs: 16, maxIntervalMs: 16
  })
  expect(probe.removed).toBe(true)
})

test('bounds a frozen native pacing probe at 120 callbacks and reports unavailable capture counters', async () => {
  environment()
  const probe = {
    id: '',
    style: {} as Record<string, string>,
    removed: false,
    setAttribute(): void {},
    remove(): void { this.removed = true }
  }
  replaceGlobal('document', {
    createElement: () => probe,
    documentElement: { append(): void {} }
  })
  let schedulerCalls = 0
  replaceGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
    schedulerCalls++
    callback(1)
    return schedulerCalls
  })
  const page = { evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => await fn(argument) } as never

  const capture = await measureBrowserFrameIntervals(page, new AbortController().signal)

  expect(capture).toEqual({ intervalsMs: [], duplicateTimestamps: 119, invalidTimestamps: 0 })
  expect(schedulerCalls).toBe(120)
  expect(() => summarizeFrameIntervals(capture.intervalsMs)).toThrow('frame pacing needs positive finite intervals')
  expect(probe.removed).toBe(true)
})

test('counts negative and non-finite native timestamp intervals without admitting them', async () => {
  environment()
  const probe = {
    id: '',
    style: {} as Record<string, string>,
    removed: false,
    setAttribute(): void {},
    remove(): void { this.removed = true }
  }
  replaceGlobal('document', {
    createElement: () => probe,
    documentElement: { append(): void {} }
  })
  const timestamps = [5, Number.NaN, 2, ...Array.from({ length: 60 }, (_, index) => 10 + index * 16)]
  let schedulerCalls = 0
  replaceGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
    callback(timestamps[schedulerCalls++]!)
    return schedulerCalls
  })
  const page = { evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => await fn(argument) } as never

  const capture = await measureBrowserFrameIntervals(page, new AbortController().signal)

  expect(capture.intervalsMs).toHaveLength(60)
  expect(capture.intervalsMs.every((interval) => interval > 0 && Number.isFinite(interval))).toBe(true)
  expect(capture.duplicateTimestamps).toBe(0)
  expect(capture.invalidTimestamps).toBe(2)
  expect(probe.removed).toBe(true)
})

test('uses a supplied fixed timestamp while scheduling every frame', async () => {
  environment()
  const probe = {
    id: '',
    style: {} as Record<string, string>,
    removed: false,
    setAttribute(): void {},
    remove(): void { this.removed = true }
  }
  replaceGlobal('document', {
    createElement: () => probe,
    documentElement: { append(): void {} }
  })
  let schedulerCalls = 0
  replaceGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
    schedulerCalls++
    callback(schedulerCalls * 16)
    return schedulerCalls
  })
  const page = { evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => await fn(argument) } as never

  const capture = await measureBrowserFrameIntervals(page, new AbortController().signal, 1)

  expect(capture).toEqual({ intervalsMs: [], duplicateTimestamps: 119, invalidTimestamps: 0 })
  expect(schedulerCalls).toBe(120)
  expect(probe.removed).toBe(true)
})
test('observes app-rAF readiness only across a wrapped request and retains unique action/candidate/paint marks', async () => {
  environment()
  const { rows, input } = pane('session-app-frame')
  const id = 'echo-app-frame'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-app-frame', sequence: 1, key: 'a' })
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'a')
  globalThis.requestAnimationFrame(() => {
    rows.textContent = 'SPEED_ECHO worker-a session-app-frame 1 a'
    mutate()
  })

  runFrameCallbacks()
  runPostFrameTask()
  const observation = await result

  expect(observation.marks.candidate?.kind).toBe('application-raf')
  expect(observation.marks.candidate?.requested).not.toBe(observation.marks.candidate?.delivered)
  expect(clock.marks.get(observation.marks.action)).toBe(10)
  expect(clock.marks.get(observation.marks.candidate!.requested)).toBe(10)
  expect(clock.marks.get(observation.marks.candidate!.delivered)).toBe(26)
  expect(clock.marks.get(observation.marks.end)).toBe(26)
})

test('uses the first stable ready DOM observation through the next native frame when readiness is task-created', async () => {
  environment()
  const { rows, input } = pane('session-ready-dom')
  const id = 'echo-ready-dom'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-ready-dom', sequence: 2, key: 'b' })
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  clock.now = 20
  rows.textContent = 'SPEED_ECHO worker-a session-ready-dom 2 b'
  mutate()
  expect(observerIsPresent(id)).toBe(true)

  runFrameCallbacks()
  runPostFrameTask()
  const observation = await result

  expect(observation.marks.candidate?.kind).toBe('ready-to-frame')
  expect(clock.marks.get(observation.marks.candidate!.requested)).toBe(20)
  expect(clock.marks.get(observation.marks.candidate!.delivered)).toBe(36)
  expect(clock.marks.get(observation.marks.end)).toBe(36)
})
test('clears a stale app-rAF candidate when readiness is invalidated before the paint task', async () => {
  environment()
  const { rows, input } = pane('session-invalidated-frame')
  const id = 'echo-invalidated-frame'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-invalidated-frame', sequence: 3, key: 'c' })
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'c')
  globalThis.requestAnimationFrame(() => {
    rows.textContent = 'SPEED_ECHO worker-a session-invalidated-frame 3 c'
    mutate()
  })
  globalThis.requestAnimationFrame(() => {
    rows.textContent = ''
    mutate()
  })

  runFrameCallbacks()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerIsPresent(id)).toBe(true)

  clock.now = 30
  rows.textContent = 'SPEED_ECHO worker-a session-invalidated-frame 3 c'
  mutate()
  runFrameCallbacks()
  runPostFrameTask()
  const observation = await result

  expect(observation.marks.candidate?.kind).toBe('ready-to-frame')
  expect(clock.marks.get(observation.marks.candidate!.requested)).toBe(30)
})

test('trace setup and flush errors preserve a completed raw observation as unavailable frame timing', async () => {
  const raw = {
    observation: {
      id: 'raw-80', kind: 'echo' as const, startedAt: 10, endedAt: 90, durationMs: 80,
      marks: { action: 'action', end: 'end' },
      pacing: { intervalsMs: [16], duplicateTimestamps: 0, invalidTimestamps: 0 },
      trace: []
    }
  }
  let setupActionRuns = 0
  const setupFallback = await captureObservedFrameTiming({
    startTrace: async () => { throw new Error('trace setup unavailable') },
    observe: async () => { setupActionRuns++; return raw },
    signal: new AbortController().signal
  })
  expect(setupActionRuns).toBe(1)
  expect(setupFallback.frameTiming).toMatchObject({
    status: 'unavailable', wallMs: 80, effectiveMs: 80, deductionMs: 0, candidate: null
  })
  expect(setupFallback.frameTiming.reason).toContain('trace setup unavailable')

  const flushFallback = await captureObservedFrameTiming({
    startTrace: async () => ({ stop: async () => { throw new Error('trace flush unavailable') } }),
    observe: async () => raw,
    signal: new AbortController().signal
  })
  expect(flushFallback.frameTiming).toMatchObject({
    status: 'unavailable', wallMs: 80, effectiveMs: 80, deductionMs: 0, candidate: null
  })
  expect(flushFallback.frameTiming.reason).toContain('trace flush unavailable')
})

test('trace resource cleanup failures remain fatal after a completed raw observation', async () => {
  const cleanupFailure = Object.assign(new Error('trace detach failed'), { name: 'TraceCleanupError' })
  await expect(captureObservedFrameTiming({
    startTrace: async () => ({ stop: async () => { throw cleanupFailure } }),
    observe: async () => ({
      observation: {
        id: 'raw-80', kind: 'echo' as const, startedAt: 10, endedAt: 90, durationMs: 80,
        marks: { action: 'action', end: 'end' },
        pacing: { intervalsMs: [], duplicateTimestamps: 0, invalidTimestamps: 0 },
        trace: []
      }
    }),
    signal: new AbortController().signal
  })).rejects.toThrow('trace detach failed')
})

test('startup navigation begins at runtime publication and success waits for health and post-paint verification', async () => {
  let now = 100
  const runtimeGate = Promise.withResolvers<unknown>()
  const restartGate = Promise.withResolvers<unknown>()
  const navigationGate = Promise.withResolvers<{ value: unknown; paintedAt: number }>()
  const verificationGate = Promise.withResolvers<void>()
  const runtime = runtimeGate.promise
  const restart = restartGate.promise
  const navigation = navigationGate.promise
  const verification = verificationGate.promise
  const navigationStarted = Promise.withResolvers<void>()
  const verificationStarted = Promise.withResolvers<void>()
  let disposed = 0
  const watcher = {
    expectSpawn(spawn: { spawnedAt: number; pid: number }) { expect(spawn).toEqual({ spawnedAt: 100, pid: 42 }) },
    runtime,
    dispose() { disposed++ }
  }

  const resultPromise = coordinateStartupAttempt({
    signal: new AbortController().signal,
    watch: () => watcher,
    restart: (_signal, onSpawn) => {
      onSpawn({ spawnedAt: 100, pid: 42 })
      return restart
    },
    navigate: async () => {
      expect(now).toBe(200)
      navigationStarted.resolve()
      return navigation
    },
    verify: async () => {
      expect(now).toBe(600)
      verificationStarted.resolve()
      return verification
    },
    now: () => now
  })

  now = 200
  runtimeGate.resolve({ pid: 42, port: 1234, token: 'fixture' })
  await navigationStarted.promise
  now = 400
  navigationGate.resolve({ value: 'painted', paintedAt: 400 })
  now = 600
  restartGate.resolve('healthy')
  await verificationStarted.promise
  now = 900
  verificationGate.resolve()
  const result = await resultPromise

  expect(result).toMatchObject({
    spawnedAt: 100, runtimeAt: 200, paintedAt: 400, verifiedAt: 900,
    navigation: 'painted', restart: 'healthy'
  })
  expect(result.paintedAt - result.spawnedAt).toBe(300)
  expect(disposed).toBe(1)
})
test('startup failure after early paint rejects instead of publishing a fast sample and disposes the watcher', async () => {
  const runtimeGate = Promise.withResolvers<unknown>()
  const restartGate = Promise.withResolvers<unknown>()
  const verifyStarted = Promise.withResolvers<void>()
  let disposeCount = 0
  const watcher = {
    expectSpawn(): void {},
    runtime: runtimeGate.promise,
    dispose() { disposeCount++ }
  }
  const controller = new AbortController()
  const attempt = coordinateStartupAttempt({
    signal: controller.signal,
    watch: () => watcher,
    restart: (_signal, onSpawn) => { onSpawn({ spawnedAt: 100, pid: 42 }); return restartGate.promise },
    navigate: async () => ({ value: 'painted', paintedAt: 400 }),
    verify: async () => {
      verifyStarted.resolve()
      throw new Error('preserved session verification failed')
    },
    now: () => 900
  })
  runtimeGate.resolve({ pid: 42, port: 1234, token: 'fixture' })
  restartGate.resolve('healthy')
  await verifyStarted.promise

  await expect(attempt).rejects.toThrow('preserved session verification failed')
  expect(disposeCount).toBe(1)
})

test('replacement exit settles the pending renderer runtime waiter and disposes startup observation', async () => {
  const runtimeGate = Promise.withResolvers<unknown>()
  const restartGate = Promise.withResolvers<unknown>()
  let disposed = 0
  const watcher = {
    expectSpawn(): void {},
    runtime: runtimeGate.promise,
    dispose() { disposed++; runtimeGate.reject(new Error('runtime watch disposed')) }
  }
  const result = coordinateStartupAttempt({
    signal: new AbortController().signal,
    watch: () => watcher,
    restart: (_signal, onSpawn) => { onSpawn({ spawnedAt: 100, pid: 42 }); return restartGate.promise },
    navigate: async () => { throw new Error('navigation should not start before runtime') },
    verify: async () => { throw new Error('verification should not run after exit') },
    now: () => 100
  })
  restartGate.reject(new Error('replacement exited'))

  await expect(result).rejects.toThrow('replacement exited')
  expect(disposed).toBe(1)
})

test('echo waits for its fresh worker/session/sequence/key acknowledgement, not stale replay', async () => {
  environment()
  const { rows, input } = pane('session-a', 'SPEED_ECHO worker-a session-a 4 a')
  const id = 'echo-1'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  mutate()
  runFrameCallbacks()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  rows.textContent += ' SPEED_ECHO worker-a session-a 5 b'
  mutate()
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  const observation = await result
  expect(observation).toMatchObject({ startedAt: 10, endedAt: 42, durationMs: 32 })
  expect(observation.trace.map(({ event }) => event)).toEqual(['keydown', 'dom', 'paint'])
})

test('echo written in a frame callback stops after that frame and splits event-to-paint phases', async () => {
  environment()
  const { rows, input } = pane('session-a')
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const id = 'echo-same-frame'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  const wrappedRequestAnimationFrame = globalThis.requestAnimationFrame
  expect(wrappedRequestAnimationFrame).not.toBe(originalRequestAnimationFrame)
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  globalThis.requestAnimationFrame(() => {
    rows.textContent += ' SPEED_ECHO worker-a session-a 5 b'
    mutate()
  })
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  expect(clock.now).toBe(26)
  runPostFrameTask()
  const observation = await result
  expect(observation).toMatchObject({ startedAt: 10, endedAt: 26, durationMs: 16 })
  expect(observation.trace).toEqual([
    { event: 'keydown', at: 10 },
    { event: 'dom', at: 26 },
    { event: 'paint', at: 26 }
  ])
  const eventToDomMs = observation.trace[1]!.at - observation.trace[0]!.at
  const domToPaintMs = observation.trace[2]!.at - observation.trace[1]!.at
  expect(Number.isFinite(eventToDomMs)).toBe(true)
  expect(Number.isFinite(domToPaintMs)).toBe(true)
  expect(eventToDomMs).toBeGreaterThanOrEqual(0)
  expect(domToPaintMs).toBeGreaterThanOrEqual(0)
  expect(Math.abs(eventToDomMs + domToPaintMs - observation.durationMs)).toBeLessThanOrEqual(0.001)
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
})

test('an already queued renderer callback cannot cancel observation of its current frame', async () => {
  environment()
  const { rows, input } = pane('session-a')
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  originalRequestAnimationFrame.call(globalThis, () => {
    rows.textContent = 'SPEED_ECHO worker-a session-a 5 b'
    globalThis.requestAnimationFrame(() => undefined)
  })
  const id = 'echo-pending-renderer'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  runFrameCallbacks()
  runPostFrameTask()
  await expect(result).resolves.toMatchObject({ startedAt: 10, endedAt: 26, durationMs: 16 })
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
})

test('switch waits for the next frame and its post-frame task after ordinary-task readiness', async () => {
  environment()
  const button = new FakeElement('.worktree-row__main')
  button.setAttribute('matches', '[data-worktree-id="worktree-b"] .worktree-row__main')
  button.setAttribute('aria-pressed', 'true')
  document.elements.set('[data-worktree-id="worktree-b"] .worktree-row__main', button)
  const { pane: oldPane } = pane('session-old')
  const id = 'switch-ready-before-frame'
  installBrowserObserver({ id, kind: 'switch', targetId: 'worktree-b', sessionId: 'session-b' })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('click', button)
  document.elements.delete('.qt-pane[data-session="session-old"]')
  pane('session-b')
  mutate()
  expect(observerSettled()).toBe(false)
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  expect(clock.now).toBe(26)
  runPostFrameTask()
  expect(await result).toMatchObject({ startedAt: 10, endedAt: 26, durationMs: 16 })
  expect(oldPane.getClientRects()).toHaveLength(1)
})

test('switch does not complete on premature sidebar selection while the old terminal remains', async () => {
  environment()
  const button = new FakeElement('.worktree-row__main')
  button.setAttribute('matches', '[data-worktree-id="worktree-b"] .worktree-row__main')
  button.setAttribute('aria-pressed', 'true')
  document.elements.set('[data-worktree-id="worktree-b"] .worktree-row__main', button)
  pane('session-old')
  const id = 'switch-old-pane'
  installBrowserObserver({ id, kind: 'switch', targetId: 'worktree-b', sessionId: 'session-b' })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('click', button)
  paint()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  expect(document.querySelector('.qt-pane[data-session="session-old"]')).not.toBeNull()
  document.elements.delete('.qt-pane[data-session="session-old"]')
  pane('session-b')
  paint()
  expect(await result).toMatchObject({ startedAt: 10, endedAt: 42, durationMs: 32 })
})

test('consecutive frames with equal native timestamps still paint a fresh acknowledgement', async () => {
  environment()
  const { rows, input } = pane('session-a')
  const id = 'echo-repeated-timestamp'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  runFrameCallbacks(0)
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  globalThis.requestAnimationFrame(() => { rows.textContent = 'SPEED_ECHO worker-a session-a 5 b' })
  runFrameCallbacks(0)
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  await expect(result).resolves.toMatchObject({ startedAt: 10, endedAt: 42, durationMs: 32 })
})

test('an acknowledgement in an ordinary task cannot use the previous frame task', async () => {
  environment()
  const { rows, input } = pane('session-a')
  const id = 'echo-between-frames'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker-a', sessionId: 'session-a', sequence: 5, key: 'b' })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'b')
  runFrameCallbacks()
  rows.textContent = 'SPEED_ECHO worker-a session-a 5 b'
  mutate()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  expect(await result).toMatchObject({ startedAt: 10, endedAt: 42, durationMs: 32 })
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
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('click', row)
  mutate()
  runFrameCallbacks()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  editor.textContent = 'SPEED FIXTURE LINE 0001'
  mutate()
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  expect(await result).toMatchObject({ durationMs: 32 })
})

test('flood progress requires a newer rendered counter from the expected visible worker', async () => {
  environment()
  const { rows } = pane('flood-session', 'SPEED_FLOOD other-worker flood-session 90 65536')
  const id = 'flood-1'
  installBrowserObserver({ id, kind: 'flood', workerId: 'flood-worker', sessionId: 'flood-session', afterCounter: 8, offeredBytes: 65536 })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  runFrameCallbacks()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  rows.textContent = 'SPEED_FLOOD flood-worker flood-session 8 65536'
  mutate()
  runFrameCallbacks()
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  rows.textContent += ' SPEED_FLOOD flood-worker flood-session 9 65536'
  mutate()
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  expect(await result).toMatchObject({ counter: 9, durationMs: 48 })
})

test('flood checks the final DOM after every frame callback before accepting a counter', async () => {
  environment()
  const { rows } = pane('flood-session', 'SPEED_FLOOD flood-worker flood-session 8 65536')
  const id = 'flood-last-callback'
  installBrowserObserver({ id, kind: 'flood', workerId: 'flood-worker', sessionId: 'flood-session', afterCounter: 8, offeredBytes: 65536 })
  const observerSettled = watchObserverSettlement(id)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  globalThis.requestAnimationFrame(() => {
    rows.textContent = 'SPEED_FLOOD flood-worker flood-session 9 65536'
    mutate()
  })
  globalThis.requestAnimationFrame(() => {
    rows.textContent = ''
    mutate()
  })
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  globalThis.requestAnimationFrame(() => {
    rows.textContent = 'SPEED_FLOOD flood-worker flood-session 10 65536'
    mutate()
  })
  runFrameCallbacks()
  await Promise.resolve()
  expect(observerSettled()).toBe(false)
  runPostFrameTask()
  expect(await result).toMatchObject({ counter: 10, startedAt: 10, endedAt: 42, durationMs: 32 })
})

test('observers share one frame hook and restore requestAnimationFrame after the last result', async () => {
  environment()
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const { rows: echoRows, input } = pane('echo-session')
  const { rows: floodRows } = pane('flood-session', 'SPEED_FLOOD flood-worker flood-session 8 65536')
  installBrowserObserver({ id: 'shared-flood', kind: 'flood', workerId: 'flood-worker', sessionId: 'flood-session', afterCounter: 8, offeredBytes: 65536 })
  const sharedRequestAnimationFrame = globalThis.requestAnimationFrame
  expect(sharedRequestAnimationFrame).not.toBe(originalRequestAnimationFrame)
  const floodSettled = watchObserverSettlement('shared-flood')
  const floodResult = waitForBrowserObserver(fakePage(), 'shared-flood', 50)
  installBrowserObserver({ id: 'shared-echo', kind: 'echo', workerId: 'worker-a', sessionId: 'echo-session', sequence: 1, key: 'a' })
  expect(globalThis.requestAnimationFrame).toBe(sharedRequestAnimationFrame)
  const echoSettled = watchObserverSettlement('shared-echo')
  const echoResult = waitForBrowserObserver(fakePage(), 'shared-echo', 50)
  document.dispatch('keydown', input, 'a')
  globalThis.requestAnimationFrame(() => {
    echoRows.textContent = 'SPEED_ECHO worker-a echo-session 1 a'
    mutate()
  })
  runFrameCallbacks()
  await Promise.resolve()
  expect(echoSettled()).toBe(false)
  runPostFrameTask()
  expect(await echoResult).toMatchObject({ durationMs: 16 })
  expect(floodSettled()).toBe(false)
  expect(globalThis.requestAnimationFrame).toBe(sharedRequestAnimationFrame)
  globalThis.requestAnimationFrame(() => {
    floodRows.textContent += ' SPEED_FLOOD flood-worker flood-session 9 65536'
    mutate()
  })
  runFrameCallbacks()
  await Promise.resolve()
  expect(floodSettled()).toBe(false)
  runPostFrameTask()
  expect(await floodResult).toMatchObject({ counter: 9, durationMs: 32 })
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
})

test('observer deadline removes observers and restores requestAnimationFrame without an acknowledgement', async () => {
  environment()
  const { input } = pane('session-timeout')
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const id = 'timeout-1'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker', sessionId: 'session-timeout', sequence: 1, key: 'z' })
  expect(globalThis.requestAnimationFrame).not.toBe(originalRequestAnimationFrame)
  const result = waitForBrowserObserver(fakePage(), id, 5)
  document.dispatch('keydown', input, 'z')
  await expect(result).rejects.toThrow('timed out after 5ms')
  expect(observerIsPresent(id)).toBe(false)
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
})

test('condition errors in a frame reject the observer and restore requestAnimationFrame', async () => {
  environment()
  const { rows, input } = pane('session-error')
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const id = 'error-1'
  installBrowserObserver({ id, kind: 'echo', workerId: 'worker', sessionId: 'session-error', sequence: 1, key: 'z' })
  expect(globalThis.requestAnimationFrame).not.toBe(originalRequestAnimationFrame)
  const result = waitForBrowserObserver(fakePage(), id, 50)
  document.dispatch('keydown', input, 'z')
  globalThis.requestAnimationFrame(() => {
    document.elements.delete('.qt-pane[data-session="session-error"]')
    rows.readError = new Error('pane removed while reading rows')
    mutate()
  })
  runFrameCallbacks()
  await expect(result).rejects.toThrow('pane removed while reading rows')
  expect(observerIsPresent(id)).toBe(false)
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
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

test('summarizes actual frame intervals with median, p90, and maximum', () => {
  expect(summarizeFrameIntervals([16, 16, 16, 16, 16, 16, 17, 18, 20, 100])).toEqual({
    frames: 10,
    medianIntervalMs: 16,
    p90IntervalMs: 20,
    maxIntervalMs: 100
  })
})

test('rejects empty and non-positive or non-finite frame intervals', () => {
  for (const intervals of [[], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
    expect(() => summarizeFrameIntervals(intervals)).toThrow('frame pacing needs positive finite intervals')
  }
})

test('invalid pacing errors retain all sixty raw intervals', () => {
  const intervals = Array<number>(60).fill(16)
  intervals[17] = 0
  expect(() => summarizeFrameIntervals(intervals)).toThrow(JSON.stringify(intervals))
})

test('paired measurements alternate which side runs first', () => {
  expect([1, 2, 3, 4].map(pairSides)).toEqual([
    ['head', 'base'],
    ['base', 'head'],
    ['head', 'base'],
    ['base', 'head']
  ])
})

test('flood pairs run in four balanced head-base-base-head blocks', () => {
  expect(floodBlocks(60)).toEqual([
    { side: 'head', first: 1, count: 30 },
    { side: 'base', first: 1, count: 30 },
    { side: 'base', first: 31, count: 30 },
    { side: 'head', first: 31, count: 30 }
  ])
  expect(floodBlocks(20)).toEqual([
    { side: 'head', first: 1, count: 10 },
    { side: 'base', first: 1, count: 10 },
    { side: 'base', first: 11, count: 10 },
    { side: 'head', first: 11, count: 10 }
  ])
  expect(floodBlocks(1)).toEqual([
    { side: 'head', first: 1, count: 1 },
    { side: 'base', first: 1, count: 1 }
  ])
  expect(floodBlocks(0)).toEqual([])
})
test('socket arrival splits echo time at the matching binary frame before terminal rendering', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-split', streamId: 17 })

  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
  await paintEcho()

  const observation = await echo.result
  expect(observation).toMatchObject({
    startedAt: 10,
    endedAt: 30,
    durationMs: 20,
    echoTiming: {
      status: 'complete',
      reason: null,
      workerReadEpochMs: 100012,
      pageTimeOriginMs: 100000,
      receivedAt: 18,
      keystrokeToWorkerMs: 2,
      workerToPageMs: 6,
      pageToPaintMs: 12
    }
  })
  expect(observation.marks.echoReceived).toBeDefined()
  expect(clock.marks.get(observation.marks.echoReceived!)).toBe(18)
})

test('split terminal marker arrival is the third message, and zero-length phases remain complete', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-fragments', streamId: 17 })
  const marker = echoMarker('worker-a', 'session-a', 5, 'b', '100010')
  for (const [part, at] of [[marker.slice(0, 13), 11], [marker.slice(13, 34), 12], [marker.slice(34), 18]] as const) {
    clock.now = at
    socket.emit('message', terminalFrame(17, part))
  }
  await paintEcho()

  const observation = await echo.result
  expect(observation.echoTiming).toMatchObject({
    status: 'complete',
    receivedAt: 18,
    keystrokeToWorkerMs: 0,
    workerToPageMs: 8,
    pageToPaintMs: 12
  })
})

test('only the active exact worker, session, sequence and key on its attached stream can match', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-isolation', streamId: 17 })
  const noise = [
    echoMarker('worker-b', 'session-a', 5, 'b', '100012'),
    echoMarker('worker-a', 'session-b', 5, 'b', '100012'),
    echoMarker('worker-a', 'session-a', 4, 'b', '100012'),
    echoMarker('worker-a', 'session-a', 5, 'a', '100012')
  ]
  for (const marker of noise) socket.emit('message', terminalFrame(17, marker))
  socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'notification', params: { text: echoMarker('worker-a', 'session-a', 5, 'b', '100012') } }))
  socket.emit('message', terminalFrame(18, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
  await paintEcho()

  const observation = await echo.result
  expect(echo.settled()).toBe(true)
  expect(observation.echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })
})

test('a legacy marker suffix preserves DOM success with an explicit unavailable split', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-legacy-suffix', streamId: 17 })
  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b')))
  await paintEcho()

  expect(await echo.result).toMatchObject({
    durationMs: 20,
    echoTiming: {
      status: 'unavailable',
      workerReadEpochMs: null,
      receivedAt: 18,
      keystrokeToWorkerMs: null,
      workerToPageMs: null,
      pageToPaintMs: null
    }
  })
})
test('a DOM acknowledgement without a fresh socket arrival retains raw echo timing as unavailable', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-missing-arrival', streamId: 17 })
  echo.rows.textContent = echoMarker('worker-a', 'session-a', 5, 'b', '100012')
  mutate()
  await paintEcho()

  expect(await echo.result).toMatchObject({
    durationMs: 20,
    echoTiming: {
      status: 'unavailable',
      reason: expect.stringContaining('arrival'),
      receivedAt: null,
      keystrokeToWorkerMs: null,
      workerToPageMs: null,
      pageToPaintMs: null
    }
  })
})

test('socket history before action and a wrong u32 stream do not satisfy a fresh echo', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const marker = echoMarker('worker-a', 'session-a', 5, 'b', '100012')
  socket.emit('message', terminalFrame(17, marker))
  const echo = armSocketEcho(socket, { id: 'socket-history', streamId: 17 })
  await paintEcho()
  expect(echo.settled()).toBe(false)
  socket.emit('message', terminalFrame(18, marker))
  await paintEcho()
  expect(echo.settled()).toBe(false)
  clock.now = 18
  socket.emit('message', terminalFrame(17, marker))
  await paintEcho()
  expect((await echo.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })
})

test('socket listener timestamps arrival before the application listener runs', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'socket-listener-order', streamId: 17 })
  socket.addEventListener('message', ({ data }) => {
    if (!(data instanceof ArrayBuffer)) return
    clock.now = 25
  })
  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
  expect(clock.now).toBe(25)
  await paintEcho()

  expect((await echo.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })
})

test('echo arrival is unavailable for missing, invalid, or out-of-order worker clocks', async () => {
  for (const [readEpochMs, deliveredAt] of [
    [undefined, 18],
    ['Infinity', 18],
    ['100009', 18],
    ['100012', 11]
  ] as const) {
    environment()
    const socket = observedSocket()
    bindStream(socket, 'session-a', 17)
    const echo = armSocketEcho(socket, { id: `bad-clock-${String(readEpochMs)}-${deliveredAt}`, streamId: 17 })
    clock.now = deliveredAt
    socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', readEpochMs)))
    await paintEcho()

    expect((await echo.result).echoTiming).toMatchObject({
      status: 'unavailable',
      keystrokeToWorkerMs: null,
      workerToPageMs: null,
      pageToPaintMs: null
    })
  }
})

test('first matching arrival wins over duplicates and reconnect binds the new stream', async () => {
  environment()
  const oldSocket = observedSocket()
  bindStream(oldSocket, 'session-a', 17, 'old-attach')
  oldSocket.close()
  const socket = newObservedSocket('wss://fixture.invalid/reconnected')
  bindStream(socket, 'session-a', 23, 'new-attach')
  const echo = armSocketEcho(socket, { id: 'socket-reconnect', streamId: 23 })
  const marker = echoMarker('worker-a', 'session-a', 5, 'b', '100012')

  clock.now = 16
  oldSocket.emit('message', terminalFrame(17, marker))
  socket.emit('message', terminalFrame(17, marker))
  socket.emit('message', terminalFrame(23, marker))
  clock.now = 19
  socket.emit('message', terminalFrame(23, marker))
  await paintEcho()

  expect((await echo.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 16 })
})

test('ambiguous matching streams keep the successful echo but make attribution unavailable', async () => {
  environment()
  const first = observedSocket()
  bindStream(first, 'session-a', 17, 'first-attach')
  const second = newObservedSocket('wss://fixture.invalid/parallel')
  bindStream(second, 'session-a', 23, 'second-attach')
  const echo = armSocketEcho(first, { id: 'socket-ambiguous', streamId: 17 })
  const marker = echoMarker('worker-a', 'session-a', 5, 'b', '100012')
  clock.now = 16
  first.emit('message', terminalFrame(17, marker))
  clock.now = 18
  second.emit('message', terminalFrame(23, marker))
  await paintEcho()

  expect(await echo.result).toMatchObject({
    durationMs: 20,
    echoTiming: {
      status: 'unavailable',
      reason: expect.stringContaining('ambiguous'),
      receivedAt: null,
      keystrokeToWorkerMs: null
    }
  })
})

test('a 4096-byte marker line is accepted, an overlong fragment is unavailable, and the next sample recovers', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const exact = armSocketEcho(socket, { id: 'socket-line-limit', streamId: 17 })
  clock.now = 18
  socket.emit('message', terminalFrame(17, `${'x'.repeat(4096)}\r\n${echoMarker('worker-a', 'session-a', 5, 'b', '100012')}`))
  await paintEcho()
  expect((await exact.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })

  clock.now = 10
  const overflow = armSocketEcho(socket, { id: 'socket-line-overflow', streamId: 17, sequence: 6, key: 'c' })
  clock.now = 18
  socket.emit('message', terminalFrame(17, `${'x'.repeat(4097)}${echoMarker('worker-a', 'session-a', 6, 'c', '100012')}`))
  await paintEcho()
  expect((await overflow.result).echoTiming).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('overflow'),
    receivedAt: null
  })

  clock.now = 10
  const recovered = armSocketEcho(socket, { id: 'socket-line-recovered', streamId: 17, sequence: 7, key: 'd' })
  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 7, 'd', '100012')))
  await paintEcho()
  expect((await recovered.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })
})

test('socket and stream tracking caps accept their exact bounds and reject beyond-bound arrivals', async () => {
  for (const limit of ['sockets', 'streams'] as const) {
    environment()
    const primary = observedSocket()
    let targetSocket = primary
    let targetStream = 0
    if (limit === 'sockets') {
      for (let index = 0; index < 30; index++) newObservedSocket(`wss://fixture.invalid/${index}`)
      targetSocket = newObservedSocket('wss://fixture.invalid/32nd')
      targetStream = 32
      bindStream(targetSocket, 'session-a', targetStream)
    } else {
      for (let index = 1; index < 128; index++) bindStream(primary, `session-${index}`, index)
      targetStream = 128
      bindStream(primary, 'session-a', targetStream)
    }
    const echo = armSocketEcho(targetSocket, { id: `cap-${limit}`, streamId: targetStream })
    clock.now = 18
    targetSocket.emit('message', terminalFrame(targetStream, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
    await paintEcho()
    expect((await echo.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })

    const beyondSocket = limit === 'sockets' ? newObservedSocket('wss://fixture.invalid/33rd') : primary
    const beyondStream = limit === 'sockets' ? 33 : 129
    if (limit === 'streams') bindStream(beyondSocket, 'session-129', beyondStream)
    clock.now = 10
    const beyond = armSocketEcho(beyondSocket, {
      id: `beyond-${limit}`, sessionId: limit === 'sockets' ? 'session-beyond' : 'session-129',
      sequence: 6, key: 'c', streamId: beyondStream
    })
    clock.now = 18
    beyondSocket.emit('message', terminalFrame(beyondStream, echoMarker(
      'worker-a', limit === 'sockets' ? 'session-beyond' : 'session-129', 6, 'c', '100012'
    )))
    await paintEcho()
    expect((await beyond.result).echoTiming).toMatchObject({
      status: 'unavailable',
      keystrokeToWorkerMs: null
    })
  }
})

test('socket observer disposes on action failure, timeout, and browser-observer disposal', async () => {
  for (const mode of ['failed-action', 'timeout', 'dispose'] as const) {
    environment()
    const socket = observedSocket()
    bindStream(socket, 'session-a', 17)
    const echo = armSocketEcho(socket, {
      id: `socket-${mode}`, streamId: 17, ...(mode === 'timeout' ? { timeoutMs: 5 } : {})
    })
    const state = Reflect.get(globalThis, '__quirkySpeedObservers') as Map<string, { dispose(error?: Error): void }>
    if (mode === 'failed-action') state.get(`socket-${mode}`)!.dispose(new Error('echo action failed'))
    if (mode === 'dispose') state.get(`socket-${mode}`)!.dispose(new Error('test disposed'))
    await expect(echo.result).rejects.toThrow(
      mode === 'timeout' ? 'timed out after 5ms' : mode === 'failed-action' ? 'echo action failed' : 'test disposed'
    )
    expect(observerIsPresent(`socket-${mode}`)).toBe(false)
  }
})

test('flood sleep evidence joins only matching run identity and overlapping sample epochs', () => {
  const capture = {
    version: 1, workerId: 'flood-worker', sessionId: 'flood-session', runId: 'run-a',
    status: 'complete', reason: null,
    intervals: [
      { requestedEpochMs: 100008, dueEpochMs: 100024, wokeEpochMs: 100060, lateMs: 36 },
      { requestedEpochMs: 100071, dueEpochMs: 100087, wokeEpochMs: 100090, lateMs: 3 }
    ]
  } as const
  const identity = { workerId: 'flood-worker', sessionId: 'flood-session', runId: 'run-a' }

  expect(joinFloodSleepTiming(capture, identity, { startEpochMs: 100010, endEpochMs: 100050 })).toEqual({
    status: 'complete', reason: null, intervals: [capture.intervals[0]], pendingLateAtEndMs: null
  })
  expect(joinFloodSleepTiming(capture, identity, { startEpochMs: 100061, endEpochMs: 100070 })).toEqual({
    status: 'complete', reason: null, intervals: [], pendingLateAtEndMs: null
  })
  for (const wrong of [
    { ...identity, workerId: 'other-worker' },
    { ...identity, sessionId: 'other-session' },
    { ...identity, runId: 'run-b' }
  ]) {
    expect(joinFloodSleepTiming(capture, wrong, { startEpochMs: 100010, endEpochMs: 100050 }))
      .toMatchObject({ status: 'unavailable', intervals: [] })
  }
})

test('controller timer evidence is joined to the page-origin echo window, including a wake after paint', () => {
  let now = 100000
  let callback: (() => void) | undefined
  let cleared = false
  const probe = createTimerProbe({
    now: () => now,
    setTimeout: (next) => { callback = next; return 1 },
    clearTimeout: () => { cleared = true }
  })
  probe.start()
  now = 100060
  callback?.()
  const window = probe.stop({
    startEpochMs: 100010,
    endEpochMs: 100030
  })
  expect(window).toMatchObject({
    status: 'complete',
    intervals: [{ requestedEpochMs: 100000, dueEpochMs: 100016, wokeEpochMs: 100060, lateMs: 44 }]
  })
  expect(cleared).toBe(true)
})

test('socket wrapper preserves native construction, statics, subclassing and borrowed sends', () => {
  environment()
  const first = observedSocket()
  const Wrapped = Reflect.get(globalThis, 'WebSocket') as typeof FakeWebSocket
  expect(Wrapped.prototype).toBe(FakeWebSocket.prototype)
  expect(Wrapped.instances).toBe(FakeWebSocket.instances)
  class Derived extends Wrapped {}
  const second = new Derived('wss://fixture.invalid/derived', ['terminal'])
  expect(second).toBeInstanceOf(Derived)
  expect(second).toBeInstanceOf(FakeWebSocket)
  expect(second.protocols).toEqual(['terminal'])
  first.send.call(second, 'unchanged')
  expect(second.sent).toEqual(['unchanged'])
  expect(first.sent).toEqual([])
})

test('short headers and lagged terminal frames cannot establish an echo arrival', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  const echo = armSocketEcho(socket, { id: 'short-lagged', streamId: 17 })
  for (let length = 0; length < 5; length++) socket.emit('message', new Uint8Array(length).fill(1).buffer)
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', '100012'), 2))
  clock.now = 18
  socket.emit('message', terminalFrame(17, echoMarker('worker-a', 'session-a', 5, 'b', '100012')))
  await paintEcho()
  expect((await echo.result).echoTiming).toMatchObject({ status: 'complete', receivedAt: 18 })
})

test('simultaneous observers isolate partial markers by session and stream and dispose on abort', async () => {
  environment()
  const socket = observedSocket()
  bindStream(socket, 'session-a', 17)
  bindStream(socket, 'session-b', 18)
  const first = armSocketEcho(socket, { id: 'parallel-a', streamId: 17 })
  const second = armSocketEcho(socket, { id: 'parallel-b', sessionId: 'session-b', streamId: 18 })
  const a = echoMarker('worker-a', 'session-a', 5, 'b', '100012')
  const b = echoMarker('worker-a', 'session-b', 5, 'b', '100012')
  for (const [stream, part] of [[17, a.slice(0, 20)], [18, b.slice(0, 20)], [17, a.slice(20)], [18, b.slice(20)]] as const) {
    clock.now = 18
    socket.emit('message', terminalFrame(stream, part))
  }
  await paintEcho()
  expect((await first.result).echoTiming.status).toBe('complete')
  expect((await second.result).echoTiming.status).toBe('complete')
  clock.now = 10
  const controller = new AbortController()
  const aborted = armSocketEcho(socket, { id: 'socket-abort', streamId: 17, sequence: 6, key: 'c', signal: controller.signal })
  controller.abort(new Error('aborted socket observation'))
  await expect(aborted.result).rejects.toThrow('aborted socket observation')
  expect(observerIsPresent('socket-abort')).toBe(false)
})

test('retains separate diagnostic trials at the inclusive 80 percent budget boundary for all metrics', () => {
  for (const metric of METRICS) {
    const threshold = 0.8 * BUDGETS[metric]
    for (const [value, expected] of [[threshold - 0.001, false], [threshold, true],
      [BUDGETS[metric], true], [BUDGETS[metric] + 0.001, true], [null, false]] as const) {
      expect(shouldRunDiagnostic(metric, value)).toBe(expected)
    }
  }
})
