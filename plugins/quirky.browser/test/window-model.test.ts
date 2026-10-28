import { describe, expect, test } from 'bun:test'
import type { PaneFrame } from '../src/pane-contract'
import { acceptLatestFrame, isTextInputKey, nativePreviewNavigationUrl, nativePreviewReportUrl, paneForView, pointerToFramePoint } from '../src/window/model'

const frame = (watchId: string, sequence: number, pane = 'pane-a'): PaneFrame => ({
  pane,
  watchId,
  sequence,
  data: 'frame',
  width: 1600,
  height: 900
})

describe('browser window model', () => {
  test('maps pointer positions through a centered letterboxed frame', () => {
    const box = { left: 10, top: 20, width: 500, height: 500 }

    expect(pointerToFramePoint(260, 270, box, 1600, 900)).toEqual({ x: 800, y: 450 })
    expect(pointerToFramePoint(260, 25, box, 1600, 900)).toBeNull()
    expect(pointerToFramePoint(9, 270, box, 1600, 900)).toBeNull()
  })

  test('keeps only newer frames from the currently leased pane and watch', () => {
    const current = frame('watch-2', 4)

    expect(acceptLatestFrame(current, frame('watch-1', 99), 'pane-a', 'watch-2')).toBe(current)
    expect(acceptLatestFrame(current, frame('watch-2', 3), 'pane-a', 'watch-2')).toBe(current)
    expect(acceptLatestFrame(current, frame('watch-2', 5, 'pane-b'), 'pane-a', 'watch-2')).toBe(current)
    expect(acceptLatestFrame(current, frame('watch-2', 5), 'pane-a', 'watch-2')).toEqual(frame('watch-2', 5))
  })
  test('sends printable Unicode keys as text and keeps controls as key events', () => {
    expect(isTextInputKey('😀')).toBe(true)
    expect(isTextInputKey('東京')).toBe(true)
    expect(isTextInputKey('ArrowLeft')).toBe(false)
    expect(isTextInputKey('F1')).toBe(false)
    expect(isTextInputKey('Dead')).toBe(false)
  })
  test('does not retarget a closed hosted pane to another active pane', () => {
    const tabs = [{ id: 'other-pane' }]

    expect(paneForView(tabs, 'other-pane', 'closed-pane')).toBeNull()
    expect(paneForView(tabs, 'other-pane', null)).toEqual({ id: 'other-pane' })
  })
  test('resolves only the backend-issued preview route at the Native navigation boundary', () => {
    const base = 'https://app.example.test/worktree/current'

    expect(nativePreviewNavigationUrl('/plugin-file-resources/token', '/plugin-file-resources/token', base))
      .toBe('https://app.example.test/plugin-file-resources/token')
    expect(nativePreviewNavigationUrl('/plugin-file-resources/token', undefined, base))
      .toBe('/plugin-file-resources/token')
    expect(nativePreviewNavigationUrl('file:///worktree/page.html', '/plugin-file-resources/token', base))
      .toBe('file:///worktree/page.html')
  })
  test('keeps backend preview routes opaque in Native state reports', () => {
    const base = 'https://app.example.test/worktree/current'

    expect(nativePreviewReportUrl('https://app.example.test/plugin-file-resources/token', '/plugin-file-resources/token', base))
      .toBe('/plugin-file-resources/token')
    expect(nativePreviewReportUrl('https://elsewhere.example/page', '/plugin-file-resources/token', base))
      .toBe('https://elsewhere.example/page')
  })
})
