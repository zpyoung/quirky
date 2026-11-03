import { describe, expect, test } from 'bun:test'
import { bundleIdentifier } from '../electrobun.config'

describe('desktop bundle identifier', () => {
  test('a release build keeps the installed app identifier', () => {
    expect(bundleIdentifier({ ELECTROBUN_BUILD_ENV: 'stable', QUIRKY_RELEASE_BUILD: '1' })).toBe('dev.quirky.app')
  })

  test('a dev build gets its own identifier, even with the release flag set', () => {
    expect(bundleIdentifier({ ELECTROBUN_BUILD_ENV: 'dev' })).toBe('dev.quirky.app.dev')
    expect(bundleIdentifier({ ELECTROBUN_BUILD_ENV: 'dev', QUIRKY_RELEASE_BUILD: '1' })).toBe('dev.quirky.app.dev')
  })

  test('a locally built stable or canary app does not claim the installed app identifier', () => {
    expect(bundleIdentifier({ ELECTROBUN_BUILD_ENV: 'stable' })).toBe('dev.quirky.app.local')
    expect(bundleIdentifier({ ELECTROBUN_BUILD_ENV: 'canary' })).toBe('dev.quirky.app.local')
    expect(bundleIdentifier({})).toBe('dev.quirky.app.local')
  })
})
