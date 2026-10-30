import type { PaneFrame } from '../pane-contract'

export type FrameBox = { left: number; top: number; width: number; height: number }
export type FramePoint = { x: number; y: number }

/** Maps a pointer from the visible, centered object-fit:contain image into frame pixels. */
export function pointerToFramePoint(
  clientX: number,
  clientY: number,
  box: FrameBox,
  frameWidth: number,
  frameHeight: number
): FramePoint | null {
  if (
    !Number.isFinite(clientX) || !Number.isFinite(clientY) ||
    !Number.isFinite(box.left) || !Number.isFinite(box.top) ||
    !Number.isFinite(box.width) || !Number.isFinite(box.height) ||
    !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) ||
    box.width <= 0 || box.height <= 0 || frameWidth <= 0 || frameHeight <= 0
  ) return null

  const scale = Math.min(box.width / frameWidth, box.height / frameHeight)
  const drawnWidth = frameWidth * scale
  const drawnHeight = frameHeight * scale
  const left = box.left + (box.width - drawnWidth) / 2
  const top = box.top + (box.height - drawnHeight) / 2
  if (clientX < left || clientX >= left + drawnWidth || clientY < top || clientY >= top + drawnHeight) return null
  return { x: (clientX - left) / scale, y: (clientY - top) / scale }
}

/** Keeps the newest frame only; events from another pane, lease, or sequence are discarded. */
export function acceptLatestFrame(
  current: PaneFrame | null,
  incoming: PaneFrame,
  pane: string,
  watchId: string
): PaneFrame | null {
  if (
    incoming.pane !== pane || incoming.watchId !== watchId ||
    !Number.isSafeInteger(incoming.sequence) || incoming.sequence < 0
  ) return current
  if (current?.pane === pane && current.watchId === watchId && incoming.sequence <= current.sequence) return current
  return incoming
}
const NON_TEXT_KEYS: Readonly<Record<string, true>> = {
  Alt: true, AltGraph: true, Backspace: true, CapsLock: true, ContextMenu: true, Control: true,
  Dead: true, Delete: true, End: true, Enter: true, Escape: true, Fn: true, FnLock: true, Home: true,
  Insert: true, Meta: true, NumLock: true, PageDown: true, PageUp: true, Pause: true, PrintScreen: true,
  Process: true, ScrollLock: true, Shift: true, Symbol: true, SymbolLock: true, Tab: true, Unidentified: true,
  ArrowDown: true, ArrowLeft: true, ArrowRight: true, ArrowUp: true
}

/** Distinguishes printable key values (including multi-code-unit Unicode) from browser controls. */
export function isTextInputKey(key: string): boolean {
  const functionKey = key.length > 1 && key[0] === 'F' && Number.isInteger(Number(key.slice(1)))
  return key !== '' && !Object.hasOwn(NON_TEXT_KEYS, key) && !functionKey
}
export function paneForView<T extends { id: string }>(tabs: readonly T[], active: string | null, requestedPaneId: string | null): T | null {
  if (requestedPaneId !== null) return tabs.find((tab) => tab.id === requestedPaneId) ?? null
  return tabs.find((tab) => tab.id === active) ?? null
}
/** What the address bar shows: a document page is identified by its file, never its grant URL. */
export function paneAddress(pane: { url: string; document?: { path: string } }): string {
  return pane.document ? pane.document.path : pane.url
}

/** Back and Forward stay live while a conversion is left to cross after guest history runs out. */
export function paneHistoryControls(pane: { canGoBack: boolean; canGoForward: boolean; convertedFrom?: unknown; convertedTo?: unknown }): { back: boolean; forward: boolean } {
  return { back: pane.canGoBack || pane.convertedFrom !== undefined, forward: pane.canGoForward || pane.convertedTo !== undefined }
}

/** Resolves only the backend-issued preview URL; ordinary typed addresses stay unchanged. */
export function nativePreviewNavigationUrl(url: string | undefined, previewUrl: string | undefined, baseUrl: string): string | null {
  if (!url) return null
  if (url !== previewUrl) return url
  try {
    return new URL(url, baseUrl).href
  } catch {
    return null
  }
}
/** Restores the backend's opaque preview route after Native reports its resolved navigation URL. */
export function nativePreviewReportUrl(url: string, previewUrl: string | undefined, baseUrl: string): string {
  if (!previewUrl) return url
  const resolvedPreviewUrl = nativePreviewNavigationUrl(previewUrl, previewUrl, baseUrl)
  return url === resolvedPreviewUrl ? previewUrl : url
}
