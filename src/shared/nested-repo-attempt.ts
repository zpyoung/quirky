import { createNonSecureContextUuid } from './non-secure-context-uuid'

export type NestedRepoRuntimeKind = 'local' | 'runtime' | 'ssh'

export function createNestedRepoAttemptId(): string {
  // Why a UUID: the attempt id must not derive from any stable repo input.
  return createNonSecureContextUuid()
}

export function canSubmitNestedRepoImport(args: {
  attemptId: string | null
  selectedCount: number
}): boolean {
  return Boolean(args.attemptId && args.selectedCount > 0)
}
