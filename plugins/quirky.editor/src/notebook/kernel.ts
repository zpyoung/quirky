import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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

const READY_TIMEOUT_MS = 65_000
const SHUTDOWN_GRACE_MS = 5_000
const MAX_FRAME_BYTES = 6 * 1024 * 1024

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, milliseconds)
  timer.unref?.()
  return promise
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* already exited */ }
  }
}

export class KernelSession {
  readonly id = randomUUID()
  readonly python: PythonEnvironment
  readonly cwd: string
  readonly bridgePath: string
  readonly home: string
  #child: ChildProcess | null = null
  #status: 'starting' | 'ready' | 'missing-ipykernel' | 'dead' | 'stopping' | 'stopped' = 'starting'
  #stderr = ''
  #stdout = ''
  #active: Execution | null = null
  #queue: Execution[] = []
  #busy = false
  #ready = Promise.withResolvers<ReadyFrame>()
  #readySettled = false
  #exit = Promise.withResolvers<void>()
  #receive = Promise.resolve()
  #executionCount: number | null = null
  #error: string | null = null

  constructor(python: PythonEnvironment, cwd: string, bridgePath: string, home: string) {
    this.python = python
    this.cwd = cwd
    this.bridgePath = bridgePath
    this.home = home
  }

  get status(): 'starting' | 'ready' | 'missing-ipykernel' | 'dead' | 'stopping' | 'stopped' { return this.#status }
  get busy(): boolean { return this.#busy }
  get pid(): number | undefined { return this.#child?.pid }
  get stderr(): string { return this.#stderr }
  get executionCount(): number | null { return this.#executionCount }
  get error(): string | null { return this.#error }

  async start(): Promise<KernelStartResult> {
    let child: ChildProcess
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
      USERPROFILE: this.home,
      XDG_CONFIG_HOME: xdgConfigDir,
      JUPYTER_CONFIG_DIR: configDir,
      JUPYTER_DATA_DIR: dataDir,
      JUPYTER_RUNTIME_DIR: runtimeDir,
      IPYTHONDIR: ipythonDir
    }
    try {
      child = spawn(this.python.path, ['-u', this.bridgePath], {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (error) {
      this.#status = 'dead'
      const detail = error instanceof Error ? error.message : String(error)
      this.#error = detail
      return { status: 'failed', detail, session: this }
    }
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.#receive = this.#receive.then(() => this.#acceptStdout(chunk)).catch((error) => this.#protocolFailure(error))
    })
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4000)
    })
    child.once('error', (error) => {
      this.#error = error.message
      this.#status = 'dead'
      this.#settleReady({ status: 'failed', detail: error.message })
      this.#finishActive('dead')
    })
    child.once('close', (code, signal) => {
      this.#exit.resolve()
      if (this.#status !== 'stopping' && this.#status !== 'stopped' && this.#status !== 'missing-ipykernel') {
        this.#status = 'dead'
        this.#error ??= `kernel bridge exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`
        this.#settleReady({ status: 'failed', detail: this.#error })
        this.#finishActive('dead')
      }
    })
    const timer = setTimeout(() => {
      this.#error = `kernel did not become ready within ${READY_TIMEOUT_MS} ms`
      this.#settleReady({ status: 'failed', detail: this.#error })
      this.#status = 'dead'
      killGroup(child, 'SIGTERM')
    }, READY_TIMEOUT_MS)
    const readiness = await this.#ready.promise
    clearTimeout(timer)
    if (readiness.status === 'ready') {
      this.#status = 'ready'
      return { status: 'ready', session: this }
    }
    if (readiness.status === 'missing-ipykernel') {
      this.#status = 'missing-ipykernel'
      return { status: 'missing-ipykernel', externallyManaged: readiness.externallyManaged, session: this }
    }
    this.#status = 'dead'
    this.#error = readiness.detail
    await this.shutdown()
    return { status: 'failed', detail: readiness.detail, session: this }
  }

  execute(code: string, onFrame: Execution['onFrame']): Promise<CellExecutionResult> {
    if (this.#status !== 'ready') return Promise.resolve({ status: 'dead', executionCount: this.#executionCount, stderr: this.#stderr || this.#error || 'The kernel is not ready.' })
    const { promise, resolve } = Promise.withResolvers<CellExecutionResult>()
    this.#queue.push({ code, onFrame, resolve })
    this.#pump()
    return promise
  }

  #pump(): void {
    if (this.#active || !this.#queue.length || this.#status !== 'ready') return
    this.#active = this.#queue.shift()!
    this.#busy = true
    try {
      this.#child?.stdin?.write(`${JSON.stringify({ op: 'execute', code: this.#active.code })}\n`)
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error)
      this.#finishActive('dead')
    }
  }

  async interrupt(): Promise<{ interrupted: boolean; stalled: boolean }> {
    if (!this.#active || !this.#child?.stdin || this.#status !== 'ready') return { interrupted: false, stalled: false }
    const active = this.#active
    const completed = Promise.withResolvers<void>()
    const originalResolve = active.resolve
    active.resolve = (result) => {
      originalResolve(result)
      completed.resolve()
    }
    try {
      this.#child.stdin.write('{"op":"interrupt"}\n')
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error)
      return { interrupted: false, stalled: false }
    }
    const result = await Promise.race([completed.promise.then(() => true), delay(10_000).then(() => false)])
    return { interrupted: true, stalled: !result && this.#active === active }
  }

  async shutdown(): Promise<void> {
    const child = this.#child
    if (!child) {
      this.#status = 'stopped'
      return
    }
    if (this.#status === 'stopped') return
    this.#status = 'stopping'
    for (const pending of this.#queue.splice(0)) pending.resolve({ status: 'dead', executionCount: this.#executionCount, stderr: 'Kernel shut down before execution.' })
    try { child.stdin?.end() } catch { /* the bridge may already have exited */ }
    const clean = await Promise.race([this.#exit.promise.then(() => true), delay(SHUTDOWN_GRACE_MS).then(() => false)])
    if (!clean) {
      killGroup(child, 'SIGKILL')
      await Promise.race([this.#exit.promise, delay(1_000)])
    }
    this.#finishActive('dead')
    this.#status = 'stopped'
  }

  #settleReady(result: ReadyFrame): void {
    if (this.#readySettled) return
    this.#readySettled = true
    this.#ready.resolve(result)
  }

  async #acceptStdout(chunk: string): Promise<void> {
    this.#stdout += chunk
    if (this.#stdout.length > MAX_FRAME_BYTES * 2) throw new Error('kernel bridge sent an oversized partial frame')
    for (;;) {
      const newline = this.#stdout.indexOf('\n')
      if (newline < 0) return
      const line = this.#stdout.slice(0, newline)
      this.#stdout = this.#stdout.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('kernel bridge frame exceeded the output limit')
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new Error('kernel bridge sent malformed NDJSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('kernel bridge frame must be an object')
      await this.#handleFrame(parsed as KernelFrame)
    }
  }

  async #handleFrame(frame: KernelFrame): Promise<void> {
    if (frame.type === 'ready') {
      this.#settleReady({ status: 'ready' })
      return
    }
    if (frame.type === 'missing') {
      this.#status = 'missing-ipykernel'
      this.#settleReady({ status: 'missing-ipykernel', externallyManaged: frame.externallyManaged === true })
      return
    }
    if (frame.type === 'start_error') {
      const detail = typeof frame.detail === 'string' ? frame.detail : 'The kernel failed to start.'
      this.#settleReady({ status: 'failed', detail })
      this.#error = detail
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
    active.resolve({ status, executionCount: this.#executionCount, stderr: this.#stderr })
    this.#pump()
  }

  #protocolFailure(error: unknown): void {
    this.#error = error instanceof Error ? error.message : String(error)
    this.#stderr = `${this.#stderr}\n${this.#error}`.slice(-4000)
    this.#status = 'dead'
    this.#settleReady({ status: 'failed', detail: this.#error })
    if (this.#child) killGroup(this.#child, 'SIGTERM')
    this.#finishActive('dead')
  }
}
