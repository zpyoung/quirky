import { afterEach, describe, expect, it } from 'vitest'
import {
  attachmentPreviewSourcePath,
  clearAttachmentPreviewSourcesForTests,
  rememberUploadedAttachmentPreviewSources
} from './agent-composer-attachment-preview'

const HOST = { connectionId: 'conn-a' }
const OTHER_HOST = { connectionId: 'conn-b' }

afterEach(() => {
  clearAttachmentPreviewSourcesForTests()
})

describe('attachment preview sources', () => {
  it('pairs uploaded remote paths with the local files they came from', () => {
    rememberUploadedAttachmentPreviewSources(
      HOST,
      ['/local/a.png', '/local/b.png'],
      ['/remote/.quirky/drops/a.png', '/remote/.quirky/drops/b.png'],
      [],
      []
    )

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/.quirky/drops/a.png')).toBe(
      '/local/a.png'
    )
    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/.quirky/drops/b.png')).toBe(
      '/local/b.png'
    )
  })

  it('skips over sources the upload skipped or failed', () => {
    rememberUploadedAttachmentPreviewSources(
      HOST,
      ['/local/skipped.png', '/local/kept.png', '/local/failed.png'],
      ['/remote/.quirky/drops/kept.png'],
      [{ sourcePath: '/local/skipped.png' }],
      [{ sourcePath: '/local/failed.png' }]
    )

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/.quirky/drops/kept.png')).toBe(
      '/local/kept.png'
    )
  })

  it('remembers nothing when the pairing cannot be reconstructed', () => {
    rememberUploadedAttachmentPreviewSources(
      HOST,
      ['/local/a.png', '/local/b.png'],
      ['/remote/.quirky/drops/a.png'],
      [],
      []
    )

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/.quirky/drops/a.png')).toBe(
      '/remote/.quirky/drops/a.png'
    )
  })

  it('falls back to the attachment path when nothing was remembered for it', () => {
    expect(attachmentPreviewSourcePath(HOST.connectionId, '/local/pasted.png')).toBe(
      '/local/pasted.png'
    )
  })

  it('keeps two hosts that share a remote path apart', () => {
    const remotePath = '/home/user/project/.quirky/drops/shot.png'
    rememberUploadedAttachmentPreviewSources(HOST, ['/local/a/secret.png'], [remotePath], [], [])
    rememberUploadedAttachmentPreviewSources(
      OTHER_HOST,
      ['/local/b/public.png'],
      [remotePath],
      [],
      []
    )

    expect(attachmentPreviewSourcePath(HOST.connectionId, remotePath)).toBe('/local/a/secret.png')
    expect(attachmentPreviewSourcePath(OTHER_HOST.connectionId, remotePath)).toBe(
      '/local/b/public.png'
    )
  })

  it('reads a local worktree straight from the attachment path, ignoring any mapping', () => {
    rememberUploadedAttachmentPreviewSources(HOST, ['/local/a.png'], ['/remote/a.png'], [], [])

    expect(attachmentPreviewSourcePath(null, '/remote/a.png')).toBe('/remote/a.png')
  })

  it('bounds what it remembers so long-lived sessions cannot grow it forever', () => {
    for (let index = 0; index < 100; index += 1) {
      rememberUploadedAttachmentPreviewSources(
        HOST,
        [`/local/${index}.png`],
        [`/remote/${index}.png`],
        [],
        []
      )
    }

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/0.png')).toBe('/remote/0.png')
    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/99.png')).toBe('/local/99.png')
  })

  it('keeps every source of one oversized drop, so no chip in it loses its image', () => {
    const sources = Array.from({ length: 100 }, (_, index) => `/local/${index}.png`)
    const uploaded = Array.from({ length: 100 }, (_, index) => `/remote/${index}.png`)

    rememberUploadedAttachmentPreviewSources(HOST, sources, uploaded, [], [])

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/0.png')).toBe('/local/0.png')
    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/99.png')).toBe('/local/99.png')
  })

  it('trims an oversized drop back to the bound once a later drop arrives', () => {
    const sources = Array.from({ length: 100 }, (_, index) => `/local/${index}.png`)
    const uploaded = Array.from({ length: 100 }, (_, index) => `/remote/${index}.png`)
    rememberUploadedAttachmentPreviewSources(HOST, sources, uploaded, [], [])

    rememberUploadedAttachmentPreviewSources(
      HOST,
      ['/local/next.png'],
      ['/remote/next.png'],
      [],
      []
    )

    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/0.png')).toBe('/remote/0.png')
    expect(attachmentPreviewSourcePath(HOST.connectionId, '/remote/next.png')).toBe(
      '/local/next.png'
    )
  })
})
