import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { ExternalJob } from '../ui-contracts'

export const MAX_JOBS_FILE_BYTES = 8 * 1024 * 1024
export const MAX_EXTERNAL_JOBS = 10_000
export const MAX_JSON_DEPTH = 128
export const MAX_JSON_TOKENS = 1_000_000
const READ_CHUNK_BYTES = 64 * 1024
const PROMPT_PREVIEW_LENGTH = 120

type JsonRecord = Record<string, unknown>
type FileStat = BigIntStats

export class ExternalJobsFileError extends Error {}

export type ExternalJobsFile = {
  identity: string
  jobs: ExternalJob[]
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function statIdentity(stat: FileStat): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(':')
}

function sameFileVersion(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function countJsonTokens(text: string): void {
  let depth = 0
  let tokens = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (code === 0x5c) escaped = true
      else if (code === 0x22) inString = false
      continue
    }

    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue
    tokens += 1
    if (tokens > MAX_JSON_TOKENS) {
      throw new ExternalJobsFileError(`OpenClaw jobs JSON exceeds the ${MAX_JSON_TOKENS.toLocaleString('en-US')} token limit`)
    }

    if (code === 0x22) {
      inString = true
      continue
    }
    if (code === 0x7b || code === 0x5b) {
      depth += 1
      if (depth > MAX_JSON_DEPTH) {
        throw new ExternalJobsFileError(`OpenClaw jobs JSON exceeds the depth ${MAX_JSON_DEPTH} limit`)
      }
      continue
    }
    if (code === 0x7d || code === 0x5d) {
      depth -= 1
      continue
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39) || code === 0x74 || code === 0x66 || code === 0x6e) {
      while (index + 1 < text.length) {
        const next = text.charCodeAt(index + 1)
        if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x2c || next === 0x5d || next === 0x7d) break
        index += 1
      }
    }
  }
}

async function readBoundedFile(path: string): Promise<{ bytes: Buffer; identity: string } | null> {
  let file: FileHandle | undefined
  try {
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }

    const initialStat = await file.stat({ bigint: true })
    if (!initialStat.isFile()) throw new ExternalJobsFileError('OpenClaw jobs file must be a regular file')
    if (initialStat.size > BigInt(MAX_JOBS_FILE_BYTES)) {
      throw new ExternalJobsFileError(`OpenClaw jobs file exceeds the ${MAX_JOBS_FILE_BYTES / (1024 * 1024)} MiB size limit`)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_JOBS_FILE_BYTES + 1 - totalBytes))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_JOBS_FILE_BYTES) {
        throw new ExternalJobsFileError(`OpenClaw jobs file exceeds the ${MAX_JOBS_FILE_BYTES / (1024 * 1024)} MiB size limit`)
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }

    const finalStat = await file.stat({ bigint: true })
    if (finalStat.size > BigInt(MAX_JOBS_FILE_BYTES)) {
      throw new ExternalJobsFileError(`OpenClaw jobs file exceeds the ${MAX_JOBS_FILE_BYTES / (1024 * 1024)} MiB size limit`)
    }
    if (!sameFileVersion(initialStat, finalStat)) {
      throw new ExternalJobsFileError('OpenClaw jobs file changed while it was being read; retry the list')
    }

    const bytes = Buffer.concat(chunks, totalBytes)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    return { bytes, identity: `${statIdentity(finalStat)}:${contentHash}` }
  } catch (error) {
    if (error instanceof ExternalJobsFileError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ExternalJobsFileError(`Could not read OpenClaw jobs file: ${message}`)
  } finally {
    await file?.close()
  }
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isoTimestamp(value: unknown): string | null {
  const time = timestamp(value)
  if (time === null) return null
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function durationLabel(milliseconds: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1_000]] as const) {
    if (milliseconds >= size && milliseconds % size === 0) return `${milliseconds / size}${unit}`
  }
  return `${milliseconds}ms`
}

function scheduleLabel(value: unknown): string {
  if (!isRecord(value)) return typeof value === 'string' && value.length > 0 ? value : 'unknown'
  const kind = stringField(value, 'kind')
  if (kind === 'at') {
    const at = value.at
    if (typeof at === 'string') return `at ${at}`
    if (typeof at === 'number' && Number.isFinite(at)) return `at ${isoTimestamp(at) ?? String(at)}`
    return 'at unknown time'
  }
  if (kind === 'every') {
    const interval = value.everyMs
    return typeof interval === 'number' && Number.isSafeInteger(interval) && interval >= 0
      ? `every ${durationLabel(interval)}`
      : 'every unknown interval'
  }
  if (kind === 'cron') {
    const expression = stringField(value, 'expr')
    if (!expression) return 'cron unknown expression'
    const timezone = stringField(value, 'tz')
    return `cron ${expression}${timezone ? ` @ ${timezone}` : ''}`
  }
  return 'unknown'
}

