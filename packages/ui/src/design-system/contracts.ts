import type { UiToolHue } from '@quirky/protocol'
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref, RefObject, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import type { ContextMenuItem } from './context-menu-contracts'

/** Shared graphite presentation contracts; feature state and side effects stay with the caller. */
export type UiTheme = 'dark' | 'light'
export type UiStatus = 'working' | 'needs-you' | 'failing' | 'done' | 'idle' | 'queued'
export type UiTone = 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'
export type UiAction = { label: string; onAction: () => void; disabled?: boolean }
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive'; ref?: Ref<HTMLButtonElement> }
export type IconButtonProps = Omit<ButtonProps, 'children'> & { label: string; children: ReactNode }
export type ExpandingIconButtonProps = Omit<ButtonProps, 'children' | 'variant'> & { label: string; children: ReactNode }
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
export type SectionHeaderProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & { title: ReactNode; titleTooltip?: string; actions?: ReactNode }
export type TabItem = { id: string; label: string; count?: number; disabled?: boolean; panelId?: string }
export type TabsProps = { label: string; items: readonly TabItem[]; value: string; onChange: (id: string) => void }
export type MenuItem = { id: string; label: string; onAction: () => void; disabled?: boolean; destructive?: boolean; checked?: boolean }
export type MenuProps = { label: string; trigger?: ReactNode; items: readonly MenuItem[] }
/** Nonmodal anchored dialog; outside pointer and Escape dismiss without trapping focus. */
export type PopoverProps = { open: boolean; label: string; anchor: RefObject<HTMLElement | null>; boundary?: HTMLElement | null; onClose(): void; children: ReactNode }
export type ToastProps = { title: string; description?: ReactNode; status?: UiStatus; action?: UiAction; onDismiss: () => void; durationMs?: number }
export type DialogProps = { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; variant?: 'dialog' | 'sheet'; placement?: 'center' | 'top'; size?: 'default' | 'wide'; closeOnBackdrop?: boolean; scrollBody?: boolean }
export type EmptyStateProps = { message: string; action?: UiAction; icon?: ReactNode }
export type FormRowProps = { label: string; htmlFor: string; help?: string; error?: string; children: ReactNode }
export type ToolPanelFrameProps = { title: string; tabs?: ReactNode; tools?: ReactNode; actions?: ReactNode; onMinimize?: () => void; children: ReactNode }
/** Plugin-owned controls portaled into their nearest shared tool frame header. */
export type ToolPanelActionsProps = { children: ReactNode }
/** Plugin-owned tool buttons portaled into their nearest shared tool frame's left rail. */
export type ToolPanelToolsProps = { children: ReactNode }
/** Plugin-owned tabs portaled into their nearest shared tool frame header, after the title. */
export type ToolPanelTabsProps = { children: ReactNode }
export type InlineAgentCardProps = { title: string; description?: ReactNode; status: UiStatus; action?: UiAction }
export type UiLayoutProps = HTMLAttributes<HTMLDivElement>
/** Icon props: `size` is the square edge in CSS pixels (default 16); an icon is decorative unless given a `label`. */
export type ToolIconProps = { name: string; hue: UiToolHue; size?: number; label?: string }
export type ControlIconProps = { name: string; size?: number; label?: string }
export type FileIconProps = { path: string; size?: number; label?: string }
export type ProjectTileProps = { name: string; color?: string | null; size?: number; label?: string }
export type PopupItem = ContextMenuItem & {
  /** Leading mark such as a status dot or project tile. */
  lead?: ReactNode
  /** Second line under the label; the search field matches it too. */
  subtitle?: string
  /** Draws the pill on the row. */
  selected?: boolean
  /** Right-aligned content; a shortcut in `key` renders after it. */
  trailing?: ReactNode
}
export type PopupMenuProps = {
  anchor: HTMLElement
  items: PopupItem[]
  title?: string
  searchPlaceholder?: string
  onClose(): void
}
/**
 * A status bar value. With `items` it is a button that opens a `PopupMenu` titled `popupTitle` (default
 * `label`); without them it is plain, non-interactive content. `label` names the control for assistive tech.
 */
export type StatusBarItemProps = { label: string; items?: PopupItem[]; popupTitle?: string; children: ReactNode }
