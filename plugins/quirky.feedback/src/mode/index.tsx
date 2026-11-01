import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { App } from './App'
import { createLayout } from './layout'
import { createPicker } from './picker'
import { createSession } from './session'
import { MAX_Z_INDEX } from './styles'
import { OVERLAY_ATTRIBUTE } from './target'

const FEEDBACK_CONTAINER_Z_INDEX = '2147483646'

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
  const bannerSlot = doc.querySelector<HTMLElement>('[data-feedback-banner-slot]')
  if (bannerSlot === null) throw new Error('Feedback mode requires a data-feedback-banner-slot host element')
  const win = doc.defaultView!
  const focused = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null

  const container = fixedLayer(doc)
  container.style.zIndex = FEEDBACK_CONTAINER_Z_INDEX
  container.setAttribute(OVERLAY_ATTRIBUTE, '')
  const stopFocus = (event: Event) => event.stopPropagation()
  container.addEventListener('focusin', stopFocus)
  bannerSlot.addEventListener('focusin', stopFocus)

  const session = createSession(context, {
    suspend(suspended) {
      container.style.zIndex = suspended ? '0' : FEEDBACK_CONTAINER_Z_INDEX
      picker.setSuspended(suspended)
    }
  })
  const picker = createPicker(doc, {
    pick(target) {
      const previous = session.getState().card?.serial
      session.pick(target)
      return session.getState().card?.serial !== previous
    },
    escape: session.escape
  })
  const unsubscribePicker = session.subscribe(() => picker.setSelection(session.getState().target))
  const layout = createLayout(context, win)

  const rootElement = fixedLayer(doc)
  container.append(picker.host, rootElement)
  doc.body.append(container)
  picker.focus()

  const root = createRoot(rootElement)
  root.render(<App session={session} layout={layout} bannerSlot={bannerSlot} annotate={(pane) => { void options.annotate(pane).catch((cause) => context.log(`feedback: annotate failed: ${cause instanceof Error ? cause.message : String(cause)}`)) }} />)
  void session.load()

  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
    unsubscribePicker()
    session.dispose()
    layout.dispose()
    picker.dispose()
    root.unmount()
    container.removeEventListener('focusin', stopFocus)
    bannerSlot.removeEventListener('focusin', stopFocus)
    container.remove()
    if (focused?.isConnected) focused.focus()
  }
}
