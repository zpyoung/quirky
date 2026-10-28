import type { ReactNode } from 'react'
import { Badge, IconButton, SectionHeader } from '@quirky/ui'
import type { RowButton } from './Rows'

type Props = {
  id: string
  heading: string
  count: number
  /** Tooltip for the heading, such as "2 files changed vs origin/main". */
  title?: string
  /** A second line under the heading, shown in the warning colour. */
  note?: string
  collapsed: boolean
  onToggle(): void
  buttons: RowButton[]
  children: ReactNode
}

/** A collapsible section: heading with its count, the header buttons, and the rows. */
export function SectionFrame({ id, heading, count, title, note, collapsed, onToggle, buttons, children }: Props) {
  return (
    <section className="ui-stack" data-section={id} title={title} style={{ gap: 'var(--ui-space-4)' }}>
      <SectionHeader
        title={heading}
        actions={
          <div className="ui-cluster">
            <span data-section-count><Badge label={`${count} ${count === 1 ? 'file' : 'files'}`}>{count}</Badge></span>
            <IconButton
              label={`${collapsed ? 'Expand' : 'Collapse'} ${heading}`}
              title={`${collapsed ? 'Expand' : 'Collapse'} ${heading}`}
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              {collapsed ? '▸' : '▾'}
            </IconButton>
            {buttons.map((button) => (
              <IconButton
                key={button.label}
                label={button.label}
                title={button.label}
                data-section-action
                variant={button.destructive ? 'destructive' : 'secondary'}
                onClick={button.run}
              >
                {button.glyph}
              </IconButton>
            ))}
          </div>
        }
      />
      {note !== undefined && <span data-section-note><Badge tone="needs-you" label={note}>{note}</Badge></span>}
      {!collapsed && children}
    </section>
  )
}
