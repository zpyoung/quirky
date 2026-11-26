import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import type { AskCardModel as StoredAskCard } from '@/store/slices/fork-ask-question-tool/asks'
import { Card } from '@/components/ui/card'
import { SecuritySurface } from '@/components/ui/security-surface'
import type { AskAnswers } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { AskCard } from './AskCard'

type GlobalAskItemProps = { entry: StoredAskCard }

function GlobalAskItem({ entry }: GlobalAskItemProps): React.JSX.Element | null {
  const { askId, spec } = entry
  const [isSubmitting, setIsSubmitting] = useState(false)

  const onSubmit = useCallback(
    (answers: AskAnswers, skipped: string[]) => {
      setIsSubmitting(true)
      void window.api.runtime
        .call({ method: 'ask.answer', params: { askId, answers, skipped } })
        .then((response) =>
          unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ committed: boolean }>)
        )
        .catch((error: unknown) => console.error('Failed to submit ask answer:', error))
        .finally(() => setIsSubmitting(false))
    },
    [askId]
  )

  const onCancel = useCallback(() => {
    void window.api.runtime
      .call({ method: 'ask.cancel', params: { askId } })
      .then((response) => unwrapRuntimeRpcResult(response))
      .catch((error: unknown) => console.error('Failed to cancel ask:', error))
  }, [askId])

  // a status-only event can arrive before the one carrying the spec
  if (!spec) {
    return null
  }
  return (
    <SecuritySurface>
      <Card
        role="region"
        aria-label={translate(
          'components.globalAskPrompt.label',
          'Request waiting for your answer'
        )}
        className="max-h-[min(420px,calc(100vh-120px))] gap-0 overflow-hidden py-0"
      >
        <AskCard
          model={{
            askId,
            status: entry.status,
            spec,
            partial: entry.partial,
            result: entry.result
          }}
          onSubmit={onSubmit}
          onCancel={onCancel}
          isSubmitting={isSubmitting}
        />
      </Card>
    </SecuritySurface>
  )
}

/**
 * Asks with no terminal pane to dock to (the brain, scripts, remote callers, approvals for their
 * actions) as a card stack that leaves the rest of the app usable. Rendered inside the app-level
 * notification stack.
 */
export function GlobalAskPrompt(): React.JSX.Element | null {
  const globalAsks = useAppStore((state) => state.globalAsks)
  if (globalAsks.length === 0) {
    return null
  }
  return (
    <>
      {globalAsks.map((entry) => (
        <GlobalAskItem key={entry.askId} entry={entry} />
      ))}
    </>
  )
}
