import { describe, expect, test } from 'bun:test'
import { detectStuck, outputSignature, type StuckWindow } from '../src/supervisor/stuck'

const MIN = 60_000
const NOW = 100 * MIN

function window(overrides: Partial<StuckWindow> = {}): StuckWindow {
  return { now: NOW, working: true, lastActivityAt: NOW - MIN, doneWhen: [], calls: [], edits: [], denials: { consecutive: 0, total: 0 }, ...overrides }
}

const call = (fingerprint: string, at = NOW - MIN) => ({ fingerprint, toolName: 'Bash', at })
const failure = (signature: string, at = NOW - MIN) => ({ signature, pass: false, at })
const edit = (path: string, contentHash: string, at: number) => ({ path, contentHash, at })

describe('detectStuck', () => {
  test('a quiet window is not stuck', () => {
    expect(detectStuck(window())).toBeNull()
  })

  describe('silence', () => {
    test('15 minutes without activity while working is stuck', () => {
      expect(detectStuck(window({ lastActivityAt: NOW - 15 * MIN }))).toMatchObject({ kind: 'silent' })
    })

    test('just under 15 minutes is not stuck', () => {
      expect(detectStuck(window({ lastActivityAt: NOW - 15 * MIN + 1 }))).toBeNull()
    })

    test('silence while not working is not stuck', () => {
      expect(detectStuck(window({ working: false, lastActivityAt: NOW - 60 * MIN }))).toBeNull()
    })

    test('no activity reading is not stuck', () => {
      expect(detectStuck(window({ lastActivityAt: null }))).toBeNull()
    })
  })

  describe('done when failing the same way', () => {
    test('3 consecutive failures with one signature', () => {
      expect(detectStuck(window({ doneWhen: [failure('a'), failure('a'), failure('a')] }))).toMatchObject({ kind: 'done-when-repeat' })
    })

    test('2 failures are not enough', () => {
      expect(detectStuck(window({ doneWhen: [failure('a'), failure('a')] }))).toBeNull()
    })

    test('a different output in the run breaks it', () => {
      expect(detectStuck(window({ doneWhen: [failure('a'), failure('b'), failure('a')] }))).toBeNull()
    })

    test('only the latest run counts, so an earlier different failure does not hide a repeat', () => {
      expect(detectStuck(window({ doneWhen: [failure('z'), failure('a'), failure('a'), failure('a')] }))).toMatchObject({ kind: 'done-when-repeat' })
    })

    test('a pass in the run breaks it', () => {
      expect(detectStuck(window({ doneWhen: [failure('a'), { signature: 'a', pass: true, at: NOW }, failure('a')] }))).toBeNull()
    })
  })

  describe('repeated tool call', () => {
    test('3 identical consecutive calls', () => {
      expect(detectStuck(window({ calls: [call('x'), call('x'), call('x')] }))).toMatchObject({ kind: 'call-loop' })
    })

    test('an interleaved different call breaks the run', () => {
      expect(detectStuck(window({ calls: [call('x'), call('y'), call('x'), call('x')] }))).toBeNull()
    })

    test('2 identical calls are fine', () => {
      expect(detectStuck(window({ calls: [call('x'), call('x')] }))).toBeNull()
    })
  })

  describe('edit then revert', () => {
    test('a file returning to a prior content hash is a revert', () => {
      const edits = [edit('a.ts', 'h1', NOW - 9 * MIN), edit('a.ts', 'h2', NOW - 8 * MIN), edit('a.ts', 'h1', NOW - 7 * MIN)]
      expect(detectStuck(window({ edits }))).toMatchObject({ kind: 'edit-revert' })
    })

    test('steady progress through new hashes is not a revert', () => {
      const edits = [edit('a.ts', 'h1', NOW - 9 * MIN), edit('a.ts', 'h2', NOW - 8 * MIN), edit('a.ts', 'h3', NOW - 7 * MIN)]
      expect(detectStuck(window({ edits }))).toBeNull()
    })

    test('the same hash twice with nothing between is not a revert', () => {
      expect(detectStuck(window({ edits: [edit('a.ts', 'h1', NOW - 9 * MIN), edit('a.ts', 'h1', NOW - 8 * MIN)] }))).toBeNull()
    })

    test('hashes of different files do not pair up', () => {
      const edits = [edit('a.ts', 'h1', NOW - 9 * MIN), edit('b.ts', 'h2', NOW - 8 * MIN), edit('c.ts', 'h1', NOW - 7 * MIN)]
      expect(detectStuck(window({ edits }))).toBeNull()
    })

    test('edits older than the window are ignored', () => {
      const edits = [edit('a.ts', 'h1', NOW - 90 * MIN), edit('a.ts', 'h2', NOW - 80 * MIN), edit('a.ts', 'h1', NOW - 7 * MIN)]
      expect(detectStuck(window({ edits }))).toBeNull()
    })
  })

  describe('denials', () => {
    test('3 in a row', () => {
      expect(detectStuck(window({ denials: { consecutive: 3, total: 3 } }))).toMatchObject({ kind: 'denials' })
    })

    test('20 in total', () => {
      expect(detectStuck(window({ denials: { consecutive: 0, total: 20 } }))).toMatchObject({ kind: 'denials' })
    })

    test('2 in a row and 19 in total is not stuck', () => {
      expect(detectStuck(window({ denials: { consecutive: 2, total: 19 } }))).toBeNull()
    })
  })
})

describe('outputSignature', () => {
  test('ignores timings, ansi colour and spacing', () => {
    const a = outputSignature('\u001b[31mFAIL\u001b[0m  fixture missing (took 12ms)\n')
    const b = outputSignature('FAIL fixture missing (took 874ms)')
    expect(a).toBe(b)
  })

  test('tells different failures apart', () => {
    expect(outputSignature('FAIL fixture missing')).not.toBe(outputSignature('FAIL timeout'))
  })
})
