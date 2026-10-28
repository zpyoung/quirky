import { expect, test } from 'bun:test'
import { KittyGraphicsDecoder } from '../../src/window/pane/kittyGraphicsDecoder'

const encode = (value: string) => new TextEncoder().encode(value)

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
