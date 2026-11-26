import type { ZodType } from 'zod'
import type { StableErrorCode } from './error-contract'

export type { StableErrorCode, NextStep } from './error-contract'

export type ApprovalCategory =
  | 'workspace-delete'
  | 'file-overwrite-delete'
  | 'chat-discard-rewind'
  | 'permission-answers'
  | 'security-settings'

export type DestructiveSpec = { category: ApprovalCategory }

/**
 * One RPC method exposed on the public CLI/API surface. The CLI, `quirky schema` and the
 * server-side gate are all derived from this record, so it is the only place a public command is
 * declared.
 */
export type PublicMethodSpec = {
  method: string
  cliPath: string[]
  summary: string
  stability: 'stable' | 'unstable'
  /** `mutate` means the call is attributed, lands in the activity trail and emits an event. */
  effect: 'read' | 'mutate'
  /** The exact schema object the RPC method parses; never a redeclaration. */
  params: ZodType | null
  /** Validated in tests only, never in production dispatch. */
  result: ZodType
  /** Param keys mapped to positionals in order; the rest become `--kebab-case` flags. */
  positionals?: string[]
  destructive?: DestructiveSpec
  approvalCategory?: ApprovalCategory
  errors: StableErrorCode[]
  /** Result keys kept in terse JSON output; `--full` returns the whole result. */
  terse?: readonly string[]
  streaming?: true
}

export function definePublicMethod(spec: PublicMethodSpec): PublicMethodSpec {
  return spec
}
