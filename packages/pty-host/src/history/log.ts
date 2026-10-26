import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024

const MAGIC = 'QPTL'
const FORMAT = 1
const HEADER_BYTES = 16
const RECORD_HEAD_BYTES = 5
const KIND_OUTPUT = 0x01
const KIND_RESIZE = 0x02
const KIND_RESTORE = 0x03

const CURRENT_NAME = 'output.log'
const PREVIOUS_NAME = 'output.1.log'

export type HistoryLogOptions = {
  cols: number
  rows: number
  maxSegmentBytes?: number
  log?: (message: string) => void
}

export type LogRecord = {
  kind: 'output' | 'resize' | 'restore'
  /** Absolute output position where the record starts. */
  offset: number
  bytes?: Uint8Array
  cols?: number
  rows?: number
}

export type LogSegment = {
  path: string
  startOffset: number
  /** Absolute output position after the segment's last readable output byte. */
  endOffset: number
  records: LogRecord[]
}

type Scan =
  | { ok: true; startOffset: number; endOffset: number; validBytes: number; records: LogRecord[] }
  | { ok: false }

function encodeHeader(startOffset: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write(MAGIC, 0, 'latin1')
  header[4] = FORMAT
  header.writeBigUInt64LE(BigInt(startOffset), 8)
  return header
}

function encodeRecord(kind: number, payload: Uint8Array): Buffer {
  const record = Buffer.alloc(RECORD_HEAD_BYTES + payload.length)
  record[0] = kind
  record.writeUInt32LE(payload.length, 1)
  record.set(payload, RECORD_HEAD_BYTES)
  return record
}

function encodeResize(cols: number, rows: number): Buffer {
  const payload = Buffer.alloc(4)
  payload.writeUInt16LE(cols, 0)
  payload.writeUInt16LE(rows, 2)
  return encodeRecord(KIND_RESIZE, payload)
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0
  while (written < bytes.length) written += writeSync(fd, bytes, written)
}

function openPrivate(path: string, flags: 'w' | 'a'): number {
  const fd = openSync(path, flags, 0o600)
  fchmodSync(fd, 0o600)
  return fd
}

/**
 * Parses one segment file. A record running past end of file is a torn tail and ends the scan
 * with `validBytes` marking where the last complete record stopped; a bad magic, unknown format
 * or malformed/unknown record makes the segment unreadable.
 */
function scanSegment(data: Uint8Array): Scan {
  if (data.length < HEADER_BYTES) return { ok: false }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC.charCodeAt(i)) return { ok: false }
  if (data[4] !== FORMAT) return { ok: false }
  const startOffset = Number(view.getBigUint64(8, true))

  const records: LogRecord[] = []
  let pos = HEADER_BYTES
  let offset = startOffset
  while (pos + RECORD_HEAD_BYTES <= data.length) {
    const kind = data[pos]
    const length = view.getUint32(pos + 1, true)
    const end = pos + RECORD_HEAD_BYTES + length
    if (end > data.length) break
    const payload = data.subarray(pos + RECORD_HEAD_BYTES, end)
    if (kind === KIND_OUTPUT) {
      records.push({ kind: 'output', offset, bytes: payload })
      offset += length
    } else if (kind === KIND_RESIZE) {
      if (length !== 4) return { ok: false }
      const cols = view.getUint16(pos + RECORD_HEAD_BYTES, true)
      const rows = view.getUint16(pos + RECORD_HEAD_BYTES + 2, true)
      records.push({ kind: 'resize', offset, cols, rows })
    } else if (kind === KIND_RESTORE) {
      records.push({ kind: 'restore', offset })
    } else {
      return { ok: false }
    }
    pos = end
  }
  return { ok: true, startOffset, endOffset: offset, validBytes: pos, records }
}

function scanFile(path: string): Scan | null {
  if (!existsSync(path)) return null
  try {
    return scanSegment(readFileSync(path))
  } catch {
    return { ok: false }
  }
}

/**
 * Reads the retained segments, `output.1.log` then `output.log`. A segment that cannot be parsed
 * is listed in `unreadable` and left out of `segments`.
 */
export function readSegments(dir: string): { segments: LogSegment[]; unreadable: string[] } {
  const segments: LogSegment[] = []
  const unreadable: string[] = []
  for (const name of [PREVIOUS_NAME, CURRENT_NAME]) {
    const path = join(dir, name)
    const scan = scanFile(path)
    if (scan === null) continue
    if (!scan.ok) unreadable.push(path)
    else segments.push({ path, startOffset: scan.startOffset, endOffset: scan.endOffset, records: scan.records })
  }
  return { segments, unreadable }
}

