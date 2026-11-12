import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { appendFileSync, closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryLog, LogReader, newestClearOffset, newestOffset, oldestOffset, readSegments } from '../src/history/log'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

/** Segment header (16) plus the resize record every segment opens with (9). */
const OPENING_BYTES = 25

const roots: string[] = []
function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlog-'))
  roots.push(root)
  return join(root, 'session')
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outputText(dir: string): string {
  return readSegments(dir)
    .segments.flatMap((s) => s.records)
    .filter((r) => r.kind === 'output')
    .map((r) => dec(r.bytes))
    .join('')
}

function tornRecord(): Buffer {
  const head = Buffer.alloc(5)
  head[0] = 0x01
  head.writeUInt32LE(100, 1)
  return Buffer.concat([head, Buffer.from('abc')])
}

describe('HistoryLog format', () => {
  test('writes the header and length-prefixed records', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('hello'))
    log.appendResize(100, 30)
    log.appendRestore()
    log.close()

    const raw = readFileSync(join(dir, 'output.log'))
    expect(raw.subarray(0, 4).toString('latin1')).toBe('QPTL')
    expect(raw[4]).toBe(1)
    expect([...raw.subarray(5, 8)]).toEqual([0, 0, 0])
    expect(raw.readBigUInt64LE(8)).toBe(0n)

    let pos = 16
    expect(raw[pos]).toBe(0x02)
    expect(raw.readUInt32LE(pos + 1)).toBe(4)
    expect(raw.readUInt16LE(pos + 5)).toBe(80)
    expect(raw.readUInt16LE(pos + 7)).toBe(24)
    pos += 9
    expect(raw[pos]).toBe(0x01)
    expect(raw.readUInt32LE(pos + 1)).toBe(5)
    expect(raw.subarray(pos + 5, pos + 10).toString()).toBe('hello')
    pos += 10
    expect(raw[pos]).toBe(0x02)
    expect(raw.readUInt16LE(pos + 5)).toBe(100)
    expect(raw.readUInt16LE(pos + 7)).toBe(30)
    pos += 9
    expect(raw[pos]).toBe(0x03)
    expect(raw.readUInt32LE(pos + 1)).toBe(0)
    expect(raw.length).toBe(pos + 5)
  })

  test('reader reports kinds and absolute offsets', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('abc'))
    log.appendResize(90, 20)
    log.appendOutput(enc('de'))
    log.appendRestore()
    log.appendOutput(enc('f'))
    expect(log.offset).toBe(6)
    log.close()

    const { segments, unreadable } = readSegments(dir)
    expect(unreadable).toEqual([])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.startOffset).toBe(0)
    expect(segments[0]!.records.map((r) => [r.kind, r.offset])).toEqual([
      ['resize', 0],
      ['output', 0],
      ['resize', 3],
      ['output', 3],
      ['restore', 5],
      ['output', 5]
    ])
    expect(segments[0]!.records[0]).toMatchObject({ cols: 80, rows: 24 })
    expect(segments[0]!.records[2]).toMatchObject({ cols: 90, rows: 20 })
    expect(oldestOffset(dir)).toBe(0)
    expect(newestOffset(dir)).toBe(6)
  })

  test('SC-34: a clear record is zero-length, takes no output position and is found by newestClearOffset', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('abc'))
    log.appendClear()
    log.appendOutput(enc('de'))
    log.appendClear()
    log.appendOutput(enc('f'))
    expect(log.offset).toBe(6)
    log.close()

    const raw = readFileSync(join(dir, 'output.log'))
    const kinds = readSegments(dir).segments[0]!.records.map((r) => [r.kind, r.offset])
    expect(kinds).toEqual([
      ['resize', 0],
      ['output', 0],
      ['clear', 3],
      ['output', 3],
      ['clear', 5],
      ['output', 5]
    ])
    expect(raw[16 + 9 + 8]).toBe(0x04)
    expect(raw.readUInt32LE(16 + 9 + 8 + 1)).toBe(0)
    expect(newestClearOffset(readSegments(dir).segments)).toBe(5)

    const reader = LogReader.open(dir)
    try {
      expect(reader.segments[0]!.records.map((r) => [r.kind, r.offset])).toEqual(kinds)
      expect(newestClearOffset(reader.segments)).toBe(5)
    } finally {
      reader.close()
    }
  })

  test('newestClearOffset is null without a clear record and looks across segments', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 20 })
    log.appendOutput(enc('abcd'))
    expect(newestClearOffset(readSegments(dir).segments)).toBeNull()
    log.appendClear()
    log.appendOutput(enc('0123456789AB'))
    log.appendOutput(enc('tail'))
    log.close()
    expect(readSegments(dir).segments).toHaveLength(2)
    expect(newestClearOffset(readSegments(dir).segments)).toBe(4)
  })

  test('create discards segments left by an earlier run', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    first.appendOutput(enc('0123456789AB'))
    first.close()
    const second = HistoryLog.create(dir, { cols: 80, rows: 24 })
    second.appendOutput(enc('new'))
    second.close()
    expect(readSegments(dir).segments).toHaveLength(1)
    expect(outputText(dir)).toBe('new')
  })

  test('files are 0600 and the directory 0700', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    log.appendOutput(enc('0123456789AB'))
    log.close()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'output.log')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'output.1.log')).mode & 0o777).toBe(0o600)
  })
})

