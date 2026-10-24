import { describe, expect, test } from 'bun:test'
import { TailBuffer } from '../src/tail'
import { RotatingLog } from '../src/log'
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('TailBuffer', () => {
  test('keeps everything until it wraps', () => {
    const tail = new TailBuffer(16)
    tail.append(enc('abc\n'))
    tail.append(enc('def'))
    expect(dec(tail.snapshot())).toBe('abc\ndef')
    expect(tail.wrapped).toBe(false)
    expect(tail.total).toBe(7)
  })

  test('keeps the last capacity bytes after wrapping, across several appends', () => {
    const tail = new TailBuffer(8)
    tail.append(enc('0123'))
    tail.append(enc('4567'))
    tail.append(enc('89ab'))
    expect(dec(tail.snapshot())).toBe('456789ab')
    expect(tail.wrapped).toBe(true)
    tail.append(enc('x'.repeat(20)))
    expect(dec(tail.snapshot())).toBe('xxxxxxxx')
    expect(tail.total).toBe(32)
  })

  test('replay starts after the first newline once wrapped', () => {
    const tail = new TailBuffer(10)
    tail.append(enc('aaaa\nbbbb\ncc'))
    expect(dec(tail.snapshot())).toBe('aa\nbbbb\ncc')
    expect(dec(tail.replay())).toBe('bbbb\ncc')
  })

  test('replay of an unwrapped tail is the whole tail', () => {
    const tail = new TailBuffer(64)
    tail.append(enc('no newline yet'))
    expect(dec(tail.replay())).toBe('no newline yet')
  })
})

describe('RotatingLog', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'qpty-log-'))

  test('appends to output.log', () => {
    const d = dir()
    const log = new RotatingLog(d, 1024)
    log.append(enc('hello '))
    log.append(enc('world'))
    log.close()
    expect(readFileSync(join(d, 'output.log'), 'utf8')).toBe('hello world')
    rmSync(d, { recursive: true })
  })

  test('rotates to output.1.log when the threshold is exceeded, replacing the previous one', () => {
    const d = dir()
    const log = new RotatingLog(d, 10)
    log.append(enc('aaaaaaaa'))
    expect(existsSync(join(d, 'output.1.log'))).toBe(false)
    log.append(enc('bbbb'))
    expect(readFileSync(join(d, 'output.1.log'), 'utf8')).toBe('aaaaaaaabbbb')
    expect(statSync(join(d, 'output.log')).size).toBe(0)
    log.append(enc('cc'))
    log.append(enc('dddddddddd'))
    expect(readFileSync(join(d, 'output.1.log'), 'utf8')).toBe('ccdddddddddd')
    log.append(enc('e'))
    log.close()
    expect(readFileSync(join(d, 'output.log'), 'utf8')).toBe('e')
    rmSync(d, { recursive: true })
  })

  test('truncates a stale log left by an earlier host', () => {
    const d = dir()
    const first = new RotatingLog(d, 4)
    first.append(enc('stale-stale'))
    first.close()
    const second = new RotatingLog(d, 1024)
    second.append(enc('fresh'))
    second.close()
    expect(readFileSync(join(d, 'output.log'), 'utf8')).toBe('fresh')
    expect(existsSync(join(d, 'output.1.log'))).toBe(false)
    rmSync(d, { recursive: true })
  })
})
