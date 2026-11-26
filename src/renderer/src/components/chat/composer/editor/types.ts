import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

export type Trigger = { kind: '@' | '/'; query: string; from: number; to: number }

/** A part of one version of a visual that a message points at. */
export type VisualRef = { viewId: string; version: number; element: string }

export type Pill =
  | { kind: 'file'; path: string }
  | { kind: 'command'; name: string }
  | ({ kind: 'visual' } & VisualRef)

/** The text form of a visual reference, without its trailing space: `@view:<viewId>/v<version>/<element>`. */
export const VISUAL_REF = '@view:(view_[0-9a-f]{12})/v(\\d+)/([a-z0-9][a-z0-9._:-]{0,79})'

/** What a visual reference reads as: the visual's title and the element's label. */
export type VisualLabel = { title: string; label: string }

export const visualRefText = (ref: VisualRef): string =>
  `@view:${ref.viewId}/v${ref.version}/${ref.element}`

const labels = new Map<string, VisualLabel>()
const watching = new Map<string, { ref: VisualRef; listeners: Set<(label: VisualLabel) => void> }>()
const looking = new Set<string>()
let resolver: ((ref: VisualRef) => Promise<VisualLabel | null>) | null = null

function lookUp(key: string, ref: VisualRef): void {
  if (resolver === null || looking.has(key)) {
    return
  }
  looking.add(key)
  resolver(ref)
    .then((found) => {
      if (found) {
        rememberVisualLabel(ref, found)
      }
    })
    .catch(() => {})
    .finally(() => looking.delete(key))
}

/** Records the title and label a reference reads as, such as when the user points at an element. */
export function rememberVisualLabel(ref: VisualRef, label: VisualLabel): void {
  const key = visualRefText(ref)
  labels.set(key, label)
  const entry = watching.get(key)
  watching.delete(key)
  entry?.listeners.forEach((listener) => listener(label))
}

/** Sets how a reference no one pointed at in this window is read. */
export function setVisualResolver(next: (ref: VisualRef) => Promise<VisualLabel | null>): void {
  resolver = next
  for (const [key, { ref }] of watching) {
    lookUp(key, ref)
  }
}

/** Drops `owner` as the resolver unless another has replaced it since. */
export function clearVisualResolver(owner: (ref: VisualRef) => Promise<VisualLabel | null>): void {
  if (resolver === owner) {
    resolver = null
  }
}

/**
 * The label of `ref` when it is known, else null with a lookup under way; `listener` runs once when
 * it arrives. `stop` drops the listener.
 */
export function watchVisualLabel(
  ref: VisualRef,
  listener: (label: VisualLabel) => void
): { label: VisualLabel | null; stop(): void } {
  const key = visualRefText(ref)
  const known = labels.get(key)
  if (known) {
    return { label: known, stop() {} }
  }
  const entry = watching.get(key) ?? { ref, listeners: new Set() }
  watching.set(key, entry)
  entry.listeners.add(listener)
  lookUp(key, ref)
  return { label: null, stop: () => void entry.listeners.delete(listener) }
}

/** `<title> > <label>`, or just the element while the label is unknown. */
export const visualPillLabel = (ref: VisualRef, label: VisualLabel | null): string =>
  label === null ? ref.element : `${label.title} › ${label.label}`

export type NavKey = 'up' | 'down' | 'enter' | 'tab' | 'escape'

export type ImeGesture = ReturnType<typeof useImeEnterGestureOwnership>

export type SubmitKind = 'send' | 'steer'

export type ComposerEditorProps = {
  initialValue: string
  onChange(value: string): void
  placeholder: string
  disabled?: boolean
  sendKey: 'enter' | 'mod-enter'
  /** Owns the IME confirm Enter; Enter never submits while it says a composition is live. */
  ime: ImeGesture
  onSubmit(kind: SubmitKind): void
  onTrigger(trigger: Trigger | null): void
  /** Returns true when the suggestion list consumed the key. */
  onKeyNav?(key: NavKey): boolean
  /** Called on Escape when `onKeyNav` did not consume it. */
  onEscape?(): void
  onUpInEmpty?(): void
  /** Called on Shift+Tab; the key is consumed only when this is provided. */
  onCycleMode?(): void
  /** Returns true when it took the paste (images and copied files); text pastes stay with the editor. */
  onPaste(event: ClipboardEvent): boolean
  onCompositionSettled?(): void
  accessibleName: string
}

export type ComposerEditorHandle = {
  focus(): void
  /** Replaces `range`, or the active trigger range when omitted, with the pill. */
  insertPill(pill: Pill, range?: { from: number; to: number }): void
  insertText(text: string): void
  wrapSelection(marker: string): void
  /** Swaps the whole document for text that came from outside the editor, without reporting a change. */
  setValue(value: string): void
  getValue(): string
  selection(): { from: number; to: number }
  hasFocus(): boolean
  containsNode(node: Node | null): boolean
}

/** The callbacks the CM6 extensions read at event time, so props can change without rebuilding the editor. */
export type EditorCallbacks = () => ComposerEditorProps
