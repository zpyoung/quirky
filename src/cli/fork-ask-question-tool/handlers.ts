import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  ASK_MAX_CHUNK_MS,
  validateAskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'
import type {
  AskEnvelope,
  AskRegisteredEnvelope
} from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  formatAskValidationErrors,
  getOptionalPositiveSafeIntegerFlag,
  readAskSpecInput,
  resolveAskOriginParams
} from './ask-cli-flags'
import { cancelAskOnInterrupt } from './ask-cli-interrupt'
import { registerAskWithRetry } from './ask-cli-register'
import { waitAskChunkWithRetry } from './ask-cli-wait'

/**
 * CLI handlers for `quirky ask`, `quirky ask wait`, and `quirky ask cancel` (tech.md C5). Every
 * printed line is bare JSON, in `--json` mode and out of it, because the consumer is always
 * a model (logic.md § Answer contract).
 */
export const ASK_HANDLERS: Record<string, CommandHandler> = {
  ask: async ({ flags, client, cwd }) => {
    const validation = validateAskSpec(readAskSpecInput(flags, cwd))
    if (!validation.ok) {
      throw new RuntimeClientError('invalid_argument', formatAskValidationErrors(validation.errors))
    }
    const timeoutMs = getOptionalPositiveSafeIntegerFlag(flags, 'timeout-ms')
    const chunkMs = getOptionalPositiveSafeIntegerFlag(flags, 'chunk-ms', ASK_MAX_CHUNK_MS)

    const registerOutcome = await registerAskWithRetry(client, {
      spec: validation.spec,
      requestId: randomUUID(),
      timeoutMs,
      ...resolveAskOriginParams(cwd)
    })
    if (!('askId' in registerOutcome)) {
      // This is ask.register's own return shape, deliberately not an AskEnvelope: no
      // capable surface ever existed, so the ask was never durably registered and there
      // is no askId to carry — an absent key, not a null one, is the honest encoding.
      console.log(JSON.stringify({ status: 'unavailable', reason: registerOutcome.reason }))
      return
    }

    const registered: AskRegisteredEnvelope = { status: 'registered', askId: registerOutcome.askId }
    console.log(JSON.stringify(registered))
    const stopCancelOnInterrupt = cancelAskOnInterrupt(client, registerOutcome.askId)
    let envelope: AskEnvelope
    try {
      envelope = await waitAskChunkWithRetry(client, registerOutcome.askId, chunkMs)
    } finally {
      stopCancelOnInterrupt()
    }
    // exit 0 regardless of envelope.status: a decline/timeout/unavailable is a normal
    // outcome for the model to reason about, not a failed command (logic.md § Answer contract).
    console.log(JSON.stringify(envelope))
  },

  'ask wait': async ({ flags, client }) => {
    const askId = getRequiredStringFlag(flags, 'id')
    const chunkMs = getOptionalPositiveSafeIntegerFlag(flags, 'chunk-ms', ASK_MAX_CHUNK_MS)
    const stopCancelOnInterrupt = cancelAskOnInterrupt(client, askId)
    let envelope: AskEnvelope
    try {
      envelope = await waitAskChunkWithRetry(client, askId, chunkMs)
    } finally {
      stopCancelOnInterrupt()
    }
    console.log(JSON.stringify(envelope))
  },

  'ask cancel': async ({ flags, client }) => {
    const askId = getRequiredStringFlag(flags, 'id')
    const result = await client.call<AskEnvelope>('ask.cancel', { askId })
    console.log(JSON.stringify(result.result))
  }
}
