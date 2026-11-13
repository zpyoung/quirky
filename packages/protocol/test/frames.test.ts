import { describe, expect, test } from 'bun:test'
import {
  PtyFrameDecoder,
  QuirkyClient,
  base64ToBytes,
  bytesToBase64,
  decodeTerminalFrame,
  decodeTerminalOutput,
  encodePtyData,
  encodePtyJson,
  encodeTerminalLagged,
  encodeTerminalOutput
} from '../src'

type ClientInternals = {
  handleMessage(data: unknown): void
  handleClose(): void
  streamBuffers: Map<number, Uint8Array[]>
  laggedStreams: Set<number>
}

function internals(client: QuirkyClient): ClientInternals {
  return client as unknown as ClientInternals
}

function makeClient(): QuirkyClient {
  return new (QuirkyClient as unknown as new (
    transport: { send(text: string): void; close(): void }
  ) => QuirkyClient)({ send() {}, close() {} })
}

function deliver(client: QuirkyClient, frame: Uint8Array): void {
  internals(client).handleMessage(frame)
}

describe('terminal output frames', () => {
  test('round-trip stream id and bytes', () => {
    const bytes = new TextEncoder().encode('hello\r\n')
    const decoded = decodeTerminalOutput(encodeTerminalOutput(4_000_000_000, bytes))
    expect(decoded?.streamId).toBe(4_000_000_000)
    expect(new TextDecoder().decode(decoded!.bytes)).toBe('hello\r\n')
    expect(decodeTerminalFrame(encodeTerminalOutput(4_000_000_000, bytes))).toEqual({
      kind: 'output',
      streamId: 4_000_000_000,
      bytes
    })
  })

  test('rejects unknown kinds', () => {
    expect(decodeTerminalOutput(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull()
  })
})

test('encodes and decodes terminal lagged frames', () => {
  const frame = encodeTerminalLagged(4_000_000_000)

  expect(frame).toEqual(new Uint8Array([2, 0xee, 0x6b, 0x28, 0x00]))
  expect(decodeTerminalFrame(frame)).toEqual({ kind: 'lagged', streamId: 4_000_000_000 })
  expect(decodeTerminalOutput(frame)).toBeNull()
  expect(decodeTerminalFrame(new Uint8Array([2, 0, 0, 0]))).toBeNull()
  expect(decodeTerminalFrame(new Uint8Array([2, 0, 0, 0, 1, 99]))).toBeNull()
  expect(decodeTerminalFrame(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull()
})

test('active terminal listeners receive output and one synchronous lag notification', () => {
  const client = makeClient()
  const output: Uint8Array[] = []
  let lagged = 0
  client.onTerminalOutput(7, (bytes) => output.push(bytes), { onLagged: () => lagged++ })

  deliver(client, encodeTerminalOutput(7, new Uint8Array([0x61])))
  expect(lagged).toBe(0)
  deliver(client, encodeTerminalLagged(7))
  expect(lagged).toBe(1)
  deliver(client, encodeTerminalLagged(7))
  deliver(client, encodeTerminalOutput(7, new Uint8Array([0x62])))

  expect(output).toEqual([new Uint8Array([0x61])])
  expect(lagged).toBe(1)
})

test('pre-listener overflow drops buffered output and asynchronously notifies unless disposed', async () => {
  const client = makeClient()
  const maximum = 4 * 1024 * 1024
  deliver(client, encodeTerminalOutput(8, new Uint8Array(maximum)))
  deliver(client, encodeTerminalOutput(8, new Uint8Array([0x62])))

  expect(internals(client).streamBuffers.has(8)).toBe(false)

  let outputCalls = 0
  let laggedCalls = 0
  client.onTerminalOutput(8, () => outputCalls++, { onLagged: () => laggedCalls++ })
  deliver(client, encodeTerminalOutput(8, new Uint8Array([0x63])))
  expect(outputCalls).toBe(0)
  expect(laggedCalls).toBe(0)
  await Promise.resolve()
  expect(laggedCalls).toBe(1)

  deliver(client, encodeTerminalLagged(9))
  let canceledCalls = 0
  const dispose = client.onTerminalOutput(9, () => outputCalls++, { onLagged: () => canceledCalls++ })
  dispose()
  expect(internals(client).laggedStreams.has(9)).toBe(false)
  await Promise.resolve()
  expect(canceledCalls).toBe(0)
})

test('disposing a replaced listener preserves the replacement stream lag latch', async () => {
  const client = makeClient()
  const streamId = 12
  deliver(client, encodeTerminalLagged(streamId))
  let replacementOutput = 0
  let replacementLagged = 0

  const disposeFirst = client.onTerminalOutput(streamId, () => {}, { onLagged: () => {} })
  const disposeReplacement = client.onTerminalOutput(
    streamId,
    () => replacementOutput++,
    { onLagged: () => replacementLagged++ }
  )
  disposeFirst()
  deliver(client, encodeTerminalOutput(streamId, new Uint8Array([0x61])))

  expect(replacementOutput).toBe(0)
  expect(replacementLagged).toBe(0)
  await Promise.resolve()
  expect(replacementLagged).toBe(1)
  disposeReplacement()
})

test('socket close cancels a queued pre-listener lag notification', async () => {
  const client = makeClient()
  const events: string[] = []
  client.onClose(() => events.push('closed'))
  deliver(client, encodeTerminalLagged(13))
  client.onTerminalOutput(13, () => {}, { onLagged: () => events.push('lagged') })

  internals(client).handleClose()

  expect(events).toEqual(['closed'])
  await Promise.resolve()
  expect(events).toEqual(['closed'])
})

test('terminal lag latches are bounded to the newest 1024 stream ids', () => {
  const client = makeClient()
  for (let streamId = 0; streamId <= 1024; streamId++) {
    deliver(client, encodeTerminalLagged(streamId))
  }

  const laggedStreams = internals(client).laggedStreams
  expect(laggedStreams.size).toBe(1024)
  expect(laggedStreams.has(0)).toBe(false)
  expect(laggedStreams.has(1024)).toBe(true)
})

test('socket close clears buffered output and lag latches', () => {
  const client = makeClient()
  deliver(client, encodeTerminalOutput(10, new Uint8Array([0x61])))
  deliver(client, encodeTerminalLagged(11))
  const state = internals(client)

  expect(state.streamBuffers.size).toBe(1)
  expect(state.laggedStreams.size).toBe(1)
  state.handleClose()
  expect(state.streamBuffers.size).toBe(0)
  expect(state.laggedStreams.size).toBe(0)
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
