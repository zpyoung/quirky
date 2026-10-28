import { describe, expect, test } from 'bun:test'
import { extractGlobals } from '../src/args'
import { resolveRuntimeSelection } from '../src/runtime-selection'

describe('paired runtime selection', () => {
  test('explicit selection overrides ambient selection and one-off pairing beats ambient saved selection', () => {
    expect(resolveRuntimeSelection({ runtime: 'saved-a' }, { QUIRKY_RUNTIME: 'local', QUIRKY_PAIRING_CODE: 'ambient-code' })).toEqual({
      kind: 'saved', selector: 'saved-a'
    })
    expect(resolveRuntimeSelection({ pairingCode: 'explicit-code' }, { QUIRKY_RUNTIME: 'saved-a' })).toEqual({
      kind: 'pairing', pairingCode: 'explicit-code'
    })
    expect(resolveRuntimeSelection({}, { QUIRKY_RUNTIME: 'saved-a', QUIRKY_PAIRING_CODE: 'ambient-code' })).toEqual({
      kind: 'pairing', pairingCode: 'ambient-code'
    })
    expect(resolveRuntimeSelection({ runtime: 'local' }, { QUIRKY_PAIRING_CODE: 'ambient-code' })).toEqual({ kind: 'local' })
  })

  test('rejects conflicting explicit targets without disclosing the one-off pairing code', () => {
    const secret = 'quirky://pair?code=private-offer'
    expect(() => resolveRuntimeSelection({ runtime: 'saved-a', pairingCode: secret }, {})).toThrow(/cannot be used together/)
    try {
      resolveRuntimeSelection({ runtime: 'saved-a', pairingCode: secret }, {})
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  test('extracts runtime flags before command parsing and refuses both explicit selectors', () => {
    expect(extractGlobals(['--runtime', 'saved-a', 'status'])).toMatchObject({
      argv: ['status'], options: { runtime: 'saved-a' }
    })
    expect(extractGlobals(['--pairing-code=one-off', 'status'])).toMatchObject({
      argv: ['status'], options: { pairingCode: 'one-off' }
    })
    expect(() => extractGlobals(['--runtime', 'saved-a', '--pairing-code', 'private-offer', 'status'])).toThrow(/cannot be used together/)
  })
})
