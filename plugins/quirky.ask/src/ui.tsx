import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { AskCards } from './AskCards'
import { PANEL_ID, createAskStore, reportOf, TOGGLE_PREVIEW_COMMAND, type AskStore } from './store'

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
  context.provide(TOGGLE_PREVIEW_COMMAND, (input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('askId, questionId, and option are required.')
    }
    const { askId, questionId, option, open } = input as Record<string, unknown>
    if (
      typeof askId !== 'string' || askId.length === 0 ||
      typeof questionId !== 'string' || questionId.length === 0 ||
      typeof option !== 'string' || option.length === 0
    ) {
      throw new Error('askId, questionId, and option must be non-empty strings.')
    }
    if (open !== undefined && typeof open !== 'boolean') {
      throw new Error('open must be a boolean.')
    }
    return { open: asks.togglePreview(askId, questionId, option, open) }
  })

}

export function deactivate(): void {
  store?.dispose()
  store = null
}