/** Absolute output position of the first retained byte, or 0 when nothing is readable. */
export function oldestOffset(dir: string): number {
  return readSegments(dir).segments[0]?.startOffset ?? 0
}

/** Absolute output position after the last retained byte, or 0 when nothing is readable. */
export function newestOffset(dir: string): number {
  const { segments } = readSegments(dir)
  return segments[segments.length - 1]?.endOffset ?? 0
}

/**
 * A session's append-only output history: framed records in `output.log`, moved over
 * `output.1.log` once the segment passes `maxSegmentBytes` of output, so the newest 16 to 32 MiB
 * stay on disk. Output positions are absolute for the session's whole life. A write error disables
 * the log (reported once) and later appends are no-ops; callers are never thrown at.
 */
export class HistoryLog {
  private fd: number | null = null
  private failed = false
  private position = 0
  private segmentStart = 0
  private cols: number
  private rows: number
  private readonly path: string
  private readonly rotatedPath: string
  private readonly maxSegmentBytes: number
  private readonly report: (message: string) => void

  private constructor(
    private readonly dir: string,
    options: HistoryLogOptions
  ) {
    this.path = join(dir, CURRENT_NAME)
    this.rotatedPath = join(dir, PREVIOUS_NAME)
    this.cols = options.cols
    this.rows = options.rows
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_SEGMENT_BYTES
    this.report = options.log ?? ((message) => console.error(message))
  }

  /** Starts a fresh history at offset 0, discarding any segments a previous run left behind. */
  static create(dir: string, options: HistoryLogOptions): HistoryLog {
    const log = new HistoryLog(dir, options)
    log.guard(() => {
      log.prepareDir()
      rmSync(log.path, { force: true })
      rmSync(log.rotatedPath, { force: true })
      log.startSegment(0)
    })
    return log
  }

  /**
   * Continues an existing history after a restart: cuts `output.log` back to its last complete
   * record so new records never follow a torn one, or starts a fresh segment when its header
   * cannot be read.
   */
  static openForAppend(dir: string, options: HistoryLogOptions): HistoryLog {
    const log = new HistoryLog(dir, options)
    log.guard(() => {
      log.prepareDir()
      const scan = scanFile(log.path)
      if (scan?.ok) {
        const fd = openPrivate(log.path, 'a')
        log.fd = fd
        ftruncateSync(fd, scan.validBytes)
        log.position = scan.endOffset
        log.segmentStart = scan.startOffset
        for (const record of scan.records) {
          if (record.kind === 'resize') {
            log.cols = record.cols!
            log.rows = record.rows!
          }
        }
        if (scan.records.length === 0) writeAll(fd, encodeResize(log.cols, log.rows))
        return
      }
      const previous = scanFile(log.rotatedPath)
      log.position = previous?.ok ? previous.endOffset : 0
      log.startSegment(log.position)
    })
    return log
  }

  /** Absolute output bytes written so far, across rotations and restores. */
  get offset(): number {
    return this.position
  }

  get disabled(): boolean {
    return this.failed
  }

  appendOutput(bytes: Uint8Array): void {
    if (!this.write(encodeRecord(KIND_OUTPUT, bytes))) return
    this.position += bytes.length
    if (this.position - this.segmentStart > this.maxSegmentBytes) this.guard(() => this.rotate())
  }

  appendResize(cols: number, rows: number): void {
    if (!this.write(encodeResize(cols, rows))) return
    this.cols = cols
    this.rows = rows
  }

  /** Marks where a restored incarnation begins. */
  appendRestore(): void {
    this.write(encodeRecord(KIND_RESTORE, new Uint8Array(0)))
  }

  close(): void {
    const fd = this.fd
    this.fd = null
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      // the fd may already be gone after a write error; nothing left to release
    }
  }

  private prepareDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
  }

  private startSegment(startOffset: number): void {
    this.close()
    this.fd = openPrivate(this.path, 'w')
    this.segmentStart = startOffset
    this.position = startOffset
    writeAll(this.fd, Buffer.concat([encodeHeader(startOffset), encodeResize(this.cols, this.rows)]))
  }

  private rotate(): void {
    this.close()
    renameSync(this.path, this.rotatedPath)
    this.startSegment(this.position)
  }

  private write(record: Uint8Array): boolean {
    const fd = this.fd
    if (this.failed || fd === null) return false
    return this.guard(() => writeAll(fd, record))
  }

  /** Runs one I/O step; the first failure disables the log and is reported once. */
  private guard(step: () => void): boolean {
    if (this.failed) return false
    try {
      step()
      return true
    } catch (err) {
      this.failed = true
      this.close()
      this.report(`pty-host: history disabled for ${this.dir}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}
