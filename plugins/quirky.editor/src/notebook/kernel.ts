import { chmodSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'
import type { PythonEnvironment } from './python'

export type KernelFrame = {
  type: string
  content?: Record<string, unknown>
  status?: string
  execution_count?: number | null
  externallyManaged?: boolean
  detail?: string
}
export type KernelStartResult =
  | { status: 'ready'; session: KernelSession }
  | { status: 'missing-ipykernel'; externallyManaged: boolean; session: KernelSession }
  | { status: 'failed'; detail: string; session: KernelSession }
export type CellExecutionResult = { status: 'ok' | 'error' | 'dead'; executionCount: number | null; stderr: string }
type Execution = {
  code: string
  onFrame(frame: KernelFrame): Promise<void>
  resolve(result: CellExecutionResult): void
}

type ReadyFrame = { status: 'ready' } | { status: 'missing-ipykernel'; externallyManaged: boolean } | { status: 'failed'; detail: string }
type KernelStatus = 'starting' | 'ready' | 'missing-ipykernel' | 'dead' | 'stopping' | 'stopped'

const READY_TIMEOUT_MS = 65_000
const SHUTDOWN_GRACE_MS = 5_000
const MAX_FRAME_BYTES = 6 * 1024 * 1024

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, milliseconds)
  timer.unref?.()
  return promise
}


/** Owns the long-lived bridge process for one notebook kernel session. */
export class KernelSession {
  readonly id = randomUUID()
  readonly python: PythonEnvironment
  readonly cwd: string
  readonly bridgePath: string
  readonly quirkyHome: string
  readonly home: string
  #process: ProcessSpawner
  #child: SpawnedProcess | null = null
  #status: KernelStatus = 'starting'
  #stdout = ''
  #active: Execution | null = null
  #queue: Execution[] = []
  #busy = false
  #ready = Promise.withResolvers<ReadyFrame>()
  #readySettled = false
  #exit = Promise.withResolvers<void>()
  #invalidated = Promise.withResolvers<void>()
  #deliveryInvalidated = false
  #stdoutLoop: Promise<void> | null = null
  #executionCount: number | null = null
  #error: string | null = null
  #protocolFailureDetail: string | null = null
  #onStatusChange: ((session: KernelSession) => void) | undefined
  #startPromise: Promise<KernelStartResult> | null = null
  #shutdownPromise: Promise<void> | null = null
  #shutdownGraceMs: number
  #exitDrainMs: number
  #stopRequested = false

  constructor(
    process: ProcessSpawner,
    python: PythonEnvironment,
    cwd: string,
    bridgePath: string,
    home: string,
    onStatusChange?: (session: KernelSession) => void,
    quirkyHome = home,
    timing: { shutdownGraceMs?: number; exitDrainMs?: number } = {}
  ) {
    this.#process = process
    this.python = python
    this.cwd = cwd
    this.bridgePath = bridgePath
    this.home = home
    this.quirkyHome = quirkyHome
    this.#onStatusChange = onStatusChange
    this.#shutdownGraceMs = timing.shutdownGraceMs ?? SHUTDOWN_GRACE_MS
    this.#exitDrainMs = timing.exitDrainMs ?? 1_000
  }

