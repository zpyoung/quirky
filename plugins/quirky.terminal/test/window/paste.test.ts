import { describe, expect, test } from 'bun:test'
import {
  BRACKETED_END,
  BRACKETED_START,
  PASTE_CHUNK_BYTES,
  PASTE_DIRECT_BYTES,
  PASTE_MAX_BYTES,
  planPaste,
  runPaste
} from '../../src/window/pane/paste'

const bytes = (text: string) => new TextEncoder().encode(text).length

describe('planPaste', () => {
  test('SC-37: 10 KiB goes in one write', () => {
    const plan = planPaste('x'.repeat(10 * 1024), false)
    expect(plan.kind).toBe('write')
    if (plan.kind === 'write') expect(plan.chunks).toHaveLength(1)
  })

  test('SC-37: 200 KiB arrives complete and in order in 16 KiB writes', () => {
    const text = Array.from({ length: 200 * 1024 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
    const plan = planPaste(text, false)
    if (plan.kind !== 'write') throw new Error('refused')
    expect(plan.chunks.length).toBe(13)
    expect(plan.chunks.every((chunk) => bytes(chunk) <= PASTE_CHUNK_BYTES)).toBe(true)
    expect(plan.chunks.join('')).toBe(text)
  })

  test('the direct limit is 64 KiB of text and one byte more is chunked', () => {
    const exact = planPaste('a'.repeat(PASTE_DIRECT_BYTES), false)
    const over = planPaste('a'.repeat(PASTE_DIRECT_BYTES + 1), false)
    if (exact.kind !== 'write' || over.kind !== 'write') throw new Error('refused')
    expect(exact.chunks).toHaveLength(1)
    expect(over.chunks.length).toBeGreaterThan(1)
  })

  test('SC-37: 20 MiB is refused and 16 MiB is not', () => {
    expect(planPaste('a'.repeat(20 * 1024 * 1024), false).kind).toBe('refused')
    expect(planPaste('a'.repeat(PASTE_MAX_BYTES + 1), false).kind).toBe('refused')
    expect(planPaste('a'.repeat(PASTE_MAX_BYTES), false).kind).toBe('write')
  })

  test('the size limit counts UTF-8 bytes, not characters', () => {
    expect(planPaste('€'.repeat(Math.floor(PASTE_MAX_BYTES / 3) + 1), false).kind).toBe('refused')
  })

  test('newlines become carriage returns', () => {
    const plan = planPaste('a\r\nb\nc\rd', false)
    if (plan.kind !== 'write') throw new Error('refused')
    expect(plan.chunks).toEqual(['a\rb\rc\rd'])
  })

  test('SC-37: bracketed markers wrap the text only when the program asked for them', () => {
    const plain = planPaste('hi', false)
    const bracketed = planPaste('hi', true)
    if (plain.kind !== 'write' || bracketed.kind !== 'write') throw new Error('refused')
    expect(plain.chunks).toEqual(['hi'])
    expect(bracketed.chunks).toEqual([`${BRACKETED_START}hi${BRACKETED_END}`])
  })

  test('a chunked bracketed paste sends the markers around the chunks and escapes inside become inert', () => {
    const plan = planPaste(`${'a'.repeat(PASTE_DIRECT_BYTES)}\x1b[201~tail`, true)
    if (plan.kind !== 'write') throw new Error('refused')
    expect(plan.chunks[0]).toBe(BRACKETED_START)
    expect(plan.chunks.at(-1)).toBe(BRACKETED_END)
    expect(plan.chunks.join('')).not.toContain('\x1b[201~tail')
    expect(plan.closer).toBe(BRACKETED_END)
  })

  test('a chunk boundary never splits a surrogate pair or a multi-byte character', () => {
    const text = '😀'.repeat(PASTE_DIRECT_BYTES / 4 + 10)
    const plan = planPaste(text, false)
    if (plan.kind !== 'write') throw new Error('refused')
    for (const chunk of plan.chunks) expect(bytes(chunk)).toBeLessThanOrEqual(PASTE_CHUNK_BYTES)
    expect(plan.chunks.join('')).toBe(text)
  })

  test('empty text writes nothing', () => {
    const plan = planPaste('', true)
    if (plan.kind !== 'write') throw new Error('refused')
    expect(plan.chunks).toEqual([])
  })
})

describe('runPaste', () => {
  test('awaits each write before sending the next', async () => {
    const order: string[] = []
    let pending = 0
    const send = async (data: string) => {
      pending += 1
      expect(pending).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 1))
      order.push(data)
      pending -= 1
    }
    expect(await runPaste(['a', 'b', 'c'], send, { closer: null })).toBe('done')
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('stops at the overall timeout and still sends the closer', async () => {
    const sent: string[] = []
    let clock = 0
    const send = async (data: string) => {
      sent.push(data)
      clock += 20_000
    }
    const result = await runPaste(['a', 'b', 'c', 'd'], send, { timeoutMs: 30_000, now: () => clock, closer: BRACKETED_END })
    expect(result).toBe('timeout')
    expect(sent).toEqual(['a', 'b', BRACKETED_END])
  })

  test('a write that never settles hits the timeout', async () => {
    const sent: string[] = []
    const send = (data: string) => {
      sent.push(data)
      return data === 'a' ? new Promise<void>(() => {}) : Promise.resolve()
    }
    expect(await runPaste(['a', 'b'], send, { timeoutMs: 20, closer: null })).toBe('timeout')
    expect(sent).toEqual(['a'])
  })

  test('a failed write ends the paste', async () => {
    const sent: string[] = []
    const send = async (data: string) => {
      sent.push(data)
      if (data === 'b') throw new Error('gone')
    }
    expect(await runPaste(['a', 'b', 'c'], send, { closer: null })).toBe('failed')
    expect(sent).toEqual(['a', 'b'])
  })
})
