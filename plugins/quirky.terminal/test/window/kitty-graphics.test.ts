import { expect, test } from 'bun:test'
import type { Terminal } from '@xterm/xterm'
import { createKittyGraphics } from '../../src/window/pane/kittyGraphics'
import { KittyGraphicsDecoder } from '../../src/window/pane/kittyGraphicsDecoder'

const encode = (value: string) => new TextEncoder().encode(value)

/** A terminal that records each write and, like xterm, parses it and calls back on a later timer turn. */
function fakeTerminal() {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const none = { dispose() {} }
  const terminal = {
    parser: { registerCsiHandler: () => none, registerEscHandler: () => none },
    buffer: { onBufferChange: () => none },
    write(data: string | Uint8Array, callback?: () => void) {
      writes.push(typeof data === 'string' ? data : decoder.decode(data))
      if (callback) setTimeout(callback, 0)
    }
  }
  return {
    terminal: terminal as unknown as Terminal,
    writes,
    text: () => writes.join(''),
    drain: async () => {
      for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

const REPAINT = '\x1b[?2026h\x1b[2J\x1b[H' + '\x1b[32mrow\x1b[0m\r\n'.repeat(20) + '\x1b[?2026l'
const DELETE_ALL = '\x1b_Ga=d,d=a\x1b\\'

test('output that arrives right after a replay goes straight to xterm', async () => {
  const fake = fakeTerminal()
  const graphics = createKittyGraphics(fake.terminal, () => {}, true)
  let replayParsed = false
  graphics.write(encode('old \x1b[31mred\x1b[0m'), true, () => { replayParsed = true })
  graphics.write(encode(REPAINT))
  expect(fake.text()).toBe('old \x1b[31mred\x1b[0m' + REPAINT)
  expect(replayParsed).toBe(false)
  await fake.drain()
  expect(replayParsed).toBe(true)
})

test('text waiting behind a graphics frame reaches xterm in one write', async () => {
  const fake = fakeTerminal()
  const graphics = createKittyGraphics(fake.terminal, () => {}, true)
  graphics.write(encode('a\x1b[31m' + DELETE_ALL))
  const repaint = encode(REPAINT)
  const third = Math.ceil(repaint.length / 3)
  for (let at = 0; at < repaint.length; at += third) graphics.write(repaint.subarray(at, at + third))
  await fake.drain()
  // the frame's parse barrier is the first empty write; text before it went out on the fast path
  const barrier = fake.writes.indexOf('')
  expect(fake.writes.slice(0, barrier).join('')).toBe('a\x1b[31m')
  expect(fake.writes.slice(barrier + 1).filter((write) => write !== '')).toEqual([REPAINT])
})

test('text on either side of a queued graphics frame keeps its place', async () => {
  const fake = fakeTerminal()
  const graphics = createKittyGraphics(fake.terminal, () => {}, true)
  graphics.write(encode(`start${DELETE_ALL}mid${DELETE_ALL}end`))
  await fake.drain()
  expect(fake.writes.filter((write) => write !== '')).toEqual(['start', 'mid', 'end'])
})

test('Kitty frames split at every transport boundary preserve ordinary UTF-8 and neighboring escape traffic', () => {
  const source = encode('snow 雪\x1b[31m\x1b_Ga=T,f=100,i=7;YWJj\x1b\\tail\x1b]0;title\x07')
  for (let cut = 0; cut <= source.length; cut++) {
    const text: number[] = []
    const frames: string[] = []
    const decoder = new KittyGraphicsDecoder((bytes) => text.push(...bytes), (frame) => frames.push(frame))
    decoder.push(source.subarray(0, cut)); decoder.push(source.subarray(cut))
    expect(new TextDecoder().decode(new Uint8Array(text))).toBe('snow 雪\x1b[31mtail\x1b]0;title\x07')
    expect(frames).toEqual(['a=T,f=100,i=7;YWJj'])
  }
})

test('non-graphics APC and incomplete escape prefixes remain valid terminal bytes', () => {
  const text: number[] = []
  const decoder = new KittyGraphicsDecoder((bytes) => text.push(...bytes), () => { throw new Error('not graphics') })
  decoder.push(encode('a\x1b_Xnot-kitty\x1b\\b\x1b'))
  decoder.push(encode('[32mc'))
  expect(new TextDecoder().decode(new Uint8Array(text))).toBe('a\x1b_Xnot-kitty\x1b\\b\x1b[32mc')
})

test('oversize and cancelled Kitty frames discard only that frame and resume text parsing', () => {
  const text: number[] = [], frames: string[] = []
  const decoder = new KittyGraphicsDecoder((bytes) => text.push(...bytes), (frame) => frames.push(frame), 32)
  decoder.push(encode('before\x1b_Ga=T;' + 'x'.repeat(64)))
  decoder.push(encode('\x1b\\after\x1b_Ga=t;ab\x18end'))
  expect(new TextDecoder().decode(new Uint8Array(text))).toBe('beforeafterend')
  expect(frames).toEqual([])
})
