import { describe, expect, test } from 'bun:test'
import type { AgentCommand } from '@quirky/protocol'
import { hoistCommand, referencedCommands } from '../slash-commands'

const COMMANDS: AgentCommand[] = [
  { name: 'tdd', kind: 'skill' },
  { name: 'quirk:brainstorming', kind: 'plugin' },
  { name: 'clear', kind: 'builtin', startOnly: true }
]

describe('hoistCommand', () => {
  test('moves the first runnable mid-message command to the front, with the surrounding prose as its arguments', () => {
    expect(hoistCommand('fix the login /tdd focus on auth', COMMANDS)).toBe('/tdd fix the login focus on auth')
    expect(hoistCommand('line one\nthen /quirk:brainstorming', COMMANDS)).toBe('/quirk:brainstorming line one\nthen')
    expect(hoistCommand('just /tdd', COMMANDS)).toBe('/tdd just')
  })

  test('leaves a message that already opens with a known command alone, even with others later', () => {
    expect(hoistCommand('/tdd and also /quirk:brainstorming', COMMANDS)).toBe('/tdd and also /quirk:brainstorming')
    expect(hoistCommand('  /clear', COMMANDS)).toBe('  /clear')
  })

  test('never moves a start-only command, an unknown name, a path or a URL', () => {
    expect(hoistCommand('please /clear later', COMMANDS)).toBe('please /clear later')
    expect(hoistCommand('see /usr/bin/tdd and a/tdd and https://x.dev/tdd', COMMANDS)).toBe('see /usr/bin/tdd and a/tdd and https://x.dev/tdd')
    expect(hoistCommand('/unknown then /tdd', COMMANDS)).toBe('/tdd /unknown then')
  })
})

describe('referencedCommands', () => {
  test('lists known commands named anywhere, in order and once each', () => {
    expect(referencedCommands('/tdd then /quirk:brainstorming, /tdd again, /nope and /usr/tdd', COMMANDS)).toEqual(['tdd'])
    expect(referencedCommands('use /quirk:brainstorming\nand /tdd', COMMANDS)).toEqual(['quirk:brainstorming', 'tdd'])
  })
})
