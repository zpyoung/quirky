import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryLog, newestOffset, oldestOffset, readSegments } from '../src/history/log'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

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

  test('create discards segments left by an earlier run', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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
    const log = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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

describe('HistoryLog.openForAppend', () => {
  test('continues from the absolute offset it ends at', () => {
    const dir = freshDir()
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('xyz'))
    first.close()

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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
    const first = HistoryLog.create(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
    first.appendOutput(enc('0123456789AB'))
    first.appendOutput(enc('tail'))
    first.close()
    writeFileSync(join(dir, 'output.log'), 'garbage')

    const log = HistoryLog.openForAppend(dir, { cols: 80, rows: 24, maxSegmentBytes: 10 })
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
