import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MountCleanup } from '@quirky/protocol'
import { Button } from '../design-system'
import { usePluginHost, usePluginState } from '../context'
import type { WindowPluginHost } from './host'
type Props = { id: string; input?: unknown }

type ActiveMount = { unmount: MountCleanup; input: unknown; remount(input: unknown): ActiveMount }

function mountBody(host: WindowPluginHost, id: string, input: unknown, parent: HTMLDivElement): ActiveMount {
  const element = parent.ownerDocument.createElement('div')
  element.className = 'plugin-slot-body'
  parent.appendChild(element)
  const unmount = host.mount(id, element, { input }, {
    deferCleanup: true,
    afterCleanup: () => element.remove()
  })
  return { unmount, input, remount: (nextInput) => mountBody(host, id, nextInput, parent) }
}

/**
 * One plugin contribution: the host's wrapper (title, loading line, error box) around a child
 * `div` the plugin owns. Each mount gets a fresh, empty child that is removed when the mount ends, so
 * a plugin never inherits what an earlier mount left behind. React never renders into that child.
 */
export function PluginSlot({ id, input }: Props) {
  const host = usePluginHost()
  const state = usePluginState()
  const anchor = useRef<HTMLDivElement>(null)
  const activeMount = useRef<ActiveMount | null>(null)
  const latestInput = useRef(input)
  useLayoutEffect(() => {
    latestInput.current = input
  }, [input])
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
  const moduleUrl = plugin ? state.model?.modules[plugin]?.url : undefined
  const moduleApiVersion = plugin ? state.model?.modules[plugin]?.apiVersion : undefined

  // A changed owner/module or retry always gets a new child; input updates use the separate effect below.
  useEffect(() => {
    const parent = anchor.current
    if (!parent) return
    activeMount.current = mountBody(host, id, latestInput.current, parent)
    return () => {
      const current = activeMount.current
      activeMount.current = null
      current?.unmount()
    }
  }, [host, id, plugin, module, moduleUrl, moduleApiVersion, retry])

  useEffect(() => {
    const current = activeMount.current
    if (!current || Object.is(current.input, input)) return
    let accepted = false
    try {
      accepted = current.unmount.updateInput?.(input) === true
    } catch {
      accepted = false
    }
    if (accepted) {
      current.input = input
      return
    }
    current.unmount()
    if (activeMount.current !== current) return
    const parent = anchor.current
    if (!parent) return
    activeMount.current = current.remount(input)
  }, [input])

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
