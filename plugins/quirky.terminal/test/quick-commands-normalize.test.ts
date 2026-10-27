import { describe, expect, test } from 'bun:test'
import { QUICK_COMMAND_LIMITS, type QuickCommand } from '../src/layout/types'
import {
  flattenQuickCommand,
  isQuickCommandComplete,
  normalizeQuickCommands,
  pickStripCommand,
  quickCommandCountError,
  validateQuickCommand,
  visibleQuickCommands
} from '../src/quick-commands/normalize'

const cmd = (over: Partial<QuickCommand> & { id: string }): QuickCommand => ({
  label: over.id,
  kind: 'terminal',
  agent: null,
  command: `echo ${over.id}`,
  appendEnter: true,
  scope: 'global',
  repo: null,
  ...over
})

describe('normalizeQuickCommands', () => {
  test('derives ids from labels and trims text', () => {
    const [a, b] = normalizeQuickCommands([
      { label: '  Hello  ', command: '  echo hello  ' },
      { label: 'Run the Tests!', command: 'npm test' }
    ])
    expect(a).toEqual({ id: 'hello', label: 'Hello', kind: 'terminal', agent: null, command: 'echo hello', appendEnter: true, scope: 'global', repo: null })
    expect(b!.id).toBe('run-the-tests')
  })

  test('SC-50: a second "Hello" gets hello-2, then hello-3', () => {
    const out = normalizeQuickCommands([
      { id: 'hello', label: 'Hello', command: 'echo 1' },
      { label: 'Hello', command: 'echo 2' },
      { label: 'hello', command: 'echo 3' }
    ])
    expect(out.map((c) => c.id)).toEqual(['hello', 'hello-2', 'hello-3'])
  })

  test('keeps an existing id and de-duplicates it too', () => {
    const out = normalizeQuickCommands([
      { id: 'keep', label: 'One', command: 'a' },
      { id: 'keep', label: 'Two', command: 'b' }
    ])
    expect(out.map((c) => c.id)).toEqual(['keep', 'keep-2'])
  })

  test('ids are at most 80 characters, suffix included', () => {
    const label = 'x'.repeat(200)
    const out = normalizeQuickCommands([{ label, command: 'a' }, { label, command: 'b' }])
    expect(out[0]!.id).toHaveLength(80)
    expect(out[1]!.id).toHaveLength(80)
    expect(out[1]!.id.endsWith('-2')).toBe(true)
  })

  test('SC-50: a row with an empty command is kept but not complete', () => {
    const [row] = normalizeQuickCommands([{ label: 'Draft', command: '   ' }])
    expect(row).toMatchObject({ id: 'draft', label: 'Draft', command: '' })
    expect(isQuickCommandComplete(row!)).toBe(false)
    expect(normalizeQuickCommands([{ command: 'echo only' }])[0]).toMatchObject({ id: 'quick-command-1', label: '', command: 'echo only' })
  })

  test('drops rows with neither label nor command, and non-objects', () => {
    expect(normalizeQuickCommands([null, 4, 'x', [], {}, { id: 'a' }, { label: 'ok', command: '' }]).map((c) => c.id)).toEqual(['ok'])
    expect(normalizeQuickCommands('nope')).toEqual([])
  })

  test('clamps label and command to the limits', () => {
    const [row] = normalizeQuickCommands([{ label: 'l'.repeat(500), command: 'c'.repeat(9000) }])
    expect(row!.label).toHaveLength(QUICK_COMMAND_LIMITS.label)
    expect(row!.command).toHaveLength(QUICK_COMMAND_LIMITS.command)
  })

  test('SC-50: keeps at most 40 rows', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ label: `c${i}`, command: 'x' }))
    expect(normalizeQuickCommands(many)).toHaveLength(40)
  })

  test('SC-54: repo scope needs a repo, else the row is global', () => {
    const out = normalizeQuickCommands([
      { label: 'Test', command: 'a', scope: 'repo', repo: ' api ' },
      { label: 'Orphan', command: 'b', scope: 'repo' },
      { label: 'Plain', command: 'c', scope: 'global', repo: 'api' }
    ])
    expect(out.map((c) => [c.scope, c.repo])).toEqual([['repo', 'api'], ['global', null], ['global', null]])
  })

  test('terminal rows default appendEnter on; agent rows never append', () => {
    const out = normalizeQuickCommands([
      { label: 'Keep', command: 'a', appendEnter: false },
      { label: 'On', command: 'b' },
      { label: 'Review', kind: 'agent', agent: 'claude', command: 'review the diff', appendEnter: true }
    ])
    expect(out.map((c) => c.appendEnter)).toEqual([false, true, false])
    expect(out[2]).toMatchObject({ kind: 'agent', agent: 'claude' })
  })

  test('an agent row without an agent is dropped', () => {
    expect(normalizeQuickCommands([{ label: 'Bad', kind: 'agent', command: 'x' }])).toEqual([])
  })

  test('is idempotent', () => {
    const once = normalizeQuickCommands([{ label: 'Hello', command: 'echo' }, { label: 'Hello', command: 'again' }, { label: 'T', command: 'x', scope: 'repo', repo: 'api' }])
    expect(normalizeQuickCommands(once)).toEqual(once)
  })
})

