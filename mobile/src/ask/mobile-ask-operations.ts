import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  askCancelReceiptSchema,
  askCommitReceiptSchema,
  askDraftReceiptSchema
} from './ask-reply-schema'

/** A refusal throws the host's message, which the card shows inline (validation, unknown ask). */
export const askAnswerRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ask.answer',
    method: 'ask.answer',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ask-commit-receipt', askCommitReceiptSchema)
  })
)

export const askCancelRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ask.cancel',
    method: 'ask.cancel',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ask-cancel-receipt', askCancelReceiptSchema)
  })
)

export const askUpdatePartialRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ask.updatePartial',
    method: 'ask.updatePartial',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ask-draft-receipt', askDraftReceiptSchema)
  })
)
