export type Trigger = { kind: '@' | '/'; query: string; from: number; to: number }

export type Pill = { kind: 'file'; path: string } | { kind: 'command'; name: string }

export type NavKey = 'up' | 'down' | 'enter' | 'tab' | 'escape'

export type ComposerEditorProps = {
  value: string
  onChange(value: string): void
  placeholder: string
  disabled?: boolean
  sendKey: 'enter' | 'mod-enter'
  onSubmit(kind: 'send' | 'steer'): void
  onTrigger(trigger: Trigger | null): void
  /** Returns true when the suggestion list consumed the key. */
  onKeyNav?(key: NavKey): boolean
  /** Called on Escape when `onKeyNav` did not consume it. */
  onEscape?(): void
  onUpInEmpty?(): void
  /** Called on Shift+Tab; the key is consumed only when this is provided. */
  onCycleMode?(): void
  onPasteFiles(files: File[]): void
  onDropFiles(files: File[]): void
  onLongPaste(text: string): void
  accessibleName: string
}

export type ComposerEditorHandle = {
  focus(): void
  /** Replaces `range`, or the active trigger range when omitted, with the pill. */
  insertPill(pill: Pill, range?: { from: number; to: number }): void
  wrapSelection(marker: string): void
  clear(): void
}

/** The callbacks the CM6 extensions read at event time, so props can change without rebuilding the editor. */
export type EditorCallbacks = () => ComposerEditorProps
