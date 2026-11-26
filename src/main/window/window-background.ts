import { BrowserWindow, nativeTheme } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'

export const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#eef0f3' } as const

/** Native window fill matching the rail, so no window flashes the wrong mode before first paint. */
export function resolveWindowBackground(
  theme: GlobalSettings['theme'],
  systemPrefersDark: boolean
): typeof WINDOW_BACKGROUND.dark | typeof WINDOW_BACKGROUND.light {
  const dark = theme === 'system' ? systemPrefersDark : theme === 'dark'
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** Repaints every open window's native fill; never shows, focuses or reorders one. */
export function repaintAllWindowBackgrounds(theme: GlobalSettings['theme']): void {
  const color = resolveWindowBackground(theme, nativeTheme.shouldUseDarkColors)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(color)
    }
  }
}
