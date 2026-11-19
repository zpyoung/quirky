import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { CallState } from '@quirky/protocol'
import { StatusDot, type UiStatus } from '@quirky/ui'

export type CardTone = 'neutral' | 'failing' | 'needs-you'

const frame = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  overflow: 'hidden',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)'
} satisfies CSSProperties

const toneBorder: Record<CardTone, CSSProperties> = {
  neutral: {},
  failing: { borderColor: 'var(--ui-failing)' },
  'needs-you': { borderColor: 'var(--ui-needs-you)' }
}

const header = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  minWidth: 0,
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  background: 'var(--ui-selected)'
} satisfies CSSProperties

const kindLabel = {
  color: 'var(--ui-muted)',
  fontSize: 'var(--ui-font-section)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  flex: 'none'
} satisfies CSSProperties

const body = { padding: 'var(--ui-space-8)', minWidth: 0, overflowWrap: 'anywhere' } satisfies CSSProperties

export const mono = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 'var(--ui-font-mono)',
  overflowWrap: 'anywhere'
} satisfies CSSProperties

export const muted = { color: 'var(--ui-muted)' } satisfies CSSProperties
export const grow = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
export const clipped = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } satisfies CSSProperties

/** A framed card with a small uppercase kind label; `header` follows the label and `children` is the body. */
export function Card({
  label,
  ariaLabel,
  tone = 'neutral',
  header: headerContent,
  children
}: {
  label: string
  ariaLabel: string
  tone?: CardTone
  header?: ReactNode
  children?: ReactNode
}) {
  return (
    <article aria-label={ariaLabel} style={{ ...frame, ...toneBorder[tone] }}>
      <div style={header}>
        <span style={kindLabel}>{label}</span>
        {headerContent}
      </div>
      {children !== undefined && <div style={body}>{children}</div>}
    </article>
  )
}

const callStatus: Record<CallState, UiStatus> = { running: 'working', done: 'done', failed: 'failing', stopped: 'idle' }
const callLabel: Record<CallState, string> = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }

/** The shared dot for a call's state, labelled for assistive tech. */
export function CallDot({ state }: { state: CallState }) {
  return <StatusDot status={callStatus[state]} label={callLabel[state]} />
}

export const callStateLabel = callLabel

const added = { color: 'var(--ui-working)' } satisfies CSSProperties
const removed = { color: 'var(--ui-failing)' } satisfies CSSProperties

/** "+18 −4" in the added and removed colors; nothing when neither count is known. */
export function Delta({ added: plus, removed: minus }: { added?: number; removed?: number }) {
  return (
    <>
      {plus !== undefined && <span style={added}>{`+${plus}`}</span>}
      {minus !== undefined && <span style={removed}>{`−${minus}`}</span>}
    </>
  )
}

const commandRow = { display: 'flex', alignItems: 'flex-start', gap: 'var(--ui-space-6)', minWidth: 0 } satisfies CSSProperties
const lineBox = { display: 'flex', alignItems: 'center', flex: 'none', height: '1lh' } satisfies CSSProperties
const toggleButton = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--ui-space-6)',
  flex: '0 1 auto',
  minWidth: 0,
  padding: 0,
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'start',
  cursor: 'pointer'
} satisfies CSSProperties
const commandBlock = { display: 'flex', flexDirection: 'column', minWidth: 0 } satisfies CSSProperties
const wrapped = { flex: '0 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } satisfies CSSProperties
const oneLine = { flex: '0 1 auto', ...clipped } satisfies CSSProperties
const chevron = {
  width: 'var(--ui-space-6)',
  height: 'var(--ui-space-6)',
  borderInlineEnd: 'var(--ui-border-width) solid currentColor',
  borderBlockEnd: 'var(--ui-border-width) solid currentColor',
  color: 'var(--ui-muted)'
} satisfies CSSProperties

/** True while `element`'s single line is wider than its box, so the line knows it has more to show. */
export function useClipped(element: HTMLElement | null, text: string): boolean {
  const [isClipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    const check = () => setClipped(element.scrollWidth > element.clientWidth)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, text])
  return isClipped
}

/** A small chevron drawn with borders, pointing right when closed and down when open; it adds no text. */
export function Chevron({ open }: { open: boolean }) {
  return <span aria-hidden="true" style={{ ...chevron, transform: open ? 'rotate(45deg)' : 'rotate(-45deg)' }} />
}

/**
 * A command kept to one line with an ellipsis, with `lead` (usually a status dot) on the same line.
 * When the line is cut off or there is `more` to show, the command becomes a button that opens the
 * whole command wrapped in place, with `more` below it. Starts closed.
 */
export function CommandLine({ text, lead, more, textStyle, style }: { text: string; lead?: ReactNode; more?: ReactNode; textStyle?: CSSProperties; style?: CSSProperties }) {
  const [open, setOpen] = useState(false)
  const [textElement, setTextElement] = useState<HTMLSpanElement | null>(null)
  const isClipped = useClipped(textElement, text)
  const expandable = open || isClipped || more !== undefined
  const onToggle = () => setOpen((shown) => !shown)
  const textSpan = (
    <span ref={setTextElement} data-command-text style={{ ...textStyle, ...(open ? wrapped : oneLine) }} title={open ? undefined : text}>
      {text}
    </span>
  )
  return (
    <div style={{ ...commandBlock, ...style }}>
      <div style={commandRow}>
        {lead !== undefined && <span style={lineBox}>{lead}</span>}
        {expandable ? (
          <button type="button" style={toggleButton} aria-expanded={open} onClick={onToggle}>
            {textSpan}
            <span style={lineBox}>
              <Chevron open={open} />
            </span>
          </button>
        ) : (
          textSpan
        )}
      </div>
      {open && more}
    </div>
  )
}
