import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, RefObject } from 'react'

/** Shared graphite presentation contracts; feature state and side effects stay with the caller. */
export type UiTheme = 'dark' | 'light'
export type UiStatus = 'working' | 'needs-you' | 'failing' | 'done' | 'idle' | 'queued'
export type UiTone = 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'
export type UiAction = { label: string; onAction: () => void; disabled?: boolean }
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive' }
export type IconButtonProps = Omit<ButtonProps, 'children'> & { label: string; children: ReactNode }
export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; error?: string }
export type StatusDotProps = { status: UiStatus; label?: string }
export type BadgeProps = { children: ReactNode; tone?: UiTone; label?: string }
export type ListRowProps = {
  title: ReactNode
  description?: ReactNode
  status?: UiStatus
  count?: number
  trailing?: ReactNode
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
}
export type SectionHeaderProps = { title: string; actions?: ReactNode }
export type TabItem = { id: string; label: string; disabled?: boolean; panelId?: string }
export type TabsProps = { label: string; items: readonly TabItem[]; value: string; onChange: (id: string) => void }
export type MenuItem = { id: string; label: string; onAction: () => void; disabled?: boolean; destructive?: boolean; checked?: boolean }
export type MenuProps = { label: string; items: readonly MenuItem[] }
/** Controlled context-menu variant of Menu; actions and selection remain caller-owned. */
export type ContextMenuItem = {
  label: string
  onSelect?(): void
  disabled?: boolean
  title?: string
  separatorBefore?: boolean
  current?: boolean
  icon?: ReactNode
  detail?: string
  badge?: string | number
  submenu?: ContextMenuItem[]
  heading?: boolean
  destructive?: boolean
}
export type ContextMenuProps = { x: number; y: number; label: string; items: ContextMenuItem[]; onClose(): void }
/** Nonmodal anchored dialog; outside pointer and Escape dismiss without trapping focus. */
export type PopoverProps = { open: boolean; label: string; anchor: RefObject<HTMLElement | null>; onClose(): void; children: ReactNode }
export type ToastProps = { title: string; description?: ReactNode; status?: UiStatus; action?: UiAction; onDismiss: () => void; durationMs?: number }
export type DialogProps = { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; variant?: 'dialog' | 'sheet'; closeOnBackdrop?: boolean }
export type EmptyStateProps = { message: string; action?: UiAction; icon?: ReactNode }
export type FormRowProps = { label: string; htmlFor: string; help?: string; error?: string; children: ReactNode }
export type ToolPanelFrameProps = { title: string; actions?: ReactNode; onMinimize?: () => void; children: ReactNode }
export type InlineAgentCardProps = { title: string; description?: ReactNode; status: UiStatus; action?: UiAction }
export type UiLayoutProps = HTMLAttributes<HTMLDivElement>
