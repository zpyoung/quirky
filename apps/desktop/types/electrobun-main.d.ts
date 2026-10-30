/**
 * Minimal stand-in for `electrobun/main`, used by tsconfig `paths` only when the real SDK has not
 * been projected into `.hutch/devkit` yet (`hutch electrobun prepare`). Covers what the shell uses.
 */
export type ElectrobunConfig = Record<string, unknown>

type MenuItem = { type: 'normal'; label: string; action?: string } | { type: 'divider' | 'separator' }

export class BrowserWindow {
  constructor(options: {
    title: string
    frame: { x?: number; y?: number; width: number; height: number }
    url: string | null
    html: string | null
    preload?: string | null
    rpc?: unknown
  })
  readonly id: number
  webview: {
    readonly id: number
    loadURL(url: string): void
    loadHTML(html: string): void
    supportsDropSourcePaths(): boolean
    on(name: 'drop-source-paths', handler: (event: unknown) => void): void
  }
  on(name: string, handler: (event: unknown) => void): void
  setTitle(title: string): void
  show(): void
  activate(): void
  close(): void
  isVisible(): boolean
  isMinimized(): boolean
}

export class BrowserView {
  constructor(options?: {
    windowId?: number
    popupRequestId?: number
    partition?: string | null
    renderer?: 'native' | 'cef'
    sandbox?: boolean
    autoResize?: boolean
    frame?: { x: number; y: number; width: number; height: number }
  })
  readonly id: number
  readonly windowId: number
  readonly hostWebviewId?: number
  readonly sandbox: boolean
  readonly renderer: 'native' | 'cef'
  readonly partition: string | null
  readonly url: string | null
  readonly navigationRules: string | null
  readonly allowedProtocols: { views: boolean; appData: boolean }
  readonly isolatedPreview: string | null
  setIsolatedPreviewHandler(handler: ((request: Request) => Response | Promise<Response>) | null): void
  setNavigationRules(rules: string[]): void
  setPageZoom(factor: number): void
  getPageZoom(): number
  getStorageIdentifier(): string | null
  remove(): void
  setNativeRequestHandling(
    kinds: Array<'dialogs' | 'auth' | 'certificates' | 'downloads' | 'popups' | 'externalApps'>,
    options?: { timeoutMs?: number }
  ): boolean
  respondToNativeRequest(requestId: number, response: { accept: boolean; text?: string; username?: string; password?: string; path?: string }): boolean
  cancelDownload(downloadId: number): boolean
  on(name: string, handler: (event: unknown) => void): void
  static getById(id: number): BrowserView | undefined
  static defineRPC<Schema>(config: unknown): { send: Record<string, (payload: unknown) => void> }
}

type StorageResult = { status: string; reason?: string }

export const Session: {
  fromPartition(partition: string): {
    setStorageIdentifier(identifier: string): StorageResult
    clearStorageData(types: 'all'): StorageResult
  }
}

export class Electroview {
  constructor(options: { rpc: unknown })
  static defineRPC<Schema>(config: unknown): unknown
}

export class Tray {
  constructor(options?: { title?: string; image?: string; template?: boolean; width?: number; height?: number })
  setMenu(menu: MenuItem[]): void
  setVisible(visible: boolean): void
  remove(): void
  on(name: 'tray-clicked', handler: (event: unknown) => void): void
}

export const Utils: {
  clipboardReadText(): string | null
  showNotification(options: { title: string; body?: string; subtitle?: string; silent?: boolean }): void
  openFileDialog(options: {
    startingFolder?: string
    allowedFileTypes?: string
    canChooseFiles?: boolean
    canChooseDirectory?: boolean
    allowsMultipleSelection?: boolean
  }): Promise<string[]>
  showItemInFolder(path: string): void
}
export const app: {
  quit(): void
  on(name: string, handler: (payload: unknown) => void): () => void
  readonly isPackaged: boolean
}
