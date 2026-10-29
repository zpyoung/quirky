
/** Only persistent partitions owned by quirky.browser may be cleared or mounted. */
export const NATIVE_BROWSER_PARTITION_RE = /^persist:quirky-browser-(?:default|profile_[0-9a-f]{32})$/

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
  /**
   * Mounts an isolated, nonpersistent preview served only from this grant instead of a browsing
   * guest; `partition` is then ignored and `url` must be about:blank or inside the grant. The host
   * blocks outbound network, permissions, downloads, popups and navigation off the grant natively.
   */
  preview?: NativeBrowserPreviewGrant
  onState(state: NativeBrowserState): void
  onPopup?(url: string, userGesture: boolean): void
}
export type NativeBrowserHandle = {
  request(request: NativeBrowserRequest): Promise<NativeBrowserState>
  /** Executes in this owned sandboxed guest, returning untrusted JSON; never host authority. */
  evaluate(script: string): Promise<unknown>
  dispose(): void
}
export type NativeBrowserCapability = {
  readonly available: boolean
  /** Whether the host can confirm native website-data removal completed. */
  readonly clearPartitionAvailable: boolean
  /** Whether `mount` accepts `preview`: the host enforces isolated workspace-document previews. */
  readonly previewAvailable: boolean
  mount(element: HTMLElement, options: NativeBrowserOptions): NativeBrowserHandle
  /** Clears only dedicated browser partitions; rejects when the host cannot confirm completion. */
  clearPartition(partition: string): Promise<void>
}
