import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { requestPaneUiControl } from '../ui-control'

type DisclosureMenuAction = 'close-browser-menu' | 'close-history-menu'

/**
 * Close behaviour for a `<details>` popover menu: it closes after a choice,
 * on Escape (returning focus to its summary) and on a press outside it.
 * An item marked `data-keep-open` is a repeatable step and leaves the menu open.
 */
export function useDisclosureMenu(
  context: UiPluginContext,
  target: { pane: string | null; action: DisclosureMenuAction }
) {
  const ref = useRef<HTMLDetailsElement>(null)

  const close = useCallback((restoreFocus: boolean) => {
    const details = ref.current
    if (!details?.open) return
    details.open = false
    if (restoreFocus) details.querySelector<HTMLElement>(':scope > summary')?.focus()
  }, [])

  const requestClose = () => {
    if (!target.pane) {
      close(true)
      return
    }
    void requestPaneUiControl(context, { action: target.action, pane: target.pane }).catch((error: unknown) => {
      context.log(`browser: menu close failed: ${error instanceof Error ? error.message : String(error)}`)
      close(true)
    })
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
    props: {
      ref,
      onClick: (event: MouseEvent<HTMLDetailsElement>) => {
        if (!(event.target instanceof Element)) return
        const item = event.target.closest<HTMLElement>('.ui-menu__item')
        if (!item || item.hasAttribute('data-keep-open') || item.hasAttribute('disabled')) return
        requestClose()
      },
      onKeyDown: (event: KeyboardEvent<HTMLDetailsElement>) => {
        if (event.key !== 'Escape' || !ref.current?.open) return
        event.preventDefault()
        event.stopPropagation()
        requestClose()
      }
    },
    close
  }
}
