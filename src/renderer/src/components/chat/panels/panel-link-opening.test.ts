import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openRoutedHttpLinkMock = vi.hoisted(() => vi.fn())
const openUrlMock = vi.fn()

vi.mock('@/lib/http-link-destinations', () => ({ openRoutedHttpLink: openRoutedHttpLinkMock }))
vi.mock('@/components/native-chat/native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { openPanelLink, openPanelPreview } from './panel-link-opening'

beforeEach(() => {
  vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('panel link opening', () => {
  it('routes a link through its workspace when one is known', () => {
    openPanelLink('https://example.com/', 'wt-1')
    expect(openRoutedHttpLinkMock).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ worktreeId: 'wt-1' })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens a link without a workspace in the system browser', () => {
    openPanelLink('https://example.com/', null)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(openRoutedHttpLinkMock).not.toHaveBeenCalled()
  })

  it('opens a preview without a workspace in the system browser', () => {
    openPanelPreview('http://localhost:3000/', undefined)
    expect(openUrlMock).toHaveBeenCalledWith('http://localhost:3000/')
  })

  it('refuses non-http schemes', () => {
    openPanelLink('file:///etc/passwd', null)
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})
