import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HistoryLog,
  LogReader,
  STORED_INDEX_MAX_ENTRIES,
  loadStoredLogIndex,
  newestClearOffset,
  readSegments
} from '../src/history/log'

const MiB = 1024 * 1024
const roots: string[] = []
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'qstored-index-'))
  roots.push(root)
  const dir = join(root, 'session')
  fs.mkdirSync(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rawRecord(kind: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(5 + payload.length)
  bytes[0] = kind
  bytes.writeUInt32LE(payload.length, 1)
  bytes.set(payload, 5)
  return bytes
}

function rawSegment(startOffset: number, records: Uint8Array[]): Buffer {
  const header = Buffer.alloc(16)
  header.write('QPTL', 0, 'latin1')
  header[4] = 1
  header.writeBigUInt64LE(BigInt(startOffset), 8)
  return Buffer.concat([header, ...records])
}

function writeSegment(dir: string, name: string, startOffset: number, records: Uint8Array[]): string {
  const path = join(dir, name)
  fs.mkdirSync(dir, { recursive: true })
  writeFileSync(path, rawSegment(startOffset, records))
  return path
}

function readerSummary(reader: LogReader) {
  return {
    unreadable: reader.unreadable,
    newestClearOffset: newestClearOffset(reader.segments),
    segments: reader.segments.map((segment) => ({
      path: segment.path,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      output: Buffer.concat(
        segment.records
          .filter((record) => record.kind === 'output')
          .map((record) => Buffer.from(reader.readOutput(segment, record, 0, record.length)))
      ),
      resize: segment.records
        .filter((record) => record.kind === 'resize')
        .map((record) => ({ offset: record.offset, cols: record.cols, rows: record.rows }))
    }))
  }
}

function diskSummary(dir: string) {
  const { segments, unreadable } = readSegments(dir)
  return {
    unreadable,
    newestClearOffset: newestClearOffset(segments),
    segments: segments.map((segment) => ({
      path: segment.path,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      output: Buffer.concat(
        segment.records
          .filter((record) => record.kind === 'output')
          .map((record) => Buffer.from(record.bytes!))
      ),
      resize: segment.records
        .filter((record) => record.kind === 'resize')
        .map((record) => ({ offset: record.offset, cols: record.cols, rows: record.rows }))
    }))
  }
}

async function expectIndexMatchesDisk(dir: string, sliceBytes = 65_536): Promise<void> {
  const expected = diskSummary(dir)
  const expectedReader = LogReader.open(dir)
  const index = await loadStoredLogIndex(dir, { sliceBytes })
  const reader = index.reader()
  try {
    expect(readerSummary(reader)).toEqual(readerSummary(expectedReader))
    expect(readerSummary(reader)).toEqual(expected)
    expect(index.startOffset).toBe(expected.segments[0]?.startOffset ?? 0)
    expect(index.endOffset).toBe(expected.segments.at(-1)?.endOffset ?? 0)
    expect(index.unreadable).toEqual(expected.unreadable)
  } finally {
    expectedReader.close()
    reader.close()
  }
}

function replaceReaderOpen<T>(run: (calls: () => number) => T): T {
  const original = LogReader.open
  let calls = 0
  LogReader.open = (dir) => {
    calls++
    return original(dir)
  }
  try {
    return run(() => calls)
  } finally {
    LogReader.open = original
  }
}

function makeManyRecordsFile(size: number): Buffer {
  const file = Buffer.alloc(size)
  file.write('QPTL', 0, 'latin1')
  file[4] = 1
  let position = 16
  let outputCount = 0
  let resizeCount = 0
  let lastResizeAt = -1
  let lastClearAt = -1
  while (position + 5 <= file.length) {
    if (position + 9 <= file.length && outputCount > 0 && outputCount % 10_000 === 0 && lastResizeAt !== outputCount) {
      file[position] = 0x02
      file.writeUInt32LE(4, position + 1)
      file.writeUInt16LE(80 + (resizeCount % 20), position + 5)
      file.writeUInt16LE(24 + (resizeCount % 10), position + 7)
      position += 9
      resizeCount++
      lastResizeAt = outputCount
    } else if (outputCount > 0 && outputCount % 20_000 === 0 && lastClearAt !== outputCount) {
      file[position] = 0x04
      file.writeUInt32LE(0, position + 1)
      position += 5
      lastClearAt = outputCount
    } else {
      file[position] = 0x01
      file.writeUInt32LE(0, position + 1)
      position += 5
      outputCount++
    }
  }
  return file
}

function rotatedFixture(): string {
  const dir = freshDir()
  const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 40 })
  log.appendOutput(encoder.encode('first segment payload'))
  log.appendOutput(encoder.encode('hello'))
  log.close()
  return dir
}

