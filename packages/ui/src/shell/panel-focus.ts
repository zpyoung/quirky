export const PANEL_FOCUS_ATTRIBUTE = 'data-panel-focused'

const FOCUS_HOLDER_SELECTOR = '[data-tool-panel], .shell-main-region'

export type PanelFocusTracker = {
  /** The element holding `data-panel-focused`, or null when none does or it has left the document. */
  current(): HTMLElement | null
  dispose(): void
}

function holderOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(FOCUS_HOLDER_SELECTOR) : null
}

/**
 * Tracks which tool panel or center card the person last pressed or focused, writing
 * `data-panel-focused` on that element alone. WebKit doesn't focus a button on click, so
 * `:focus-within` can't carry this. A press or focus outside every holder changes nothing.
 */
export function createPanelFocusTracker(doc: Document): PanelFocusTracker {
  let holder: HTMLElement | null = null

  const live = (): HTMLElement | null => {
    if (holder !== null && !holder.isConnected) holder = null
    return holder
  }
  const claim = (next: HTMLElement) => {
    const previous = live()
    if (previous === next) return
    previous?.removeAttribute(PANEL_FOCUS_ATTRIBUTE)
    next.setAttribute(PANEL_FOCUS_ATTRIBUTE, '')
    holder = next
  }
  const onEvent = (event: Event) => {
    const next = holderOf(event.target)
    if (next !== null) claim(next)
  }

  const initial = holderOf(doc.activeElement)
  if (initial !== null) claim(initial)
  doc.addEventListener('pointerdown', onEvent, true)
  doc.addEventListener('focusin', onEvent, true)

  return {
    current: live,
    dispose() {
      doc.removeEventListener('pointerdown', onEvent, true)
      doc.removeEventListener('focusin', onEvent, true)
      holder?.removeAttribute(PANEL_FOCUS_ATTRIBUTE)
      holder = null
    }
  }
}

/** Starts tracking on `doc` and returns the function that stops it. */
export function trackPanelFocus(doc: Document): () => void {
  return createPanelFocusTracker(doc).dispose
}
