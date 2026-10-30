export const OVERLAY_ATTRIBUTE = 'data-quirky-feedback'

const TERMINAL_PANE = '[data-terminal-pane]'
const BROWSER_PANE = '.qbp[data-browser-pane]'
const NATIVE_HOST = '.qbp-native-host'
const WATCH_MODE = '.qbp-mode[data-mode="watch"]'

export type Target = { element: Element; label: string }

function labelOf(element: Element): string {
  if (element.matches(TERMINAL_PANE)) return 'Terminal pane'
  if (element.matches(BROWSER_PANE)) return 'Browser pane'
  return element.localName
}

/**
 * The element a person means when they point at `element`: a terminal or browser pane stands for
 * everything inside it, so pane content is never reached. The label is a tag name or a pane name,
 * never element text.
 */
export function resolveTarget(element: Element): Target {
  const terminal = element.closest(TERMINAL_PANE)
  if (terminal !== null) return { element: terminal, label: labelOf(terminal) }
  const browser = element.closest(BROWSER_PANE)
  if (browser !== null && browser.querySelector(WATCH_MODE) !== null) return { element: browser, label: labelOf(browser) }
  const native = element.closest(NATIVE_HOST)?.closest(BROWSER_PANE) ?? null
  if (native !== null) return { element: native, label: labelOf(native) }
  return { element, label: labelOf(element) }
}

/** The topmost element at a point that is not part of the feedback overlay itself. */
export function elementAtPoint(doc: Document, x: number, y: number): Element | null {
  const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : []
  return stack.find((element) => element.closest(`[${OVERLAY_ATTRIBUTE}]`) === null) ?? null
}
