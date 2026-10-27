import { useEffect, useRef } from 'react'
import { usePluginHost } from '../context'
import { isPaletteChord } from '../plugins/palette'

/**
 * Cmd+Shift+P toggles the command palette; every other chord goes to the plugins' keybindings,
 * which is where the session shortcuts live. Only a consumed chord stops propagating: one the
 * host prevented but did not consume (a terminal-first key) still reaches the focused terminal.
 */
export function useShortcuts(togglePalette: () => void): void {
  const host = usePluginHost()
  const toggle = useRef(togglePalette)
  toggle.current = togglePalette

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteChord(event)) {
        event.preventDefault()
        event.stopPropagation()
        toggle.current()
        return
      }
      if (host.handleKey(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [host])
}
