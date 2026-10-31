import { useEffect, useRef, type MouseEventHandler, type RefObject } from 'react'
import { usePluginHost, usePluginState } from '../context'

export type Region = 'sidebar' | 'view' | 'panel'

type RegionProps = {
  ref: RefObject<HTMLElement | null>
  tabIndex: -1
  'data-region': Region
  'data-focused': boolean
  onClickCapture: MouseEventHandler
}

/**
 * Props that report clicks as canonical region focus. External layout focus changes take browser
 * focus unless it is already inside; a click response preserves focus moved by that click's action.
 */
export function useRegion(region: Region): RegionProps {
  const host = usePluginHost()
  const { layout } = usePluginState()
  const ref = useRef<HTMLElement>(null)
  const clickFocus = useRef<{ from: Element | null } | null>(null)
  const focused = layout.focus === region

  useEffect(() => {
    const element = ref.current
    const requestedFrom = clickFocus.current
    clickFocus.current = null
    if (focused && element && !element.contains(document.activeElement)
      && (!requestedFrom || requestedFrom.from === document.activeElement)) element.focus()
  }, [focused])

  return {
    ref,
    tabIndex: -1,
    'data-region': region,
    'data-focused': focused,
    onClickCapture: () => {
      const pending = !focused ? { from: document.activeElement } : null
      if (pending) clickFocus.current = pending
      void host.focus(region).then((accepted) => {
        if (!accepted && clickFocus.current === pending) clickFocus.current = null
      })
    }
  }
}
