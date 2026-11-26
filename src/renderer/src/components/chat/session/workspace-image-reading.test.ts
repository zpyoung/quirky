// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readDir: vi.fn(), readPreview: vi.fn() }))

vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  readRuntimeDirectory: mocks.readDir
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readPreview
}))

import { workspaceImageReaderFor } from './workspace-image-reading'

const context = { target: { kind: 'local' }, worktreeId: 'wt-1', worktreePath: '/work/a' } as const

beforeEach(() => {
  mocks.readDir.mockReset()
  mocks.readPreview.mockReset()
})

describe('workspaceImageReaderFor', () => {
  it('refuses a path through a symlinked directory without reading the file', async () => {
    mocks.readDir.mockResolvedValueOnce([{ name: 'docs', isDirectory: false, isSymlink: true }])
    const read = workspaceImageReaderFor(context)

    await expect(read?.('docs/shot.png')).rejects.toThrow(/symbolic link/)
    expect(mocks.readPreview).not.toHaveBeenCalled()
  })

  it('reads an image reached without a symlink through the owner listing', async () => {
    mocks.readDir
      .mockResolvedValueOnce([{ name: 'docs', isDirectory: true, isSymlink: false }])
      .mockResolvedValueOnce([{ name: 'shot.png', isDirectory: false, isSymlink: false }])
    mocks.readPreview.mockResolvedValue({ content: 'AAAA', isImage: true, mimeType: 'image/png' })
    const read = workspaceImageReaderFor(context)

    await expect(read?.('docs/shot.png')).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AAAA'
    })
    expect(mocks.readDir).toHaveBeenNthCalledWith(2, context, '/work/a/docs')
  })
})
