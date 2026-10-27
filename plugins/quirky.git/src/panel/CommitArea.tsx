import { useRef, useState, type ReactNode } from 'react'
import { messageRows } from './format'
import type { MenuItem, MenuItemId, PrimaryAction } from './ladder'
import { PopupMenu, type MenuEntry } from './Menu'

type Props = {
  message: string
  onMessage(text: string): void
  /** The message box is locked: a commit or remote call runs, or there is nothing staged to describe. */
  locked: boolean
  primary: PrimaryAction
  menu: MenuItem[]
  /** Where the in-flight spinner shows: on the primary when it is the running action, else on the chevron. */
  spinner: 'primary' | 'chevron' | null
  /** The latest remote failure, shown under the button. */
  remoteError: string | null
  onPrimary(): void
  onMenu(id: MenuItemId): void
  /** The AI sparkle shown over the message box, when Source Control AI actions are on. */
  sparkle?: ReactNode
  children?: ReactNode
}

/** The commit message box, the primary split button with its chevron menu, and the cards and error beneath. */
export function CommitArea({ message, onMessage, locked, primary, menu, spinner, remoteError, onPrimary, onMenu, sparkle, children }: Props) {
  const chevron = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  const openMenu = () => {
    const box = chevron.current?.getBoundingClientRect()
    setMenuAt({ x: box?.left ?? 0, y: box?.bottom ?? 0 })
  }
  const entries: MenuEntry[] = menu.map((item) => ({
    label: item.label,
    disabled: !item.enabled,
    title: item.title,
    separatorBefore: item.separatorBefore,
    onSelect: () => onMenu(item.id)
  }))

  return (
    <div className="commit-box">
      <textarea
        className={sparkle ? 'scm-ai-message' : undefined}
        rows={messageRows(message)}
        value={message}
        placeholder="Message"
        aria-label="Commit message"
        disabled={locked}
        onChange={(event) => onMessage(event.target.value)}
      />
      {sparkle}
      <div className="scm-split">
        <button type="button" className="primary scm-primary" disabled={!primary.enabled} title={primary.title} onClick={onPrimary}>
          {spinner === 'primary' && <span className="scm-spinner" aria-hidden="true" />}
          {primary.label}
        </button>
        <button
          ref={chevron}
          type="button"
          className="primary scm-chevron-button"
          aria-label="More commit and remote actions"
          aria-haspopup="menu"
          onClick={openMenu}
        >
          {spinner === 'chevron' ? <span className="scm-spinner" aria-hidden="true" /> : '▾'}
        </button>
      </div>
      {remoteError !== null && (
        <p id="commit-area-remote-error" className="scm-remote-error" role="alert">
          {remoteError}
        </p>
      )}
      {children}
      {menuAt && <PopupMenu x={menuAt.x} y={menuAt.y} label="Commit and remote actions" items={entries} onClose={() => setMenuAt(null)} />}
    </div>
  )
}
