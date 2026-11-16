import type { CSSProperties, ReactNode } from 'react'
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
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  background: 'var(--ui-selected)'
} satisfies CSSProperties

const kindLabel = {
  color: 'var(--ui-muted)',
  fontSize: 'var(--ui-font-section)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase'
} satisfies CSSProperties

const body = { padding: 'var(--ui-space-8)', minWidth: 0, overflowWrap: 'anywhere' } satisfies CSSProperties

export const mono = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 'var(--ui-font-mono)',
  overflowWrap: 'anywhere'
} satisfies CSSProperties

export const muted = { color: 'var(--ui-muted)' } satisfies CSSProperties
export const grow = { flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties

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
