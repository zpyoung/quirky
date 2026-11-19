import type { CSSProperties } from 'react'
import { Badge } from '@quirky/ui'
import { Card, clipped, grow, mono, muted } from './Card'

const errors = { margin: 0, paddingInlineStart: 'var(--ui-space-16)' } satisfies CSSProperties
const source = {
  ...mono,
  margin: 'var(--ui-space-6) 0 0',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  whiteSpace: 'pre-wrap',
  background: 'var(--ui-selected)',
  borderRadius: 'var(--ui-radius-control)'
} satisfies CSSProperties

/** A view the daemon refused: its title, why, and the spec the agent sent behind a Show source disclosure. */
export function ViewError({ title, errors: messages, source: spec, agent }: { title: string; errors: string[]; source: string; agent?: string }) {
  return (
    <Card
      label="View"
      ariaLabel={`View failed: ${title}`}
      tone="failing"
      header={
        <>
          <strong style={clipped} title={title}>{title}</strong>
          {agent && <Badge>{`by ${agent}`}</Badge>}
          <span style={grow} />
          <Badge tone="failing">{"couldn't show"}</Badge>
        </>
      }
    >
      <ul style={errors}>
        {messages.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
      <details>
        <summary style={muted}>Show source</summary>
        <pre style={source}>{spec}</pre>
      </details>
    </Card>
  )
}
