import type { ReactNode } from 'react'

/** Content and callbacks for shared searchable, nested context menus. State stays with the caller. */
export type ContextMenuItem = {
  id?: string
  label: string
  /** A disabled action may explain its refusal through the native tooltip. */
  title?: string
  key?: string | null
  enabled?: boolean
  separator?: boolean
  danger?: boolean
  swatch?: string
  checked?: boolean
  submenu?: ContextMenuItem[]
  onSelect?: () => void
  /** Noninteractive group caption; unlike a separator this carries readable content. */
  heading?: boolean
  icon?: ReactNode
  detail?: string
  badge?: string | number
  separatorBefore?: boolean
}

export type ContextMenuListProps = {
  items: ContextMenuItem[]
  label: string
  onChoose(item: ContextMenuItem): void
  onClose(): void
  onBack?: () => void
  header?: ReactNode
  highlightFirst?: boolean
  autoFocus?: boolean
}

export type ContextMenuProps = {
  items: ContextMenuItem[]
  label: string
  x: number
  y: number
  onClose(): void
  header?: ReactNode
  highlightFirst?: boolean
  /** The horizontal menu edge anchored at x before viewport clamping. */
  align?: 'start' | 'end'
}
