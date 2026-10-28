import type { CSSProperties } from 'react'
import type { StructuredMessage } from '@quirky/protocol'
import { Badge } from '@quirky/ui'

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

const row = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)',
  alignSelf: 'flex-start',
  maxWidth: '100%',
  minWidth: 0,
  padding: 'var(--ui-space-8)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  color: 'var(--ui-text)',
  background: 'var(--ui-selected)',
  overflowWrap: 'anywhere'
} satisfies CSSProperties

const body = { minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } satisfies CSSProperties
const code = { fontFamily: 'var(--ui-font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } satisfies CSSProperties

export function MessageRow({ message }: { message: StructuredMessage }) {
  switch (message.role) {
    case 'tool':
      return (
        <article aria-label={`${message.role} message`} style={row}>
          <Badge>tool</Badge>
          <details>
            <summary>{firstLine(message.text) || 'tool'}</summary>
            <pre style={code}>{message.text}</pre>
          </details>
        </article>
      )
    case 'result':
    case 'system':
      return (
        <article aria-label={`${message.role} message`} style={row}>
          <Badge>{message.role}</Badge>
          <div style={body}>{message.text}</div>
        </article>
      )
    default:
      return (
        <article aria-label={`${message.role} message`} style={row}>
          <Badge>{message.role}</Badge>
          <div style={body}>{message.text}</div>
        </article>
      )
  }
}
