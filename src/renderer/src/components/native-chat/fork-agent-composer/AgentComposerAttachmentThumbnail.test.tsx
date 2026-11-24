// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentComposerAttachmentThumbnail } from './AgentComposerAttachmentThumbnail'
import {
  clearAttachmentPreviewSourcesForTests,
  rememberUploadedAttachmentPreviewSources
} from './agent-composer-attachment-preview'

const loadLocalImageAbsolutePath = vi.hoisted(() => vi.fn())
const onImageCacheInvalidated = vi.hoisted(() => vi.fn(() => () => {}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  loadLocalImageAbsolutePath,
  onImageCacheInvalidated
}))

// The pane's owner is what scopes a remote preview; stub the two resolvers so a
// test can say which connection a tab belongs to without a whole store fixture.
const connectionIdByTab = vi.hoisted(() => new Map<string, string | null>())

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree: {} }) }
}))

vi.mock('../native-chat-file-link', () => ({
  findTerminalTabWorktreeId: (_tabs: unknown, terminalTabId: string) => terminalTabId
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState: (_state: unknown, worktreeId: string | null) =>
    worktreeId === null ? null : connectionIdByTab.get(worktreeId)
}))

const CHAT_IMAGE_ACCESS = { kind: 'chat-image' }

beforeEach(() => {
  loadLocalImageAbsolutePath.mockResolvedValue('blob:quirky/attachment')
})

afterEach(() => {
  cleanup()
  connectionIdByTab.clear()
  clearAttachmentPreviewSourcesForTests()
  vi.clearAllMocks()
})

describe('AgentComposerAttachmentThumbnail', () => {
  it('shows the attached image once it can be read', async () => {
    render(
      <AgentComposerAttachmentThumbnail
        path="/local/shot.png"
        label="shot.png"
        terminalTabId="tab-1"
      />
    )

    const thumbnail = await screen.findByAltText('shot.png')
    expect(thumbnail).toHaveAttribute('src', 'blob:quirky/attachment')
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith(
      '/local/shot.png',
      undefined,
      undefined,
      CHAT_IMAGE_ACCESS
    )
  })

  it('reads an attached path outside the worktree with chat-image access', async () => {
    render(
      <AgentComposerAttachmentThumbnail
        path="/outside/worktree/shot.png"
        label="shot.png"
        terminalTabId="tab-1"
      />
    )

    await screen.findByAltText('shot.png')
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith(
      '/outside/worktree/shot.png',
      undefined,
      undefined,
      CHAT_IMAGE_ACCESS
    )
  })

  it('reads an uploaded attachment from the local file it came from', async () => {
    connectionIdByTab.set('tab-1', 'conn-a')
    rememberUploadedAttachmentPreviewSources(
      { connectionId: 'conn-a' },
      ['/local/shot.png'],
      ['/remote/.quirky/drops/shot.png'],
      [],
      []
    )

    render(
      <AgentComposerAttachmentThumbnail
        path="/remote/.quirky/drops/shot.png"
        label="shot.png"
        terminalTabId="tab-1"
      />
    )

    await screen.findByAltText('shot.png')
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith(
      '/local/shot.png',
      undefined,
      undefined,
      CHAT_IMAGE_ACCESS
    )
  })

  it('never shows another host image for the same remote path', async () => {
    connectionIdByTab.set('tab-a', 'conn-a')
    connectionIdByTab.set('tab-b', 'conn-b')
    const remotePath = '/home/user/project/.quirky/drops/shot.png'
    rememberUploadedAttachmentPreviewSources(
      { connectionId: 'conn-a' },
      ['/local/a/secret.png'],
      [remotePath],
      [],
      []
    )

    render(
      <AgentComposerAttachmentThumbnail path={remotePath} label="shot.png" terminalTabId="tab-b" />
    )

    await waitFor(() => expect(loadLocalImageAbsolutePath).toHaveBeenCalled())
    expect(loadLocalImageAbsolutePath).toHaveBeenCalledWith(
      remotePath,
      undefined,
      undefined,
      CHAT_IMAGE_ACCESS
    )
    expect(loadLocalImageAbsolutePath.mock.calls.map(([path]) => path)).not.toContain(
      '/local/a/secret.png'
    )
  })

  it('keeps the icon when the image cannot be read', async () => {
    loadLocalImageAbsolutePath.mockResolvedValue(null)

    const { container } = render(
      <AgentComposerAttachmentThumbnail
        path="/remote/only.png"
        label="only.png"
        terminalTabId="tab-1"
      />
    )

    await waitFor(() => expect(loadLocalImageAbsolutePath).toHaveBeenCalled())
    expect(screen.queryByAltText('only.png')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})
