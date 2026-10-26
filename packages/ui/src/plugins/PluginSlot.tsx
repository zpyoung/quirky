import { useEffect, useRef } from 'react'
import { usePluginHost, usePluginState } from '../context'

type Props = { id: string; input?: unknown }

/**
 * One plugin contribution: the host's wrapper (title, loading line, error box) around a child
 * `div` the plugin owns. Each mount gets a fresh, empty child that is removed when the mount ends, so
 * a plugin never inherits what an earlier mount left behind. React never renders into that child.
 */
export function PluginSlot({ id, input }: Props) {
  const host = usePluginHost()
  const state = usePluginState()
  const anchor = useRef<HTMLDivElement>(null)
  const entry = [
    ...(state.model?.sidebarSections ?? []),
    ...(state.model?.panels ?? []),
    ...(state.model?.views ?? [])
  ].find((candidate) => candidate.id === id)
  const slot = state.slots[id] ?? { status: 'loading' as const }

  const plugin = entry?.plugin
  const module = entry?.module

  // the host drops a mount whose owner changed, so the owner and its module are part of the mount's identity
  useEffect(() => {
    const parent = anchor.current
    if (!parent) return
    const element = document.createElement('div')
    element.className = 'plugin-slot-body'
    parent.appendChild(element)
    const unmount = host.mount(id, element, { input })
    return () => {
      unmount()
      element.remove()
    }
  }, [host, id, input, plugin, module])

  return (
    <section className="plugin-slot" data-plugin-slot={id}>
      {slot.status === 'loading' && (
        <header className="plugin-slot-head">
          <span className="plugin-slot-title">{entry?.title ?? id}</span>
          <span className="muted">Loading</span>
        </header>
      )}
      {slot.status === 'error' && (
        <div className="plugin-slot-error" role="alert">
          {slot.message}
        </div>
      )}
      <div ref={anchor} style={{ display: 'contents' }} />
    </section>
  )
}