function promptText(job: JsonRecord): string {
  const payload = isRecord(job.payload) ? job.payload : null
  for (const value of [payload?.message, payload?.prompt, job.message, job.prompt]) {
    if (typeof value === 'string') return value
  }
  return ''
}

function preview(text: string): string {
  return text.length > PROMPT_PREVIEW_LENGTH ? `${text.slice(0, PROMPT_PREVIEW_LENGTH - 3)}...` : text
}

function runTimestamp(run: JsonRecord): number | null {
  for (const key of ['startedAtMs', 'startedAt', 'createdAtMs', 'createdAt', 'timestamp', 'at', 'ts']) {
    const value = timestamp(run[key])
    if (value !== null) return value
  }
  return null
}

function mapRuns(job: JsonRecord, state: JsonRecord): JsonRecord[] {
  const source = Array.isArray(job.runs) ? job.runs : Array.isArray(state.runs) ? state.runs : []
  return source
    .map((run, index) => ({ run, index, at: isRecord(run) ? runTimestamp(run) : null }))
    .filter((entry): entry is { run: JsonRecord; index: number; at: number | null } => isRecord(entry.run))
    .sort((left, right) => {
      if (left.at === null) return right.at === null ? left.index - right.index : 1
      if (right.at === null) return -1
      return right.at - left.at || left.index - right.index
    })
    .map(({ run }) => run)
}

function mapJob(value: unknown, index: number): ExternalJob {
  if (!isRecord(value)) throw new ExternalJobsFileError(`OpenClaw jobs file is malformed: jobs[${index}] must be an object`)
  const id = stringField(value, 'id')
  if (!id) throw new ExternalJobsFileError(`OpenClaw jobs file is malformed: jobs[${index}].id must be a non-empty string`)
  const state = isRecord(value.state) ? value.state : {}
  const prompt = promptText(value)
  const promptPreview = preview(prompt)
  const enabled = value.enabled !== false
  const lastStatus = stringField(state, 'lastStatus') ?? stringField(value, 'lastStatus')
  const runningAt = timestamp(value.runningAtMs) ?? timestamp(state.runningAtMs)
  const runRecords = mapRuns(value, state)
  const rawRunCount = state.runCount ?? value.runCount
  const runCount = typeof rawRunCount === 'number' && Number.isSafeInteger(rawRunCount) && rawRunCount >= 0
    ? rawRunCount
    : runRecords.length > 0 ? runRecords.length : null

  return {
    id,
    name: stringField(value, 'name') ?? (promptPreview || id),
    schedule: scheduleLabel(value.schedule),
    enabled,
    state: !enabled ? 'disabled' : runningAt !== null && runningAt > 0 ? 'running' : lastStatus ?? 'idle',
    promptPreview,
    nextRunAt: isoTimestamp(state.nextRunAtMs ?? value.nextRunAtMs),
    lastRunAt: isoTimestamp(state.lastRunAtMs ?? value.lastRunAtMs),
    lastStatus,
    lastError: stringField(state, 'lastError') ?? stringField(value, 'lastError'),
    runCount,
    runs: runRecords
  }
}

export async function readOpenClawJobs(path: string): Promise<ExternalJobsFile> {
  const file = await readBoundedFile(path)
  if (file === null) return { identity: 'missing', jobs: [] }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
  } catch {
    throw new ExternalJobsFileError('OpenClaw jobs file is not valid UTF-8 JSON')
  }
  countJsonTokens(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ExternalJobsFileError(`OpenClaw jobs file JSON is malformed: ${message}`)
  }
  if (!isRecord(value) || !Array.isArray(value.jobs)) {
    throw new ExternalJobsFileError('OpenClaw jobs file JSON must be an object with a jobs array')
  }
  if (value.jobs.length > MAX_EXTERNAL_JOBS) {
    throw new ExternalJobsFileError(`OpenClaw jobs file exceeds the ${MAX_EXTERNAL_JOBS.toLocaleString('en-US')} jobs limit`)
  }

  return { identity: file.identity, jobs: value.jobs.map(mapJob) }
}
