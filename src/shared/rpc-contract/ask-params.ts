// RPC param schemas for ask.* (tech.md C4). Domain validation (spec shape, answer domains) is
// re-run server-side by the handlers via the shared validators — these schemas only police wire
// shape, matching the loosely-typed-CLI-JSON convention in the main RPC schemas.
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString } from './rpc-param-primitives'

const UnknownRecord = z.record(z.string(), z.unknown())

export const AskRegisterParams = z.object({
  spec: z.unknown(),
  requestId: z.string().min(1, 'requestId is required'),
  paneKey: OptionalString,
  terminalHandle: OptionalString,
  worktreeId: OptionalString,
  workspaceId: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  cwd: z.string().min(1, 'cwd is required')
})

export const AskWaitParams = z.object({
  askId: z.string().min(1, 'askId is required'),
  chunkMs: OptionalFiniteNumber
})

export const AskAnswerParams = z.object({
  askId: z.string().min(1, 'askId is required'),
  answers: UnknownRecord.default({}),
  skipped: z.array(z.string()).default([])
})

export const AskUpdatePartialParams = z.object({
  askId: z.string().min(1, 'askId is required'),
  partial: UnknownRecord.default({})
})

export const AskCancelParams = z.object({
  askId: z.string().min(1, 'askId is required')
})

export const AskSnapshotParams = z.object({
  paneKey: OptionalString
})

export const AskSubscribeParams = z.object({
  sinceSeq: OptionalFiniteNumber,
  epoch: OptionalString
})
