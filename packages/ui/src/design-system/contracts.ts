import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** Shared graphite presentation contracts; feature state and side effects stay with the caller. */
export type UiTheme = 'dark' | 'light'
export type UiStatus = 'working' | 'needs-you' | 'failing' | 'done' | 'idle' | 'queued'
export type UiTone = 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'
export type UiAction = { label: string; onAction: () => void; disabled?: boolean }
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive' }
export type IconButtonProps = Omit<ButtonProps, 'children'> & { label: string; children: ReactNode }
export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; error?: string }
export type StatusDotProps = { status: UiStatus; label?: string; progress?: number }
export type BadgeProps = { children: ReactNode; tone?: UiTone; label?: string }
export type ListRowProps = {
  title: ReactNode
  description?: ReactNode
  status?: UiStatus
  progress?: number
  count?: number
  trailing?: ReactNode
  selected?: boolean
  disabled?: boolean
  mainTitle?: string
  mainLabel?: string
  onClick?: () => void
}
export type SectionHeaderProps = { title: string; actions?: ReactNode }
export type TabItem = { id: string; label: string; disabled?: boolean; panelId?: string }
export type TabsProps = { label: string; items: readonly TabItem[]; value: string; onChange: (id: string) => void }
export type MenuItem = {
  id: string
  label: string
  onAction?: () => void
  disabled?: boolean
  destructive?: boolean
  title?: string
  current?: boolean
  submenu?: readonly MenuItem[]
}
export type MenuProps = {
  label: string
  items: readonly MenuItem[]
  /** A context menu opens immediately at a pointer's viewport coordinates. */
  position?: { x: number; y: number }
  onClose?: () => void
}
export type ToastProps = { title: string; description?: ReactNode; status?: UiStatus; action?: UiAction; onDismiss: () => void; durationMs?: number }
export type DialogProps = { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; variant?: 'dialog' | 'sheet'; size?: 'default' | 'wide'; closeOnBackdrop?: boolean }
export type EmptyStateProps = { message: string; action?: UiAction; icon?: ReactNode }
export type FormRowProps = { label: string; htmlFor: string; help?: string; error?: string; children: ReactNode }
export type ToolPanelFrameProps = { title: string; actions?: ReactNode; onMinimize?: () => void; children: ReactNode }
export type InlineAgentCardProps = { title: string; description?: ReactNode; status: UiStatus; action?: UiAction }
export type UiLayoutProps = HTMLAttributes<HTMLDivElement>
