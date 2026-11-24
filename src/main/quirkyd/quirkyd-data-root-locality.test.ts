import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { quirkydDataRootIsOnLocalDisk } from './quirkyd-data-root-locality'

describe('quirkydDataRootIsOnLocalDisk', () => {
  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'recognises a local temp directory, and refuses a path it cannot inspect',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'quirkyd-locality-'))
      try {
        expect(quirkydDataRootIsOnLocalDisk(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      expect(quirkydDataRootIsOnLocalDisk(join(root, 'missing'))).toBe(false)
    }
  )

  it('treats a Windows UNC data root as reachable from other machines', () => {
    expect(quirkydDataRootIsOnLocalDisk('\\\\filer\\home\\quirky', 'win32')).toBe(false)
    expect(quirkydDataRootIsOnLocalDisk('\\\\?\\UNC\\filer\\home\\quirky', 'win32')).toBe(false)
    expect(quirkydDataRootIsOnLocalDisk('C:\\Users\\u\\AppData\\Roaming\\quirky', 'win32')).toBe(
      true
    )
    expect(quirkydDataRootIsOnLocalDisk('\\\\?\\C:\\Users\\u\\quirky', 'win32')).toBe(true)
  })
})
