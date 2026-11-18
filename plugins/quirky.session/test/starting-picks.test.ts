import { describe, expect, test } from 'bun:test'
import type { AgentOptions } from '../src/window/chat/controls'
import { NO_HARNESS_DEFAULTS, startingPicks } from '../src/window/chat/startingPicks'

const effort = { id: 'effort', label: 'Effort', type: 'select' as const, choices: ['low', 'high', 'max'].map((value) => ({ value, label: value })), default: 'high' }
const CLAUDE: AgentOptions = {
  supported: true,
  models: [
    { id: 'opus', label: 'Opus', options: [effort] },
    { id: 'haiku', label: 'Haiku', options: [] }
  ],
  unlisted: 'accept',
  unlistedOptions: [effort],
  defaultModel: 'opus'
}
const NONE = { model: null, effort: null }

describe('startingPicks', () => {
  test('falls back to the catalog default when the settings name nothing', () => {
    expect(startingPicks(CLAUDE, NO_HARNESS_DEFAULTS, NONE)).toEqual({ model: 'opus', effort: 'high' })
  })

  test('the agent settings win over the catalog default, an unlisted model included when the catalog accepts it', () => {
    expect(startingPicks(CLAUDE, { model: 'haiku', effort: null }, NONE)).toEqual({ model: 'haiku', effort: null })
    expect(startingPicks(CLAUDE, { model: 'claude-opus-5-5', effort: 'max' }, NONE)).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
    expect(startingPicks(CLAUDE, { model: null, effort: 'low' }, NONE)).toEqual({ model: 'opus', effort: 'low' })
  })

  test('user picks win over the settings', () => {
    expect(startingPicks(CLAUDE, { model: 'haiku', effort: 'low' }, { model: 'opus', effort: 'max' })).toEqual({ model: 'opus', effort: 'max' })
    expect(startingPicks(CLAUDE, { model: 'haiku', effort: 'low' }, { model: 'opus', effort: null })).toEqual({ model: 'opus', effort: 'low' })
  })

  test('an effort the model does not offer is left to the agent, without falling back to the catalog default', () => {
    expect(startingPicks(CLAUDE, { model: 'haiku', effort: 'high' }, NONE)).toEqual({ model: 'haiku', effort: null })
    expect(startingPicks(CLAUDE, { model: null, effort: 'ultra' }, NONE)).toEqual({ model: 'opus', effort: null })
  })

  test('a settings model the catalog refuses is left to the agent instead of swapped for the catalog default', () => {
    expect(startingPicks({ ...CLAUDE, unlisted: 'refuse' }, { model: 'claude-opus-5-5', effort: 'high' }, NONE)).toEqual({ model: null, effort: null })
  })

  test('an agent with no settings and no declared default launches on its own choice', () => {
    expect(startingPicks({ ...CLAUDE, defaultModel: null }, NO_HARNESS_DEFAULTS, NONE)).toEqual({ model: null, effort: null })
  })

  test('without a catalog the picks pass as they are', () => {
    expect(startingPicks(null, { model: 'opus', effort: 'high' }, { model: null, effort: 'low' })).toEqual({ model: null, effort: 'low' })
  })
})
