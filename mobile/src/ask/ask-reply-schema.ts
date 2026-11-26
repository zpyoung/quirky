import { z } from 'zod'

// Checked against src/main/runtime/rpc/methods/fork-ask-question-tool/ask.ts: answer answers
// `{ committed }`, cancel answers the resolved envelope, updatePartial answers `{ ok: true }`.

/** `committed: false` means the ask was already settled (or gone) when the answer arrived. */
export const askCommitReceiptSchema = z.looseObject({ committed: z.boolean() })

export const askCancelReceiptSchema = z.looseObject({ status: z.string().optional() })

export const askDraftReceiptSchema = z.looseObject({})
