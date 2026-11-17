import type { CSSProperties } from 'react'
import type { TestsItem } from '../turns'
import { callStateLabel, Card, CallDot, grow, mono, muted } from './Card'

const counts = { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--ui-space-12)' } satisfies CSSProperties
const big = { fontSize: 'var(--ui-font-title)', fontWeight: 600 } satisfies CSSProperties
const tail = {
  ...mono,
  margin: 'var(--ui-space-8) 0 0',
  padding: 'var(--ui-space-6) var(--ui-space-8)',
  whiteSpace: 'pre-wrap',
  border: 'var(--ui-border-width) solid var(--ui-failing)',
  borderRadius: 'var(--ui-radius-control)'
} satisfies CSSProperties

/** A test run: the command, then passed, failed and skipped counts, with the output tail when something failed. */
export function TestResults({ item }: { item: TestsItem }) {
  const { passed, failed, skipped } = item
  const total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0)
  const hasCounts = passed !== undefined || failed !== undefined || skipped !== undefined
  const failing = item.state === 'failed' || (failed ?? 0) > 0
  return (
    <Card
      label="Tests"
      ariaLabel={`Tests: ${item.command}`}
      tone={failing ? 'failing' : 'neutral'}
      header={
        <>
          <span style={mono}>{item.command}</span>
          <span style={grow} />
          {item.state !== 'done' && (
            <>
              <CallDot state={item.state} />
              <span>{callStateLabel[item.state]}</span>
            </>
          )}
        </>
      }
    >
      {hasCounts ? (
        <div style={counts}>
          {passed !== undefined && <span style={{ ...big, color: 'var(--ui-working)' }}>{`${passed} passed`}</span>}
          {failed !== undefined && failed > 0 && <span style={{ ...big, color: 'var(--ui-failing)' }}>{`${failed} failed`}</span>}
          {skipped !== undefined && skipped > 0 && <span style={muted}>{`${skipped} skipped`}</span>}
          <span style={muted}>{`${total} total`}</span>
        </div>
      ) : (
        <span style={muted}>{item.state === 'running' ? 'Running tests' : callStateLabel[item.state]}</span>
      )}
      {item.tail && failing && <pre style={tail}>{item.tail}</pre>}
    </Card>
  )
}
