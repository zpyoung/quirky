// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readLocalWorkspaceImage } from './workspace-image-read'

const readDir = vi.fn()
const readFile = vi.fn()

beforeEach(() => {
  readDir.mockReset()
  readFile.mockReset()
  vi.stubGlobal('window', { api: { fs: { readDir, readFile } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readLocalWorkspaceImage', () => {
  it('refuses a path whose directory component is a symlink', async () => {
    readDir.mockResolvedValueOnce([{ name: 'docs', isDirectory: false, isSymlink: true }])
    await expect(readLocalWorkspaceImage('/work/a', 'docs/shot.png')).rejects.toThrow(
      /symbolic link/
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('refuses a symlinked image file', async () => {
    readDir
      .mockResolvedValueOnce([{ name: 'docs', isDirectory: true, isSymlink: false }])
      .mockResolvedValueOnce([{ name: 'shot.png', isDirectory: false, isSymlink: true }])
    await expect(readLocalWorkspaceImage('/work/a', 'docs/shot.png')).rejects.toThrow(
      /symbolic link/
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reads an image reached without any symlink', async () => {
    readDir
      .mockResolvedValueOnce([{ name: 'docs', isDirectory: true, isSymlink: false }])
      .mockResolvedValueOnce([{ name: 'shot.png', isDirectory: false, isSymlink: false }])
    readFile.mockResolvedValue({
      content: 'AAAA',
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
    await expect(readLocalWorkspaceImage('/work/a', 'docs/shot.png')).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AAAA'
    })
    expect(readDir).toHaveBeenNthCalledWith(1, { dirPath: '/work/a' })
    expect(readDir).toHaveBeenNthCalledWith(2, { dirPath: '/work/a/docs' })
  })
})
