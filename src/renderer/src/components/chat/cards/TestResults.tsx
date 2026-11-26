import type { RenderItemOf } from '../chat-turns'
import { Card } from './Card'
import { translate } from '@/i18n/i18n'

function stateWord(state: 'running' | 'passed' | 'failed'): string {
  switch (state) {
    case 'running':
      return translate('components.chat.cards.testStateRunning', 'Running')
    case 'passed':
      return translate('components.chat.cards.testStatePassed', 'Passed')
    case 'failed':
      return translate('components.chat.cards.testStateFailed', 'Failed')
  }
}

/** A test run: the command, then passed, failed and skipped counts, with the output tail on failure. */
export function TestResults({ item }: { item: RenderItemOf<'test-result'> }): React.JSX.Element {
  const { command, state, passed, failed, skipped, tail } = item.body
  const total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0)
  const hasCounts = passed !== undefined || failed !== undefined || skipped !== undefined
  const failing = state === 'failed' || (failed ?? 0) > 0
  return (
    <Card
      label={translate('components.chat.cards.testsLabel', 'Tests')}
      ariaLabel={translate('components.chat.cards.testsAria', 'Tests: {{command}}', { command })}
      tone={failing ? 'failing' : 'neutral'}
      header={
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-chat-code" title={command}>
            {command}
          </span>
          {state !== 'passed' && (
            <span className="shrink-0 text-xs text-muted-foreground">{stateWord(state)}</span>
          )}
        </>
      }
    >
      {hasCounts ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {passed !== undefined && (
            <span className="text-base font-semibold text-chat-diff-added">
              {translate('components.chat.cards.testsPassed', '{{count}} passed', {
                count: passed
              })}
            </span>
          )}
          {failed !== undefined && failed > 0 && (
            <span className="text-base font-semibold text-chat-diff-removed">
              {translate('components.chat.cards.testsFailed', '{{count}} failed', {
                count: failed
              })}
            </span>
          )}
          {skipped !== undefined && skipped > 0 && (
            <span className="text-muted-foreground">
              {translate('components.chat.cards.testsSkipped', '{{count}} skipped', {
                count: skipped
              })}
            </span>
          )}
          <span className="text-muted-foreground">
            {translate('components.chat.cards.testsTotal', '{{count}} total', { count: total })}
          </span>
        </div>
      ) : (
        <span className="text-muted-foreground">
          {state === 'running'
            ? translate('components.chat.cards.testsRunning', 'Running tests')
            : stateWord(state)}
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
