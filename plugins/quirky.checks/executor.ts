import { StringDecoder } from 'node:string_decoder'
import type { ProcessSpawner, SpawnedProcess } from '@quirky/protocol'

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

/** Runs one shell command with bounded decoded tails and process-group cancellation. */
export async function runCommand(spawner: ProcessSpawner, options: RunCommandOptions): Promise<CommandResult> {
  const startedAt = Date.now()
  if (options.signal?.aborted) return emptyResult(startedAt, { aborted: true })

  let child: SpawnedProcess
  try {
    child = spawner.spawn([options.shell ?? DEFAULT_SHELL, '-c', options.command], {
      cwd: options.cwd,
      timeoutMs: options.timeoutSeconds * 1000,
      killGraceMs: TERMINATION_GRACE_MS,
      stderr: 'pipe',
      groupGrace: true,
      ...(options.signal ? { signal: options.signal } : {})
    })
  } catch (error) {
    return emptyResult(startedAt, { error: errorText(error) })
  }

  const stdout: Tail = { value: '', truncated: false, totalCharacters: 0 }
  const stderr: Tail = { value: '', truncated: false, totalCharacters: 0 }
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let failure: string | undefined

  const readOutput = async (
    stream: ReadableStream<Uint8Array>,
    tail: Tail,
    decoder: StringDecoder
  ): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        appendTail(tail, decoder.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength)))
      }
    } catch (error) {
      failure ??= errorText(error)
    } finally {
      appendTail(tail, decoder.end())
      reader?.releaseLock()
    }
  }

  const stdoutDone = readOutput(child.stdout, stdout, stdoutDecoder)
  const stderrDone = readOutput(child.stderr, stderr, stderrDecoder)
  const exit = await child.exited
  await Promise.all([stdoutDone, stderrDone])

  const error = exit.spawnError?.message
    ?? failure
    ?? (exit.groupSurvived ? 'process group could not be stopped' : undefined)
  return emptyResult(startedAt, {
    ran: child.pid !== null,
    exitCode: exit.exitCode,
    timedOut: exit.stopped === 'timeout',
    aborted: exit.stopped === 'aborted',
    stdoutTail: stdout.value,
    stderrTail: stderr.value,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    ...(error === undefined ? {} : { error })
  })
}
