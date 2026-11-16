import { useState, type CSSProperties } from 'react'
import { CallDot, mono, muted } from './cards/Card'
import { summarizeActivity, type ActivityCall } from './turns'

const summary = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-4) var(--ui-space-6)',
  color: 'var(--ui-muted)',
  cursor: 'pointer'
} satisfies CSSProperties
const list = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-4)',
  margin: 'var(--ui-space-2) 0 var(--ui-space-4) var(--ui-space-16)',
  padding: '0 0 0 var(--ui-space-8)',
  listStyle: 'none',
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)', minWidth: 0 } satisfies CSSProperties
const detail = { ...mono, ...muted, margin: 'var(--ui-space-2) 0 0', whiteSpace: 'pre-wrap' } satisfies CSSProperties

/** A run of read-only tool calls folded into one line that expands to one row per call. */
export function Activity({ calls }: { calls: ActivityCall[] }) {
  const running = calls.some((call) => call.item.state === 'running')
  const [open, setOpen] = useState(running)
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} aria-label="Tool activity">
      <summary style={summary}>
        <span aria-hidden="true">{open ? '\u25be' : '\u25b8'}</span>
        {summarizeActivity(calls)}
      </summary>
      <ul style={list}>
        {calls.map((call) => (
          <li key={call.seq} style={row} data-call-state={call.item.state}>
            <CallDot state={call.item.state} />
            <span>{call.item.summary}</span>
            {call.item.detail && (
              <details>
                <summary style={muted}>Details</summary>
                <pre style={detail}>{call.item.detail}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
