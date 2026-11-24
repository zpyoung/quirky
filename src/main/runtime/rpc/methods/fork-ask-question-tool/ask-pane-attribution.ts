import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { QuirkyRuntimeService } from '../../../quirky-runtime'

export type AskAttributionParams = {
  paneKey?: string
  terminalHandle?: string
  worktreeId?: string
  workspaceId?: string
}

export type AskAttribution = {
  paneKey: string | null
  worktreeId: string | null
  /** Best terminal-handle identity available for the no-UI dispatch lookup (C7); '' when none. */
  dispatchLookupHandle: string
  /** True once any env claim was supplied at all — distinguishes "nothing to hand off to" from "nothing was even claimed". */
  anyIdentityClaimed: boolean
}

function resolveLivePaneKey(paneKey: string, runtime: QuirkyRuntimeService): string | undefined {
  return parsePaneKey(paneKey) !== null
    ? (runtime.getAgentStatusTerminalHandleForPaneKey(paneKey) ?? undefined)
    : undefined
}

// Why: folder workspaces have worktreeId-shaped ids (tech.md C3), so resolving either claim
// through the same worktree selector covers both without a separate workspace lookup.
async function isKnownWorktreeId(
  worktreeId: string,
  runtime: QuirkyRuntimeService
): Promise<boolean> {
  try {
    await runtime.showManagedWorktree(`id:${worktreeId}`)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves who owns an ask (tech.md C3): the server never trusts a `paneKey`/`terminalHandle`/
 * `worktreeId`/`workspaceId` env claim without validating it against live runtime state, falling
 * back through terminal handle then worktree/workspace scope to no attribution at all.
 */
export async function resolveAskAttribution(
  params: AskAttributionParams,
  runtime: QuirkyRuntimeService
): Promise<AskAttribution> {
  const anyIdentityClaimed = Boolean(
    params.paneKey || params.terminalHandle || params.worktreeId || params.workspaceId
  )

  const liveHandle = params.paneKey ? resolveLivePaneKey(params.paneKey, runtime) : undefined
  if (params.paneKey && liveHandle) {
    return {
      paneKey: params.paneKey,
      worktreeId: runtime.getTerminalWorktreeIdForPaneKey(params.paneKey),
      dispatchLookupHandle: liveHandle,
      anyIdentityClaimed
    }
  }

  const resolvedPaneKey = params.terminalHandle
    ? runtime.getTerminalPaneKey(params.terminalHandle)
    : null
  if (resolvedPaneKey) {
    return {
      paneKey: resolvedPaneKey,
      worktreeId: runtime.getTerminalWorktreeIdForPaneKey(resolvedPaneKey),
      dispatchLookupHandle: params.terminalHandle as string,
      anyIdentityClaimed
    }
  }

  const claimedWorktreeId = params.worktreeId ?? params.workspaceId ?? null
  const worktreeId =
    claimedWorktreeId && (await isKnownWorktreeId(claimedWorktreeId, runtime))
      ? claimedWorktreeId
      : null

  return {
    paneKey: null,
    worktreeId,
    dispatchLookupHandle: params.terminalHandle ?? '',
    anyIdentityClaimed
  }
}
