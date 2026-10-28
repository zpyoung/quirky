import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { Menu } from '@quirky/ui'
import type { MenuItem } from '@quirky/ui'
import { AGENTS_VIEW_ID, loadMenuEntries, SHELL_ONLY_MENU, type MenuEntry } from './menuEntries'
import type { NewSessionRequest } from './PromptDialog'

type Props = { context: UiPluginContext; onPick: (request: NewSessionRequest) => void }

/** The + menu: Shell, installed enabled agents, and the Agents settings entry. */
export function NewSessionMenu({ context, onPick }: Props) {
  const [entries, setEntries] = useState<MenuEntry[]>(SHELL_ONLY_MENU)
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef(0)

  const choose = useCallback((entry: MenuEntry) => {
    if (entry.kind === 'manage') context.openView(AGENTS_VIEW_ID)
    else onPick(entry.request)
  }, [context, onPick])

  const items = useMemo<MenuItem[]>(() => entries.map((entry, index) => ({
    id: `${entry.kind}-${index}-${entry.label}`,
    label: entry.label,
    onAction: () => choose(entry)
  })), [choose, entries])

  useEffect(() => {
    const trigger = root.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    if (!trigger) return

    let open = trigger.getAttribute('aria-expanded') === 'true'
    let unsubscribe: (() => void) | undefined
    const load = () => {
      const request = ++latest.current
      void loadMenuEntries(context).then((loaded) => {
        if (open && request === latest.current) setEntries(loaded)
      })
    }
    const onChange = (event: QuirkyEvent) => {
      if (event.type === 'quirky.agents/changed' || event.type === 'setting.changed') load()
    }
    const observer = new MutationObserver(() => {
      const next = trigger.getAttribute('aria-expanded') === 'true'
      if (next === open) return
      open = next
      if (open) {
        setEntries(SHELL_ONLY_MENU)
        unsubscribe = context.subscribe(onChange)
        load()
      } else {
        unsubscribe?.()
        unsubscribe = undefined
        latest.current += 1
      }
    })
    observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })

    return () => {
      observer.disconnect()
      unsubscribe?.()
      open = false
      latest.current += 1
    }
  }, [context])

  return (
    <div ref={root}>
      <Menu label="+ New session" items={items} />
    </div>
  )
}