describe('HistoryLog rotation', () => {
  test('offsets continue across a rotation and each segment starts with a resize', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 25 })
    log.appendOutput(enc('aaaaaa'))
    log.appendResize(70, 20)
    log.appendOutput(enc('bbbbbb'))
    expect(log.offset).toBe(12)
    log.appendOutput(enc('cc'))
    log.close()

    const { segments } = readSegments(dir)
    expect(segments.map((s) => s.path.split('/').pop())).toEqual(['output.1.log', 'output.log'])
    expect(segments[0]!.startOffset).toBe(0)
    expect(segments[1]!.startOffset).toBe(12)
    for (const s of segments) expect(s.records[0]!.kind).toBe('resize')
    expect(segments[1]!.records[0]).toMatchObject({ cols: 70, rows: 20, offset: 12 })
    expect(segments[1]!.records[1]).toMatchObject({ kind: 'output', offset: 12 })
    expect(outputText(dir)).toBe('aaaaaabbbbbbcc')
  })

  test('resize and restore records count toward the segment size', () => {
    const maxSegmentBytes = 200
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes })
    for (let i = 0; i < 500; i++) {
      log.appendResize(80 + (i % 2), 24)
      log.appendRestore()
    }
    log.appendOutput(enc('end'))
    log.close()

    expect(log.offset).toBe(3)
    const resizeRecord = 9
    for (const name of ['output.log', 'output.1.log']) {
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(maxSegmentBytes + resizeRecord)
    }
    const { segments, unreadable } = readSegments(dir)
    expect(unreadable).toEqual([])
    expect(segments).toHaveLength(2)
    for (const s of segments) expect(s.startOffset).toBe(0)
    expect(newestOffset(dir)).toBe(3)
  })

  test('a rotation caused by a resize opens the next segment at the new size', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    log.appendOutput(enc('ab'))
    log.appendResize(120, 40)
    log.appendOutput(enc('c'))
    log.close()

    const { segments } = readSegments(dir)
    expect(segments.at(-1)!.records[0]).toMatchObject({ kind: 'resize', cols: 120, rows: 40 })
    expect(outputText(dir)).toBe('abc')
    expect(log.offset).toBe(3)
  })

  test('keeps only the newest two segments of a long run', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 1600 })
    const unit = 'x'.repeat(100)
    for (let i = 0; i < 40; i++) log.appendOutput(enc(unit.slice(0, 99) + String.fromCharCode(65 + (i % 26))))
    log.close()

    const { segments } = readSegments(dir)
    expect(segments).toHaveLength(2)
    const oldest = oldestOffset(dir)
    const newest = newestOffset(dir)
    expect(newest).toBe(4000)
    expect(newest - oldest).toBeGreaterThanOrEqual(1600)
    expect(newest - oldest).toBeLessThanOrEqual(3200)
    expect(segments[1]!.startOffset).toBe(segments[0]!.startOffset + segments[0]!.records.filter((r) => r.kind === 'output').reduce((n, r) => n + r.bytes!.length, 0))
  })
})

