import { useEffect, type RefObject } from 'react'

/**
 * Returns focus to the docked composer when the window regains focus after it had focus on blur.
 * Without this the window can come back with focus on the page body, and the next keystroke goes
 * nowhere instead of into the composer the owner was typing in.
 */
export function useDockWindowRefocus(
  root: HTMLElement | null,
  composer: RefObject<{ focus: () => void } | null>
): void {
  useEffect(() => {
    if (!root) {
      return undefined
    }
    let composerHadFocus = false
    const onBlur = (): void => {
      composerHadFocus = root.contains(root.ownerDocument.activeElement)
    }
    const onFocus = (): void => {
      const hadFocus = composerHadFocus
      composerHadFocus = false
      const active = root.ownerDocument.activeElement
      if (hadFocus && (active === null || active === root.ownerDocument.body)) {
        composer.current?.focus()
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [composer, root])
}
