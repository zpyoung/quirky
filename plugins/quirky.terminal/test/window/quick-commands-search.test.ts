import { describe, expect, test } from 'bun:test'
import { searchQuickCommands } from '../../src/window/quick-commands/search'
import type { QuickCommand } from '../../src/layout/types'

function qc(id: string, over: Partial<QuickCommand> = {}): QuickCommand {
  return { id, label: id, kind: 'terminal', agent: null, command: '', appendEnter: true, scope: 'global', repo: null, ...over }
}

describe('searchQuickCommands', () => {
  test('an empty or blank query keeps every command in order', () => {
    const list = [qc('b'), qc('a')]
    expect(searchQuickCommands(list, '').map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(searchQuickCommands(list, '   ').map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  test('a label match outranks an agent match, which outranks a command-body match', () => {
    const body = qc('body', { label: 'Zed', command: 'run tests now' })
    const agent = qc('agent', { label: 'Alpha', kind: 'agent', agent: 'tests', command: 'x' })
    const label = qc('label', { label: 'Tests' })
    expect(searchQuickCommands([body, agent, label], 'tests').map((entry) => entry.id)).toEqual(['label', 'agent', 'body'])
  })

  test('within a field, an exact match beats a prefix, a word start and a substring', () => {
    const list = [qc('sub', { label: 'xdevx' }), qc('word', { label: 'my dev' }), qc('prefix', { label: 'dev server' }), qc('exact', { label: 'Dev' })]
    expect(searchQuickCommands(list, 'dev').map((entry) => entry.id)).toEqual(['exact', 'prefix', 'word', 'sub'])
  })

  test('is case-insensitive and treats runs of whitespace as one space', () => {
    expect(searchQuickCommands([qc('a', { label: 'Start  Dev\tServer' })], 'start dev').map((entry) => entry.id)).toEqual(['a'])
    expect(searchQuickCommands([qc('a', { label: 'Start Dev' })], 'START   DEV').map((entry) => entry.id)).toEqual(['a'])
  })

  test('a command nothing matches is left out, and an oversized query matches nothing', () => {
    expect(searchQuickCommands([qc('a')], 'zzz')).toEqual([])
    expect(searchQuickCommands([qc('a')], 'a'.repeat(3000))).toEqual([])
  })
})
