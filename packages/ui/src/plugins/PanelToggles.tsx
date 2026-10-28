import { useEffect, useRef, useState } from 'react'
import { usePluginHost, usePluginState } from '../context'

/** One activity control per panel; the open panel's button is pressed and badges show beside its title. */
export function PanelToggles({ vertical = false }: { vertical?: boolean }) {
  const host = usePluginHost()
  const { model, layout, badges, badgeTitles } = usePluginState()
  const [menu, setMenu] = useState<{ panelId: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  return (
    <>
      {(model?.panels ?? []).map((panel) => {
        const count = badges[panel.id]
        return (
          <button
            key={panel.id}
            className={`panel-toggle${vertical ? ' panel-toggle-vertical' : ''}${layout.panel === panel.id ? ' active' : ''}`}
            aria-label={panel.title}
            title={panel.title}
            aria-pressed={layout.panel === panel.id}
            onClick={() => host.togglePanel(panel.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu({ panelId: panel.id, x: Math.min(event.clientX, window.innerWidth - 120), y: Math.min(event.clientY, window.innerHeight - 100) })
            }}
          >
            {panel.title}
            {count !== undefined && count > 0 && (
              <span className="badge" title={badgeTitles[panel.id] ?? `${count} waiting`}>
                {count}
              </span>
            )}
          </button>
        )
      })}
      {menu && <div
        ref={menuRef}
        role="menu"
        aria-label={`Position ${model?.panels.find((panel) => panel.id === menu.panelId)?.title ?? 'panel'} activity control`}
        style={{ position: 'fixed', zIndex: 1000, left: menu.x, top: menu.y, display: 'flex', gap: 4, padding: 5, color: 'var(--text, #d7dae0)', background: 'var(--bg-raised, #1d2027)', border: '1px solid var(--border, #2b2f3a)', borderRadius: 6, boxShadow: '0 8px 28px #0008' }}
      >
        {(['top', 'side'] as const).map((position) => (
          <button
            key={position}
            type="button"
            role="menuitemradio"
            aria-checked={(layout.activityBarPosition ?? 'top') === position}
            onClick={() => {
              host.configurePanel(menu.panelId, { activityBarPosition: position })
              setMenu(null)
            }}
          >
            {position === 'top' ? 'Top' : 'Side'}
          </button>
        ))}
      </div>}
    </>
  )
}
