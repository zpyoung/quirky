import type { ExecutionHostId } from '../../../shared/execution-host'
import { isKeybindingActionId, type KeybindingActionId } from '../../../shared/keybindings'

export type AppCommandSource = 'plugin-keybinding' | 'plugin-palette' | 'rpc'

export type AppCommandDispatchOptions = {
  /** Workspace the command targets; actions that act on the active workspace decline for any other. */
  worktreeId?: string
  /** Host that owns `worktreeId` when several hosts publish the same workspace id. */
  hostId?: ExecutionHostId
  /** Report whether the command would be claimed without running it. */
  probeOnly?: boolean
}

export type AppCommandDispatchResult = { claimed: boolean; reason?: string }

export type AppCommandDispatcher = (
  actionId: KeybindingActionId,
  source: AppCommandSource,
  options?: AppCommandDispatchOptions
) => boolean | AppCommandDispatchResult

let currentDispatcher: AppCommandDispatcher | null = null

export function registerAppCommandDispatcher(dispatcher: AppCommandDispatcher): () => void {
  currentDispatcher = dispatcher
  return () => {
    if (currentDispatcher === dispatcher) {
      currentDispatcher = null
    }
  }
}

function toResult(
  outcome: boolean | AppCommandDispatchResult,
  actionId: string
): AppCommandDispatchResult {
  if (typeof outcome === 'object') {
    return outcome
  }
  return outcome
    ? { claimed: true }
    : { claimed: false, reason: `${actionId} is not available right now` }
}

/** For callers that only need to know whether a handler claimed the command. */
export function dispatchAppCommand(actionId: string, source: AppCommandSource): boolean {
  return isKeybindingActionId(actionId) && currentDispatcher !== null
    ? toResult(currentDispatcher(actionId, source), actionId).claimed
    : false
}

/** Like `dispatchAppCommand`, but says why a command was declined so an RPC caller can act on it. */
export function dispatchAppCommandWithResult(
  actionId: string,
  source: AppCommandSource,
  options?: AppCommandDispatchOptions
): AppCommandDispatchResult {
  if (!isKeybindingActionId(actionId)) {
    return { claimed: false, reason: `unknown action ${actionId}` }
  }
  if (currentDispatcher === null) {
    return { claimed: false, reason: 'the app window is not ready to run commands' }
  }
  return toResult(currentDispatcher(actionId, source, options), actionId)
}
