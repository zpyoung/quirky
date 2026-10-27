import { spawn, type ChildProcess } from 'node:child_process'

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputLimitExceeded: boolean
}

export type ProcessOptions = {
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export class ProviderProcessOwner {
  private readonly children = new Set<ChildProcess>()
  private closed = false

  async run(program: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    if (this.closed || options.signal?.aborted) {
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, outputLimitExceeded: false }
    }
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.children.add(child)
    const { promise, resolve } = Promise.withResolvers<ProcessResult>()
    const outputLimit = options.maxOutputBytes ?? 512 * 1024
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let outputLimitExceeded = false
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      terminate(child)
    }, options.timeoutMs)
    const abort = (): void => terminate(child)
    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      this.children.delete(child)
      resolve(result)
    }
    const append = (current: string, chunk: Buffer): string => {
      bytes += chunk.byteLength
      if (bytes > outputLimit) {
        outputLimitExceeded = true
        terminate(child)
        const remaining = Math.max(0, outputLimit - (bytes - chunk.byteLength))
        return current + chunk.subarray(0, remaining).toString('utf8')
      }
      return current + chunk.toString('utf8')
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', () => finish({ code: null, signal: null, stdout, stderr: '', timedOut, outputLimitExceeded }))
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal, stdout, stderr, timedOut, outputLimitExceeded })
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    return promise
  }

  track(child: ChildProcess): void {
    if (this.closed) terminate(child)
    else this.children.add(child)
    child.once('close', () => this.children.delete(child))
    child.once('error', () => this.children.delete(child))
  }

  async shutdown(): Promise<void> {
    this.closed = true
    const children = [...this.children]
    await Promise.all(children.map((child) => terminateAndWait(child)))
    this.children.clear()
  }
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 1_000)
  child.once('close', () => clearTimeout(killTimer))
}

function terminateAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const deadline = setTimeout(resolve, 1_500)
  const complete = (): void => {
    clearTimeout(deadline)
    resolve()
  }
  child.once('close', complete)
  child.once('error', complete)
  terminate(child)
  return promise
}

export type ProviderRuntime = {
  processes: ProviderProcessOwner
  signal: AbortSignal
  now(): number
  fetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>
  run(program: string, args: string[], options: Omit<ProcessOptions, 'signal'> & { signal?: AbortSignal }): Promise<ProcessResult>
}

export function createProviderRuntime(processes: ProviderProcessOwner, signal: AbortSignal): ProviderRuntime {
  return {
    processes,
    signal,
    now: () => Date.now(),
    fetch: async (url, init = {}, timeoutMs = 10_000) => {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const inputSignal = init.signal
      const abortInput = (): void => controller.abort()
      if (inputSignal) inputSignal.addEventListener('abort', abortInput, { once: true })
      if (signal.aborted || inputSignal?.aborted) controller.abort()
      const timer = setTimeout(abort, timeoutMs)
      try {
        return await fetch(url, { ...init, signal: controller.signal })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        inputSignal?.removeEventListener('abort', abortInput)
      }
    },
    run: (program, args, options) => processes.run(program, args, { ...options, signal: options.signal ?? signal })
  }
}
