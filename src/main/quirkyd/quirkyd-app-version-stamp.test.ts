import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stampQuirkydAppVersion } from './quirkyd-host-adapters'

describe('the Quirky version a server reports', () => {
  let root: string
  let saved: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quirkyd-app-version-'))
    saved = process.env.QUIRKY_APP_VERSION
    delete process.env.QUIRKY_APP_VERSION
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (saved === undefined) {
      delete process.env.QUIRKY_APP_VERSION
    } else {
      process.env.QUIRKY_APP_VERSION = saved
    }
  })

  it('is the release its bundle was built from, not a dev placeholder', () => {
    mkdirSync(join(root, 'out', 'cli'), { recursive: true })
    writeFileSync(join(root, 'out', 'package.json'), JSON.stringify({ version: '1.4.224' }))
    stampQuirkydAppVersion(() => root)
    expect(process.env.QUIRKY_APP_VERSION).toBe('1.4.224')
  })

  it('replaces a version inherited from the Quirky that started it', () => {
    process.env.QUIRKY_APP_VERSION = '1.4.300'
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'package.json'), JSON.stringify({ version: '1.4.224' }))
    stampQuirkydAppVersion(() => root)
    expect(process.env.QUIRKY_APP_VERSION).toBe('1.4.224')
  })

  it('leaves the environment alone when the bundle has no version', () => {
    stampQuirkydAppVersion(() => root)
    expect(process.env.QUIRKY_APP_VERSION).toBeUndefined()
    stampQuirkydAppVersion(() => {
      throw new Error('quirkyd_install_root_unavailable')
    })
    expect(process.env.QUIRKY_APP_VERSION).toBeUndefined()
  })
})
