import { describe, expect, test } from 'bun:test'
import { findOptionOccurrence, hasOption, hasOptionAnywhere, removeConflicts, removeOption, terminatorIndex } from '../../src/core/arg-occurrence'
import type { Conflict } from '../../src/core/types'

const MODEL: Conflict = { flags: ['-m', '--model'] }
const CODEX_MODEL: Conflict = { flags: ['-c', '--config'], valuePrefix: 'model=' }
const CLAUDE_VALUE_FLAGS = ['--append-system-prompt', '--model', '--effort']

describe('findOptionOccurrence', () => {
  test('finds a flag with a separate value', () => {
    expect(findOptionOccurrence(['--yolo', '--model', 'x'], ['--model'], true)).toEqual({ index: 1, consumed: 2, value: 'x' })
  })

  test('finds --flag=value, -fvalue and -f=value', () => {
    expect(findOptionOccurrence(['--model=x'], ['-m', '--model'], true)).toEqual({ index: 0, consumed: 1, value: 'x' })
    expect(findOptionOccurrence(['-mx'], ['-m', '--model'], true)).toEqual({ index: 0, consumed: 1, value: 'x' })
    expect(findOptionOccurrence(['-m=x'], ['-m', '--model'], true)).toEqual({ index: 0, consumed: 1, value: 'x' })
  })

  test('does not consume a dash-leading next token', () => {
    expect(findOptionOccurrence(['--model', '--yolo'], ['--model'], true)).toEqual({ index: 0, consumed: 1, value: undefined })
  })

  test('does not match a longer flag by prefix', () => {
    expect(findOptionOccurrence(['--model-x', 'v'], ['--model'], true)).toBeNull()
    expect(findOptionOccurrence(['--mx'], ['-m'], true)).toBeNull()
  })

  test('stops at the terminator only when asked', () => {
    expect(findOptionOccurrence(['--', '--model', 'x'], ['--model'], true)).toBeNull()
    expect(findOptionOccurrence(['--', '--model', 'x'], ['--model'], false)?.index).toBe(1)
  })
})

describe('terminatorIndex', () => {
  test('is the length without a terminator', () => {
    expect(terminatorIndex(['--yolo', 'x'])).toBe(2)
    expect(terminatorIndex([])).toBe(0)
  })

  test('is the index of the first --', () => {
    expect(terminatorIndex(['--yolo', '--', 'x', '--'])).toBe(1)
  })

  test('skips a -- that is a value flag value', () => {
    expect(terminatorIndex(['--append-system-prompt', '--', '--=literal', '--', 'text'], CLAUDE_VALUE_FLAGS)).toBe(3)
  })

  test('counts that -- when the flag is not a value flag', () => {
    expect(terminatorIndex(['--append-system-prompt', '--', 'text'])).toBe(1)
  })
})

describe('removeOption', () => {
  test.each([[['-c', 'model=o3']], [['--config', 'model=o3']], [['-c=model=o3']], [['-cmodel=o3']], [['--config=model=o3']]])(
    'strips the codex model config %j',
    (tokens) => {
      expect(removeOption([...tokens, '--search'], CODEX_MODEL)).toEqual(['--search'])
    }
  )

  test('keeps other codex config, including effort, when stripping the model', () => {
    const tokens = ['-c', 'model_reasoning_effort=high', '-cmodel_reasoning_effort=low', '-csandbox=x']
    expect(removeOption(tokens, CODEX_MODEL)).toEqual(tokens)
  })

  test('removes only the model entry from mixed codex config', () => {
    expect(removeOption(['-c', 'model=x', '-c', 'model_reasoning_effort=high'], CODEX_MODEL)).toEqual([
      '-c',
      'model_reasoning_effort=high'
    ])
  })

  test('leaves everything after a terminator', () => {
    const tokens = ['--', '-c', 'model=o3']
    expect(removeOption(tokens, CODEX_MODEL)).toEqual(tokens)
    expect(removeOption(['-m', 'a', '--', '-m', 'b'], MODEL)).toEqual(['--', '-m', 'b'])
  })

  test('removes every spelling of a gemini model', () => {
    expect(removeOption(['-m', 'a', '--model=b', '-mc', '--yolo'], MODEL)).toEqual(['--yolo'])
  })

  test('consumes an empty value', () => {
    expect(removeOption(['--model', '', '--yolo'], { flags: ['--model'] })).toEqual(['--yolo'])
  })

  test('keeps a following flag', () => {
    expect(removeOption(['--model', '--yolo'], { flags: ['--model'] })).toEqual(['--yolo'])
  })

  test('a value flag whose value is -- does not hide later options', () => {
    expect(removeOption(['--append-system-prompt', '--', '--model', 'x', '--yolo'], { flags: ['--model'] }, CLAUDE_VALUE_FLAGS)).toEqual([
      '--append-system-prompt',
      '--',
      '--yolo'
    ])
  })

  test('without the value flag, that -- ends the scan', () => {
    const tokens = ['--append-system-prompt', '--', '--model', 'x']
    expect(removeOption(tokens, { flags: ['--model'] })).toEqual(tokens)
  })

  test('a value flag can swallow a dash-leading value that looks like the option', () => {
    const tokens = ['--append-system-prompt', '--model', '--yolo']
    expect(removeOption(tokens, { flags: ['--model'] }, CLAUDE_VALUE_FLAGS)).toEqual(tokens)
  })

  test('never mutates its input', () => {
    const tokens = ['-m', 'a', '--yolo']
    removeOption(tokens, MODEL)
    expect(tokens).toEqual(['-m', 'a', '--yolo'])
  })
})

describe('hasOption', () => {
  test('is true when something would be removed', () => {
    expect(hasOption(['--yolo', '--model=x'], MODEL)).toBe(true)
    expect(hasOption(['-c', 'model=x'], CODEX_MODEL)).toBe(true)
  })

  test('is false for a different value prefix, no flag, or text after --', () => {
    expect(hasOption(['-c', 'model_reasoning_effort=high'], CODEX_MODEL)).toBe(false)
    expect(hasOption(['--yolo'], MODEL)).toBe(false)
    expect(hasOption(['--', '-m', 'x'], MODEL)).toBe(false)
  })
})

describe('removeConflicts', () => {
  test('applies each conflict in turn', () => {
    expect(removeConflicts(['-m', 'a', '-c', 'model=b', '-c', 'x=1', '--yolo'], [MODEL, CODEX_MODEL])).toEqual(['-c', 'x=1', '--yolo'])
  })

  test('with no conflicts returns a copy', () => {
    const tokens = ['--yolo']
    const out = removeConflicts(tokens, [])
    expect(out).toEqual(tokens)
    expect(out).not.toBe(tokens)
  })
})

describe('hasOptionAnywhere', () => {
  test('finds a flag past a -- that hasOption stops at', () => {
    const tokens = ['env', '--', 'claude', '--model', 'x']
    expect(hasOption(tokens, MODEL)).toBe(false)
    expect(hasOptionAnywhere(tokens, MODEL)).toBe(true)
  })

  test('honors the conflict value prefix across occurrences', () => {
    expect(hasOptionAnywhere(['-c', 'x=1', '--', '-c', 'model=b'], CODEX_MODEL)).toBe(true)
    expect(hasOptionAnywhere(['-c', 'x=1'], CODEX_MODEL)).toBe(false)
  })

  test("skips a value flag's value", () => {
    expect(hasOptionAnywhere(['--append-system-prompt', '--model'], MODEL, CLAUDE_VALUE_FLAGS)).toBe(false)
  })
})
