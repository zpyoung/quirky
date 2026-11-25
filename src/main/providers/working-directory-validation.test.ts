import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateWorkingDirectoryAsync } from './local-pty-utils'
import { _resetWorkingDirectoryValidationStateForTest } from './working-directory-validation'

let tempDir: string

beforeEach(async () => {
  _resetWorkingDirectoryValidationStateForTest()
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'quirky-cwd-validate-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('validateWorkingDirectoryAsync', () => {
  it('accepts an existing directory', async () => {
    await expect(validateWorkingDirectoryAsync(tempDir)).resolves.toBeUndefined()
  })

  it('rejects a missing directory with the actionable unmounted-volume message', async () => {
    await expect(validateWorkingDirectoryAsync(path.join(tempDir, 'gone'))).rejects.toThrow(
      /does not exist.*unmounted volume/s
    )
  })

  it('rejects a path that exists but is a file', async () => {
    const filePath = path.join(tempDir, 'not-a-dir.txt')
    await writeFile(filePath, 'x')

    await expect(validateWorkingDirectoryAsync(filePath)).rejects.toThrow('is not a directory')
  })

  it('never blocks the event loop while the filesystem answers', async () => {
    // A dead UNC share must not freeze unrelated daemon RPCs (STA-4470).
    let ticked = false
    const pending = validateWorkingDirectoryAsync(tempDir)
    setImmediate(() => {
      ticked = true
    })

    await pending

    expect(ticked).toBe(true)
  })
})
