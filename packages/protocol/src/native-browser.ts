
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
/**
 * A page action the system webview holds until the owner answers it. `id` is opaque and
 * single-use; an unanswered request fails closed when the host's deadline passes.
 */
export type NativeBrowserPageRequest =
  | { id: string; kind: 'alert' | 'confirm' | 'prompt'; origin: string; frameUrl: string; message: string; defaultText?: string }
  | { id: string; kind: 'auth'; origin: string; host: string; realm: string; isProxy: boolean; previousFailureCount: number }
  | { id: string; kind: 'certificate'; origin: string; host: string; error: string }
  | { id: string; kind: 'external'; origin: string; url: string; scheme: string; userGesture: boolean }
  | { id: string; kind: 'download'; origin: string; url: string; suggestedFilename: string; mimeType: string; expectedBytes: number }
  | { id: string; kind: 'popup'; origin: string; url: string; method: string; width: number | null; height: number | null }
/**
 * `text` answers a prompt, `username`/`password` an auth challenge, `path` (absolute) a download.
 * Accepting a popup opens it, with its opener intact, in a host-owned window titled by its origin.
 */
export type NativeBrowserPageAnswer = { accept: boolean; text?: string; username?: string; password?: string; path?: string }
export type NativeBrowserDownloadUpdate = {
  id: string; state: 'started' | 'progress' | 'completed' | 'failed'
  path?: string; received?: number; total?: number; error?: string; cancelled?: boolean
}
export type NativeBrowserOptions = {
  id: string
  url: string
  zoom: number
  partition: string
  /** Additional host-element masks; plugin-owned overlays may mark themselves with `data-quirky-native-mask`. */
  masks?: string[]
  onState(state: NativeBrowserState): void
  /** Observed only where page requests are unavailable; otherwise popups arrive as `onPageRequest`. */
  onPopup?(url: string, userGesture: boolean): void
  onPageRequest?(request: NativeBrowserPageRequest): void
  /** The request can no longer be answered: it timed out or its view went away. */
  onPageRequestExpired?(id: string): void
  /** Download ids come from the accepted `download` request. */
  onDownload?(update: NativeBrowserDownloadUpdate): void
}
export type NativeBrowserHandle = {
  request(request: NativeBrowserRequest): Promise<NativeBrowserState>
  /** Executes in this owned sandboxed guest, returning untrusted JSON; never host authority. */
  evaluate(script: string): Promise<unknown>
  /** Resolves false when the request is unknown, already answered or expired. */
  answer?(id: string, answer: NativeBrowserPageAnswer): Promise<boolean>
  /** Resolves false when the download is not active in this view. */
  cancelDownload?(id: string): Promise<boolean>
  dispose(): void
}
export type NativeBrowserCapability = {
  readonly available: boolean
  /** Whether the host can confirm native website-data removal completed. */
  readonly clearPartitionAvailable: boolean
  /** Whether mounted views deliver page requests and download control instead of the webview's defaults. */
  readonly pageRequestsAvailable?: boolean
  mount(element: HTMLElement, options: NativeBrowserOptions): NativeBrowserHandle
  /** Clears only dedicated browser partitions; rejects when the host cannot confirm completion. */
  clearPartition(partition: string): Promise<void>
}
