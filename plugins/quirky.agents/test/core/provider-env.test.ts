import { describe, expect, test } from 'bun:test'
import { materializeProviderEnvironment } from '../../src/core/provider-env'

describe('provider process environment', () => {
  test('null patches delete inherited and planned values instead of becoming the string null', () => {
    const env = materializeProviderEnvironment(
      { HOME: '/tmp/provider-home', CODEX_HOME: '/inherited-codex', KEEP: 'value' },
      [
        { CODEX_HOME: null, REMOVE: null },
        { CODEX_HOME: null }
      ]
    )
    expect(env).toEqual({ HOME: '/tmp/provider-home', KEEP: 'value' })
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('REMOVE')
  })

  test('a later managed account home overrides a planned removal', () => {
    expect(materializeProviderEnvironment(
      { CODEX_HOME: '/inherited-codex' },
      [{ CODEX_HOME: null }, { CODEX_HOME: '/managed-codex' }]
    )).toEqual({ CODEX_HOME: '/managed-codex' })
  })
})
