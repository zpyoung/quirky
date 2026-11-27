import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { selectHeadAsk } from '@/store/slices/fork-ask-question-tool/asks'
import type { AskAnswers } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskPartial } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { AskCardModel } from './ask-card-model'
import { cancelAsk } from './cancel-ask'

/** Coalesces rapid keystrokes into far fewer `ask.updatePartial` calls while keeping restart-resilience current. */
const DRAFT_UPDATE_DEBOUNCE_MS = 500

function sendPartial(askId: string, partial: AskPartial): void {
  void window.api.runtime
    .call({ method: 'ask.updatePartial', params: { askId, partial } })
    .then((response) => unwrapRuntimeRpcResult(response))
    .catch((error: unknown) => console.error('Failed to update ask partial:', error))
}

export type AskPaneDock = {
  /** Null when there is no head ask, or the head ask has no spec yet. */
  model: AskCardModel | null
  isSubmitting: boolean
  /** Why the last submit did not land; null until one fails, and cleared by the next attempt or edit. */
  submitError: string | null
  onSubmit: (answers: AskAnswers, skipped: string[]) => void
  onCancel: () => void
  onDraftChange: (partial: AskPartial) => void
}

/**
 * Docks the pane's head ask: narrows the store's `spec: AskSpec | null` card down to what
 * `AskCard` requires, and wires submit/cancel through the runtime RPC bridge. A head entry with
 * no spec yet is not a bug — a status-only event can arrive before the one carrying the spec —
 * so it narrows to `null` and the caller renders nothing (tech.md § C8).
 *
 * `paneKey` is nullable so a host that renders outside any pane — the right-sidebar panel, which
 * follows whichever session is focused — can call it unconditionally.
 */
export function useAskPaneDock(paneKey: string | null): AskPaneDock {
  const entry = useAppStore((state) => selectHeadAsk(state, paneKey))
  const model = useMemo<AskCardModel | null>(() => {
    if (!entry?.spec) {
      return null
    }
    return {
      askId: entry.askId,
      status: entry.status,
      spec: entry.spec,
      partial: entry.partial,
      result: entry.result
    }
  }, [entry])

  const [submittingAskId, setSubmittingAskId] = useState<string | null>(null)
  const [submitFailure, setSubmitFailure] = useState<{ askId: string; message: string } | null>(
    null
  )
  const askId = model?.askId ?? null

  const onSubmit = useCallback(
    (answers: AskAnswers, skipped: string[]) => {
      if (!askId) {
        return
      }
      setSubmittingAskId(askId)
      setSubmitFailure(null)
      void window.api.runtime
        .call({ method: 'ask.answer', params: { askId, answers, skipped } })
        .then((response) =>
          unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ committed: boolean }>)
        )
        .then((result) => {
          if (!result.committed) {
            setSubmitFailure({
              askId,
              message: translate(
                'components.fork-ask-question-tool.askCard.submitNotCommitted',
                'This question was already answered or closed elsewhere.'
              )
            })
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to submit ask answer:', error)
          setSubmitFailure({
            askId,
            message: translate(
              'components.fork-ask-question-tool.askCard.submitFailed',
              "Couldn't submit your answer: {{reason}}",
              { reason: error instanceof Error ? error.message : String(error) }
            )
          })
        })
        .finally(() => setSubmittingAskId((current) => (current === askId ? null : current)))
    },
    [askId]
  )

  const onCancel = useCallback(() => {
    if (askId) {
      cancelAsk(askId)
    }
  }, [askId])

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef<{ askId: string; partial: AskPartial } | null>(null)
  // a pending draft belongs to the ask that wrote it; leaving that ask flushes it instead of dropping the last keystrokes
  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current)
        draftTimerRef.current = null
      }
      if (pendingDraftRef.current) {
        sendPartial(pendingDraftRef.current.askId, pendingDraftRef.current.partial)
        pendingDraftRef.current = null
      }
    },
    [askId]
  )
  const onDraftChange = useCallback(
    (partial: AskPartial) => {
      if (!askId) {
        return
      }
      setSubmitFailure(null)
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current)
      }
      pendingDraftRef.current = { askId, partial }
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null
        pendingDraftRef.current = null
        sendPartial(askId, partial)
      }, DRAFT_UPDATE_DEBOUNCE_MS)
    },
    [askId]
  )

  return {
    model,
    isSubmitting: askId !== null && submittingAskId === askId,
    submitError: askId !== null && submitFailure?.askId === askId ? submitFailure.message : null,
    onSubmit,
    onCancel,
    onDraftChange
  }
}
