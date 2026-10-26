import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { AGENTS_VIEW_ID, loadMenuEntries, SHELL_ONLY_MENU, type MenuEntry } from './menuEntries'
import type { NewSessionRequest } from './PromptDialog'

type Props = { context: UiPluginContext; onPick: (request: NewSessionRequest) => void }

/** The `+` menu: Shell, the installed enabled agents from the catalog, and a way to manage them. */
export function NewSessionMenu({ context, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<MenuEntry[]>(SHELL_ONLY_MENU)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    let current = true
    let latest = 0
    const load = () => {
      const request = ++latest
      void loadMenuEntries(context).then((loaded) => {
        if (current && request === latest) setEntries(loaded)
      })
    }
    setEntries(SHELL_ONLY_MENU)
    load()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.agents/changed' || event.type === 'setting.changed') load()
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [open, context])

  const choose = (entry: MenuEntry) => {
    setOpen(false)
    if (entry.kind === 'manage') context.openView(AGENTS_VIEW_ID)
    else onPick(entry.request)
  }

  return (
    <div className="menu-root" ref={root}>
      <button
        className="icon-button tab-add"
        aria-label="New session"
        aria-haspopup="menu"
        aria-expanded={open}
        title="New session"
        onClick={() => setOpen(!open)}
      >
        +
      </button>
      {open && (
        <ul className="menu" role="menu">
          {entries.map((entry) => (
            <li key={entry.label} role="none">
              <button role="menuitem" onClick={() => choose(entry)}>
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
