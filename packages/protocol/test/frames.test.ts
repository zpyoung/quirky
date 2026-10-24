import { describe, expect, test } from 'bun:test'
import {
  PtyFrameDecoder,
  base64ToBytes,
  bytesToBase64,
  decodeTerminalOutput,
  encodePtyData,
  encodePtyJson,
  encodeTerminalOutput
} from '../src'

describe('terminal output frames', () => {
  test('round-trip stream id and bytes', () => {
    const bytes = new TextEncoder().encode('hello\r\n')
    const decoded = decodeTerminalOutput(encodeTerminalOutput(4_000_000_000, bytes))
    expect(decoded?.streamId).toBe(4_000_000_000)
    expect(new TextDecoder().decode(decoded!.bytes)).toBe('hello\r\n')
  })

  test('rejects unknown kinds', () => {
    expect(decodeTerminalOutput(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull()
  })
})

describe('pty frames', () => {
  test('decode frames split across arbitrary chunks', () => {
    const wire = new Uint8Array([
      ...encodePtyJson({ id: 1, type: 'list' }),
      ...encodePtyData('s_1', new TextEncoder().encode('abc')),
      ...encodePtyJson({ type: 'exit', sessionId: 's_1', exitCode: 0 })
    ])
    const decoder = new PtyFrameDecoder()
    const frames = []
    for (let i = 0; i < wire.length; i += 3) frames.push(...decoder.push(wire.subarray(i, i + 3)))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ kind: 'json', message: { id: 1, type: 'list' } })
    expect(frames[1].kind).toBe('data')
    if (frames[1].kind === 'data') {
      expect(frames[1].sessionId).toBe('s_1')
      expect(new TextDecoder().decode(frames[1].bytes)).toBe('abc')
    }
    expect(frames[2]).toEqual({ kind: 'json', message: { type: 'exit', sessionId: 's_1', exitCode: 0 } })
  })
})

test('base64 round-trips large binary', () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 256)
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
})
