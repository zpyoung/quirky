import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, lstatMock, readFileMock, rmMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn()
}))

// Why mock the chokepoint: encoding, timeout and the hidden console are its
// contract now, so this suite asserts what the distro is asked to run.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock,
  rm: rmMock
}))

import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toHostFilesystemPath,
  toHostRemovalPath
} from './local-worktree-filesystem'

function completeExecFile(stdout = ''): void {
  runProcessMock.mockResolvedValue({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('local worktree filesystem runtime access', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    completeExecFile()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses host filesystem operations when no WSL distro is selected', async () => {
    lstatMock.mockResolvedValue({ type: 'file' })
    readFileMock.mockResolvedValue('gitdir: ../.git/worktrees/feature')

    const access = getLocalWorktreePathAccess()
    await access.statPath('C:\\repo\\.git')
    await access.readPath('C:\\repo\\.git')
    await removeLocalWorktreePath('C:\\repo\\feature')

    expect(lstatMock).toHaveBeenCalledWith('C:\\repo\\.git')
    expect(readFileMock).toHaveBeenCalledWith('C:\\repo\\.git', 'utf8')
    expect(rmMock).toHaveBeenCalledWith(
      toHostRemovalPath('C:\\repo\\feature'),
      expect.objectContaining({
        recursive: true,
        force: true
      })
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('uses a Win32 long-path namespace for host removal on Windows', async () => {
    await withPlatform('win32', async () => {
      const longPath = `C:\\repo\\${'nested\\'.repeat(40)}feature`

      await removeLocalWorktreePath(longPath)

      expect(toHostRemovalPath(longPath)).toBe(`\\\\?\\${longPath}`)
      expect(rmMock).toHaveBeenCalledWith(
        `\\\\?\\${longPath}`,
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
    })
  })

  it('uses the same Win32 namespace for host directory creation on Windows', async () => {
    await withPlatform('win32', async () => {
      const longPath = `C:\\repo\\${'nested\\'.repeat(40)}feature`

      expect(toHostFilesystemPath(longPath)).toBe(`\\\\?\\${longPath}`)
    })
  })

  it('leaves POSIX WSL paths unchanged on a Windows host', async () => {
    await withPlatform('win32', async () => {
      expect(toHostFilesystemPath('/home/me/worktrees')).toBe('/home/me/worktrees')
    })
  })

  it('leaves WSL UNC paths unchanged on a Windows host', async () => {
    await withPlatform('win32', async () => {
      const wslPath = String.raw`\\wsl.localhost\Ubuntu\home\me\worktrees`
      expect(toHostFilesystemPath(wslPath)).toBe(wslPath)
    })
  })

  it('retries transient host removal failures on Windows', async () => {
    vi.useFakeTimers()
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
      rmMock.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)

      const removal = removeLocalWorktreePath('C:\\repo\\feature')
      await vi.advanceTimersByTimeAsync(250)

      await expect(removal).resolves.toBeUndefined()
      expect(rmMock).toHaveBeenCalledTimes(2)
      expect(rmMock).toHaveBeenNthCalledWith(
        1,
        toHostRemovalPath('C:\\repo\\feature'),
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
      expect(rmMock).toHaveBeenNthCalledWith(
        2,
        toHostRemovalPath('C:\\repo\\feature'),
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
    })
  })

  it('does not retry host removal failures outside Windows', async () => {
    await withPlatform('linux', async () => {
      const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
      rmMock.mockRejectedValue(error)

      await expect(removeLocalWorktreePath('/repo/feature')).rejects.toBe(error)
      expect(rmMock).toHaveBeenCalledTimes(1)
    })
  })
})
