import type { UiPluginContext } from '@quirky/protocol'
import { requestWindowCommand } from '../window-command'

export const WORKSPACE_VIEW_ACTION_COMMAND = 'command:quirky.terminal/workspace-view-action'

type WorkspaceDialogKind = 'close-running' | 'close-pinned' | 'new-session' | 'switch-tabs'
type WorkspaceViewActionArgs =
  | { workspace: string; action: 'open-pane-menu'; pane: string; x: number; y: number }
  | { workspace: string; action: 'close-menu' }
  | { workspace: string; action: 'cancel-dialog'; kind: WorkspaceDialogKind; generation: string }
  | { workspace: string; action: 'confirm-close'; kind: 'close-running' | 'close-pinned'; generation: string; dontAskAgain?: boolean }
  | { workspace: string; action: 'submit-session'; kind: 'new-session'; generation: string; prompt: string }
  | { workspace: string; action: 'activate-switcher'; kind: 'switch-tabs'; generation: string; tab?: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Dispatches once in this context's exact window; reports transport/refusal errors without fallback. */
export async function runWorkspaceViewAction(context: UiPluginContext, args: WorkspaceViewActionArgs): Promise<void> {
  let result: unknown
  try {
    result = await requestWindowCommand(context, { command: WORKSPACE_VIEW_ACTION_COMMAND, args })
  } catch (error) {
    context.toast('Could not run workspace action', messageOf(error))
    return
  }
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    const reason = 'reason' in result && typeof result.reason === 'string' ? result.reason : 'The command was refused.'
    context.toast('Could not run workspace action', reason)
  }
}
