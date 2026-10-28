import { describe, expect, test } from 'bun:test'
import { configureInput, validateAddressList } from '../src/daemon/api'

describe('mobile API input contract', () => {
  test('rejects unknown configure keys and invalid bounded machine names', () => {
    expect(() => configureInput({ machineName: ' Laptop ' })).toThrow()
    expect(() => configureInput({ machineName: 'Laptop', token: 'secret' })).toThrow()
    expect(configureInput({ machineName: 'Laptop' })).toEqual({ machineName: 'Laptop' })
  })

  test('bounds fit restore, custom address count and address length', () => {
    expect(configureInput({ autoRestoreFitMs: null })).toEqual({ autoRestoreFitMs: null })
    expect(configureInput({ autoRestoreFitMs: 1000 })).toEqual({ autoRestoreFitMs: 5000 })
    expect(configureInput({ autoRestoreFitMs: 9_000_000 })).toEqual({ autoRestoreFitMs: 3_600_000 })
    expect(() => validateAddressList(['x'.repeat(16_385)])).toThrow()
    expect(() => validateAddressList(Array.from({ length: 51 }, () => 'host.local'))).toThrow()
    expect(validateAddressList(['192.168.1.3'])).toEqual(['192.168.1.3'])
  })
})
