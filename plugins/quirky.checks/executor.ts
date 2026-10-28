import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const MAX_TAIL_CHARACTERS = 4000
const TERMINATION_GRACE_MS = 2000
const DEFAULT_SHELL = '/bin/sh'

type Tail = { value: string; truncated: boolean; totalCharacters: number }

export type CommandResult = {
  ran: boolean
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdoutTail: string
  stderrTail: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  error?: string
}

export type RunCommandOptions = {
  command: string
  cwd: string
  timeoutSeconds: number
  signal?: AbortSignal
  /** Internal shell override, used to exercise spawn failures without a public API escape hatch. */
  shell?: string
}

function codePointCount(value: string): number {
  let count = 0
  for (const _character of value) count++
  return count
}

/** Returns a suffix of at most `limit` Unicode code points, without splitting surrogate pairs. */
function takeLastCharacters(value: string, limit: number): string {
  let index = value.length
  let remaining = limit
  while (index > 0 && remaining > 0) {
    const last = value.charCodeAt(index - 1)
    index--
    if (last >= 0xdc00 && last <= 0xdfff && index > 0) {
      const previous = value.charCodeAt(index - 1)
      if (previous >= 0xd800 && previous <= 0xdbff) index--
    }
    remaining--
  }
  return value.slice(index)
}

function appendTail(tail: Tail, text: string): void {
  if (text === '') return
  const addedCharacters = codePointCount(text)
  tail.totalCharacters += addedCharacters
  if (tail.totalCharacters > MAX_TAIL_CHARACTERS) tail.truncated = true
  tail.value = takeLastCharacters(tail.value + text, MAX_TAIL_CHARACTERS)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyResult(startedAt: number, values: Partial<CommandResult> = {}): CommandResult {
  const result: CommandResult = {
    ran: false,
    pass: false,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stdoutTail: '',
    stderrTail: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...values
  }
  result.pass = result.ran && result.exitCode === 0 && !result.timedOut && !result.aborted && result.error === undefined
  return result
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    try { child.kill(signal) } catch { /* best-effort fallback; close and forced pipe cleanup still bound this run */ }
  }
}

/** Runs one shell command with bounded decoded tails and process-group cancellation. */
export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const startedAt = Date.now()
  if (options.signal?.aborted) return Promise.resolve(emptyResult(startedAt, { aborted: true }))

  const { promise, resolve } = Promise.withResolvers<CommandResult>()
  const stdout: Tail = { value: '', truncated: false, totalCharacters: 0 }
  const stderr: Tail = { value: '', truncated: false, totalCharacters: 0 }
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let child: ChildProcess | undefined
  let ran = false
  let exitCode: number | null = null
  let timedOut = false
  let aborted = false
  let failure: string | undefined
  let childClosed = false
  let finished = false
  let terminationRequested = false
  let termSent = false
  let killGraceComplete = false
  let stdoutEnded = false
  let stderrEnded = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (force = false) => {
    if (finished || (!force && (!childClosed || (terminationRequested && !killGraceComplete)))) return
    finished = true
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', onAbort)
    resolve(emptyResult(startedAt, {
      ran,
      exitCode,
      timedOut,
      aborted,
      stdoutTail: stdout.value,
      stderrTail: stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      ...(failure === undefined ? {} : { error: failure })
    }))
  }

  const killAfterGrace = () => {
    if (!child || killTimer !== undefined || killGraceComplete) return
    signalGroup(child, 'SIGTERM')
    termSent = true
    killTimer = setTimeout(() => {
      if (child) signalGroup(child, 'SIGKILL')
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      killGraceComplete = true
      finish()
    }, TERMINATION_GRACE_MS)
  }

  const requestTermination = () => {
    terminationRequested = true
    if (child?.pid !== undefined && !termSent) killAfterGrace()
  }

  const onAbort = () => {
    aborted = true
    requestTermination()
  }

  const appendOutput = (target: Tail, decoder: StringDecoder, chunk: Buffer | string) => {
    appendTail(target, typeof chunk === 'string' ? chunk : decoder.write(chunk))
  }

  const flushDecoder = (target: Tail, decoder: StringDecoder) => appendTail(target, decoder.end())

  options.signal?.addEventListener('abort', onAbort, { once: true })
  timeoutTimer = setTimeout(() => {
    timedOut = true
    requestTermination()
  }, options.timeoutSeconds * 1000)

  try {
    child = spawn(options.shell ?? DEFAULT_SHELL, ['-c', options.command], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    failure = errorText(error)
    finish(true)
    return promise
  }

  child.stdout?.on('data', (chunk: Buffer | string) => appendOutput(stdout, stdoutDecoder, chunk))
  child.stderr?.on('data', (chunk: Buffer | string) => appendOutput(stderr, stderrDecoder, chunk))
  child.stdout?.once('end', () => {
    if (stdoutEnded) return
    stdoutEnded = true
    flushDecoder(stdout, stdoutDecoder)
  })
  child.stderr?.once('end', () => {
    if (stderrEnded) return
    stderrEnded = true
    flushDecoder(stderr, stderrDecoder)
  })
  child.stdout?.once('close', () => {
    if (stdoutEnded) return
    stdoutEnded = true
    flushDecoder(stdout, stdoutDecoder)
  })
  child.stderr?.once('close', () => {
    if (stderrEnded) return
    stderrEnded = true
    flushDecoder(stderr, stderrDecoder)
  })
  child.stdout?.on('error', (error) => { failure ??= errorText(error) })
  child.stderr?.on('error', (error) => { failure ??= errorText(error) })
  child.once('spawn', () => {
    ran = true
    if (terminationRequested && !termSent) killAfterGrace()
  })
  child.once('error', (error) => {
    failure ??= errorText(error)
    if (!ran) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish(true)
      return
    }
    requestTermination()
  })
  child.once('close', (code) => {
    exitCode = code
    childClosed = true
    finish()
  })

  if (options.signal?.aborted) onAbort()
  return promise
}
