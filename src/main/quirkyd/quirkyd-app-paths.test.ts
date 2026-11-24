import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppPathName } from '../../shared/app-environment'
import {
  resolveQuirkydInstallRoot,
  resolveQuirkydPath,
  resolveUserDataPath
} from './quirkyd-app-paths'

const ALL_PATH_NAMES: AppPathName[] = [
  'userData',
  'home',
  'appData',
  'temp',
  'downloads',
  'logs',
  'exe'
]

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
})

describe('resolveUserDataPath', () => {
  it('prefers QUIRKY_USER_DATA, then XDG_DATA_HOME, then ~/.quirky', () => {
    vi.stubEnv('QUIRKY_USER_DATA', join(sep, 'srv', 'quirky-state'))
    vi.stubEnv('XDG_DATA_HOME', join(sep, 'xdg'))
    expect(resolveUserDataPath()).toBe(join(sep, 'srv', 'quirky-state'))

    vi.stubEnv('QUIRKY_USER_DATA', '')
    expect(resolveUserDataPath()).toBe(join(sep, 'xdg', 'Quirky'))

    vi.stubEnv('XDG_DATA_HOME', '')
    expect(resolveUserDataPath()).toBe(join(homedir(), '.quirky'))
  })
})

describe('resolveQuirkydPath', () => {
  it('answers every path name without ever falling back to the data directory', () => {
    vi.stubEnv('QUIRKY_USER_DATA', join(sep, 'srv', 'quirky-state'))
    const answers = new Map(ALL_PATH_NAMES.map((name) => [name, resolveQuirkydPath(name)]))

    for (const [name, answer] of answers) {
      expect(answer, `${name} answered nothing`).toBeTruthy()
      if (name !== 'userData') {
        // The catch-all this replaced returned the data directory for four of seven
        // names, 'exe' included — a data directory is not an executable.
        expect(answer, `${name} answered the userData directory`).not.toBe(
          join(sep, 'srv', 'quirky-state')
        )
      }
    }
  })

  it("answers 'exe' with the Node binary running this process", () => {
    expect(resolveQuirkydPath('exe')).toBe(process.execPath)
  })

  it("keeps 'logs' inside the data root so the whole deployment is one directory", () => {
    vi.stubEnv('QUIRKY_USER_DATA', join(sep, 'srv', 'quirky-state'))
    expect(resolveQuirkydPath('logs')).toBe(join(sep, 'srv', 'quirky-state', 'logs'))
  })

  it("answers 'home' and 'temp' from the OS", () => {
    expect(resolveQuirkydPath('home')).toBe(homedir())
    expect(resolveQuirkydPath('temp')).toBe(tmpdir())
  })

  it("answers 'appData' with the per-user application-data root of each platform", () => {
    setPlatform('darwin')
    expect(resolveQuirkydPath('appData')).toBe(join(homedir(), 'Library', 'Application Support'))

    setPlatform('win32')
    vi.stubEnv('APPDATA', join('C:', 'Users', 'quirky', 'AppData', 'Roaming'))
    expect(resolveQuirkydPath('appData')).toBe(join('C:', 'Users', 'quirky', 'AppData', 'Roaming'))
    vi.stubEnv('APPDATA', '')
    expect(resolveQuirkydPath('appData')).toBe(join(homedir(), 'AppData', 'Roaming'))

    setPlatform('linux')
    vi.stubEnv('XDG_CONFIG_HOME', join(sep, 'xdg-config'))
    expect(resolveQuirkydPath('appData')).toBe(join(sep, 'xdg-config'))
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(resolveQuirkydPath('appData')).toBe(join(homedir(), '.config'))
  })

  it("answers 'downloads' from XDG_DOWNLOAD_DIR before the home default", () => {
    vi.stubEnv('XDG_DOWNLOAD_DIR', join(sep, 'srv', 'incoming'))
    expect(resolveQuirkydPath('downloads')).toBe(join(sep, 'srv', 'incoming'))

    vi.stubEnv('XDG_DOWNLOAD_DIR', '')
    expect(resolveQuirkydPath('downloads')).toBe(join(homedir(), 'Downloads'))
  })
})

describe('resolveQuirkydInstallRoot', () => {
  it('is the directory holding the running bundle, not the working directory', () => {
    expect(resolveQuirkydInstallRoot(join(sep, 'opt', 'quirky', 'quirkyd.js'))).toBe(
      join(sep, 'opt', 'quirky')
    )
  })

  it('absolutizes a relative script path against the working directory', () => {
    expect(resolveQuirkydInstallRoot(join('out', 'quirkyd', 'quirkyd.js'))).toBe(
      join(process.cwd(), 'out', 'quirkyd')
    )
  })

  // STA-5495: siblings such as the watcher entry ship beside the bundle, not beside the link.
  it.skipIf(process.platform === 'win32')('follows a symlinked script to the real bundle', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirkyd-install-root-')))
    try {
      const bundle = join(root, 'slot')
      const bin = join(root, 'bin')
      mkdirSync(bundle)
      mkdirSync(bin)
      writeFileSync(join(bundle, 'quirkyd.js'), '')
      symlinkSync(join(bundle, 'quirkyd.js'), join(bin, 'quirkyd'))
      expect(resolveQuirkydInstallRoot(join(bin, 'quirkyd'))).toBe(bundle)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses instead of guessing when the process has no main script', () => {
    const originalArgv = process.argv
    // `node -e` leaves argv[1] unset; cwd would be a guess, not an answer.
    process.argv = [process.execPath]
    try {
      expect(() => resolveQuirkydInstallRoot()).toThrow(/quirkyd_install_root_unavailable/)
    } finally {
      process.argv = originalArgv
    }
  })
})
