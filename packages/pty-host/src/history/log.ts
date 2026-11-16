import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { open as openAsync, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024

const MAGIC = 'QPTL'
const FORMAT = 1
const HEADER_BYTES = 16
const RECORD_HEAD_BYTES = 5
const KIND_OUTPUT = 0x01
const KIND_RESIZE = 0x02
const KIND_RESTORE = 0x03
const KIND_CLEAR = 0x04

const CURRENT_NAME = 'output.log'
const PREVIOUS_NAME = 'output.1.log'

const INDEX_MIN_READ_BYTES = 32
const INDEX_MAX_READ_BYTES = 4096
/** Output records smaller than this join their neighbours in one index entry. */
export const INDEX_SOLO_BYTES = 4096
/** A joined entry is closed once its file bytes reach this. */
export const INDEX_GROUP_BYTES = 64 * 1024

export const STORED_INDEX_SLICE_BYTES = 1024 * 1024
export const STORED_INDEX_MAX_ENTRIES = 65_536

export type HistoryLogOptions = {
  cols: number
  rows: number
  maxSegmentBytes?: number
  log?: (message: string) => void
}

export type LogRecord = {
  kind: 'output' | 'resize' | 'restore' | 'clear'
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
    } else if (kind === KIND_CLEAR) {
      records.push({ kind: 'clear', offset })
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

/** One record of an indexed segment; `at` is where its payload starts in the file. */
export type IndexedRecord = {
  kind: 'output' | 'resize' | 'restore' | 'clear'
  /** Absolute output position where the record starts. */
  offset: number
  /** Payload bytes; for output this is the span of output positions it covers. */
  length: number
  at: number
  cols?: number
  rows?: number
  /** Set on an entry that joins several consecutive output records. */
  joined?: true
}

export type IndexedSegment = {
  path: string
  startOffset: number
  endOffset: number
  records: IndexedRecord[]
  fd: number
}
type WriterRecord = IndexedRecord & { fileStart?: number; recordCount?: number }
type SegmentIndex = Omit<IndexedSegment, 'fd' | 'records'> & { records: WriterRecord[] }
type WriterGroup = { record: WriterRecord; fileBytes: number }
type JoinedRange = { fileStart: number; recordCount: number }

function groupRecords(records: IndexedRecord[]): WriterRecord[] {
  const grouped: WriterRecord[] = []
  let open: WriterGroup | null = null
  for (const record of records) {
    if (record.kind !== 'output' || record.length >= INDEX_SOLO_BYTES) {
      grouped.push({ ...record })
      open = null
      continue
    }
    const fileBytes = record.length + RECORD_HEAD_BYTES
    if (open === null) {
      const entry: WriterRecord = {
        ...record,
        fileStart: record.at - RECORD_HEAD_BYTES,
        recordCount: 1
      }
      grouped.push(entry)
      open = { record: entry, fileBytes }
    } else {
      open.record.length += record.length
      open.record.recordCount = open.record.recordCount! + 1
      open.record.joined = true
      open.fileBytes += fileBytes
    }
    if (open.fileBytes >= INDEX_GROUP_BYTES) open = null
  }
  return grouped
}

function openWriterGroup(records: WriterRecord[]): WriterGroup | null {
  const record = records.at(-1)
  if (record?.kind !== 'output' || record.fileStart === undefined || record.recordCount === undefined) return null
  const fileBytes = record.length + record.recordCount * RECORD_HEAD_BYTES
  return fileBytes < INDEX_GROUP_BYTES ? { record, fileBytes } : null
}

function indexFromScan(path: string, scan: Extract<Scan, { ok: true }>): SegmentIndex {
  let position = HEADER_BYTES
  const records: IndexedRecord[] = scan.records.map((record) => {
    const length = record.bytes?.length ?? (record.kind === 'resize' ? 4 : 0)
    const indexed: IndexedRecord = {
      kind: record.kind,
      offset: record.offset,
      length,
      at: position + RECORD_HEAD_BYTES,
      ...(record.kind === 'resize' ? { cols: record.cols, rows: record.rows } : {})
    }
    position += RECORD_HEAD_BYTES + length
    return indexed
  })
  return {
    path,
    startOffset: scan.startOffset,
    endOffset: scan.endOffset,
    records: groupRecords(records)
  }
}

function indexedEnd(records: WriterRecord[]): number {
  const last = records.at(-1)
  if (!last) return HEADER_BYTES
  if (last.kind === 'output' && last.fileStart !== undefined && last.recordCount !== undefined) {
    return last.fileStart + last.length + last.recordCount * RECORD_HEAD_BYTES
  }
  return last.at + last.length
}

function readFully(fd: number, buffer: Uint8Array, position: number): number {
  let filled = 0
  while (filled < buffer.length) {
    const n = readSync(fd, buffer, filled, buffer.length - filled, position + filled)
    if (n === 0) break
    filled += n
  }
  return filled
}

/**
 * Walks one open segment's record heads without reading output payloads, so the cost is the
 * framing, not the file. Applies the same validity rules as `scanSegment`.
 */
function indexSegment(fd: number, path: string): IndexedSegment | null {
  const size = fstatSync(fd).size
  if (size < HEADER_BYTES) return null
  const header = Buffer.alloc(HEADER_BYTES)
  readFully(fd, header, 0)
  if (header.toString('latin1', 0, MAGIC.length) !== MAGIC || header[4] !== FORMAT) return null
  const startOffset = Number(header.readBigUInt64LE(8))

  let block = Buffer.alloc(0)
  let blockAt = 0
  const view = (position: number, length: number): Buffer => {
    if (position < blockAt || position + length > blockAt + block.length) {
      // heads that follow each other closely (small records) share ever larger reads; a head
      // after a big payload costs only a small one
      const contiguous = position <= blockAt + block.length
      const want = contiguous ? Math.min(block.length * 2, INDEX_MAX_READ_BYTES) : INDEX_MIN_READ_BYTES
      block = Buffer.alloc(Math.min(Math.max(length, want, INDEX_MIN_READ_BYTES), size - position))
      blockAt = position
      readFully(fd, block, position)
    }
    return block.subarray(position - blockAt, position - blockAt + length)
  }

  const records: IndexedRecord[] = []
  let pos = HEADER_BYTES
  let offset = startOffset
  while (pos + RECORD_HEAD_BYTES <= size) {
    const head = view(pos, RECORD_HEAD_BYTES)
    const kind = head[0]
    const length = head.readUInt32LE(1)
    const end = pos + RECORD_HEAD_BYTES + length
    if (end > size) break
    const at = pos + RECORD_HEAD_BYTES
    if (kind === KIND_OUTPUT) {
      records.push({ kind: 'output', offset, length, at })
      offset += length
    } else if (kind === KIND_RESIZE) {
      if (length !== 4) return null
      const payload = view(at, 4)
      records.push({ kind: 'resize', offset, length, at, cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) })
    } else if (kind === KIND_RESTORE) {
      records.push({ kind: 'restore', offset, length, at })
    } else if (kind === KIND_CLEAR) {
      records.push({ kind: 'clear', offset, length, at })
    } else {
      return null
    }
    pos = end
  }
  return { path, startOffset, endOffset: offset, records, fd }
}

/**
 * Random access to the retained segments for readers that need only part of the log. `open`
 * indexes record heads and leaves payloads on disk; `readOutput` then fetches just the output
 * bytes asked for, so a reader's I/O is bounded by what it requests rather than by file size.
 * Segments hold their file descriptor, so a rotation after `open` does not disturb reads.
 */
export class LogReader {
  private constructor(
    readonly segments: IndexedSegment[],
    readonly unreadable: string[],
    private readonly joinedRanges = new WeakMap<IndexedRecord, JoinedRange>()
  ) {}

  /** Builds a reader from the writer-maintained index. */
  static fromWriterIndex(
    segments: IndexedSegment[],
    unreadable: string[],
    joinedRanges: WeakMap<IndexedRecord, JoinedRange>
  ): LogReader {
    return new LogReader(segments, unreadable, joinedRanges)
  }

  /** Same segments and unreadable rules as `readSegments`. */
  static open(dir: string): LogReader {
    const segments: IndexedSegment[] = []
    const unreadable: string[] = []
    for (const name of [PREVIOUS_NAME, CURRENT_NAME]) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      let fd: number | null = null
      try {
        fd = openSync(path, 'r')
        const segment = indexSegment(fd, path)
        if (segment) {
          segments.push(segment)
          continue
        }
      } catch {
        // an unreadable file is reported below like a malformed one
      }
      if (fd !== null) closeQuietly(fd)
      unreadable.push(path)
    }
    return new LogReader(segments, unreadable)
  }

  /** Bytes `[from, to)` of an output entry's payload. */
  readOutput(segment: IndexedSegment, record: IndexedRecord, from: number, to: number): Uint8Array {
    const start = Math.max(0, Math.min(from, record.length))
    const end = Math.max(0, Math.min(to, record.length))
    if (end <= start) return Buffer.alloc(0)

    if (!record.joined) {
      const bytes = Buffer.alloc(end - start)
      const filled = readFully(segment.fd, bytes, record.at + start)
      return filled === bytes.length ? bytes : bytes.subarray(0, filled)
    }

    const range = this.joinedRanges.get(record)!
    const fileBytes = Buffer.alloc(record.length + range.recordCount * RECORD_HEAD_BYTES)
    const filled = readFully(segment.fd, fileBytes, range.fileStart)
    const output = Buffer.alloc(end - start)
    let filePosition = 0
    let outputPosition = 0
    let copied = 0
    while (filePosition + RECORD_HEAD_BYTES <= filled) {
      const length = fileBytes.readUInt32LE(filePosition + 1)
      const payloadAt = filePosition + RECORD_HEAD_BYTES
      const payloadEnd = payloadAt + length
      if (payloadEnd > filled) break
      const outputEnd = outputPosition + length
      const copyStart = Math.max(start, outputPosition)
      const copyEnd = Math.min(end, outputEnd)
      if (copyEnd > copyStart) {
        fileBytes.copy(
          output,
          copyStart - start,
          payloadAt + copyStart - outputPosition,
          payloadAt + copyEnd - outputPosition
        )
        copied += copyEnd - copyStart
      }
      outputPosition = outputEnd
      filePosition = payloadEnd
      if (outputPosition >= end) break
    }
    return copied === output.length ? output : output.subarray(0, copied)
  }

  close(): void {
    for (const segment of this.segments) closeQuietly(segment.fd)
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
}

export type StoredIndexOptions = {
  sliceBytes?: number
  /** Awaited before each read of at most `sliceBytes` at `position` of the segment at `path`. */
  beforeSlice?: (path: string, position: number) => void | Promise<void>
}

/** The record index of a stored session's retained segments, held in memory with no open files. */
export type StoredLogIndex = {
  /** The session folder: where the checkpoint and the segments live. */
  readonly dir: string
  /** First retained output position; 0 when nothing is readable. */
  readonly startOffset: number
  /** Output position after the last retained byte; 0 when nothing is readable. */
  readonly endOffset: number
  readonly unreadable: readonly string[]
  /** Entries held across all segments. */
  readonly entries: number
  /** False when `entries` is over `STORED_INDEX_MAX_ENTRIES`: use it and let it go. */
  readonly retain: boolean
  /** True once `reader()` found a segment that no longer matches. */
  readonly stale: boolean
  /**
   * Opens the segments for payload reads; the caller closes it. A segment whose inode, size,
   * modification time or change time differs from the load's, or that cannot be opened, is listed
   * in the reader's `unreadable`.
   * Parses nothing and never calls `LogReader.open`.
   */
  reader(): LogReader
}

type StoredFileIdentity = {
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

type StoredFileIndex = {
  path: string
  identity: StoredFileIdentity | null
  segment: SegmentIndex | null
}

function identityOf(stat: StoredFileIdentity): StoredFileIdentity {
  return { ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

function identityMatches(stat: StoredFileIdentity, expected: StoredFileIdentity): boolean {
  return stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs
}

function addStoredOutput(
  records: WriterRecord[],
  group: { value: WriterGroup | null },
  offset: number,
  length: number,
  at: number
): void {
  if (length >= INDEX_SOLO_BYTES) {
    group.value = null
    records.push({ kind: 'output', offset, length, at })
    return
  }

  if (group.value === null) {
    const record: WriterRecord = {
      kind: 'output',
      offset,
      length,
      at,
      fileStart: at - RECORD_HEAD_BYTES,
      recordCount: 1
    }
    records.push(record)
    group.value = { record, fileBytes: length + RECORD_HEAD_BYTES }
  } else {
    group.value.record.length += length
    group.value.record.recordCount = group.value.record.recordCount! + 1
    group.value.record.joined = true
    group.value.fileBytes += length + RECORD_HEAD_BYTES
  }

  if (group.value.fileBytes >= INDEX_GROUP_BYTES) group.value = null
}

async function scanStoredSegment(
  handle: FileHandle,
  path: string,
  sliceBytes: number,
  beforeSlice?: StoredIndexOptions['beforeSlice']
): Promise<StoredFileIndex> {
  let identity: StoredFileIdentity | null = null
  try {
    let position = 0
    let carry = 0
    let firstRead = true
    let size = 0
    let startOffset = 0
    let offset = 0
    let headerRead = false
    let tornTail = false
    let records: WriterRecord[] = []
    let lastClear: WriterRecord | null = null
    const group: { value: WriterGroup | null } = { value: null }
    const buffer = Buffer.alloc(sliceBytes + HEADER_BYTES)

    while (firstRead || position < size) {
      if (firstRead) {
        await beforeSlice?.(path, position)
        const stat = await handle.stat({ bigint: true })
        identity = identityOf(stat)
        size = Number(stat.size)
        firstRead = false
        if (!Number.isSafeInteger(size) || size < HEADER_BYTES) return { path, identity, segment: null }
      } else {
        const { promise, resolve } = Promise.withResolvers<void>()
        setImmediate(resolve)
        await promise
        await beforeSlice?.(path, position)
      }

      if (position >= size) break
      const requested = Math.min(sliceBytes, size - position)
      const { bytesRead } = await handle.read(buffer, carry, requested, position)
      if (bytesRead === 0) break

      const dataEnd = carry + bytesRead
      const base = position - carry
      let cursor = 0
      let skipTo: number | null = null
      if (!headerRead) {
        if (dataEnd >= HEADER_BYTES) {
          if (
            buffer.toString('latin1', 0, MAGIC.length) !== MAGIC ||
            buffer[4] !== FORMAT
          ) {
            return { path, identity, segment: null }
          }
          startOffset = Number(buffer.readBigUInt64LE(8))
          offset = startOffset
          headerRead = true
          cursor = HEADER_BYTES
        }
      }

      while (headerRead && cursor < dataEnd) {
        const recordAt = base + cursor
        if (dataEnd - cursor < RECORD_HEAD_BYTES) break
        const kind = buffer[cursor]
        const length = buffer.readUInt32LE(cursor + 1)
        const recordEnd = recordAt + RECORD_HEAD_BYTES + length
        if (recordEnd > size) {
          tornTail = true
          break
        }
        const payloadAt = recordAt + RECORD_HEAD_BYTES
        const dataFileEnd = base + dataEnd

        if (kind === KIND_OUTPUT) {
          addStoredOutput(records, group, offset, length, payloadAt)
          offset += length
          if (recordEnd > dataFileEnd) {
            skipTo = recordEnd
            break
          }
        } else if (kind === KIND_RESIZE) {
          if (length !== 4) return { path, identity, segment: null }
          if (recordEnd > dataFileEnd) break
          group.value = null
          records.push({
            kind: 'resize',
            offset,
            length,
            at: payloadAt,
            cols: buffer.readUInt16LE(cursor + RECORD_HEAD_BYTES),
            rows: buffer.readUInt16LE(cursor + RECORD_HEAD_BYTES + 2)
          })
        } else if (kind === KIND_RESTORE) {
          group.value = null
          if (recordEnd > dataFileEnd) {
            skipTo = recordEnd
            break
          }
        } else if (kind === KIND_CLEAR) {
          group.value = null
          lastClear = { kind: 'clear', offset, length, at: payloadAt }
          if (recordEnd > dataFileEnd) {
            skipTo = recordEnd
            break
          }
        } else {
          return { path, identity, segment: null }
        }

        cursor += RECORD_HEAD_BYTES + length
      }

      if (skipTo !== null) {
        position = skipTo
        carry = 0
        continue
      }
      if (tornTail) break

      const remaining = dataEnd - cursor
      if (remaining > 0) buffer.copy(buffer, 0, cursor, dataEnd)
      carry = remaining
      position += bytesRead
    }

    if (!headerRead) return { path, identity, segment: null }
    if (lastClear !== null) records.push(lastClear)
    return {
      path,
      identity,
      segment: { path, startOffset, endOffset: offset, records }
    }
  } catch {
    return { path, identity, segment: null }
  }
}

/** Never rejects. Holds at most one slice of file bytes at a time and yields a loop turn between slices. */
export async function loadStoredLogIndex(dir: string, options?: StoredIndexOptions): Promise<StoredLogIndex> {
  const requestedSliceBytes = options?.sliceBytes ?? STORED_INDEX_SLICE_BYTES
  const sliceBytes = Number.isSafeInteger(requestedSliceBytes) && requestedSliceBytes > 0
    ? requestedSliceBytes
    : STORED_INDEX_SLICE_BYTES
  const files: StoredFileIndex[] = []
  const unreadable: string[] = []

  for (const name of [PREVIOUS_NAME, CURRENT_NAME]) {
    const path = join(dir, name)
    let handle: FileHandle
    try {
      handle = await openAsync(path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(path)
      continue
    }

    const file = await scanStoredSegment(handle, path, sliceBytes, options?.beforeSlice)
    try {
      await handle.close()
    } catch {
    }
    files.push(file)
    if (file.segment === null) unreadable.push(path)
  }

  const segments = files.flatMap((file) => file.segment === null ? [] : [file.segment])
  const entries = segments.reduce((count, segment) => count + segment.records.length, 0)
  let stale = false

  return {
    dir,
    startOffset: segments[0]?.startOffset ?? 0,
    endOffset: segments.at(-1)?.endOffset ?? 0,
    unreadable,
    entries,
    retain: entries <= STORED_INDEX_MAX_ENTRIES,
    get stale() {
      return stale
    },
    reader() {
      const unavailable = new Set(unreadable)
      const readerSegments: IndexedSegment[] = []
      const joinedRanges = new WeakMap<IndexedRecord, JoinedRange>()

      for (const file of files) {
        if (file.identity === null) {
          stale = true
          unavailable.add(file.path)
          continue
        }

        let fd: number | null = null
        try {
          fd = openSync(file.path, 'r')
          if (!identityMatches(fstatSync(fd, { bigint: true }), file.identity)) {
            stale = true
            unavailable.add(file.path)
            closeQuietly(fd)
            fd = null
            continue
          }
          if (file.segment === null) {
            closeQuietly(fd)
            fd = null
            continue
          }

          const records = file.segment.records.map((source) => {
            const { fileStart, recordCount, ...record } = source
            const copy: IndexedRecord = { ...record }
            if (source.joined) joinedRanges.set(copy, { fileStart: fileStart!, recordCount: recordCount! })
            return copy
          })
          readerSegments.push({
            path: file.segment.path,
            startOffset: file.segment.startOffset,
            endOffset: file.segment.endOffset,
            records,
            fd
          })
          fd = null
        } catch {
          stale = true
          unavailable.add(file.path)
        } finally {
          if (fd !== null) closeQuietly(fd)
        }
      }

      return LogReader.fromWriterIndex(readerSegments, [...unavailable], joinedRanges)
    }
  }
}

/**
 * Output position of the newest `clear` record in `segments`, or null when none was recorded.
 * Output before it is no longer part of what the session shows.
 */
export function newestClearOffset(segments: ReadonlyArray<{ records: ReadonlyArray<{ kind: string; offset: number }> }>): number | null {
  for (let s = segments.length - 1; s >= 0; s--) {
    const { records } = segments[s]
    for (let r = records.length - 1; r >= 0; r--) if (records[r].kind === 'clear') return records[r].offset
  }
  return null
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
 * `output.1.log` once the segment file passes `maxSegmentBytes` (header and every record kind
 * counted), so a segment never exceeds that size by more than one record and the newest 16 to
 * 32 MiB stay on disk. Output positions count output payload bytes only and are absolute for the
 * session's whole life. A write error disables
 * the log (reported once) and later appends are no-ops; callers are never thrown at.
 */
export class HistoryLog {
  private fd: number | null = null
  private failed = false
  private position = 0
  private segmentBytes = 0
  private currentIndex: SegmentIndex | null = null
  private previousIndex: SegmentIndex | null | undefined = undefined
  private previousUnreadable = false
  private currentGroup: WriterGroup | null = null
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
      log.previousIndex = null
      log.previousUnreadable = false
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
        log.segmentBytes = scan.validBytes
        log.currentIndex = indexFromScan(log.path, scan)
        log.currentGroup = openWriterGroup(log.currentIndex.records)
        for (const record of scan.records) {
          if (record.kind === 'resize') {
            log.cols = record.cols!
            log.rows = record.rows!
          }
        }
        if (scan.records.length === 0 && !log.write(encodeResize(log.cols, log.rows))) return
        log.rotateIfFull()
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
  /** A snapshot of the segments written by this log. */
  reader(): LogReader {
    if (this.failed) return LogReader.open(this.dir)
    this.indexPreviousSegment()
    const indexes: SegmentIndex[] = []
    const unreadable: string[] = []
    if (this.previousIndex) indexes.push(this.previousIndex)
    else if (this.previousUnreadable && existsSync(this.rotatedPath)) unreadable.push(this.rotatedPath)
    if (this.currentIndex === null) return LogReader.open(this.dir)
    indexes.push(this.currentIndex)

    const segments: IndexedSegment[] = []
    const joinedRanges = new WeakMap<IndexedRecord, JoinedRange>()
    for (const index of indexes) {
      let fd: number | null = null
      try {
        fd = openSync(index.path, 'r')
        if (fstatSync(fd).size < indexedEnd(index.records)) {
          closeQuietly(fd)
          for (const segment of segments) closeQuietly(segment.fd)
          return LogReader.open(this.dir)
        }
        const records = index.records.map((record) => {
          const { fileStart, recordCount, ...source } = record
          const copy: IndexedRecord = { ...source }
          if (record.joined) joinedRanges.set(copy, { fileStart: fileStart!, recordCount: recordCount! })
          return copy
        })
        segments.push({
          path: index.path,
          startOffset: index.startOffset,
          endOffset: index.endOffset,
          records,
          fd
        })
      } catch {
        if (fd !== null) closeQuietly(fd)
        for (const segment of segments) closeQuietly(segment.fd)
        return LogReader.open(this.dir)
      }
    }
    return LogReader.fromWriterIndex(segments, unreadable, joinedRanges)
  }

  appendOutput(bytes: Uint8Array): void {
    if (!this.write(encodeRecord(KIND_OUTPUT, bytes))) return
    this.position += bytes.length
    if (this.currentIndex) this.currentIndex.endOffset = this.position
    this.rotateIfFull()
  }

  appendResize(cols: number, rows: number): void {
    if (!this.write(encodeResize(cols, rows))) return
    this.cols = cols
    this.rows = rows
    this.rotateIfFull()
  }

  /** Marks where a restored incarnation begins. */
  appendRestore(): void {
    if (this.write(encodeRecord(KIND_RESTORE, new Uint8Array(0)))) this.rotateIfFull()
  }

  /** Marks that everything before the current output position was cleared from the session's screen and history. */
  appendClear(): void {
    if (this.write(encodeRecord(KIND_CLEAR, new Uint8Array(0)))) this.rotateIfFull()
  }

  /** False once the log has been closed or has failed; appends are then no-ops. */
  get isOpen(): boolean {
    return this.fd !== null
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

  private indexPreviousSegment(): void {
    if (this.previousIndex !== undefined) return
    if (!existsSync(this.rotatedPath)) {
      this.previousIndex = null
      this.previousUnreadable = false
      return
    }
    let fd: number | null = null
    try {
      fd = openSync(this.rotatedPath, 'r')
      const indexed = indexSegment(fd, this.rotatedPath)
      if (indexed === null) {
        this.previousIndex = null
        this.previousUnreadable = true
        return
      }
      this.previousIndex = {
        path: indexed.path,
        startOffset: indexed.startOffset,
        endOffset: indexed.endOffset,
        records: groupRecords(indexed.records)
      }
      this.previousUnreadable = false
    } catch {
      this.previousIndex = null
      this.previousUnreadable = true
    } finally {
      if (fd !== null) closeQuietly(fd)
    }
  }

  private startSegment(startOffset: number): void {
    this.close()
    this.fd = openPrivate(this.path, 'w')
    this.position = startOffset
    const opening = Buffer.concat([encodeHeader(startOffset), encodeResize(this.cols, this.rows)])
    writeAll(this.fd, opening)
    this.segmentBytes = opening.length
    this.currentIndex = {
      path: this.path,
      startOffset,
      endOffset: startOffset,
      records: [{
        kind: 'resize',
        offset: startOffset,
        length: 4,
        at: HEADER_BYTES + RECORD_HEAD_BYTES,
        cols: this.cols,
        rows: this.rows
      }]
    }
    this.currentGroup = null
  }

  private rotateIfFull(): void {
    if (this.segmentBytes > this.maxSegmentBytes) this.guard(() => this.rotate())
  }

  private rotate(): void {
    const previousIndex = this.currentIndex
    this.close()
    renameSync(this.path, this.rotatedPath)
    this.previousIndex = previousIndex === null ? null : { ...previousIndex, path: this.rotatedPath }
    this.previousUnreadable = false
    this.startSegment(this.position)
  }

  private write(record: Buffer): boolean {
    const fd = this.fd
    if (this.failed || fd === null) return false
    const fileStart = this.segmentBytes
    if (!this.guard(() => writeAll(fd, record))) return false
    this.segmentBytes += record.length
    this.indexRecord(record, fileStart)
    return true
  }

  private indexRecord(record: Buffer, fileStart: number): void {
    const index = this.currentIndex!
    const length = record.readUInt32LE(1)
    const kind = record[0]
    if (kind === KIND_OUTPUT) {
      if (length >= INDEX_SOLO_BYTES) {
        this.currentGroup = null
        index.records.push({
          kind: 'output',
          offset: this.position,
          length,
          at: fileStart + RECORD_HEAD_BYTES
        })
      } else if (this.currentGroup === null) {
        const entry: WriterRecord = {
          kind: 'output',
          offset: this.position,
          length,
          at: fileStart + RECORD_HEAD_BYTES,
          fileStart,
          recordCount: 1
        }
        index.records.push(entry)
        this.currentGroup = { record: entry, fileBytes: length + RECORD_HEAD_BYTES }
      } else {
        this.currentGroup.record.length += length
        this.currentGroup.record.recordCount = this.currentGroup.record.recordCount! + 1
        this.currentGroup.record.joined = true
        this.currentGroup.fileBytes += length + RECORD_HEAD_BYTES
      }
      if (this.currentGroup !== null && this.currentGroup.fileBytes >= INDEX_GROUP_BYTES) this.currentGroup = null
    } else {
      this.currentGroup = null
      if (kind === KIND_RESIZE) {
        index.records.push({
          kind: 'resize',
          offset: this.position,
          length,
          at: fileStart + RECORD_HEAD_BYTES,
          cols: record.readUInt16LE(RECORD_HEAD_BYTES),
          rows: record.readUInt16LE(RECORD_HEAD_BYTES + 2)
        })
      } else if (kind === KIND_RESTORE) {
        index.records.push({
          kind: 'restore',
          offset: this.position,
          length,
          at: fileStart + RECORD_HEAD_BYTES
        })
      } else {
        index.records.push({
          kind: 'clear',
          offset: this.position,
          length,
          at: fileStart + RECORD_HEAD_BYTES
        })
      }
    }
    index.endOffset = this.position
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
