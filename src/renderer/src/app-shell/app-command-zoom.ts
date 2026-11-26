import { applyUIZoom } from '@/lib/ui-zoom'
import { computeEditorFontSize, nextEditorFontZoomLevel } from '@/lib/editor-font-zoom'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { writeNativeChatFontSize } from '@/components/native-chat/native-chat-font-size-write'
import { zoomLevelToPercent } from '@/components/settings/SettingsConstants'
import { requestPdfZoom } from '@/components/editor/pdf-zoom-request'
import { resolveZoomTarget } from '../hooks/resolve-zoom-target'
import { useAppStore } from '../store'
import { stepUIZoomLevel } from '../../../shared/ui-zoom-level'
import type { KeybindingActionId } from '../../../shared/keybindings'

function applyZoomCommand(direction: 'in' | 'out' | 'reset'): void {
  const store = useAppStore.getState()
  const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } = store
  const target = resolveZoomTarget({
    activeView,
    activeTabType,
    activeElement: document.activeElement
  })
  if (target === 'chat') {
    void writeNativeChatFontSize(
      direction === 'in' ? 'increase' : direction === 'out' ? 'decrease' : 'reset'
    )
    return
  }
  if (target === 'terminal') {
    return
  }
  if (target === 'editor') {
    // Why: a PDF owns its page zoom; editor font zoom would change nothing visible.
    if (requestPdfZoom(direction)) {
      return
    }
    const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
    setEditorFontZoomLevel(next)
    void window.api.ui.set({ editorFontZoomLevel: next })
    const baseFontSize = settings?.terminalFontSize ?? 13
    const actual = computeEditorFontSize(baseFontSize, next)
    dispatchZoomLevelChanged('editor', Math.round((actual / baseFontSize) * 100))
    return
  }
  const next = stepUIZoomLevel(window.api.ui.getZoomLevel(), direction)
  applyUIZoom(next)
  void window.api.ui.set({ uiZoomLevel: next })
  dispatchZoomLevelChanged('ui', zoomLevelToPercent(next))
}

type ZoomCommandContext = {
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
}

/** Zoom acts on whichever surface has focus, so it always claims. */
export const ZOOM_COMMAND_FACTORIES = {
  'zoom.in': (context: ZoomCommandContext) => () =>
    context.claim('zoom.in', () => applyZoomCommand('in')),
  'zoom.out': (context: ZoomCommandContext) => () =>
    context.claim('zoom.out', () => applyZoomCommand('out')),
  'zoom.reset': (context: ZoomCommandContext) => () =>
    context.claim('zoom.reset', () => applyZoomCommand('reset'))
}