describe('loadStoredLogIndex', () => {
  test('loads a 1 MiB file in awaited bounded slices and never opens LogReader', async () => {
    const dir = freshDir()
    const records = Array.from({ length: MiB / 128 }, () => rawRecord(0x01, Buffer.alloc(123, 0x61)))
    writeSegment(dir, 'output.log', 0, records)

    const real = { ...fsp }
    const readSizes: number[] = []
    mock.module('node:fs/promises', () => ({
      ...real,
      open: async (...args: Parameters<typeof fsp.open>) => {
        const handle = await real.open(...args)
        const read = handle.read.bind(handle)
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number | null) => {
          readSizes.push(length)
          return read(buffer, offset, length, position)
        }) as typeof handle.read
        return handle
      }
    }))

    let yielded = 0
    try {
      await replaceReaderOpen(async (calls) => {
        const index = await loadStoredLogIndex(dir, {
          sliceBytes: 65_536,
          beforeSlice: () => {
            const callback = Promise.withResolvers<void>()
            setImmediate(() => {
              yielded++
              callback.resolve()
            })
            return callback.promise
          }
        })
        expect(index.endOffset).toBe(MiB / 128 * 123)
        expect(yielded).toBeGreaterThanOrEqual(15)
        expect(readSizes.length).toBeGreaterThanOrEqual(16)
        expect(Math.max(...readSizes)).toBeLessThanOrEqual(65_536)
        expect(calls()).toBe(0)
      })
    } finally {
      mock.module('node:fs/promises', () => real)
    }
  })

  test('slices a control-only file by file bytes and retains joined outputs, newest clears, and every resize', async () => {
    const dir = freshDir()
    const path = join(dir, 'output.log')
    fs.mkdirSync(dir, { recursive: true })
    writeFileSync(path, makeManyRecordsFile(2 * MiB))
    let slices = 0
    const index = await loadStoredLogIndex(dir, {
      sliceBytes: 65_536,
      beforeSlice: () => { slices++ }
    })
    const reader = index.reader()
    try {
      const records = reader.segments[0]!.records
      expect(slices).toBeGreaterThanOrEqual(32)
      expect(records.filter((record) => record.kind === 'output').length).toBeLessThan(100)
      expect(records.filter((record) => record.kind === 'clear')).toHaveLength(1)
      expect(records.filter((record) => record.kind === 'resize')).toHaveLength(
        readSegments(dir).segments[0]!.records.filter((record) => record.kind === 'resize').length
      )
    } finally {
      reader.close()
    }
  })

  test('agrees with LogReader across rotations, torn tails, malformed segments and record sizes', async () => {
    const rotated = rotatedFixture()
    await expectIndexMatchesDisk(rotated)

    const tornTail = freshDir()
    writeSegment(tornTail, 'output.log', 0, [
      rawRecord(0x01, encoder.encode('complete')),
      rawRecord(0x01, Buffer.alloc(100, 0x74)).subarray(0, 30)
    ])
    await expectIndexMatchesDisk(tornTail)

    const tornHead = freshDir()
    const withHead = rawSegment(0, [rawRecord(0x01, encoder.encode('complete'))])
    writeFileSync(join(tornHead, 'output.log'), Buffer.concat([withHead, Buffer.from([0x01, 0x03])]))
    await expectIndexMatchesDisk(tornHead)

    const malformed = freshDir()
    writeSegment(malformed, 'output.1.log', 0, [rawRecord(0x01, encoder.encode('previous'))])
    const badMagic = rawSegment(0, [rawRecord(0x01, encoder.encode('bad'))])
    badMagic.write('NOPE', 0, 'latin1')
    writeFileSync(join(malformed, 'output.1.log'), badMagic)
    writeSegment(malformed, 'output.log', 8, [rawRecord(0x01, encoder.encode('current'))])
    await expectIndexMatchesDisk(malformed)

    const badKind = freshDir()
    writeSegment(badKind, 'output.log', 0, [rawRecord(0x7f)])
    await expectIndexMatchesDisk(badKind)

    const badResize = freshDir()
    writeSegment(badResize, 'output.log', 0, [rawRecord(0x02, Buffer.from([1, 2]))])
    await expectIndexMatchesDisk(badResize)

    const short = freshDir()
    writeFileSync(join(short, 'output.log'), Buffer.from('short'))
    await expectIndexMatchesDisk(short)

    await expectIndexMatchesDisk(freshDir())
    const missing = freshDir()
    rmSync(missing, { recursive: true, force: true })
    await expectIndexMatchesDisk(missing)

    const sizes = freshDir()
    writeSegment(sizes, 'output.log', 0, [
      ...[0, 1, 4095, 4096, 200_000].map((size) => rawRecord(0x01, Buffer.alloc(size, size % 251)))
    ])
    await expectIndexMatchesDisk(sizes)

    const controls = freshDir()
    writeSegment(controls, 'output.log', 0, [
      rawRecord(0x01, encoder.encode('a')),
      rawRecord(0x04),
      rawRecord(0x03),
      rawRecord(0x01, encoder.encode('b')),
      rawRecord(0x04),
      rawRecord(0x03),
      rawRecord(0x01, encoder.encode('c')),
      rawRecord(0x04),
      rawRecord(0x01, encoder.encode('d'))
    ])
    await expectIndexMatchesDisk(controls)
    const index = await loadStoredLogIndex(controls)
    const reader = index.reader()
    try {
      expect(newestClearOffset(reader.segments)).toBe(3)
      expect(reader.segments.flatMap((segment) => segment.records).filter((record) => record.kind === 'clear')).toHaveLength(1)
      expect(decoder.decode(Buffer.concat(reader.segments.flatMap((segment) => segment.records
        .filter((record) => record.kind === 'output')
        .map((record) => Buffer.from(reader.readOutput(segment, record, 0, record.length))))))).toBe('abcd')
    } finally {
      reader.close()
    }
  })

  test('does not retain an index above the entry limit', async () => {
    const dir = freshDir()
    const resize = rawRecord(0x02, Buffer.from([80, 0, 24, 0]))
    const records = Array.from({ length: STORED_INDEX_MAX_ENTRIES + 4 }, () => resize)
    writeSegment(dir, 'output.log', 0, records)

    const index = await loadStoredLogIndex(dir, { sliceBytes: 65_536 })
    expect(index.entries).toBe(STORED_INDEX_MAX_ENTRIES + 4)
    expect(index.retain).toBe(false)
  })

  test('marks a changed segment unreadable and stale without a synchronous fallback', async () => {
    for (const change of ['truncate', 'replace', 'rewrite'] as const) {
      const dir = rotatedFixture()
      const current = join(dir, 'output.log')
      const previous = join(dir, 'output.1.log')
      const index = await loadStoredLogIndex(dir)
      if (change === 'truncate') {
        truncateSync(current, Math.floor(statSync(current).size / 2))
      } else if (change === 'replace') {
        const bytes = readFileSync(current)
        bytes[bytes.length - 1] ^= 1
        const replacement = join(dir, 'replacement.log')
        writeFileSync(replacement, bytes)
        renameSync(replacement, current)
      } else {
        const before = statSync(current)
        const bytes = readFileSync(current)
        bytes[bytes.length - 1] ^= 1
        writeFileSync(current, bytes)
        utimesSync(current, before.atime, before.mtime)
      }

      const original = LogReader.open
      let calls = 0
      LogReader.open = () => { calls++; throw new Error('forbidden synchronous fallback') }
      try {
        const reader = index.reader()
        expect(reader.unreadable).toContain(current)
        expect(reader.segments.map((segment) => segment.path)).toContain(previous)
        const previousSegment = reader.segments.find((segment) => segment.path === previous)!
        expect(Buffer.concat(previousSegment.records.filter((record) => record.kind === 'output')
          .map((record) => Buffer.from(reader.readOutput(previousSegment, record, 0, record.length)))).length).toBeGreaterThan(0)
        reader.close()
        expect(index.stale).toBe(true)
        expect(calls).toBe(0)
      } finally {
        LogReader.open = original
      }
    }

    const deleted = rotatedFixture()
    const deletedIndex = await loadStoredLogIndex(deleted)
    const existingPaths = [join(deleted, 'output.1.log'), join(deleted, 'output.log')]
    rmSync(deleted, { recursive: true, force: true })
    const original = LogReader.open
    LogReader.open = () => { throw new Error('forbidden synchronous fallback') }
    try {
      const reader = deletedIndex.reader()
      expect(reader.segments).toEqual([])
      expect(reader.unreadable).toEqual(existingPaths)
      expect(deletedIndex.stale).toBe(true)
      reader.close()
    } finally {
      LogReader.open = original
    }
  })

  test('observes truncation before the first slice, but marks a mid-load truncation stale', async () => {
    const firstDir = freshDir()
    writeSegment(firstDir, 'output.log', 0, [rawRecord(0x01, Buffer.alloc(200_000, 0x61))])
    const firstPath = join(firstDir, 'output.log')
 
    const firstEntered = Promise.withResolvers<void>()
    const firstGate = Promise.withResolvers<void>()
    const firstLoad = loadStoredLogIndex(firstDir, {
      sliceBytes: 65_536,
      beforeSlice: async (_path, position) => {
        if (position !== 0) return
        firstEntered.resolve()
        await firstGate.promise
      }
    })
    await firstEntered.promise
    truncateSync(firstPath, Math.floor(statSync(firstPath).size / 2))
    firstGate.resolve()
    const firstIndex = await firstLoad
    const expected = LogReader.open(firstDir)
    const firstReader = firstIndex.reader()
    try {
      expect(readerSummary(firstReader)).toEqual(readerSummary(expected))
      expect(firstIndex.stale).toBe(false)
    } finally {
      expected.close()
      firstReader.close()
    }

    const secondDir = freshDir()
    writeSegment(secondDir, 'output.log', 0, Array.from({ length: MiB / 128 }, () => rawRecord(0x01, Buffer.alloc(123, 0x62))))
    const secondPath = join(secondDir, 'output.log')
    const secondEntered = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const secondLoad = loadStoredLogIndex(secondDir, {
      sliceBytes: 65_536,
      beforeSlice: async (_path, position) => {
        if (position < 65_536) return
        secondEntered.resolve()
        await secondGate.promise
      }
    })
    await secondEntered.promise
    truncateSync(secondPath, Math.floor(statSync(secondPath).size / 2))
    secondGate.resolve()
    const secondIndex = await secondLoad
    const secondReader = secondIndex.reader()
    try {
      expect(secondReader.unreadable).toContain(secondPath)
      expect(secondIndex.stale).toBe(true)
    } finally {
      secondReader.close()
    }
  })
})
