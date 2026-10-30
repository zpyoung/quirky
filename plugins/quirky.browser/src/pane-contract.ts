import type { NativeBrowserDownloadUpdate, NativeBrowserPageRequest, NativeBrowserPreviewGrant } from '@quirky/protocol'

/** Browser pane public API. Native browsing does not start the automation runtime. */
export type PaneMode = 'native' | 'watch'
export type PaneSearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'
export type PaneViewport = 'default' | 'mobile-s' | 'mobile-m' | 'mobile-l' | 'tablet' | 'laptop' | 'laptop-l' | 'desktop'
export type PaneCommand = { id: string; action: 'navigate' | 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'find' | 'zoom'; url?: string; text?: string; forward?: boolean; level?: number }
export type PanePrompt = { id: string; kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth' | 'certificate' | 'external'; message: string; origin: string; defaultValue?: string; canProceed?: boolean; expiresAt: number }
export type PaneDownload = { id: string; name: string; state: 'downloading' | 'paused' | 'completed' | 'canceled' | 'error'; received: number; total?: number; path?: string; error?: string }
/**
 * A pane showing a workspace HTML document in an isolated native preview. `path` is the canonical
 * in-worktree file and the identity; `grant` and `url` are minted per mount and never persisted.
 */
export type PaneDocument = { path: string; grant: NativeBrowserPreviewGrant; url: string }
/**
 * The other kind of page a conversion crossed, one level deep: a document by path, or a web page by
 * its stored address. Never carries a grant URL.
 */
export type PaneConversion = { kind: 'url'; url: string } | { kind: 'document'; path: string }
export type PaneTab = {
  id: string; worktreeId: string; profileId: string; partition: string; mode: PaneMode; page: string | null; url: string; title: string;
  loading: boolean; error: string | null; canGoBack: boolean; canGoForward: boolean;
  zoom: number; viewport: PaneViewport; command: PaneCommand | null;
  find: { text: string; current: number; total: number }; prompts: PanePrompt[]; downloads: PaneDownload[];
  sourcePath?: string; preview?: { path: string; url: string }; tabId?: string;
  document?: PaneDocument;
  /** Set on a page converted from the other kind; Back crosses it once guest history runs out. */
  convertedFrom?: PaneConversion;
  /** Set on a page Back returned to across a conversion; Forward re-crosses it. */
  convertedTo?: PaneConversion;
}
export type PaneState = { tabs: PaneTab[]; active: string | null; history: { url: string; title: string; visitedAt: number }[] }
export type PaneFrame = { pane: string; watchId: string; sequence: number; data: string; width: number; height: number }
/** Either a visible prompt the user answers later, or an immediate answer to hand back to the native view. */
export type PaneNativeDecision = { prompt: string | null; answer: { accept: boolean; path?: string } | null }
/** Sent to the window that owns the Native view; `id` is the native request or download id. Never carries credentials. */
export type PaneNativeAction =
  | { pane: string; action: 'answer'; id: string; prompt: string; kind: PanePrompt['kind']; accept: boolean; text?: string }
  | { pane: string; action: 'cancelDownload'; id: string }
export const PANE_METHODS = ['paneOpen', 'paneState', 'paneNavigate', 'panePreview', 'paneControl', 'paneReport', 'paneClose', 'paneSuggestions', 'paneWatch', 'paneWatchStop', 'paneFrameAck', 'paneInput', 'paneRespond', 'paneDownload', 'paneNativeRequest', 'paneNativeUpdate'] as const
export type PaneMethod = typeof PANE_METHODS[number]
/** Every method below is declared by the built-in manifest and generated CLI. */
export type PaneRequests = {
  paneOpen: { worktree: string; group?: string; url?: string; page?: string; mode?: PaneMode; profile?: string; consumer?: string }
  paneState: { worktree?: string }
  paneNavigate: { pane: string; input: string; consumer?: string }
  /** Converts a Native pane to an isolated preview of one HTML file inside its worktree. */
  panePreview: { pane: string; path: string }
  paneControl: { pane: string; action: PaneCommand['action'] | 'viewport'; text?: string; forward?: boolean; level?: number; preset?: PaneViewport; consumer?: string }
  paneReport: { pane: string; command?: string; url?: string; title?: string; loading?: boolean; error?: string | null; canGoBack?: boolean; canGoForward?: boolean; findCurrent?: number; findTotal?: number; tabId?: string }
  paneClose: { pane: string; fromTab?: boolean; tabId?: string; consumer?: string }
  paneSuggestions: { worktree: string; query: string }
  paneWatch: { pane: string; consumer?: string }
  paneWatchStop: { pane: string; watchId: string; consumer?: string }
  paneInput: { pane: string; kind: 'mouse' | 'key' | 'text' | 'wheel'; type?: string; x?: number; y?: number; button?: string; key?: string; code?: string; text?: string; deltaX?: number; deltaY?: number; modifiers?: number; consumer?: string }
  paneRespond: { pane: string; prompt: string; accept: boolean; text?: string; username?: string; password?: string }
  paneDownload: { pane: string; download: string; action: 'cancel' | 'open' | 'reveal' | 'dismiss' }
  paneFrameAck: { pane: string; watchId: string; sequence: number; consumer?: string }
  paneNativeRequest: { pane: string; request: NativeBrowserPageRequest }
  paneNativeUpdate: { pane: string; expired?: string; download?: NativeBrowserDownloadUpdate }
}
