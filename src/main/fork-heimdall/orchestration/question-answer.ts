import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import type { WatcherQuestionState } from './orchestration-contract'

/**
 * Reads whether a question thread can still be answered. A thread belonging to another Run reads as
 * absent rather than pending, because this Run's coordinator could never answer it.
 */
export function readWatcherQuestion(
  runtime: QuirkyRuntimeService,
  run: RunRow,
  messageId: string
): WatcherQuestionState {
  const question = runtime.getOrchestrationDb().getQuestion(messageId)
  if (!question || question.run_id !== run.id) {
    return { status: 'absent' }
  }
  if (question.status === 'answered' || question.status === 'closed') {
    return { status: question.status }
  }
  return { status: 'pending' }
}

export function answerWatcherQuestion(
  runtime: QuirkyRuntimeService,
  run: RunRow,
  messageId: string,
  body: string
): void {
  const db = runtime.getOrchestrationDb()
  const question = db.getQuestion(messageId)
  if (!question || question.run_id !== run.id) {
    throw new OrchestrationError(
      'question_not_found',
      `Question ${messageId} was not found in Run ${run.id}.`
    )
  }

  const answered = db.answerQuestion({
    messageId,
    runId: run.id,
    consumerGeneration: run.consumer_generation,
    body
  })
  if (db.getFederatedDispatch(question.dispatch_id)) {
    db.enqueueFederationRelay({
      dispatchId: question.dispatch_id,
      direction: 'to_worker',
      kind: 'reply',
      payload: JSON.stringify({
        questionId: question.message_id,
        answerMessageId: answered.message.id,
        body
      })
    })
    runtime.ensureOrchestrationFederationRelay(run.id)
    return
  }
  runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
}