  get status(): KernelStatus { return this.#status }
  get busy(): boolean { return this.#busy }
  get pid(): number | undefined { return this.#child?.pid ?? undefined }
  get stderr(): string { return this.#diagnostic() }
  get executionCount(): number | null { return this.#executionCount }
  get error(): string | null { return this.#error }

  start(): Promise<KernelStartResult> {
    if (this.#startPromise) return this.#startPromise
    const pending = this.#start()
    this.#startPromise = pending
    return pending
  }

  async #start(): Promise<KernelStartResult> {
    const configDir = join(this.home, 'jupyter', 'config')
    const dataDir = join(this.home, 'jupyter', 'data')
    const runtimeDir = join(this.home, 'jupyter', 'runtime')
    const ipythonDir = join(this.home, 'ipython')
    const xdgConfigDir = join(this.home, 'xdg-config')
    for (const directory of [configDir, dataDir, runtimeDir, ipythonDir, xdgConfigDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    const env = {
      ...process.env,
      HOME: this.home,
      QUIRKY_HOME: this.quirkyHome,
      USERPROFILE: this.home,
      XDG_CONFIG_HOME: xdgConfigDir,
      JUPYTER_CONFIG_DIR: configDir,
      JUPYTER_DATA_DIR: dataDir,
      JUPYTER_RUNTIME_DIR: runtimeDir,
      IPYTHONDIR: ipythonDir
    }
    let child: SpawnedProcess
    try {
      child = this.#process.spawn([this.python.path, '-u', this.bridgePath], {
        cwd: this.cwd,
        env,
        stdin: 'pipe',
        timeoutMs: null,
        killGraceMs: 5_000,
        stderrTailBytes: 16_384
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.#markDead(detail)
      return { status: 'failed', detail, session: this }
    }

    this.#child = child
    this.#stdoutLoop = this.#readStdout(child)
    void child.exited.then(async (exit) => {
      this.#exit.resolve()
      await this.#handleExit(exit)
    }).catch((error) => this.#protocolFailure(error))

    const timer = setTimeout(() => {
      if (this.#status !== 'starting') return
      const detail = `kernel did not become ready within ${READY_TIMEOUT_MS} ms`
      this.#markDead(detail)
      this.#stopChild()
    }, READY_TIMEOUT_MS)
    const readiness = await this.#ready.promise
    clearTimeout(timer)
    if (readiness.status === 'ready') {
      if (this.#status === 'starting') this.#setStatus('ready')
      if (this.#status === 'ready') return { status: 'ready', session: this }
      return { status: 'failed', detail: this.#error ?? 'Kernel stopped before becoming ready.', session: this }
    }
    if (readiness.status === 'missing-ipykernel') {
      this.#setStatus('missing-ipykernel')
      return { status: 'missing-ipykernel', externallyManaged: readiness.externallyManaged, session: this }
    }
    this.#error ??= readiness.detail
    if (this.#status !== 'stopping' && this.#status !== 'stopped') this.#markDead(readiness.detail)
    await this.shutdown()
    return { status: 'failed', detail: readiness.detail, session: this }
  }

  execute(code: string, onFrame: Execution['onFrame']): Promise<CellExecutionResult> {
    if (this.#status !== 'ready') {
      return Promise.resolve({ status: 'dead', executionCount: this.#executionCount, stderr: this.#diagnostic() || this.#error || 'The kernel is not ready.' })
    }
    const { promise, resolve } = Promise.withResolvers<CellExecutionResult>()
    this.#queue.push({ code, onFrame, resolve })
    this.#pump()
    return promise
  }

  #pump(): void {
    if (this.#active || !this.#queue.length || this.#status !== 'ready') return
    this.#active = this.#queue.shift()!
    this.#busy = true
    void this.#write(`${JSON.stringify({ op: 'execute', code: this.#active.code })}\n`)
  }

  async interrupt(): Promise<{ interrupted: boolean; stalled: boolean }> {
    const child = this.#child
    if (!this.#active || !child || this.#status !== 'ready') return { interrupted: false, stalled: false }
    const active = this.#active
    const completed = Promise.withResolvers<void>()
    const originalResolve = active.resolve
    active.resolve = (result) => {
      originalResolve(result)
      completed.resolve()
    }
    void this.#write('{"op":"interrupt"}\n').catch(() => {})
    const outcome = await Promise.race([
      completed.promise.then(() => 'completed' as const),
      delay(10_000).then(() => 'timeout' as const)
    ])
    if (this.#status !== 'ready') return { interrupted: false, stalled: false }
    return { interrupted: true, stalled: outcome === 'timeout' && this.#active === active }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    const pending = this.#shutdown()
    this.#shutdownPromise = pending
    return pending
  }

  async #shutdown(): Promise<void> {
    if (this.#status === 'stopped') return
    this.#invalidateDelivery()
    this.#setStatus('stopping')
    this.#settleReady({ status: 'failed', detail: this.#error ?? 'Kernel shut down before becoming ready.' })
    this.#failQueued('Kernel shut down before execution.')
    const child = this.#child
    if (!child) {
      this.#finishActive('dead')
      this.#setStatus('stopped')
      return
    }

    try {
      void child.closeInput().catch(() => {})
    } catch {}
    const exited = await Promise.race([
      this.#exit.promise.then(() => true),
      delay(this.#shutdownGraceMs).then(() => false)
    ])
    if (!exited) {
      try {
        const stopped = child.stop({ signal: 'SIGKILL' })
        await Promise.race([
          stopped.then(() => undefined, () => undefined),
          delay(1_000)
        ])
      } catch {}
    }
    this.#finishActive('dead')
    this.#setStatus('stopped')
  }

  #setStatus(status: KernelStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#onStatusChange?.(this)
  }

  #invalidateDelivery(): void {
    if (this.#deliveryInvalidated) return
    this.#deliveryInvalidated = true
    this.#stdout = ''
    this.#invalidated.resolve()
  }

  #markDead(detail: string): void {
    if (this.#status === 'dead' || this.#status === 'stopping' || this.#status === 'stopped' || this.#status === 'missing-ipykernel') return
    this.#invalidateDelivery()
    this.#error ??= detail
    this.#setStatus('dead')
    this.#settleReady({ status: 'failed', detail: this.#error })
    this.#finishActive('dead')
    this.#failQueued(this.#error)
  }

  #failQueued(message: string): void {
    const stderr = this.#diagnostic() || message
    for (const pending of this.#queue.splice(0)) {
      pending.resolve({ status: 'dead', executionCount: this.#executionCount, stderr })
    }
  }

  #settleReady(result: ReadyFrame): void {
    if (this.#readySettled) return
    this.#readySettled = true
    this.#ready.resolve(result)
  }

  async #readStdout(child: SpawnedProcess): Promise<void> {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        if (this.#deliveryInvalidated) return
        let result: { kind: 'invalidated' } | { kind: 'read'; done: boolean; value: Uint8Array | undefined }
        try {
          result = await Promise.race([
            reader.read().then(({ done, value }) => ({ kind: 'read' as const, done, value })),
            this.#invalidated.promise.then(() => ({ kind: 'invalidated' as const }))
          ])
        } catch (error) {
          if (!this.#deliveryInvalidated) {
            const detail = error instanceof Error ? error.message : String(error)
            this.#protocolFailure(new Error(`kernel bridge stdout failed: ${detail}`))
          }
          return
        }
        if (result.kind === 'invalidated') return
        if (result.done) {
          const finalChunk = decoder.decode()
          if (finalChunk && !this.#deliveryInvalidated) {
            try {
              await this.#acceptStdout(finalChunk)
            } catch (error) {
              if (!this.#deliveryInvalidated) this.#protocolFailure(error)
            }
          }
          return
        }
        const text = decoder.decode(result.value, { stream: true })
        if (text && !this.#deliveryInvalidated) {
          try {
            await this.#acceptStdout(text)
          } catch (error) {
            if (!this.#deliveryInvalidated) this.#protocolFailure(error)
            return
          }
        }
      }
    } finally {
      if (this.#deliveryInvalidated) {
        try { void reader.cancel().catch(() => {}) } catch {}
      } else {
        try { reader.releaseLock() } catch {}
      }
    }
  }

  async #acceptStdout(chunk: string): Promise<void> {
    if (this.#deliveryInvalidated) return
    this.#stdout += chunk
    if (this.#stdout.length > MAX_FRAME_BYTES * 2) throw new Error('kernel bridge sent an oversized partial frame')
    for (;;) {
      if (this.#deliveryInvalidated) {
        this.#stdout = ''
        return
      }
      const newline = this.#stdout.indexOf('\n')
      if (newline < 0) return
      const line = this.#stdout.slice(0, newline)
      this.#stdout = this.#stdout.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('kernel bridge frame exceeded the output limit')
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new Error('kernel bridge sent malformed NDJSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('kernel bridge frame must be an object')
      await Promise.race([
        this.#handleFrame(parsed as KernelFrame),
        this.#invalidated.promise
      ])
      if (this.#deliveryInvalidated) {
        this.#stdout = ''
        return
      }
    }
  }

  async #handleFrame(frame: KernelFrame): Promise<void> {
    if (this.#deliveryInvalidated) return
    if (frame.type === 'ready') {
      this.#settleReady({ status: 'ready' })
      return
    }
    if (frame.type === 'missing') {
      this.#setStatus('missing-ipykernel')
      this.#settleReady({ status: 'missing-ipykernel', externallyManaged: frame.externallyManaged === true })
      return
    }
    if (frame.type === 'start_error') {
      this.#markDead(typeof frame.detail === 'string' ? frame.detail : 'The kernel failed to start.')
      return
    }
    if (frame.type === 'done') {
      if (typeof frame.execution_count === 'number') this.#executionCount = frame.execution_count
      this.#finishActive(frame.status === 'ok' ? 'ok' : 'error')
      return
    }
    if (this.#active) await this.#active.onFrame(frame)
  }

  #finishActive(status: CellExecutionResult['status']): void {
    const active = this.#active
    if (!active) return
    this.#active = null
    this.#busy = false
    active.resolve({ status, executionCount: this.#executionCount, stderr: this.#diagnostic() })
    this.#pump()
  }

  #diagnostic(): string {
    const stderr = this.#child?.stderrTail() ?? ''
    const combined = this.#protocolFailureDetail === null ? stderr : `${stderr}\n${this.#protocolFailureDetail}`
    return combined.slice(-4_000)
  }

  #write(data: string): Promise<boolean> {
    const child = this.#child
    if (!child) return Promise.resolve(false)
    let pending: Promise<boolean>
    try {
      pending = child.write(data)
    } catch (error) {
      if (!this.#deliveryInvalidated) {
        const detail = error instanceof Error ? error.message : String(error)
        this.#protocolFailure(new Error(`kernel bridge stdin failed: ${detail}`))
      }
      return Promise.resolve(false)
    }
    return pending.then((written) => {
      if (!written && !this.#deliveryInvalidated) this.#protocolFailure(new Error('kernel bridge stdin failed: the pipe is closed'))
      return written
    }, (error) => {
      if (!this.#deliveryInvalidated) {
        const detail = error instanceof Error ? error.message : String(error)
        this.#protocolFailure(new Error(`kernel bridge stdin failed: ${detail}`))
      }
      return false
    })
  }

  #stopChild(): void {
    if (!this.#child || this.#stopRequested) return
    this.#stopRequested = true
    try { void this.#child.stop().catch(() => {}) } catch {}
  }

  #protocolFailure(error: unknown): void {
    if (this.#deliveryInvalidated) return
    const detail = error instanceof Error ? error.message : String(error)
    this.#protocolFailureDetail ??= detail
    this.#error ??= detail
    this.#markDead(detail)
    this.#stopChild()
  }

  async #handleExit(exit: SpawnExit): Promise<void> {
    if (exit.spawnError) {
      this.#markDead(exit.spawnError.message)
      return
    }
    if (this.#deliveryInvalidated || this.#status === 'stopping' || this.#status === 'stopped' || this.#status === 'missing-ipykernel') return
    const stdoutLoop = this.#stdoutLoop ?? Promise.resolve()
    await Promise.race([stdoutLoop, delay(this.#exitDrainMs)])
    if (this.#deliveryInvalidated || this.#status === 'stopping' || this.#status === 'stopped' || this.#status === 'missing-ipykernel') return
    this.#markDead(`kernel bridge exited${exit.exitCode === null ? '' : ` with code ${exit.exitCode}`}${exit.signal ? ` (${exit.signal})` : ''}`)
  }
}
