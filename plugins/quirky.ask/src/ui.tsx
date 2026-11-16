import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { AskCards } from './AskCards'
import { CARD_VIEW_ID, CardView, parseCardInput } from './CardView'
import { PANEL_ID, createAskStore, reportOf, type AskStore } from './store'

let store: AskStore | null = null

/** Provides the Questions panel and the embeddable ask card; the badge follows the pending asks from activation on, with the panel closed or open. */
export function activate(context: UiPluginContext): void {
  store?.dispose()
  const asks = createAskStore(context)
  store = asks

  context.provide(PANEL_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    root.render(<AskCards store={asks} context={context} />)
    const sendReport = () => props.report?.(reportOf(asks))
    sendReport()
    const unsubscribe = asks.subscribe(sendReport)
    return () => {
      unsubscribe()
      root.unmount()
    }
  })

  context.provide(CARD_VIEW_ID, (element: HTMLElement, props: { input?: unknown }) => {
    const input = parseCardInput(props.input)
    if (!input) return undefined
    const root = createRoot(element)
    root.render(<CardView context={context} input={input} />)
    return () => root.unmount()
  })
}

export function deactivate(): void {
  store?.dispose()
  store = null
}
