import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { AskCards } from './AskCards'
import { PANEL_ID, createAskStore, reportOf, type AskStore } from './store'

let store: AskStore | null = null

/** Provides the Questions panel; the badge follows the pending asks from activation on, with the panel closed or open. */
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
}

export function deactivate(): void {
  store?.dispose()
  store = null
}
