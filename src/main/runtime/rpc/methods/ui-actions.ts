import type { BrowserWindow } from 'electron'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { ACTION_CATALOG, isCatalogedActionId } from '../../../../shared/keybindings/action-catalog'
import {
  UiListActionsParams,
  UiRunActionParams
} from '../../../../shared/public-rpc/public-methods/ui'
import type { QuirkyRuntimeService } from '../../quirky-runtime'
import { requestRendererAction, requestRendererUiState } from '../../ui-bridge/ui-renderer-request'
import { defineMethod, type RpcContext } from '../core'
import { registerDestructivePreviewer } from '../destructive-previewers'
import { PublicRpcError } from '../public-rpc-error'

function noUiError(): PublicRpcError {
  return new PublicRpcError(
    'unavailable',
    'no_ui',
    [
      { command: 'quirky status', why: 'this host has no window; UI commands need the desktop app' }
    ],
    undefined,
    'no app window is open; start the desktop app first'
  )
}

function notApplicableError(message: string): PublicRpcError {
  return new PublicRpcError(
    'unavailable',
    'not_applicable',
    [{ command: 'quirky action list --available', why: 'shows which actions apply right now' }],
    undefined,
    message
  )
}

function invalidActionArgument(message: string): PublicRpcError {
  return new PublicRpcError(
    'invalid_argument',
    'invalid_argument',
    [{ command: 'quirky action list', why: 'lists valid action ids' }],
    undefined,
    message
  )
}

function requireUiWindow(runtime: QuirkyRuntimeService): BrowserWindow {
  try {
    return runtime.getAuthoritativeWindow()
  } catch {
    throw noUiError()
  }
}

type ResolvedUiWorkspace = { worktreeId: string; hostId?: ExecutionHostId }

/**
 * The workspace a selector names, with the host that owns it: a workspace id repeats across hosts,
 * so the renderer needs the host to pick the same checkout main resolved. A host main cannot settle
 * is left out and the renderer declines an id that several hosts publish.
 */
async function resolveWorkspace(
  runtime: QuirkyRuntimeService,
  selector: string | undefined
): Promise<ResolvedUiWorkspace | undefined> {
  if (selector === undefined) {
    return undefined
  }
  const scope = await runtime.showTerminalWorkspaceLaunchScope(selector)
  const hostId = await runtime
    .resolveRuntimeFileTarget(selector)
    .then((target) => target.executionHostId)
    .catch(() => undefined)
  return { worktreeId: scope.id, ...(hostId ? { hostId } : {}) }
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
      const workspace = await resolveWorkspace(runtime, params.workspace)
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
          ...workspace
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
        throw invalidActionArgument(`unknown action ${params.actionId}`)
      }
      if (entry.dispatch === 'ui-only') {
        throw notApplicableError(entry.uiOnlyReason ?? 'runs only in the app window')
      }
      if (entry.takesWorkspace && entry.destructive && params.workspace === undefined) {
        throw invalidActionArgument(`${params.actionId} requires a workspace`)
      }
      const win = requireUiWindow(runtime)
      const workspace = await resolveWorkspace(runtime, params.workspace)
      const reply = await requestRendererAction(win, {
        actionId: params.actionId,
        ...workspace
      })
      if (!reply.claimed) {
        throw notApplicableError(reply.reason ?? `${params.actionId} is not available right now`)
      }
      return { claimed: true }
    }
  })
]
