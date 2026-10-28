import { useEffect } from 'react'
import { usePluginHost } from '../context'

/** Routes contributed shortcuts before the titlebar's unclaimed command-search fallback. */
export function useShortcuts(): void {
  const host = usePluginHost()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (host.handleKey(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const onSearch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'k' ||
        host.getState().windowRoute !== null ||
        host.getState().layout.palette === true ||
        (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]'))
      ) return
      event.preventDefault()
      event.stopPropagation()
      host.setPalette(true)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onSearch)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onSearch)
    }
  }, [host])
}
