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
  })
  webview: { loadURL(url: string): void; loadHTML(html: string): void }
  on(name: string, handler: (event: unknown) => void): void
  show(): void
  activate(): void
}

export class Tray {
  constructor(options?: { title?: string })
  setMenu(menu: MenuItem[]): void
  on(name: 'tray-clicked', handler: (event: unknown) => void): void
}

export const Utils: { showNotification(options: { title: string; body?: string }): void }
export const app: { quit(): void; readonly isPackaged: boolean }
