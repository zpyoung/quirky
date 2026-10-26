import { useEffect } from 'react'
import { usePluginState } from '../context'

/** Writes the active theme's color variables onto the document root whenever they change. */
export function useThemeVariables(): void {
  const { themeVariables } = usePluginState()
  useEffect(() => {
    const style = document.documentElement.style
    for (const [name, value] of Object.entries(themeVariables)) style.setProperty(name, value)
  }, [themeVariables])
}
