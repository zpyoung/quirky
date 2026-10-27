import type { ReactNode } from 'react'
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
    <section className="scm-section" data-section={id}>
      <header className="scm-section-head" title={title}>
        <button type="button" className="scm-section-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          <span className="scm-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="scm-section-title">{heading}</span>
          <span className="scm-count">{count}</span>
        </button>
        <span className="scm-section-actions">
          {buttons.map((b) => (
            <button
              key={b.label}
              type="button"
              className={`icon-button${b.destructive ? ' scm-destructive' : ''}`}
              title={b.label}
              aria-label={b.label}
              onClick={b.run}
            >
              {b.glyph}
            </button>
          ))}
        </span>
      </header>
      {note !== undefined && <p className="scm-section-note">{note}</p>}
      {!collapsed && children}
    </section>
  )
}
