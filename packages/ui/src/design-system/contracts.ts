import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref, RefObject, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

/** Shared graphite presentation contracts; feature state and side effects stay with the caller. */
export type UiTheme = 'dark' | 'light'
export type UiStatus = 'working' | 'needs-you' | 'failing' | 'done' | 'idle' | 'queued'
export type UiTone = 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'
export type UiAction = { label: string; onAction: () => void; disabled?: boolean }
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive'; ref?: Ref<HTMLButtonElement> }
export type IconButtonProps = Omit<ButtonProps, 'children'> & { label: string; children: ReactNode }
export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; error?: string; ref?: Ref<HTMLInputElement> }
export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; help?: string; error?: string }
export type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; help?: string; error?: string }
export type StatusDotProps = { status: UiStatus; label?: string; progress?: number }
export type BadgeProps = { children: ReactNode; tone?: UiTone; label?: string }
export type ListRowProps = {
  title: ReactNode
  description?: ReactNode
  status?: UiStatus
  statusLabel?: string
  progress?: number
  count?: number
  trailing?: ReactNode
  selected?: boolean
  compact?: boolean
  disabled?: boolean
  mainTitle?: string
  mainLabel?: string
  onClick?: () => void
}
export type SectionHeaderProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & { title: string; titleTooltip?: string; actions?: ReactNode }
export type TabItem = { id: string; label: string; disabled?: boolean; panelId?: string }
export type TabsProps = { label: string; items: readonly TabItem[]; value: string; onChange: (id: string) => void }
export type MenuItem = { id: string; label: string; onAction: () => void; disabled?: boolean; destructive?: boolean; checked?: boolean }
export type MenuProps = { label: string; trigger?: ReactNode; items: readonly MenuItem[] }
/** Nonmodal anchored dialog; outside pointer and Escape dismiss without trapping focus. */
export type PopoverProps = { open: boolean; label: string; anchor: RefObject<HTMLElement | null>; boundary?: HTMLElement | null; onClose(): void; children: ReactNode }
export type ToastProps = { title: string; description?: ReactNode; status?: UiStatus; action?: UiAction; onDismiss: () => void; durationMs?: number }
export type DialogProps = { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; variant?: 'dialog' | 'sheet'; placement?: 'center' | 'top'; size?: 'default' | 'wide'; closeOnBackdrop?: boolean; scrollBody?: boolean }
export type EmptyStateProps = { message: string; action?: UiAction; icon?: ReactNode }
export type FormRowProps = { label: string; htmlFor: string; help?: string; error?: string; children: ReactNode }
export type ToolPanelFrameProps = { title: string; actions?: ReactNode; onMinimize?: () => void; children: ReactNode }
/** Plugin-owned controls portaled into their nearest shared tool frame header. */
export type ToolPanelActionsProps = { children: ReactNode }
export type InlineAgentCardProps = { title: string; description?: ReactNode; status: UiStatus; action?: UiAction }
export type UiLayoutProps = HTMLAttributes<HTMLDivElement>
