import { useEffect, useRef } from 'react'
import type { UiSlotEntry } from '@quirky/protocol'
import { usePluginHost, usePluginState } from '../context'

/**
 * One plugin overlay: a `div` the plugin owns, mounted through the host like any other slot.
 * There is no wrapper chrome, since the overlay draws whatever it wants over the window; React
 * never renders into the div, and what a mount leaves behind is cleared when the mount ends.
 */
function OverlayMount({ entry }: { entry: UiSlotEntry }) {
  const host = usePluginHost()
  const element = useRef<HTMLDivElement>(null)
  const { id, plugin, module } = entry

  // the host drops a mount whose owner changed, so the owner and its module are part of the mount's identity
  useEffect(() => {
    const target = element.current
    if (!target) return
    const unmount = host.mount(id, target, undefined, {
      deferCleanup: true,
      afterCleanup: () => target.replaceChildren()
    })
    return unmount
  }, [host, id, plugin, module])

  return <div ref={element} data-plugin-overlay={id} />
}

/**
 * The fixed full-window layer that holds every effective overlay. The layer itself ignores the
 * pointer, so only the parts an overlay draws take clicks.
 */
export function OverlayLayer() {
  const { model } = usePluginState()
  return (
    <div className="overlay-layer">
      {(model?.overlays ?? []).map((entry) => (
        <OverlayMount key={entry.id} entry={entry} />
      ))}
    </div>
  )
}
