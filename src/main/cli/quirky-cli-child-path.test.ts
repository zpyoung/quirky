import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

import { prependQuirkyCliDirToChildPath } from './quirky-cli-child-path'

const USER_DATA = '/data/quirky'
const RESOURCES = '/app/Resources'

beforeEach(() => {
  installFakeAppEnvironment()
})

afterEach(() => installFakeAppEnvironment())

describe('prependQuirkyCliDirToChildPath', () => {
  it.each(['linux', 'darwin'] as const)(
    'uses the %s execution host CLI and profile over inherited values',
    (platform) => {
      const launcher = join(USER_DATA, 'cli', 'bin', 'quirky')
      installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
      const env: Record<string, string> = {
        PATH: `/usr/bin:${join(USER_DATA, 'cli', 'bin')}::/bin`,
        QUIRKY_USER_DATA_PATH: '/parent/profile',
        QUIRKY_CLI_COMMAND: '/parent/quirky',
        QUIRKY_CLI_BIN_DIR: '/parent/bin'
      }
      expect(
        prependQuirkyCliDirToChildPath(env, {
          isPackaged: true,
          userDataPath: USER_DATA,
          resourcesPath: null,
          platform
        })
      ).toBe(launcher)
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin:/bin`)
      expect(env.QUIRKY_USER_DATA_PATH).toBe(USER_DATA)
      expect(env.QUIRKY_CLI_COMMAND).toBe(launcher)
      expect(env.QUIRKY_CLI_BIN_DIR).toBe(join(USER_DATA, 'cli', 'bin'))
    }
  )
  it('leads packaged macOS PATH with the bundled CLI dir', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }
    prependQuirkyCliDirToChildPath(env, {
      isPackaged: true,
      userDataPath: USER_DATA,
      resourcesPath: RESOURCES,
      platform: 'darwin'
    })
    expect(env.PATH).toBe(`${join(RESOURCES, 'bin')}:/usr/bin`)
    expect(env.QUIRKY_CLI_BIN_DIR).toBe(join(RESOURCES, 'bin'))
  })

  it('leaves a packaged darwin/win32 PATH alone with no resources root', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' }
    prependQuirkyCliDirToChildPath(env, {
      isPackaged: true,
      userDataPath: USER_DATA,
      resourcesPath: null,
      platform: 'darwin'
    })
    expect(env.PATH).toBe('/usr/bin')
  })

  it.each<[NodeJS.Platform, string]>([
    ['linux', ':'],
    ['darwin', ':'],
    ['win32', ';']
  ])('leads an unpackaged %s PATH with the dev launcher dir', (platform, pathDelimiter) => {
    const env: Record<string, string> = { PATH: '/usr/bin' }
    prependQuirkyCliDirToChildPath(env, {
      isPackaged: false,
      userDataPath: USER_DATA,
      resourcesPath: RESOURCES,
      platform
    })
    expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}${pathDelimiter}/usr/bin`)
    expect(env.QUIRKY_CLI_BIN_DIR).toBe(
      platform === 'win32' ? undefined : join(USER_DATA, 'cli', 'bin')
    )
  })

  it('writes no trailing delimiter when nothing was inherited', () => {
    const env: Record<string, string> = { PATH: '' }
    const inheritedPath = process.env.PATH
    delete process.env.PATH
    try {
      prependQuirkyCliDirToChildPath(env, {
        isPackaged: false,
        userDataPath: USER_DATA,
        platform: 'linux'
      })
    } finally {
      if (inheritedPath !== undefined) {
        process.env.PATH = inheritedPath
      }
    }
    // Why: an empty trailing segment resolves as `.` in some shells.
    expect(env.PATH).toBe(join(USER_DATA, 'cli', 'bin'))
  })
})