describe('readSegments damage handling', () => {
  test('drops a torn tail and keeps the records before it', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('one'))
    log.appendOutput(enc('two'))
    log.close()
    appendFileSync(join(dir, 'output.log'), tornRecord())
    expect(outputText(dir)).toBe('onetwo')
    expect(newestOffset(dir)).toBe(6)
  })

  test('drops a partial record header at the end', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('one'))
    log.close()
    appendFileSync(join(dir, 'output.log'), Buffer.from([0x01, 0x07]))
    expect(outputText(dir)).toBe('one')
  })

  test('a segment with bad magic is unreadable and omitted', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    log.appendOutput(enc('0123456789AB'))
    log.appendOutput(enc('tail'))
    log.close()
    const rotated = join(dir, 'output.1.log')
    const raw = readFileSync(rotated)
    raw.write('NOPE', 0, 'latin1')
    writeFileSync(rotated, raw)

    const { segments, unreadable } = readSegments(dir)
    expect(unreadable).toEqual([rotated])
    expect(segments).toHaveLength(1)
    expect(oldestOffset(dir)).toBe(12)
    expect(outputText(dir)).toBe('tail')
  })

  test('an unknown format or record kind makes the segment unreadable', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('abc'))
    log.close()
    const path = join(dir, 'output.log')
    const good = readFileSync(path)

    const badFormat = Buffer.from(good)
    badFormat[4] = 9
    writeFileSync(path, badFormat)
    expect(readSegments(dir).unreadable).toEqual([path])

    writeFileSync(path, Buffer.concat([good, Buffer.from([0x7f, 0, 0, 0, 0])]))
    const result = readSegments(dir)
    expect(result.unreadable).toEqual([path])
    expect(result.segments).toEqual([])
  })

  test('a missing or empty directory reads as nothing', () => {
    const dir = freshDir()
    expect(readSegments(dir)).toEqual({ segments: [], unreadable: [] })
    expect(oldestOffset(dir)).toBe(0)
    expect(newestOffset(dir)).toBe(0)
  })
})

