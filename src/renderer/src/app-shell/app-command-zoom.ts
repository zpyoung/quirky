import { applyUIZoom } from '@/lib/ui-zoom'
import { computeEditorFontSize, nextEditorFontZoomLevel } from '@/lib/editor-font-zoom'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { writeNativeChatFontSize } from '@/components/native-chat/native-chat-font-size-write'
import { zoomLevelToPercent } from '@/components/settings/SettingsConstants'
import { requestPdfZoom } from '@/components/editor/pdf-zoom-request'
import { resolveZoomTarget } from '../hooks/resolve-zoom-target'
import { useAppStore } from '../store'
import { stepUIZoomLevel } from '../../../shared/ui-zoom-level'
import type { AppCommandSource } from '@/lib/app-command-dispatch'
import type { KeybindingActionId } from '../../../shared/keybindings'

function currentZoomTarget(): ReturnType<typeof resolveZoomTarget> {
  const { activeView, activeTabType } = useAppStore.getState()
  return resolveZoomTarget({ activeView, activeTabType, activeElement: document.activeElement })
}

function applyZoomCommand(direction: 'in' | 'out' | 'reset'): void {
  const store = useAppStore.getState()
  const { editorFontZoomLevel, setEditorFontZoomLevel, settings } = store
  const target = currentZoomTarget()
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
  options: { source?: AppCommandSource }
  decline: (actionId: KeybindingActionId, reason: string) => false
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
}

type ZoomActionId = 'zoom.in' | 'zoom.out' | 'zoom.reset'

/**
 * Zoom acts on whichever surface has focus. A focused terminal zooms itself through the window
 * menu's IPC, which a remote caller cannot trigger, so an RPC request declines rather than claim
 * a change that never happens; the probe and the run take the same branch.
 */
function zoomCommand(
  actionId: ZoomActionId,
  direction: 'in' | 'out' | 'reset'
): (context: ZoomCommandContext) => () => boolean {
  return (context) => () => {
    if (context.options.source === 'rpc' && currentZoomTarget() === 'terminal') {
      return context.decline(
        actionId,
        'a terminal has focus and its font zoom is not remotely drivable'
      )
    }
    return context.claim(actionId, () => applyZoomCommand(direction))
  }
}

export const ZOOM_COMMAND_FACTORIES = {
  'zoom.in': zoomCommand('zoom.in', 'in'),
  'zoom.out': zoomCommand('zoom.out', 'out'),
  'zoom.reset': zoomCommand('zoom.reset', 'reset')
}
