import { describe, expect, it } from 'vitest'
import {
  AGENT_STATE_RULES_BUNDLE_MAX_BYTES,
  parseAgentStateRulesBundle
} from './agent-state-rules-bundle'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'

function file(id: string): Record<string, unknown> {
  const found = BUNDLED_AGENT_STATE_RULE_FILES.find((candidate) => candidate.id === id)
  return structuredClone({ ...found })
}

function bundle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    engineVersion: 1,
    files: [file('claude')],
    ...overrides
  })
}

function rejection(text: string) {
  const result = parseAgentStateRulesBundle(text)
  return result.ok ? null : result.error
}

describe('agent state rules bundle', () => {
  it('accepts a bundle of valid rule files', () => {
    expect(parseAgentStateRulesBundle(bundle())).toMatchObject({
      ok: true,
      bundle: { version: 2 }
    })
  })

  it.each([
    ['an unknown top-level field', bundle({ signature: 'x' }), 'Unrecognized key'],
    ['a version that is not a positive integer', bundle({ version: '2026.10.02' }), 'version'],
    ['version zero', bundle({ version: 0 }), 'version'],
    ['a missing version', bundle({ version: undefined }), 'version'],
    ['another engine', bundle({ engineVersion: 2 }), 'engineVersion'],
    [
      'a file with a misspelled field',
      bundle({ files: [{ ...file('claude'), rule: [] }] }),
      'agent state rules file 0'
    ],
    ['two files for one agent', bundle({ files: [file('claude'), file('claude')] }), 'two files'],
    ['a bundledOnly field', bundle({ bundledOnly: true }), 'Unrecognized key']
  ])('rejects %s', (_label, text, error) => {
    expect(rejection(text)).toContain(error)
  })

  it('rejects text over the size cap before parsing it', () => {
    expect(rejection(`${bundle()}${' '.repeat(AGENT_STATE_RULES_BUNDLE_MAX_BYTES)}`)).toBe(
      `larger than ${AGENT_STATE_RULES_BUNDLE_MAX_BYTES} bytes`
    )
  })

  it('accepts any bundled agent', () => {
    expect(rejection(bundle({ files: [file('gemini')] }))).toBeNull()
  })
})
