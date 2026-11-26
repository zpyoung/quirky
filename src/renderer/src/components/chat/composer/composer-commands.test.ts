import { describe, expect, it } from 'vitest'
import { composerCommandsFor } from './composer-commands'
import { slashSuggestions } from './SuggestionList'

describe('composerCommandsFor', () => {
  it('lists compact and clear as host commands ahead of the agent commands', () => {
    const commands = composerCommandsFor({
      conversationCommands: ['clear', 'compact'],
      sessionCommands: [
        { name: 'review', kind: 'skill', description: 'Review a diff' },
        { name: 'compact', kind: 'command' }
      ]
    })
    expect(commands.map((command) => [command.name, command.kind])).toEqual([
      ['clear', 'host'],
      ['compact', 'host'],
      ['review', 'skill']
    ])
  })
})

describe('slashSuggestions', () => {
  const commands = composerCommandsFor({
    conversationCommands: ['clear', 'compact'],
    sessionCommands: [{ name: 'review', kind: 'skill' }]
  })

  it('routes compact through the host and sends agent commands as text', () => {
    const rows = slashSuggestions(commands, '', new Set())
    expect(rows.find((row) => row.label === '/compact')?.source).toBe('host')
    expect(rows.find((row) => row.label === '/review')?.source).toBe('agent')
  })

  it('narrows the list by what was typed after the slash', () => {
    expect(slashSuggestions(commands, 'comp', new Set()).map((row) => row.label)).toEqual([
      '/compact'
    ])
  })

  it('offers the composer’s own commands only where they can act', () => {
    expect(slashSuggestions(commands, 'plan', new Set()).map((row) => row.label)).toEqual([])
    expect(slashSuggestions(commands, 'plan', new Set(['plan'])).map((row) => row.source)).toEqual([
      'local'
    ])
  })
})
