import { useEffect, useRef, useState } from 'react'
import { Button } from '../design-system'
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
  const [retry, setRetry] = useState(0)
  const entry = [
    ...(state.model?.sidebarSections ?? []),
    ...(state.model?.activityItems ?? []),
    ...(state.model?.statusBars ?? []),
    ...(state.model?.panels ?? []),
    ...(state.model?.settingsSections ?? []),
    ...(state.model?.views ?? []),
    ...(state.model?.overlays ?? [])
  ].find((candidate) => candidate.id === id)
  const slot = state.slots[id] ?? { status: 'loading' as const }

  const plugin = entry?.plugin
  const module = entry?.module

  // The host drops a mount whose owner changed; retry intentionally re-enters its mount path.
  useEffect(() => {
    const parent = anchor.current
    if (!parent) return
    const element = document.createElement('div')
    element.className = 'plugin-slot-body'
    parent.appendChild(element)
    const unmount = host.mount(id, element, { input }, {
      deferCleanup: true,
      afterCleanup: () => element.remove()
    })
    return unmount
  }, [host, id, input, plugin, module, retry])

  const statusBar = entry?.kind === 'status-bar'
  return (
    <section
      className={`plugin-slot${statusBar ? ' plugin-status-bar-slot' : ''}`}
      data-plugin-slot={id}
      {...(statusBar && entry ? { 'aria-label': entry.title } : {})}
    >
      {!statusBar && slot.status === 'loading' && (
        <header className="plugin-slot-head">
          <span className="plugin-slot-title">{entry?.title ?? id}</span>
          <span className="muted">Loading</span>
        </header>
      )}
      {slot.status === 'error' && (
        <div className="plugin-slot-error" role="alert">
          <strong>{plugin ?? 'Unknown plugin'}</strong>
          <span>{slot.message}</span>
          <Button variant="secondary" onClick={() => setRetry((attempt) => attempt + 1)}>Reload</Button>
        </div>
      )}
      <div ref={anchor} style={{ display: 'contents' }} />
    </section>
  )
}
