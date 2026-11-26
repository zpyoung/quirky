import type { BrowserWindow } from 'electron'
import { ACTION_CATALOG, isCatalogedActionId } from '../../../../shared/keybindings/action-catalog'
import {
  UiListActionsParams,
  UiRunActionParams
} from '../../../../shared/public-rpc/public-methods/ui'
import type { QuirkyRuntimeService } from '../../quirky-runtime'
import {
  UiBridgeError,
  requestRendererAction,
  requestRendererUiState
} from '../../ui-bridge/ui-renderer-request'
import { defineMethod, type RpcContext } from '../core'
import { registerDestructivePreviewer } from '../destructive-previewers'

function requireUiWindow(runtime: QuirkyRuntimeService): BrowserWindow {
  try {
    return runtime.getAuthoritativeWindow()
  } catch {
    throw new UiBridgeError('no_ui', 'no app window is open; start the desktop app first')
  }
}

async function resolveWorkspaceId(
  runtime: QuirkyRuntimeService,
  selector: string | undefined
): Promise<string | undefined> {
  return selector === undefined
    ? undefined
    : (await runtime.showTerminalWorkspaceLaunchScope(selector)).id
}

/** Lists what `ui.runAction` with `workspace.delete` would remove, one effect per line. */
export async function previewUiRunAction(
  params: unknown,
  { runtime }: Pick<RpcContext, 'runtime'>
): Promise<string[]> {
  const parsed = UiRunActionParams.safeParse(params)
  if (
    !parsed.success ||
    !isCatalogedActionId(parsed.data.actionId) ||
    ACTION_CATALOG[parsed.data.actionId].destructive?.category !== 'workspace-delete' ||
    parsed.data.workspace === undefined
  ) {
    return []
  }
  const selector = parsed.data.workspace
  const scope = await runtime.showTerminalWorkspaceLaunchScope(selector)
  if (scope.folderWorkspace) {
    return ['removes folder workspace from Quirky; files stay on disk']
  }
  const status = await runtime.getRuntimeGitStatus(selector, { admissionTier: 'status' })
  const count = status.entries.length
  return [
    `deletes the worktree at ${scope.path}`,
    `${count} uncommitted ${count === 1 ? 'file' : 'files'} would be lost`
  ]
}

registerDestructivePreviewer('ui.runAction', previewUiRunAction)

export const UI_ACTION_METHODS = [
  defineMethod({
    name: 'ui.state',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => requestRendererUiState(requireUiWindow(runtime))
  }),
  defineMethod({
    name: 'ui.listActions',
    permission: 'workspace',
    params: UiListActionsParams,
    handler: async (params, { runtime }) => {
      const win = requireUiWindow(runtime)
      const worktreeId = await resolveWorkspaceId(runtime, params.workspace)
      const actions: {
        id: string
        description: string
        available: boolean
        reason?: string
        destructive: boolean
      }[] = []
      for (const [id, entry] of Object.entries(ACTION_CATALOG)) {
        const destructive = entry.destructive !== undefined
        if (entry.dispatch === 'ui-only') {
          actions.push({
            id,
            description: entry.description,
            available: false,
            ...(entry.uiOnlyReason ? { reason: entry.uiOnlyReason } : {}),
            destructive
          })
          continue
        }
        const probe = await requestRendererAction(win, {
          actionId: id,
          probeOnly: true,
          ...(worktreeId ? { worktreeId } : {})
        })
        actions.push({
          id,
          description: entry.description,
          available: probe.claimed,
          ...(probe.reason ? { reason: probe.reason } : {}),
          destructive
        })
      }
      return { actions: params.available ? actions.filter((action) => action.available) : actions }
    }
  }),
  defineMethod({
    name: 'ui.runAction',
    permission: 'desktop-control',
    params: UiRunActionParams,
    handler: async (params, { runtime }) => {
      const entry = isCatalogedActionId(params.actionId)
        ? ACTION_CATALOG[params.actionId]
        : undefined
      if (!entry) {
        throw new UiBridgeError('invalid_argument', `unknown action ${params.actionId}`)
      }
      if (entry.dispatch === 'ui-only') {
        throw new UiBridgeError(
          'not_applicable',
          entry.uiOnlyReason ?? 'runs only in the app window'
        )
      }
      if (entry.takesWorkspace && entry.destructive && params.workspace === undefined) {
        throw new UiBridgeError('invalid_argument', `${params.actionId} requires a workspace`)
      }
      const win = requireUiWindow(runtime)
      const worktreeId = await resolveWorkspaceId(runtime, params.workspace)
      const reply = await requestRendererAction(win, {
        actionId: params.actionId,
        ...(worktreeId ? { worktreeId } : {})
      })
      if (!reply.claimed) {
        throw new UiBridgeError(
          'not_applicable',
          reply.reason ?? `${params.actionId} is not available right now`
        )
      }
      return { claimed: true }
    }
  })
]
