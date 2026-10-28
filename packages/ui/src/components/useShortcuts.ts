import { useEffect } from 'react'
import { usePluginHost } from '../context'

/** Routes key events to active contributed keybindings; unconsumed terminal-first keys still reach the terminal. */
export function useShortcuts(): void {
  const host = usePluginHost()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (host.handleKey(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [host])
}
