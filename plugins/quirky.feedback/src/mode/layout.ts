import type { UiPluginContext } from '@quirky/protocol'
import { OVERLAY_ATTRIBUTE } from './target'

export type Layout = {
  subscribe(listener: () => void): () => void
  /** Changes whenever the page layout may have moved; each change is coalesced to one animation frame. */
  version(): number
  dispose(): void
}

/** Watches resize, scroll, the window's own layout changes and page DOM changes so markers can be re-queried. */
export function createLayout(context: UiPluginContext, win: Window): Layout {
  const listeners = new Set<() => void>()
  let version = 0
  let frame = 0
  let disposed = false

  const run = () => {
    frame = 0
    version++
    for (const listener of [...listeners]) listener()
  }
  const schedule = () => {
    if (disposed || frame !== 0) return
    frame = win.requestAnimationFrame(run)
  }

  win.addEventListener('resize', schedule)
  win.addEventListener('scroll', schedule, true)
  const unsubscribe = context.onLayout(schedule)
  const inOverlay = (node: Node) => node instanceof Element && node.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null
  // the mode's own overlay is left out, or each redraw would schedule the next one
  const pageChanges = new MutationObserver((records) => {
    if (records.some((record) => !inOverlay(record.target))) schedule()
  })
  pageChanges.observe(win.document.documentElement, { subtree: true, childList: true, attributes: true })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    version: () => version,
    dispose() {
      if (disposed) return
      disposed = true
      if (frame !== 0) win.cancelAnimationFrame(frame)
      frame = 0
      win.removeEventListener('resize', schedule)
      win.removeEventListener('scroll', schedule, true)
      pageChanges.disconnect()
      unsubscribe()
      listeners.clear()
    }
  }
}
