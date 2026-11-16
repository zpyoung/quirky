import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { PANE_VIEW_ID, ViewsPane, parsePaneInput } from './Pane'
import { RENDER_VIEW_ID, ViewCardView, parseRenderInput } from './render/ViewCard'

/** Provides the embeddable view card and the Views pane. */
export function activate(context: UiPluginContext): void {
  context.provide(RENDER_VIEW_ID, (element: HTMLElement, props: { input?: unknown }) => {
    const input = parseRenderInput(props.input)
    if (!input) return undefined
    const root = createRoot(element)
    root.render(<ViewCardView context={context} viewId={input.viewId} />)
    return () => root.unmount()
  })

  context.provide(PANE_VIEW_ID, (element: HTMLElement, props: { input?: unknown }) => {
    const input = parsePaneInput(props.input)
    if (!input) return undefined
    const root = createRoot(element)
    root.render(<ViewsPane context={context} session={input.session} />)
    return () => root.unmount()
  })
}
