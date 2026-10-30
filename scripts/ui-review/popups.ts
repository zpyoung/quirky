/** Marks the copies of opened popups that the `host:popups` capture leaves on the page. */
export const CLONE_ATTRIBUTE = 'data-capture-popup-clone'

/** Matches the popup the app has open now, never one of this capture's own copies. */
export const OPEN_POPUP_SELECTOR = `.ui-popup:not([${CLONE_ATTRIBUTE}])`

type CloneSource<T> = { cloneNode(deep: boolean): T }
type CloneCopy = { setAttribute(name: string, value: string): void }

/**
 * Copies an opened popup into `host` as a picture of it: the copy is `inert` and `aria-hidden`, so it
 * takes no focus or clicks and no accessibility query sees it. The page code runs this function
 * stringified inside the browser, so it must not refer to anything outside its own body.
 */
export function appendInertClone<T extends CloneCopy>(
  source: CloneSource<T>,
  host: { appendChild(child: T): unknown },
  attribute: string
): T {
  const clone = source.cloneNode(true)
  clone.setAttribute('inert', '')
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute(attribute, '')
  host.appendChild(clone)
  return clone
}

/** Page expression that copies the open popup into the body; true when a popup was open to copy. */
export function cloneOpenPopupExpression(): string {
  return `(() => {
    const source = document.querySelector(${JSON.stringify(OPEN_POPUP_SELECTOR)})
    if (!source) return false
    ;(${appendInertClone.toString()})(source, document.body, ${JSON.stringify(CLONE_ATTRIBUTE)})
    return true
  })()`
}

/** Page expression that removes every copy this capture added. */
export function removeClonesExpression(): string {
  return `document.querySelectorAll(${JSON.stringify(`[${CLONE_ATTRIBUTE}]`)}).forEach((node) => node.remove())`
}

/**
 * Page expression that slides each copy right until it no longer covers an earlier one. The app
 * anchors every popup under its own control, so two neighbouring switchers' popups would otherwise
 * overlap and hide each other's rows.
 */
export function separateClonesExpression(gap = 16): string {
  return `(() => {
    const clones = [...document.querySelectorAll(${JSON.stringify(`[${CLONE_ATTRIBUTE}]`)})]
    clones.forEach((clone, index) => {
      const here = clone.getBoundingClientRect()
      for (const earlier of clones.slice(0, index)) {
        const other = earlier.getBoundingClientRect()
        const apart = here.right <= other.left || other.right <= here.left || here.bottom <= other.top || other.bottom <= here.top
        if (apart) continue
        clone.style.left = (other.right + ${gap}) + 'px'
        return
      }
    })
  })()`
}
