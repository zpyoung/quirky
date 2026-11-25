import type { RenderItemOf } from '../chat-turns'
import { Card } from './Card'

const STATE_WORDS = { running: 'Running', passed: 'Passed', failed: 'Failed' } as const

/** A test run: the command, then passed, failed and skipped counts, with the output tail on failure. */
export function TestResults({ item }: { item: RenderItemOf<'test-result'> }): React.JSX.Element {
  const { command, state, passed, failed, skipped, tail } = item.body
  const total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0)
  const hasCounts = passed !== undefined || failed !== undefined || skipped !== undefined
  const failing = state === 'failed' || (failed ?? 0) > 0
  return (
    <Card
      label="Tests"
      ariaLabel={`Tests: ${command}`}
      tone={failing ? 'failing' : 'neutral'}
      header={
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-chat-code" title={command}>
            {command}
          </span>
          {state !== 'passed' && (
            <span className="shrink-0 text-xs text-muted-foreground">{STATE_WORDS[state]}</span>
          )}
        </>
      }
    >
      {hasCounts ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {passed !== undefined && (
            <span className="text-base font-semibold text-chat-diff-added">{`${passed} passed`}</span>
          )}
          {failed !== undefined && failed > 0 && (
            <span className="text-base font-semibold text-chat-diff-removed">{`${failed} failed`}</span>
          )}
          {skipped !== undefined && skipped > 0 && (
            <span className="text-muted-foreground">{`${skipped} skipped`}</span>
          )}
          <span className="text-muted-foreground">{`${total} total`}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">
          {state === 'running' ? 'Running tests' : STATE_WORDS[state]}
        </span>
      )}
      {tail && failing && (
        <pre className="mt-2 whitespace-pre-wrap rounded-md border border-destructive/50 px-2 py-1 font-mono text-chat-code">
          {tail}
        </pre>
      )}
    </Card>
  )
}
