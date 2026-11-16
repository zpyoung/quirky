import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import type { FloodSleepCapture } from './contracts'

const MAX_SLEEP_INTERVALS = 8192
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
export const FLOOD_CHUNK_BYTES = 65_536 as const
export const FLOOD_INTERVAL_MS = 16 as const
const CONTROL_PREFIX = 0x1e
const MAX_CONTROL_BYTES = 4096

export type WorkerOutput = {
  write(chunk: Uint8Array): boolean
  once(event: 'drain', listener: () => void): unknown
}

type Control = { op: string; session?: string; runId?: string }
type FloodRun = {
  runId: string
  firstCounter: number
  lastCounter: number
  bytesWritten: number
  startedAt: number
  sleepTiming: FloodSleepCapture
}

/** Builds one bounded flood chunk with its progress counter embedded in the terminal stream. */
export function createFloodChunk(workerId: string, sessionId: string, counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 1) throw new Error('flood counters must be positive safe integers')
  const marker = Buffer.from(`SPEED_FLOOD ${workerId} ${sessionId} ${counter} ${FLOOD_CHUNK_BYTES}\r\n`)
  if (marker.byteLength > FLOOD_CHUNK_BYTES) throw new Error('flood marker exceeds its output chunk')
  const chunk = Buffer.alloc(FLOOD_CHUNK_BYTES, 0x20)
  marker.copy(chunk, FLOOD_CHUNK_BYTES - marker.byteLength)
  return chunk
}

/** Waits for the writable stream to accept more output instead of queuing an unbounded flood. */
export async function writeWorkerOutput(output: WorkerOutput, chunk: Uint8Array): Promise<void> {
  if (output.write(chunk)) return
  const { promise, resolve } = Promise.withResolvers<void>()
  output.once('drain', resolve)
  await promise
}

function parseControl(bytes: number[]): Control | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const control = value as Record<string, unknown>
    if (typeof control.op !== 'string') return null
    return {
      op: control.op,
      ...(typeof control.session === 'string' ? { session: control.session } : {}),
      ...(typeof control.runId === 'string' ? { runId: control.runId } : {})
    }
  } catch {
    return null
  }
}

type WorkerDependencies = {
  input: {
    isTTY?: boolean
    setRawMode(mode: boolean): unknown
    setEncoding(encoding: 'utf8'): unknown
    on(event: 'data', listener: (value: string | Buffer) => void): unknown
    pause(): unknown
  }
  output: WorkerOutput
  now(): number
  sleep(ms: number): Promise<unknown>
  publish(path: string, capture: FloodSleepCapture): Promise<void>
}

/** Publishes bounded disposable evidence without placing sleep intervals in terminal output. */
export async function publishFloodSleepCapture(path: string, capture: FloodSleepCapture): Promise<void> {
  let serialized = JSON.stringify(capture)
  if (Buffer.byteLength(serialized) > MAX_CAPTURE_BYTES) {
    serialized = JSON.stringify({ version: 1, workerId: capture.workerId.slice(0, 128),
      sessionId: capture.sessionId.slice(0, 128), runId: capture.runId.slice(0, 128),
      status: 'unavailable', reason: 'serialized-capture-too-large', intervals: [] })
  }
  await writeFile(path, serialized)
}

