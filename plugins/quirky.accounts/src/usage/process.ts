import type { ProcessSpawner, SpawnOptions, SpawnedProcess } from '@quirky/protocol'

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

const DEFAULT_MAX_OUTPUT_BYTES = 524_288
const KILL_GRACE_MS = 1_000

function emptyResult(): ProcessResult {
  return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, outputLimitExceeded: false }
}

function decode(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

export class ProviderProcessOwner {
  private readonly handles = new Set<SpawnedProcess>()
  private readonly runs = new Set<Promise<ProcessResult>>()
  private closed = false
  private shutdownPromise: Promise<void> | null = null

  constructor(private readonly spawner: ProcessSpawner) {}

  run(program: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    if (this.closed || options.signal?.aborted) return Promise.resolve(emptyResult())
    const operation = this.runProcess(program, args, options)
    this.runs.add(operation)
    void operation.then(
      () => this.runs.delete(operation),
      () => this.runs.delete(operation)
    )
    return operation
  }

  spawn(program: string, args: string[], options: SpawnOptions): SpawnedProcess {
    if (this.closed) throw new Error('Provider process owner is shut down')
    const handle = this.start(program, args, options)
    void handle.exited.then(
      () => this.handles.delete(handle),
      () => this.handles.delete(handle)
    )
    return handle
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    const handles = [...this.handles]
    const runs = [...this.runs]
    const { promise, resolve } = Promise.withResolvers<void>()
    this.shutdownPromise = promise
    const stops = handles.map(async (handle) => {
      try {
        await handle.stop({ graceMs: KILL_GRACE_MS })
      } catch {}
      try {
        await handle.exited
      } catch {}
    })
    void Promise.allSettled([...stops, ...runs]).then(() => resolve())
    return promise
  }

  private start(program: string, args: string[], options: SpawnOptions): SpawnedProcess {
    if (this.closed) throw new Error('Provider process owner is shut down')
    const handle = this.spawner.spawn([program, ...args], options)
    this.handles.add(handle)
    return handle
  }

  private async runProcess(program: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    let handle: SpawnedProcess | undefined
    try {
      handle = this.start(program, args, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeoutMs: options.timeoutMs,
        killGraceMs: KILL_GRACE_MS,
        signal: options.signal
      })
      const outputLimit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const stdoutChunks: Uint8Array[] = []
      const stderrChunks: Uint8Array[] = []
      let retainedBytes = 0
      let outputLimitExceeded = false
      let readFailed = false
      const stop = (): void => {
        try {
          void handle!.stop({ graceMs: KILL_GRACE_MS }).catch(() => {})
        } catch {}
      }
      const append = (chunks: Uint8Array[], chunk: Uint8Array): void => {
        if (outputLimitExceeded) return
        const remaining = Math.max(0, outputLimit - retainedBytes)
        const retained = Math.min(chunk.byteLength, remaining)
        if (retained > 0) chunks.push(retained === chunk.byteLength ? chunk : chunk.subarray(0, retained))
        retainedBytes += retained
        if (retained < chunk.byteLength) {
          outputLimitExceeded = true
          stop()
        }
      }
      const consume = async (stream: ReadableStream<Uint8Array>, chunks: Uint8Array[]): Promise<void> => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          reader = stream.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            append(chunks, value)
          }
        } catch {
          readFailed = true
          stop()
        } finally {
          reader?.releaseLock()
        }
      }
      const stdoutDone = consume(handle.stdout, stdoutChunks)
      const stderrDone = consume(handle.stderr, stderrChunks)
      const exitPromise = handle.exited.catch(() => {
        readFailed = true
        stop()
        return null
      })
      const [exit] = await Promise.all([exitPromise, stdoutDone, stderrDone])
      if (!exit || exit.spawnError || (readFailed && exit.stopped !== 'timeout' && !outputLimitExceeded)) {
        return emptyResult()
      }
      const stdout = decode(stdoutChunks)
      const stderr = decode(stderrChunks)
      const signal = exit.signal as NodeJS.Signals | null
      const timedOut = exit.stopped === 'timeout'
      if (timedOut) {
        return { code: null, signal, stdout, stderr, timedOut: true, outputLimitExceeded }
      }
      if (options.signal?.aborted || this.closed || exit.stopped === 'aborted') {
        return { code: null, signal, stdout, stderr, timedOut: false, outputLimitExceeded }
      }
      return {
        code: exit.stopped === 'stop' ? null : exit.exitCode,
        signal,
        stdout,
        stderr,
        timedOut: false,
        outputLimitExceeded
      }
    } catch {
      return emptyResult()
    } finally {
      if (handle) this.handles.delete(handle)
    }
  }
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
