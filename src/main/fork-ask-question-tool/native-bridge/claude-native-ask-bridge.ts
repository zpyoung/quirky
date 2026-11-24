import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  askResultToClaudeAnswers,
  claudeQuestionsToAskSpec,
  NO_OWNER_ANSWER
} from './native-question-spec'
import {
  nativeAskRequestId,
  resolveSessionHandoff,
  runNativeQuestion,
  type NativeSessionHandoff
} from './native-question-handoff'

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

function deny(toolUseID: string, message: string): PermissionResult {
  return { behavior: 'deny', message, toolUseID }
}

async function answerThroughOwner(
  sessionId: string,
  handoff: NativeSessionHandoff,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2]
): Promise<PermissionResult | null> {
  const conversion = claudeQuestionsToAskSpec(input)
  if (!conversion.ok) {
    return deny(
      options.toolUseID,
      `Quirky could not relay this question to the watcher owner (${conversion.reason}). ${NO_OWNER_ANSWER}`
    )
  }
  try {
    const envelope = await runNativeQuestion({
      handoff,
      spec: conversion.spec,
      requestId: nativeAskRequestId('claude', sessionId, options.toolUseID || options.requestId),
      signal: options.signal
    })
    if (!envelope) {
      return null
    }
    if (envelope.status === 'answered' || envelope.status === 'partial') {
      return {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: askResultToClaudeAnswers(conversion.bindings, envelope)
        },
        toolUseID: options.toolUseID
      }
    }
    return deny(options.toolUseID, NO_OWNER_ANSWER)
  } catch {
    return deny(options.toolUseID, NO_OWNER_ANSWER)
  }
}

/**
 * Wraps a structured Claude session's `canUseTool` so that an owned worker's `AskUserQuestion` is
 * answered by its watcher owner instead of surfacing a card; every other call reaches `inner`.
 */
export function bridgeClaudeAsk(sessionId: string, inner: CanUseTool): CanUseTool {
  return (toolName, input, options) => {
    if (toolName !== ASK_USER_QUESTION_TOOL) {
      return inner(toolName, input, options)
    }
    const handoff = resolveSessionHandoff(sessionId)
    return handoff
      ? answerThroughOwner(sessionId, handoff, input, options)
      : inner(toolName, input, options)
  }
}
