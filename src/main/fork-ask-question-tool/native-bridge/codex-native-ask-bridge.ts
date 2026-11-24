import type {
  CodexAppServerConnection,
  CodexAppServerServerRequest
} from '../../codex/codex-app-server-connection'
import type { CodexSession } from '../../codex/codex-structured-session-state'
import {
  answerCodexPrompt,
  CODEX_USER_INPUT_METHOD,
  prepareCodexPromptAnswer,
  type CodexPendingPrompt
} from '../../codex/codex-structured-prompt-replies'
import {
  askResultToCodexAnswers,
  codexParamsToAskSpec,
  NO_OWNER_ANSWER,
  type NativeQuestionBinding
} from './native-question-spec'
import {
  nativeAskRequestId,
  resolveSessionHandoff,
  runNativeQuestion,
  type NativeSessionHandoff
} from './native-question-handoff'

type BridgedCodexSession = Pick<CodexSession, 'prompts' | 'ended'> & {
  connection: Pick<CodexAppServerConnection, 'closed' | 'respond' | 'respondWithError'>
}

const CODEX_USER_INPUT_REFUSED = -32001

function isStillWaiting(session: BridgedCodexSession, prompt: CodexPendingPrompt): boolean {
  return (
    !session.ended &&
    !session.connection.closed &&
    session.prompts.find(prompt.promptKey) === prompt
  )
}

function replyWithAnswers(
  session: BridgedCodexSession,
  prompt: CodexPendingPrompt,
  answers: Record<string, string>
): void {
  for (const [questionId, answer] of Object.entries(answers)) {
    const claim = session.prompts.claim(prompt.promptKey, 'question')
    if (!claim || claim.prompt !== prompt) {
      return
    }
    const prepared = prepareCodexPromptAnswer(prompt, {
      kind: 'answers',
      answers: [{ questionId, optionIds: [], other: answer }]
    })
    answerCodexPrompt(session.prompts, session.connection, claim, prepared)
  }
}

async function answerThroughOwner(args: {
  sessionId: string
  session: BridgedCodexSession
  request: CodexAppServerServerRequest
  prompt: CodexPendingPrompt
  handoff: NativeSessionHandoff
  spec: Parameters<typeof runNativeQuestion>[0]['spec']
  bindings: NativeQuestionBinding[]
}): Promise<void> {
  const { session, prompt } = args
  try {
    const envelope = await runNativeQuestion({
      handoff: args.handoff,
      spec: args.spec,
      requestId: nativeAskRequestId('codex', args.sessionId, prompt.promptKey),
      stillWanted: () => isStillWaiting(session, prompt)
    })
    if (!envelope || !isStillWaiting(session, prompt)) {
      return
    }
    // A declined or expired hand-off still owes Codex a reply; every question gets the no-answer text.
    const result =
      envelope.status === 'answered' || envelope.status === 'partial'
        ? envelope
        : { answers: {}, skipped: [], summary: '' }
    replyWithAnswers(session, prompt, askResultToCodexAnswers(args.bindings, result))
  } catch (error) {
    if (!isStillWaiting(session, prompt)) {
      return
    }
    session.prompts.forget(prompt)
    session.connection.respondWithError(
      args.request.id,
      CODEX_USER_INPUT_REFUSED,
      `Quirky could not relay ${CODEX_USER_INPUT_METHOD} to the watcher owner: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Takes an owned worker's Codex `requestUserInput` away from the UI: the question is relayed to the
 * watcher owner and answered on the connection once the owner replies. Returns true when the
 * request was taken (including a refusal reply), so the caller must neither journal nor answer it.
 */
export function bridgeCodexUserInput(
  sessionId: string,
  session: BridgedCodexSession,
  request: CodexAppServerServerRequest
): boolean {
  if (request.method !== CODEX_USER_INPUT_METHOD) {
    return false
  }
  const handoff = resolveSessionHandoff(sessionId)
  if (!handoff) {
    return false
  }
  const conversion = codexParamsToAskSpec(request.params)
  // a provider-valid request too large for an ask keeps its normal prompt rather than being refused.
  if (!conversion.ok && conversion.exceedsAskCapacity) {
    return false
  }
  const prompt = conversion.ok ? session.prompts.register(request) : null
  if (!conversion.ok || !prompt) {
    const reason = conversion.ok ? 'the request could not be tracked' : conversion.reason
    session.connection.respondWithError(
      request.id,
      CODEX_USER_INPUT_REFUSED,
      `Quirky could not relay this question to the watcher owner (${reason}). ${NO_OWNER_ANSWER}`
    )
    return true
  }
  void answerThroughOwner({
    sessionId,
    session,
    request,
    prompt,
    handoff,
    spec: conversion.spec,
    bindings: conversion.bindings
  })
  return true
}
