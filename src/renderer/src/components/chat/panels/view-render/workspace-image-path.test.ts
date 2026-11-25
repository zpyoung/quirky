import { describe, expect, it } from 'vitest'
import { resolveWorkspaceImagePath } from './workspace-image-path'

const ROOT = '/Users/me/project'

describe('resolveWorkspaceImagePath', () => {
  it('resolves a relative path inside the workspace', () => {
    expect(resolveWorkspaceImagePath(ROOT, 'docs/shot.png')).toEqual({
      ok: true,
      relativePath: 'docs/shot.png',
      absolutePath: '/Users/me/project/docs/shot.png'
    })
  })

  it('normalizes dot segments and a trailing slash on the root', () => {
    expect(resolveWorkspaceImagePath(`${ROOT}/`, './a/./b/../c.png')).toEqual({
      ok: true,
      relativePath: 'a/c.png',
      absolutePath: '/Users/me/project/a/c.png'
    })
  })

  it.each([
    '/etc/passwd',
    '~/secret.png',
    '../outside.png',
    'a/../../outside.png',
    '..',
    'C:/Users/x.png',
    'file:///etc/passwd',
    'https://example.com/x.png',
    'a\\b.png',
    'a\0b.png',
    '',
    '   ',
    './'
  ])('rejects %j', (path) => {
    expect(resolveWorkspaceImagePath(ROOT, path).ok).toBe(false)
  })

  it('rejects everything without a workspace root', () => {
    expect(resolveWorkspaceImagePath(null, 'a.png').ok).toBe(false)
    expect(resolveWorkspaceImagePath('', 'a.png').ok).toBe(false)
  })
})
