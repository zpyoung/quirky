import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '@quirky/protocol'
import type { NewSessionRequest } from './PromptDialog'

type Entry = NewSessionRequest

export const SESSION_MENU: Entry[] = [
  { agent: 'shell', background: false, label: 'Shell' },
  { agent: 'claude', background: false, label: 'Claude' },
  { agent: 'codex', background: false, label: 'Codex' },
  { agent: 'opencode', background: false, label: 'OpenCode' },
  { agent: 'gemini', background: false, label: 'Gemini' },
  { agent: 'claude', background: true, label: 'Claude (background)' }
]

type Props = { onPick: (entry: Entry) => void }

export function NewSessionMenu({ onPick }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

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
          {SESSION_MENU.map((entry) => (
            <li key={entry.label} role="none">
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onPick(entry)
                }}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function agentLabel(agent: AgentKind): string {
  return SESSION_MENU.find((entry) => entry.agent === agent && !entry.background)?.label ?? agent
}