/** Runs isolated benchmark input and load with injectable clocks and output for deterministic checks. */
export async function runWorker(workerId: string, echoDelayMs: number, timingFile?: string, dependencies?: WorkerDependencies): Promise<void> {
  const { input, output, now, sleep, publish } = dependencies ?? {
    input: process.stdin, output: process.stdout,
    now: () => performance.timeOrigin + performance.now(), sleep: Bun.sleep, publish: publishFloodSleepCapture
  }
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('speed worker requires a raw terminal')
  input.setRawMode(true)
  input.setEncoding('utf8')

  let sessionId: string | undefined
  let sequence = 0
  let nextFloodCounter = 1
  let floodRunning = false
  let floodTask: Promise<void> | undefined
  let currentFloodRun: FloodRun | undefined
  let echoQueue: Promise<void> | undefined
  let controlQueue: Promise<void> = Promise.resolve()
  let controlBytes: number[] | undefined
  let discardControl = false
  let closing = false

  const writeText = async (value: string) => writeWorkerOutput(output, Buffer.from(value))
  const writeMarker = async (value: string) => writeText(`\r\n${value}\r\n`)

  const flood = async (state: FloodRun) => {
    while (floodRunning) {
      const counter = nextFloodCounter++
      const chunk = createFloodChunk(workerId, sessionId!, counter)
      if (state.firstCounter === 0) state.firstCounter = counter
      state.lastCounter = counter
      await writeWorkerOutput(output, chunk)
      state.bytesWritten += chunk.byteLength
      if (!floodRunning) break
      const requestedEpochMs = now()
      await sleep(FLOOD_INTERVAL_MS)
      const wokeEpochMs = now()
      const capture = state.sleepTiming
      if (capture.status === 'complete') {
        if (capture.intervals.length === MAX_SLEEP_INTERVALS || !Number.isFinite(requestedEpochMs) || !Number.isFinite(wokeEpochMs) || wokeEpochMs < requestedEpochMs + FLOOD_INTERVAL_MS) {
          capture.status = 'unavailable'
          capture.reason = capture.intervals.length === MAX_SLEEP_INTERVALS ? 'sleep-buffer-overflow' : 'invalid-sleep-clock'
          capture.intervals = []
        } else {
          capture.intervals.push({ requestedEpochMs, dueEpochMs: requestedEpochMs + FLOOD_INTERVAL_MS,
            wokeEpochMs, lateMs: wokeEpochMs - requestedEpochMs - FLOOD_INTERVAL_MS })
        }
      }
    }
    const elapsedMs = Math.max(0, now() - state.startedAt)
    if (timingFile) await publish(timingFile, state.sleepTiming).catch(() => undefined)
    await writeMarker(
      `SPEED_FLOOD_SUMMARY:${workerId}:${sessionId}:${state.runId}:${state.firstCounter}:${state.lastCounter}:${state.bytesWritten}:${elapsedMs}`
    )
    if (currentFloodRun === state) currentFloodRun = undefined
  }

  const handleControl = async (control: Control) => {
    if (control.op === 'bind') {
      if (!control.session) throw new Error('bind requires a terminal session ID')
      sessionId = control.session
      await writeMarker(`SPEED_READY ${workerId} ${sessionId}`)
      return
    }
    if (control.op === 'flood-start') {
      if (!sessionId) throw new Error('bind the speed worker before starting flood mode')
      if (!control.runId) throw new Error('flood-start requires a run ID')
      if (floodRunning) throw new Error('speed flood is already running')
      await floodTask
      floodRunning = true
      const run: FloodRun = {
        runId: control.runId,
        firstCounter: 0,
        lastCounter: 0,
        bytesWritten: 0,
        startedAt: now(),
        sleepTiming: { version: 1, workerId, sessionId, runId: control.runId, status: 'complete', reason: null, intervals: [] }
      }
      currentFloodRun = run
      await writeMarker(`SPEED_FLOOD_STARTED ${workerId} ${sessionId} ${run.runId}`)
      floodTask = flood(run).catch(async (error: unknown) => {
        floodRunning = false
        currentFloodRun = undefined
        await writeMarker(`SPEED_FLOOD_ERROR ${workerId} ${sessionId} ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    if (control.op === 'flood-stop') {
      if (!currentFloodRun || control.runId !== currentFloodRun.runId) throw new Error('flood-stop does not match the active run')
      floodRunning = false
      await floodTask
      floodTask = undefined
      return
    }
    if (control.op === 'shutdown') {
      floodRunning = false
      await floodTask
      floodTask = undefined
      currentFloodRun = undefined
      closing = true
      input.pause()
      input.setRawMode(false)
      process.exitCode = 0
    }
  }

  input.on('data', (value: string | Buffer) => {
    const bytes = Buffer.from(value)
    for (const byte of bytes) {
      if (controlBytes) {
        if (byte === 0x0a) {
          const control = discardControl ? null : parseControl(controlBytes)
          controlBytes = undefined
          discardControl = false
          if (control) {
            controlQueue = controlQueue.then(() => handleControl(control)).catch(async (error: unknown) => {
              await writeMarker(`SPEED_WORKER_ERROR ${workerId} ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined)
            })
          }
        } else if (!discardControl && controlBytes.length < MAX_CONTROL_BYTES) {
          controlBytes.push(byte)
        } else {
          discardControl = true
        }
        continue
      }
      if (byte === CONTROL_PREFIX) {
        controlBytes = []
        discardControl = false
        continue
      }
      if (closing || !sessionId || byte < 0x20 || byte >= 0x7f) continue
      sequence++
      const key = String.fromCharCode(byte)
      const marker = `SPEED_ECHO ${workerId} ${sessionId} ${sequence} ${key} readEpochMs=${now()}`
      if (echoDelayMs === 0) {
        void writeMarker(marker).catch(() => undefined)
      } else {
        const deadline = now() + echoDelayMs
        echoQueue = (echoQueue ?? Promise.resolve()).then(async () => {
          const remainingMs = deadline - now()
          if (remainingMs > 0) await sleep(remainingMs)
          await writeMarker(marker)
        }).catch(() => undefined)
      }
    }
  })
}

if (import.meta.main) {
  const workerId = process.argv[2]
  if (!workerId) throw new Error('speed worker requires a worker ID')
  const { values } = parseArgs({ args: process.argv.slice(3), strict: true, allowPositionals: false, options: {
    'echo-delay-ms': { type: 'string' }, 'timing-file': { type: 'string' }
  } })
  const echoDelayMs = Number(values['echo-delay-ms'] ?? 0)
  if (!Number.isFinite(echoDelayMs) || echoDelayMs < 0) throw new Error('--echo-delay-ms must be a non-negative number')
  const timingFile = values['timing-file']
  if (timingFile !== undefined && !isAbsolute(timingFile)) throw new Error('--timing-file must be an absolute disposable path')
  void runWorker(workerId, echoDelayMs, timingFile).catch((error: unknown) => {
    console.error(`speed worker failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
