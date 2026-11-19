import { expect, test } from 'bun:test'
import { createInputGate, writeReplay } from '../../src/window/pane/replayGate'

function fakeTerminal() {
  const writes: { data: Uint8Array; done?: () => void }[] = []
  return {
    writes,
    write(data: Uint8Array, done?: () => void) {
      writes.push({ data, done })
    }
  }
}

test('overlapping replay writes keep input muted until every callback finishes', () => {
  for (const order of [[0, 1], [1, 0]] as const) {
    const gate = createInputGate()
    const term = fakeTerminal()
    writeReplay(term, new Uint8Array([1]), gate)
    writeReplay(term, new Uint8Array([2]), gate)
    expect(gate.allows()).toBe(false)
    term.writes[order[0]]!.done?.()
    expect(gate.allows()).toBe(false)
    term.writes[order[1]]!.done?.()
    expect(gate.allows()).toBe(true)
  }
})
