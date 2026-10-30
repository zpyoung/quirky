
/** Only persistent partitions owned by quirky.browser may be cleared or mounted. */
export const NATIVE_BROWSER_PARTITION_RE = /^persist:quirky-browser-(?:default|profile_[0-9a-f]{32})$/

/** Localhost worktree labels are `<label>.quirky.localhost`; native panes send this domain to the label proxy. */
export const NATIVE_BROWSER_LABEL_DOMAIN = 'quirky.localhost'

/** Electrobun rules: block all URLs, then allow only human-browser protocols. */
export const NATIVE_BROWSER_NAVIGATION_RULES = ['^*', 'https://*', 'http://*', 'file://*', 'about:blank'] as const

/** The custom scheme isolated workspace-document previews are served over; never a browsing URL. */
export const NATIVE_BROWSER_PREVIEW_SCHEME = 'quirky-preview'

/** Electrobun rules for an isolated preview: block all URLs, then allow only its own scheme. */
export const NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES = ['^*', 'quirky-preview://*', 'about:blank'] as const

export const NATIVE_BROWSER_PREVIEW_GRANT_RE = /^[0-9a-f]{32}$/

/**
 * Read authority for one isolated workspace-document preview. `root` is an absolute directory and
 * `entry` a slash-separated path inside it; with `entryOnly` the preview may read the entry file and
 * nothing else. Grants are minted per mount and never persisted.
 */
export type NativeBrowserPreviewGrant = { id: string; root: string; entry: string; entryOnly: boolean }

/** `quirky-preview://<grant>/<entry>`, each path segment encoded so `#`, `?` and `%` stay literal. */
export function nativeBrowserPreviewUrl(grant: string, entry: string): string {
  const path = entry.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
  return `${NATIVE_BROWSER_PREVIEW_SCHEME}://${grant}/${path}`
}

/** Shape check shared by the renderer and the desktop host; it says nothing about the files. */
export function isNativeBrowserPreviewGrant(value: unknown): value is NativeBrowserPreviewGrant {
  if (!value || typeof value !== 'object') return false
  const grant = value as Partial<NativeBrowserPreviewGrant>
  return typeof grant.id === 'string' && NATIVE_BROWSER_PREVIEW_GRANT_RE.test(grant.id) &&
    typeof grant.root === 'string' && grant.root.startsWith('/') && !grant.root.includes('\0') &&
    typeof grant.entry === 'string' && !grant.entry.includes('\0') &&
    grant.entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    typeof grant.entryOnly === 'boolean'
}

/** Whether `raw` is a preview URL inside `grant`; the host decides which files it may read. */
export function isNativeBrowserPreviewUrl(raw: string, grant: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === `${NATIVE_BROWSER_PREVIEW_SCHEME}:` && url.host === grant && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** A user agent is one header line: printable, bounded, and never able to inject another header. */
export function isNativeBrowserUserAgent(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** A sandboxed system-webview hosted inside a plugin-owned element. Never available in a plain web client. */
export type NativeBrowserState = {
  id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  zoom: number; error: string | null; findCurrent: number; findTotal: number
  /** Whether this view can reload while bypassing the engine cache; false keeps Hard Reload unavailable. */
  hardReloadAvailable: boolean
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
  /**
   * Mounts an isolated, nonpersistent preview served only from this grant instead of a browsing
   * guest; `partition` is then ignored and `url` must be about:blank or inside the grant. The host
   * blocks outbound network, permissions, downloads, popups and navigation off the grant natively.
   */
  preview?: NativeBrowserPreviewGrant
  /** Sent from the guest's first page on; omitted keeps the system webview's own. The mount fails when the host can't apply it. */
  userAgent?: string
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
  /** Whether `mount` accepts `preview`: the host enforces isolated workspace-document previews. */
  readonly previewAvailable: boolean
  mount(element: HTMLElement, options: NativeBrowserOptions): NativeBrowserHandle
  /** The system webview's own user agent, or null when this host can't read or override it. */
  defaultUserAgent(): Promise<string | null>
  /** Clears only dedicated browser partitions; rejects when the host cannot confirm completion. */
  clearPartition(partition: string): Promise<void>
}