describe('validateQuickCommand', () => {
  const good = { label: 'Hello', command: 'echo hello' }
  const fields = (input: unknown) => validateQuickCommand(input).map((e) => e.field)

  test('a plain terminal command is valid', () => {
    expect(validateQuickCommand(good)).toEqual([])
    expect(validateQuickCommand({ ...good, kind: 'terminal', appendEnter: false, scope: 'repo', repo: 'api' })).toEqual([])
  })

  test('SC-49: label up to 80 and command up to 4000 characters', () => {
    expect(fields({ ...good, label: 'l'.repeat(80) })).toEqual([])
    expect(fields({ ...good, label: 'l'.repeat(81) })).toEqual(['label'])
    expect(fields({ ...good, command: 'c'.repeat(4000) })).toEqual([])
    expect(fields({ ...good, command: 'c'.repeat(4001) })).toEqual(['command'])
  })

  test('repo up to 200 characters, and required for repo scope', () => {
    expect(fields({ ...good, scope: 'repo', repo: 'r'.repeat(200) })).toEqual([])
    expect(fields({ ...good, scope: 'repo', repo: 'r'.repeat(201) })).toEqual(['repo'])
    expect(fields({ ...good, scope: 'repo' })).toEqual(['repo'])
    expect(fields({ ...good, scope: 'repo', repo: '  ' })).toEqual(['repo'])
  })

  test('SC-53: an agent is required for agent commands and refused for terminal ones', () => {
    expect(fields({ ...good, kind: 'agent' })).toEqual(['agent'])
    expect(fields({ ...good, kind: 'agent', agent: 'claude' })).toEqual([])
    expect(fields({ ...good, kind: 'terminal', agent: 'claude' })).toEqual(['agent'])
    expect(fields({ ...good, agent: null })).toEqual([])
  })

  test('appendEnter is only for terminal commands', () => {
    expect(fields({ ...good, kind: 'agent', agent: 'claude', appendEnter: true })).toEqual(['appendEnter'])
    expect(fields({ ...good, kind: 'agent', agent: 'claude', appendEnter: false })).toEqual([])
  })

  test('unknown kind, scope and wrong types are reported', () => {
    expect(fields({ ...good, kind: 'script' })).toContain('kind')
    expect(fields({ ...good, scope: 'team' })).toContain('scope')
    expect(fields({ label: 4, command: [] })).toEqual(['label', 'command'])
    expect(fields(null)).toEqual(['label'])
  })

  test('SC-50: empty text is not a validation error', () => {
    expect(validateQuickCommand({ label: 'Draft', command: '' })).toEqual([])
  })

  test('SC-50: the 41st command is refused, the 40th is fine', () => {
    expect(quickCommandCountError(39)).toBeNull()
    expect(quickCommandCountError(40)).toBe('at most 40 quick commands')
  })

  test('errors carry a message', () => {
    expect(validateQuickCommand({ ...good, kind: 'agent' })[0]!.message).toBe('an agent command needs an agent')
  })
})

describe('flattenQuickCommand', () => {
  test('SC-51: lines are trimmed, empty ones dropped, the rest joined with "; "', () => {
    expect(flattenQuickCommand('cd web\nnpm test')).toBe('cd web; npm test')
    expect(flattenQuickCommand('  cd web  \r\n\r\n   npm test\r\n')).toBe('cd web; npm test')
    expect(flattenQuickCommand('a\rb')).toBe('a; b')
  })

  test('a single line is unchanged apart from trimming', () => {
    expect(flattenQuickCommand('  echo hello ')).toBe('echo hello')
    expect(flattenQuickCommand('\n\n')).toBe('')
  })
})

describe('visibleQuickCommands and pickStripCommand', () => {
  const hello = cmd({ id: 'hello' })
  const test1 = cmd({ id: 'test', scope: 'repo', repo: 'api' })
  const other = cmd({ id: 'other', scope: 'repo', repo: 'web' })
  const list = [hello, test1, other]

  test('SC-54: a repo sees global commands and its own', () => {
    expect(visibleQuickCommands(list, 'api').map((c) => c.id)).toEqual(['hello', 'test'])
    expect(visibleQuickCommands(list, 'web').map((c) => c.id)).toEqual(['hello', 'other'])
    expect(visibleQuickCommands(list, 'zzz').map((c) => c.id)).toEqual(['hello'])
  })

  test('SC-54: the floating workspace sees only global commands', () => {
    expect(visibleQuickCommands(list, null).map((c) => c.id)).toEqual(['hello'])
  })

  test('SC-54: the strip picks the last used, else the first repo command, else the first global', () => {
    expect(pickStripCommand(list, 'api', 'hello')?.id).toBe('hello')
    expect(pickStripCommand(list, 'api', null)?.id).toBe('test')
    expect(pickStripCommand([hello, test1], 'web', null)?.id).toBe('hello')
    expect(pickStripCommand(list, null, null)?.id).toBe('hello')
  })

  test('a last-used command that is gone or hidden is ignored', () => {
    expect(pickStripCommand(list, 'api', 'removed')?.id).toBe('test')
    expect(pickStripCommand(list, 'api', 'other')?.id).toBe('test')
  })

  test('SC-50: incomplete rows are skipped', () => {
    const draft = cmd({ id: 'draft', command: '', scope: 'repo', repo: 'api' })
    expect(pickStripCommand([draft, hello], 'api', null)?.id).toBe('hello')
    expect(pickStripCommand([draft, hello], 'api', 'draft')?.id).toBe('hello')
    expect(pickStripCommand([draft], 'api', null)).toBeNull()
    expect(pickStripCommand([], 'api', null)).toBeNull()
  })
})
