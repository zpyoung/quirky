import { describe, expect, test } from 'bun:test'
import { TailBuffer } from '../src/tail'

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

  test('a starting total continues the output position without counting earlier bytes as dropped', () => {
    const tail = new TailBuffer(16, 1000)
    expect(tail.total).toBe(1000)
    tail.append(enc('abc\ndef'))
    expect(tail.total).toBe(1007)
    expect(tail.wrapped).toBe(false)
    expect(dec(tail.replay())).toBe('abc\ndef')
  })

  test('a buffer with a starting total wraps only after its own capacity is exceeded', () => {
    const tail = new TailBuffer(8, 500)
    tail.append(enc('aaaa\nbbb'))
    expect(tail.wrapped).toBe(false)
    tail.append(enc('cc\nd'))
    expect(tail.wrapped).toBe(true)
    expect(tail.total).toBe(512)
    expect(dec(tail.snapshot())).toBe('\nbbbcc\nd')
    expect(dec(tail.replay())).toBe('bbbcc\nd')
  })
})
