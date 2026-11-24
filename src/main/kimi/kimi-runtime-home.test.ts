import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getHostKimiHome, getKimiRuntimeTarget, resolveKimiHome } from './kimi-runtime-home'
import type { GlobalSettings } from '../../shared/global-settings-types'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return overrides as GlobalSettings
}

describe('getKimiRuntimeTarget', () => {
  it('pins to host off Windows even when the setting says wsl', () => {
    expect(
      getKimiRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
        'darwin'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })
})

describe('resolveKimiHome', () => {
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME

  beforeEach(() => {
    delete process.env.KIMI_CODE_HOME
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
  })

  it('resolves the host home for a host target', async () => {
    expect(await resolveKimiHome({ runtime: 'host', wslDistro: null })).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
  })

  it('resolves the host home even when the target names a WSL distro', async () => {
    expect(await resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'darwin')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
  })
})
