import { expect, test } from 'bun:test'
import { createInputGate, writeReplay } from '../src/lib/replayGate'

function fakeTerminal() {
  const writes: { data: Uint8Array; done?: () => void }[] = []
  return {
    writes,
    write(data: Uint8Array, done?: () => void) {
      writes.push({ data, done })
    }
  }
}

test('input is allowed until a replay is written', () => {
  expect(createInputGate().allows()).toBe(true)
})

test('input is dropped from the replay write until xterm has parsed it', () => {
  const gate = createInputGate()
  const term = fakeTerminal()
  writeReplay(term, new Uint8Array([1, 2, 3]), gate)
  expect(term.writes).toHaveLength(1)
  expect(gate.allows()).toBe(false)
  term.writes[0]!.done?.()
  expect(gate.allows()).toBe(true)
})

test('an empty replay never closes the gate', () => {
  const gate = createInputGate()
  const term = fakeTerminal()
  writeReplay(term, new Uint8Array(0), gate)
  expect(term.writes).toHaveLength(0)
  expect(gate.allows()).toBe(true)
})
