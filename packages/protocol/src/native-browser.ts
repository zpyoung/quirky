
/** Only persistent partitions owned by quirky.browser may be cleared or mounted. */
export const NATIVE_BROWSER_PARTITION_RE = /^persist:quirky-browser-(?:default|profile_[0-9a-f]{32})$/

/** Electrobun rules: block all URLs, then allow only human-browser protocols. */
export const NATIVE_BROWSER_NAVIGATION_RULES = ['^*', 'https://*', 'http://*', 'file://*', 'about:blank'] as const

/** A sandboxed system-webview hosted inside a plugin-owned element. Never available in a plain web client. */
export type NativeBrowserState = {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  zoom: number; error: string | null; findCurrent: number; findTotal: number
}
export type NativeBrowserRequest =
  | { action: 'navigate'; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' }
  | { action: 'find'; text: string; forward?: boolean }
  | { action: 'zoom'; level: number }
export type NativeBrowserOptions = {
  id: string
  url: string
  zoom: number
  partition: string
  /** Additional host-element masks; plugin-owned overlays may mark themselves with `data-quirky-native-mask`. */
  masks?: string[]
  onState(state: NativeBrowserState): void
  onPopup?(url: string, userGesture: boolean): void
}
export type NativeBrowserHandle = { request(request: NativeBrowserRequest): Promise<NativeBrowserState>; dispose(): void }
export type NativeBrowserCapability = {
  readonly available: boolean
  /** Whether the host can confirm native website-data removal completed. */
  readonly clearPartitionAvailable: boolean
  mount(element: HTMLElement, options: NativeBrowserOptions): NativeBrowserHandle
  /** Clears only dedicated browser partitions; rejects when the host cannot confirm completion. */
  clearPartition(partition: string): Promise<void>
}
