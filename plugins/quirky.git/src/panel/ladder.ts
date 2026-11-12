import type { GitUpstreamStatus } from '@quirky/protocol'

/**
 * Orca's lease predicate: the branch is both ahead and behind but every behind commit is a
 * patch-equivalent copy of a local one (a rebased branch), so a force push with lease is the
 * right way to update the remote.
 */
export function shouldForcePushWithLease(upstream: GitUpstreamStatus): boolean {
  return upstream.hasUpstream && upstream.ahead > 0 && upstream.behind > 0 && upstream.behindPatchEquivalent === true
}
