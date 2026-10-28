import { useState, type ReactNode } from 'react'
import { Button, ContextMenu, FormRow, IconButton } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import { messageRows } from './format'
import type { MenuItem, MenuItemId, PrimaryAction } from './ladder'

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
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  const entries: ContextMenuItem[] = menu.map((item) => ({
    label: item.label,
    disabled: !item.enabled,
    title: item.title,
    separatorBefore: item.separatorBefore,
    onSelect: () => onMenu(item.id)
  }))

  return (
    <div className="ui-stack">
      <FormRow label="Commit message" htmlFor="source-control-commit-message">
        <div style={{ position: 'relative' }}>
          <textarea
            id="source-control-commit-message"
            className="ui-text-field__input"
            style={sparkle ? { paddingInlineEnd: 'var(--ui-space-24)' } : undefined}
            rows={messageRows(message)}
            value={message}
            placeholder="Message"
            aria-label="Commit message"
            aria-describedby={remoteError === null ? undefined : 'commit-area-remote-error'}
            disabled={locked}
            onChange={(event) => onMessage(event.target.value)}
          />
          {sparkle}
        </div>
      </FormRow>
      <div className="ui-cluster" style={{ gap: 0, flexWrap: 'nowrap' }}>
        <Button
          data-git-primary
          variant="primary"
          style={{ flex: 1 }}
          disabled={!primary.enabled}
          title={primary.title}
          onClick={onPrimary}
        >
          {spinner === 'primary' && <span role="status" aria-label="Action in progress">◌</span>}
          {primary.label}
        </Button>
        <IconButton
          label="More commit and remote actions"
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenuAt({ x: box.left, y: box.bottom })
          }}
        >
          {spinner === 'chevron' ? <span role="status" aria-label="Action in progress">◌</span> : '▾'}
        </IconButton>
      </div>
      {remoteError !== null && (
        <p id="commit-area-remote-error" role="alert" style={{ color: 'var(--ui-failing)' }}>
          {remoteError}
        </p>
      )}
      {children}
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} label="Commit and remote actions" items={entries} onClose={() => setMenuAt(null)} />}
    </div>
  )
}