describe('LogReader', () => {
  /** What `readSegments` reports, read back through the indexed reader. */
  function viaReader(dir: string) {
    const reader = LogReader.open(dir)
    try {
      return {
        unreadable: reader.unreadable,
        segments: reader.segments.map((segment) => ({
          path: segment.path,
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          records: segment.records.map((record) => ({
            kind: record.kind,
            offset: record.offset,
            ...(record.kind === 'output' ? { bytes: reader.readOutput(segment, record, 0, record.length) } : {}),
            ...(record.kind === 'resize' ? { cols: record.cols, rows: record.rows } : {})
          }))
        }))
      }
    } finally {
      reader.close()
    }
  }

  function viaReadSegments(dir: string) {
    const { segments, unreadable } = readSegments(dir)
    return {
      unreadable,
      segments: segments.map((segment) => ({
        path: segment.path,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        records: segment.records.map((record) => ({
          kind: record.kind,
          offset: record.offset,
          ...(record.kind === 'output' ? { bytes: record.bytes } : {}),
          ...(record.kind === 'resize' ? { cols: record.cols, rows: record.rows } : {})
        }))
      }))
    }
  }

  test('reports the same segments and records as readSegments, across rotation and many small records', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 9000 })
    for (let i = 0; i < 2000; i++) {
      log.appendOutput(enc(`line ${i}\n`))
      if (i % 300 === 0) log.appendResize(60 + (i % 7), 20)
      if (i % 700 === 0) log.appendRestore()
    }
    log.close()
    expect(viaReader(dir).segments).toHaveLength(2)
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
  })

  test('treats a torn tail, bad magic, unknown format, unknown kind and a bad resize like readSegments', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    log.appendOutput(enc('0123456789AB'))
    log.appendOutput(enc('tail'))
    log.close()
    const current = join(dir, 'output.log')
    const rotated = join(dir, 'output.1.log')
    const goodCurrent = readFileSync(current)
    const goodRotated = readFileSync(rotated)

    appendFileSync(current, tornRecord())
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
    expect(viaReader(dir).unreadable).toEqual([])

    const badMagic = Buffer.from(goodRotated)
    badMagic.write('NOPE', 0, 'latin1')
    writeFileSync(rotated, badMagic)
    writeFileSync(current, goodCurrent)
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
    expect(viaReader(dir).unreadable).toEqual([rotated])

    writeFileSync(rotated, goodRotated)
    const badFormat = Buffer.from(goodCurrent)
    badFormat[4] = 9
    writeFileSync(current, badFormat)
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
    expect(viaReader(dir).unreadable).toEqual([current])

    writeFileSync(current, Buffer.concat([goodCurrent, Buffer.from([0x7f, 0, 0, 0, 0])]))
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
    expect(viaReader(dir).unreadable).toEqual([current])

    const wrongResize = Buffer.concat([goodCurrent, Buffer.from([0x02, 2, 0, 0, 0, 1, 2])])
    writeFileSync(current, wrongResize)
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
    expect(viaReader(dir).unreadable).toEqual([current])

    writeFileSync(current, Buffer.alloc(3))
    expect(viaReader(dir)).toEqual(viaReadSegments(dir))
  })

  test('a missing directory reads as nothing', () => {
    const reader = LogReader.open(freshDir())
    expect(reader.segments).toEqual([])
    expect(reader.unreadable).toEqual([])
    reader.close()
  })

  test('indexing and a ranged read touch only the framing and the bytes asked for', () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const body = new Uint8Array(mib).map((_, i) => i % 251)
    for (let i = 0; i < 8; i++) log.appendOutput(body)
    log.close()

    const real = { ...fs }
    let total = 0
    mock.module('node:fs', () => ({
      ...real,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = real.readSync(...args)
        total += n
        return n
      },
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        const data = real.readFileSync(...args)
        total += data.length
        return data
      }
    }))
    try {
      const reader = LogReader.open(dir)
      expect(reader.segments[0]!.endOffset).toBe(8 * mib)
      expect(total).toBeLessThan(64 * 1024)

      const record = reader.segments[0]!.records.filter((r) => r.kind === 'output')[3]!
      total = 0
      const bytes = reader.readOutput(reader.segments[0]!, record, 1000, 1500)
      expect(total).toBe(500)
      expect(bytes).toEqual(body.subarray(1000, 1500))
      reader.close()
    } finally {
      mock.module('node:fs', () => real)
    }
  })
})

describe('HistoryLog.openForAppend', () => {
  test('continues from the absolute offset it ends at', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('xyz'))
    first.close()

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 20 })
    expect(log.offset).toBe(15)
    log.appendRestore()
    log.appendOutput(enc('!'))
    expect(log.offset).toBe(16)
    log.close()
    expect(outputText(dir)).toBe('0123456789ABxyz!')
  })

  test('truncates a torn tail, and a second torn tail after reopening loses nothing newer (SC-20)', () => {
    const dir = freshDir()
    const path = join(dir, 'output.log')
    const first = HistoryLog.create(dir, { cols: 80, rows: 24 })
    first.appendOutput(enc('A'))
    first.appendOutput(enc('B'))
    first.close()
    appendFileSync(path, tornRecord())

    const second = HistoryLog.openForAppend(dir, { cols: 80, rows: 24 })
    expect(second.offset).toBe(2)
    second.appendRestore()
    second.appendOutput(enc('C'))
    second.close()
    expect(outputText(dir)).toBe('ABC')
    expect(readFileSync(path).includes(Buffer.from('abc'))).toBe(false)

    appendFileSync(path, tornRecord())
    const third = HistoryLog.openForAppend(dir, { cols: 80, rows: 24 })
    expect(third.offset).toBe(3)
    third.appendRestore()
    third.appendOutput(enc('D'))
    third.close()

    expect(outputText(dir)).toBe('ABCD')
    const kinds = readSegments(dir).segments[0]!.records.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'restore')).toHaveLength(2)
  })

  test('rewrites a bad header with the last known offset', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('tail'))
    first.close()
    writeFileSync(join(dir, 'output.log'), 'garbage')

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    expect(log.offset).toBe(12)
    log.appendOutput(enc('new'))
    log.close()

    const { segments, unreadable } = readSegments(dir)
    expect(unreadable).toEqual([])
    expect(segments.map((s) => s.startOffset)).toEqual([0, 12])
    expect(segments[1]!.records[0]!.kind).toBe('resize')
    expect(outputText(dir)).toBe('0123456789ABnew')
  })

  test('starts at offset 0 when nothing exists yet', () => {
    const dir = freshDir()
    const log = HistoryLog.openForAppend(dir, { cols: 100, rows: 40 })
    expect(log.offset).toBe(0)
    log.appendOutput(enc('hi'))
    log.close()
    const seg = readSegments(dir).segments[0]!
    expect(seg.records[0]).toMatchObject({ kind: 'resize', cols: 100, rows: 40 })
    expect(outputText(dir)).toBe('hi')
  })
})

