import { expect, test } from 'bun:test'
import { OutputScanner } from '../src/scanner'

const encode = new TextEncoder()

test('OSC9999 object status survives every chunk boundary without changing terminal bytes', () => {
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'owned-provider', prompt: 'café; proceed' }
  const input = encode.encode(`before\x1b]9999;${JSON.stringify(payload)}\x1b\\after`)
  for (let split = 0; split <= input.length; split++) {
    const scanner = new OutputScanner()
    const first = scanner.push(input.subarray(0, split))
    const second = scanner.push(input.subarray(split))
    expect([...first.facts, ...second.facts]).toEqual([{ kind: 'agent-status', payload }])
    expect(Buffer.concat([first.bytes, second.bytes])).toEqual(Buffer.from(input))
    expect(scanner.atBoundary).toBe(true)
  }
})

test('malformed, non-object and oversized private reports cannot emit authority and do not poison following reports', () => {
  const scanner = new OutputScanner()
  for (const body of ['{', 'null', '[]', '"working"', JSON.stringify({ state: 'working', padding: 'x'.repeat(4096) })]) {
    expect(scanner.push(encode.encode(`\x1b]9999;${body}\x07`)).facts).toEqual([])
  }
  expect(scanner.push(encode.encode('\x1b]9999;{"state":"done"}\x07')).facts).toEqual([{ kind: 'agent-status', payload: { state: 'done' } }])
})

test('aborted OSC9999 never escapes as a bell or private report', () => {
  const scanner = new OutputScanner()
  expect(scanner.push(encode.encode('\x1b]9999;{"state":"working"}\x18')).facts).toEqual([])
  expect(scanner.push(encode.encode('ordinary output')).facts).toEqual([])
})
