/** Browser pane public API. Native browsing does not start the automation runtime. */
export type PaneMode = 'native' | 'watch'
export type PaneSearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'
export type PaneViewport = 'default' | 'mobile-s' | 'mobile-m' | 'mobile-l' | 'tablet' | 'laptop' | 'laptop-l' | 'desktop'
export type PaneCommand = { id: string; action: 'navigate' | 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'find' | 'zoom'; url?: string; text?: string; forward?: boolean; level?: number }
export type PanePrompt = { id: string; kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth' | 'certificate' | 'external'; message: string; origin: string; defaultValue?: string; canProceed?: boolean; expiresAt: number }
export type PaneDownload = { id: string; name: string; state: 'downloading' | 'paused' | 'completed' | 'canceled' | 'error'; received: number; total?: number; path?: string; error?: string }
export type PaneTab = {
  id: string; worktreeId: string; profileId: string; partition: string; mode: PaneMode; page: string | null; url: string; title: string;
  loading: boolean; error: string | null; canGoBack: boolean; canGoForward: boolean;
  zoom: number; viewport: PaneViewport; command: PaneCommand | null;
  find: { text: string; current: number; total: number }; prompts: PanePrompt[]; downloads: PaneDownload[];
  sourcePath?: string; preview?: { path: string; url: string }; tabId?: string;
}
export type PaneState = { tabs: PaneTab[]; active: string | null; history: { url: string; title: string; visitedAt: number }[] }
export type PaneFrame = { pane: string; watchId: string; sequence: number; data: string; width: number; height: number }
export const PANE_METHODS = ['paneOpen', 'paneState', 'paneNavigate', 'paneControl', 'paneReport', 'paneClose', 'paneSuggestions', 'paneWatch', 'paneWatchStop', 'paneFrameAck', 'paneInput', 'paneRespond', 'paneDownload'] as const
export type PaneMethod = typeof PANE_METHODS[number]
/** Every method below is declared by the built-in manifest and generated CLI. */
export type PaneRequests = {
  paneOpen: { worktree: string; url?: string; page?: string; mode?: PaneMode; profile?: string }
  paneState: { worktree?: string }
  paneNavigate: { pane: string; input: string }
  paneControl: { pane: string; action: PaneCommand['action'] | 'viewport'; text?: string; forward?: boolean; level?: number; preset?: PaneViewport }
  paneReport: { pane: string; command?: string; url?: string; title?: string; loading?: boolean; error?: string | null; canGoBack?: boolean; canGoForward?: boolean; findCurrent?: number; findTotal?: number; tabId?: string }
  paneClose: { pane: string; fromTab?: boolean }
  paneSuggestions: { worktree: string; query: string }
  paneWatch: { pane: string }
  paneWatchStop: { pane: string; watchId: string }
  paneInput: { pane: string; kind: 'mouse' | 'key' | 'text' | 'wheel'; type?: string; x?: number; y?: number; button?: string; key?: string; code?: string; text?: string; deltaX?: number; deltaY?: number; modifiers?: number }
  paneRespond: { pane: string; prompt: string; accept: boolean; text?: string; username?: string; password?: string }
  paneDownload: { pane: string; download: string; action: 'cancel' | 'open' | 'reveal' | 'dismiss' }
  paneFrameAck: { pane: string; watchId: string; sequence: number }
}