describe('HistoryLog failure handling', () => {
  test('a write error disables the log, logs once, and never throws', () => {
    const dir = freshDir()
    const messages: string[] = []
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, log: (m) => messages.push(m) })
    log.appendOutput(enc('before'))
    closeSync((log as unknown as { fd: number }).fd)

    expect(() => log.appendOutput(enc('after'))).not.toThrow()
    expect(log.disabled).toBe(true)
    expect(() => log.appendResize(1, 1)).not.toThrow()
    expect(() => log.appendRestore()).not.toThrow()
    expect(() => log.appendOutput(enc('more'))).not.toThrow()
    expect(() => log.close()).not.toThrow()
    expect(messages).toHaveLength(1)
    expect(log.offset).toBe(6)
    expect(outputText(dir)).toBe('before')
  })

  test('a log that cannot be created is disabled instead of throwing', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '..', 'blocker'), 'x')
    const messages: string[] = []
    const log = HistoryLog.create(join(dir, '..', 'blocker', 'session'), { cols: 80, rows: 24, log: (m) => messages.push(m) })
    expect(log.disabled).toBe(true)
    expect(messages).toHaveLength(1)
    expect(() => log.appendOutput(enc('x'))).not.toThrow()
  })
})
describe('HistoryLog indexed reader', () => {
  function summaryFromReader(reader: LogReader) {
    return {
      unreadable: reader.unreadable,
      segments: reader.segments.map((segment) => ({
        path: segment.path,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        output: Buffer.concat(
          segment.records
            .filter((record) => record.kind === 'output')
            .map((record) => Buffer.from(reader.readOutput(segment, record, 0, record.length)))
        ),
        events: segment.records
          .filter((record) => record.kind !== 'output')
          .map((record) => ({
            kind: record.kind,
            offset: record.offset,
            ...(record.kind === 'resize' ? { cols: record.cols, rows: record.rows } : {})
          }))
      }))
    }
  }

  function summaryFromDisk(dir: string) {
    const { segments, unreadable } = readSegments(dir)
    return {
      unreadable,
      segments: segments.map((segment) => ({
        path: segment.path,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        output: Buffer.concat(
          segment.records
            .filter((record) => record.kind === 'output')
            .map((record) => Buffer.from(record.bytes!))
        ),
        events: segment.records
          .filter((record) => record.kind !== 'output')
          .map((record) => ({
            kind: record.kind,
            offset: record.offset,
            ...(record.kind === 'resize' ? { cols: record.cols, rows: record.rows } : {})
          }))
      }))
    }
  }

  function countDiskOpens<T>(run: (count: () => number) => T): T {
    const original = LogReader.open
    let total = 0
    LogReader.open = (dir) => {
      total++
      return original(dir)
    }
    try {
      return run(() => total)
    } finally {
      LogReader.open = original
    }
  }

  test('keeps a small grouped index for a large open log without reading the file', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const line = enc('x'.repeat(100))
    for (let i = 0; i < 40_000; i++) log.appendOutput(line)

    const real = { ...fs }
    let total = 0
    mock.module('node:fs', () => ({
      ...real,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = real.readSync(...args)
        total += n
        return n
      }
    }))
    try {
      const reader = log.reader()
      try {
        expect(reader.segments[0]!.records.length).toBeLessThan(200)
        expect(reader.segments[0]!.startOffset).toBe(0)
        expect(reader.segments[0]!.endOffset).toBe(4_000_000)
        expect(total).toBe(0)
      } finally {
        reader.close()
      }
    } finally {
      mock.module('node:fs', () => real)
      log.close()
    }
  })

  test('groups small outputs and keeps large outputs and non-output records as boundaries', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    for (let i = 0; i < 10; i++) log.appendOutput(enc('a'.repeat(100)))
    log.appendOutput(enc('b'.repeat(4096)))
    for (let i = 0; i < 3; i++) log.appendOutput(enc('c'.repeat(100)))
    log.appendResize(90, 30)
    for (let i = 0; i < 2; i++) log.appendOutput(enc('d'.repeat(100)))

    const reader = log.reader()
    try {
      expect(reader.segments[0]!.records.slice(1).map((record) =>
        record.kind === 'output' ? [record.kind, record.length, record.joined] : [record.kind]
      )).toEqual([
        ['output', 1000, true],
        ['output', 4096, undefined],
        ['output', 300, true],
        ['resize'],
        ['output', 200, true]
      ])
    } finally {
      reader.close()
      log.close()
    }
  })

  test('bounds joined entries by their file bytes', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const line = enc('x'.repeat(100))
    for (let i = 0; i < 1000; i++) log.appendOutput(line)

    const reader = log.reader()
    try {
      const outputs = reader.segments[0]!.records.filter((record) => record.kind === 'output')
      const fileSize = statSync(join(dir, 'output.log')).size
      const spans = outputs.map((record, i) => {
        const next = outputs[i + 1]
        return (next ? next.at - 5 : fileSize) - (record.at - 5)
      })
      expect(Math.max(...spans)).toBeLessThanOrEqual(65_536 + 4095 + 5)
    } finally {
      reader.close()
      log.close()
    }
  })

  test('reads ranges from joined outputs in one file read', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('aaaa'))
    log.appendOutput(enc('bbbb'))
    log.appendOutput(enc('cccc'))

    const real = { ...fs }
    let total = 0
    mock.module('node:fs', () => ({
      ...real,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = real.readSync(...args)
        total++
        return n
      }
    }))
    try {
      const reader = log.reader()
      try {
        const segment = reader.segments[0]!
        const entry = segment.records.find((record) => record.kind === 'output')!
        expect(entry.joined).toBe(true)
        expect(dec(reader.readOutput(segment, entry, 2, 10))).toBe('aabbbbcc')
        expect(total).toBe(1)

        total = 0
        expect(dec(reader.readOutput(segment, entry, 0, 99))).toBe('aaaabbbbcccc')
        expect(total).toBe(1)
      } finally {
        reader.close()
      }
    } finally {
      mock.module('node:fs', () => real)
      log.close()
    }
  })

  test('uses the writer index across rotation without reading record heads', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 9000 })
    for (let i = 0; i < 2000; i++) {
      log.appendOutput(enc(`line ${i}\n`))
      if (i % 300 === 0) log.appendResize(60 + (i % 7), 20)
      if (i % 700 === 0) log.appendRestore()
    }

    const real = { ...fs }
    let total = 0
    mock.module('node:fs', () => ({
      ...real,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = real.readSync(...args)
        total += n
        return n
      }
    }))
    try {
      const reader = log.reader()
      try {
        expect(reader.segments).toHaveLength(2)
        expect(total).toBe(0)
        expect(summaryFromReader(reader)).toEqual(summaryFromDisk(dir))
      } finally {
        reader.close()
      }
    } finally {
      mock.module('node:fs', () => real)
      log.close()
    }
  })

  test('indexes a restored log’s older segment once', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('tail!'))
    first.close()

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    const firstReader = log.reader()
    try {
      expect(summaryFromReader(firstReader)).toEqual(summaryFromDisk(dir))
    } finally {
      firstReader.close()
    }

    const real = { ...fs }
    let total = 0
    mock.module('node:fs', () => ({
      ...real,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        const n = real.readSync(...args)
        total += n
        return n
      }
    }))
    try {
      const secondReader = log.reader()
      try {
        expect(total).toBe(0)
        expect(summaryFromReader(secondReader)).toEqual(summaryFromDisk(dir))
      } finally {
        secondReader.close()
      }
    } finally {
      mock.module('node:fs', () => real)
      log.close()
    }
  })

  test('reports an unreadable older segment after append restore', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('tail!'))
    first.close()
    writeFileSync(join(dir, 'output.1.log'), 'garbage')

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 10 })
    const expected = summaryFromDisk(dir)
    for (let i = 0; i < 2; i++) {
      const reader = log.reader()
      try {
        expect(summaryFromReader(reader)).toEqual(expected)
      } finally {
        reader.close()
      }
    }
    log.close()
  })

  test('keeps an open reader independent of later appends', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('first'))

    const snapshot = log.reader()
    try {
      const segment = snapshot.segments[0]!
      const entry = segment.records.find((record) => record.kind === 'output')!
      log.appendOutput(enc('second'))
      expect(entry.length).toBe(5)
      expect(dec(snapshot.readOutput(segment, entry, 0, entry.length))).toBe('first')

      const current = log.reader()
      try {
        const currentSegment = current.segments[0]!
        const currentEntry = currentSegment.records.find((record) => record.kind === 'output')!
        expect(dec(current.readOutput(currentSegment, currentEntry, 0, currentEntry.length))).toBe('firstsecond')
      } finally {
        current.close()
      }
    } finally {
      snapshot.close()
      log.close()
    }
  })

  test('keeps an open reader independent of rotation', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: OPENING_BYTES + 9 })
    log.appendOutput(enc('first'))

    const snapshot = log.reader()
    try {
      log.appendOutput(enc('next!'))
      expect(summaryFromReader(snapshot).segments.map((segment) => dec(segment.output)).join('')).toBe('first')

      const current = log.reader()
      try {
        expect(summaryFromReader(current).segments.map((segment) => dec(segment.output)).join('')).toBe('next!')
      } finally {
        current.close()
      }
    } finally {
      snapshot.close()
      log.close()
    }
  })

  test('uses the in-memory index after a healthy log is closed', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('closed'))
    log.close()

    countDiskOpens((count) => {
      const reader = log.reader()
      try {
        expect(summaryFromReader(reader)).toEqual(summaryFromDisk(dir))
        expect(count()).toBe(0)
      } finally {
        reader.close()
      }
    })
  })

  test('falls back to the disk reader when an indexed segment is truncated', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    for (let i = 0; i < 200; i++) log.appendOutput(enc(`line ${i}\n`))
    const path = join(dir, 'output.log')
    const bytes = readFileSync(path)
    writeFileSync(path, bytes.subarray(0, bytes.length - 3))
    const expected = summaryFromDisk(dir)

    countDiskOpens((count) => {
      const reader = log.reader()
      try {
        expect(summaryFromReader(reader)).toEqual(expected)
        expect(count()).toBe(1)
      } finally {
        reader.close()
      }
    })
    log.close()
  })

  test('falls back to the disk reader when an indexed segment is missing', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('missing'))
    rmSync(join(dir, 'output.log'))
    const expected = summaryFromDisk(dir)

    countDiskOpens((count) => {
      const reader = log.reader()
      try {
        expect(summaryFromReader(reader)).toEqual(expected)
        expect(count()).toBe(1)
      } finally {
        reader.close()
      }
    })
    log.close()
  })

  test('falls back to the disk reader when the writer is disabled', () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('before'))
    closeSync((log as unknown as { fd: number }).fd)
    log.appendOutput(enc('after'))
    expect(log.disabled).toBe(true)
    const expected = summaryFromDisk(dir)

    countDiskOpens((count) => {
      const reader = log.reader()
      try {
        expect(summaryFromReader(reader)).toEqual(expected)
        expect(count()).toBe(1)
      } finally {
        reader.close()
      }
    })
    log.close()
  })
})
