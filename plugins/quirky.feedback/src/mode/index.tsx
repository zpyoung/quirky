import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { App } from './App'
import { createLayout } from './layout'
import { createPicker } from './picker'
import { createSession } from './session'
import { MAX_Z_INDEX } from './styles'
import { OVERLAY_ATTRIBUTE } from './target'

type Options = { annotate(pane: string): Promise<void> }

function fixedLayer(doc: Document): HTMLElement {
  const layer = doc.createElement('div')
  Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: MAX_Z_INDEX, pointerEvents: 'none' })
  return layer
}

/**
 * Turns feedback mode on in the host document and returns the function that turns it off. The mode
 * draws in its own container on `document.body`, above menus and dialogs, and reads the host DOM
 * directly. The returned function removes every node, listener and frame the mode created, and
 * calling it again does nothing.
 */
export function mountFeedbackMode(context: UiPluginContext, options: Options): () => void {
  const doc = document
  const win = doc.defaultView!
  const focused = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null

  const container = fixedLayer(doc)
  container.setAttribute(OVERLAY_ATTRIBUTE, '')
  const stopFocus = (event: Event) => event.stopPropagation()
  container.addEventListener('focusin', stopFocus)

  const session = createSession(context, {
    suspend(suspended) {
      container.style.zIndex = suspended ? '0' : MAX_Z_INDEX
      picker.setSuspended(suspended)
    }
  })
  const picker = createPicker(doc, { pick: session.pick, escape: session.escape })
  const layout = createLayout(context, win)

  const rootElement = fixedLayer(doc)
  container.append(picker.host, rootElement)
  doc.body.append(container)
  picker.focus()

  const root = createRoot(rootElement)
  root.render(<App session={session} layout={layout} annotate={(pane) => { void options.annotate(pane).catch((cause) => context.log(`feedback: annotate failed: ${cause instanceof Error ? cause.message : String(cause)}`)) }} />)
  void session.load()

  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
    session.dispose()
    layout.dispose()
    picker.dispose()
    root.unmount()
    container.removeEventListener('focusin', stopFocus)
    container.remove()
    if (focused?.isConnected) focused.focus()
  }
}
