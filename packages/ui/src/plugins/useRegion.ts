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
 * Props that make an element one of the shell's three regions: a click inside it tells the daemon
 * focus is there, and the layout's focus moving to it takes the browser's focus unless that is
 * already inside.
 */
export function useRegion(region: Region): RegionProps {
  const host = usePluginHost()
  const { layout } = usePluginState()
  const ref = useRef<HTMLElement>(null)
  const focused = layout.focus === region

  useEffect(() => {
    const element = ref.current
    if (focused && element && !element.contains(document.activeElement)) element.focus()
  }, [focused])

  return {
    ref,
    tabIndex: -1,
    'data-region': region,
    'data-focused': focused,
    onClickCapture: () => host.focus(region)
  }
}
