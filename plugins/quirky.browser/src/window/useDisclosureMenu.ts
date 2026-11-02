import { useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'

/**
 * Close behaviour for a `<details>` popover menu: it closes after a choice,
 * on Escape (returning focus to its summary) and on a press outside it.
 * An item marked `data-keep-open` is a repeatable step and leaves the menu open.
 */
export function useDisclosureMenu() {
  const ref = useRef<HTMLDetailsElement>(null)

  const close = (restoreFocus: boolean) => {
    const details = ref.current
    if (!details?.open) return
    details.open = false
    if (restoreFocus) details.querySelector<HTMLElement>(':scope > summary')?.focus()
  }

  useEffect(() => {
    const details = ref.current
    if (!details) return
    const onOutside = (event: Event) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) details.open = false
    }
    details.ownerDocument.addEventListener('pointerdown', onOutside)
    return () => details.ownerDocument.removeEventListener('pointerdown', onOutside)
  }, [])

  return {
    ref,
    onClick: (event: MouseEvent<HTMLDetailsElement>) => {
      if (!(event.target instanceof Element)) return
      const item = event.target.closest<HTMLElement>('.ui-menu__item')
      if (!item || item.hasAttribute('data-keep-open') || item.hasAttribute('disabled')) return
      close(true)
    },
    onKeyDown: (event: KeyboardEvent<HTMLDetailsElement>) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }
}
