import { useEffect } from 'react'
import { DEFAULT_THEME } from '@quirky/protocol'
import { usePluginState } from '../context'
import { applyThemeAppearance } from './appearance'

/** Resolves and writes the window's active theme onto the document root. */
export function useThemeVariables(): void {
  const { model, themeVariables } = usePluginState()
  useEffect(() => {
    if (!model) return
    const activeTheme = model.themes.find((theme) => theme.id === model.theme.active) ?? DEFAULT_THEME
    const root = document.documentElement

    if (activeTheme.id !== DEFAULT_THEME.id) {
      applyThemeAppearance(root, model, themeVariables, activeTheme.appearance)
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyThemeAppearance(root, model, themeVariables, media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [model, themeVariables])
}
