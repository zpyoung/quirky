import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { createViewUiController } from './control'
import { PANE_VIEW_ID, ViewsPane, parsePaneInput } from './Pane'
import { RENDER_VIEW_ID, ViewCardView, parseRenderInput } from './render/ViewCard'

/** Provides the embeddable view card and the Views pane. */
export function activate(context: UiPluginContext): void {
  const controller = createViewUiController(context)

  context.provide(RENDER_VIEW_ID, (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => {
    const input = parseRenderInput(props.input)
    if (!input) return undefined
    const root = createRoot(element)
    const instance = controller.mount({ surface: RENDER_VIEW_ID, viewId: input.viewId, report: props.report })
    root.render(<ViewCardView context={context} instance={instance} viewId={input.viewId} version={input.version} surface={input.surface} drawing={input.drawing} focused={input.focused} />)
    return () => {
      try {
        root.unmount()
      } finally {
        instance.dispose()
      }
    }
  })

  context.provide(PANE_VIEW_ID, (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => {
    const input = parsePaneInput(props.input)
    if (!input) return undefined
    const root = createRoot(element)
    const instance = controller.mount({ surface: PANE_VIEW_ID, session: input.session, report: props.report })
    root.render(<ViewsPane context={context} instance={instance} session={input.session} />)
    return () => {
      try {
        root.unmount()
      } finally {
        instance.dispose()
      }
    }
  })
}
