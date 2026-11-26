import { ACTION_CATALOG, isCatalogedActionId } from '../../../shared/keybindings/action-catalog'
import { UiRunActionParams } from '../../../shared/public-rpc/public-methods/ui'
import { AutomationId } from '../../../shared/rpc-contract/automation-params'
import { ProfileDelete } from '../../../shared/rpc-contract/browser-params'
import { LinearCommentDelete } from '../../../shared/rpc-contract/linear-agent-access-params'
import { ResetParams } from '../../../shared/rpc-contract/orchestration-params'
import { ProjectGroupSelector } from '../../../shared/rpc-contract/repo-params'
import {
  RemoveAccountParams,
  RemoveDataAccountParams
} from '../../../shared/rpc-contract/accounts-params'
import { AntigravityAccountMutationParams } from '../../../shared/rpc-contract/antigravity-accounts-params'
import { SkillDeleteRequestSchema } from '../../../shared/skill-delete-contract'
import { FileDelete, FileWrite } from '../../../shared/rpc-contract/files-mutation-params'
import { GitBulkPaths, GitFilePath } from '../../../shared/rpc-contract/git-params'
import { WorktreeRemove } from '../../../shared/rpc-contract/worktree-params'
import type { RpcContext } from './core'
import {
  registerApprovalCategoryResolver,
  registerDestructivePreviewer,
  registerDestructiveResolver
} from './destructive-previewers'

// agentApprovalPolicy is listed so an agent cannot switch approvals off without being asked.
const SECURITY_SETTING_KEYS = [
  'agentDefaultEnv',
  'agentDefaultArgs',
  'nativeChatPermissionMode',
  'agentStatusHooksEnabled',
  'agentApprovalPolicy'
] as const

registerDestructiveResolver('ui.runAction', (params) => {
  const parsed = UiRunActionParams.safeParse(params)
  if (!parsed.success || !isCatalogedActionId(parsed.data.actionId)) {
    return undefined
  }
  return ACTION_CATALOG[parsed.data.actionId].destructive
})

registerApprovalCategoryResolver('settings.update', (params) => {
  if (typeof params !== 'object' || params === null) {
    return undefined
  }
  const touched = SECURITY_SETTING_KEYS.some(
    (key) => key in params && (params as Record<string, unknown>)[key] !== undefined
  )
  return touched ? 'security-settings' : undefined
})

/** One own property of an untrusted params object, without asserting its shape. */
export function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const entry: [string, unknown] | undefined = Object.entries(value).find(([name]) => name === key)
  return entry?.[1]
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key)
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

const ID_PREFIX = 'id:'

/**
 * The workspace a call acts on, which can differ from the caller's own. An explicit id wins, then
 * a selector (resolved through the runtime unless it already names an id); undefined when the
 * params name no workspace or it no longer resolves.
 */
export async function resolveTargetWorktreeId(
  runtime: { showTerminalWorkspaceLaunchScope(selector: string): Promise<{ id: string }> },
  params: unknown
): Promise<string | undefined> {
  const id =
    stringField(params, 'worktreeId') ??
    stringField(params, 'workspaceId') ??
    stringField(recordField(params, 'command'), 'workspace')
  if (id) {
    return id
  }
  const selector = stringField(params, 'worktree') ?? stringField(params, 'workspace')
  if (!selector) {
    return undefined
  }
  if (selector.startsWith(ID_PREFIX)) {
    return selector.slice(ID_PREFIX.length)
  }
  try {
    return (await runtime.showTerminalWorkspaceLaunchScope(selector)).id
  } catch {
    return undefined
  }
}

async function describeWorkspace(ctx: RpcContext, selector: string): Promise<string> {
  try {
    const scope = await ctx.runtime.showTerminalWorkspaceLaunchScope(selector)
    return scope.folderWorkspace
      ? `the folder workspace at ${scope.path}`
      : `the workspace at ${scope.path}`
  } catch {
    return `the workspace ${selector}`
  }
}

function genericEffect(method: string): string[] {
  return [`${method} is destructive`]
}

async function pathExists(
  ctx: RpcContext,
  selector: string,
  relativePath: string
): Promise<{ size: number; isDirectory: boolean } | null | 'unknown'> {
  try {
    return await ctx.runtime.statRuntimeFile(selector, relativePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return /ENOENT|not[_ ]found|no such file/i.test(message) ? null : 'unknown'
  }
}

registerDestructivePreviewer('files.write', async (params, ctx) => {
  const parsed = FileWrite.safeParse(params)
  if (!parsed.success) {
    return genericEffect('files.write')
  }
  const { worktree, relativePath, content } = parsed.data
  const workspace = await describeWorkspace(ctx, worktree)
  const existing = await pathExists(ctx, worktree, relativePath)
  if (existing === null) {
    return [`creates ${relativePath} in ${workspace} (${content.length} characters)`]
  }
  if (existing !== 'unknown' && existing.isDirectory) {
    return [`${relativePath} in ${workspace} is a directory, so the write is refused`]
  }
  return [
    existing === 'unknown'
      ? `writes ${relativePath} in ${workspace}, replacing it if it exists`
      : `${relativePath} exists in ${workspace} (${existing.size} bytes) and will be replaced with ${content.length} characters`
  ]
})

registerDestructivePreviewer('files.delete', async (params, ctx) => {
  const parsed = FileDelete.safeParse(params)
  if (!parsed.success) {
    return genericEffect('files.delete')
  }
  const { worktree, relativePath, recursive } = parsed.data
  const workspace = await describeWorkspace(ctx, worktree)
  const existing = await pathExists(ctx, worktree, relativePath)
  if (existing === null) {
    return [`${relativePath} does not exist in ${workspace}; nothing is deleted`]
  }
  if (existing !== 'unknown' && existing.isDirectory) {
    return [
      recursive
        ? `deletes the directory ${relativePath} in ${workspace} and everything inside it`
        : `deletes the directory ${relativePath} in ${workspace} if it is empty`
    ]
  }
  return [`deletes ${relativePath} from ${workspace}`]
})

registerDestructivePreviewer('git.discard', async (params, ctx) => {
  const parsed = GitFilePath.safeParse(params)
  if (!parsed.success) {
    return genericEffect('git.discard')
  }
  const workspace = await describeWorkspace(ctx, parsed.data.worktree)
  return [`discards the uncommitted changes to ${parsed.data.filePath} in ${workspace}`]
})

const MAX_LISTED_PATHS = 10

registerDestructivePreviewer('git.bulkDiscard', async (params, ctx) => {
  const parsed = GitBulkPaths.safeParse(params)
  if (!parsed.success) {
    return genericEffect('git.bulkDiscard')
  }
  const { worktree, filePaths } = parsed.data
  const workspace = await describeWorkspace(ctx, worktree)
  const listed = filePaths.slice(0, MAX_LISTED_PATHS)
  const more = filePaths.length - listed.length
  return [
    `discards the uncommitted changes to ${filePaths.length} files in ${workspace}`,
    ...listed.map((path) => `- ${path}`),
    ...(more > 0 ? [`- and ${more} more`] : [])
  ]
})

registerDestructivePreviewer('worktree.rm', async (params, ctx) => {
  const parsed = WorktreeRemove.safeParse(params)
  if (!parsed.success) {
    return genericEffect('worktree.rm')
  }
  const workspace = await describeWorkspace(ctx, parsed.data.worktree)
  return [
    `removes ${workspace} from disk`,
    ...(parsed.data.force ? ['--force discards its uncommitted changes'] : [])
  ]
})

/** For a target the params already name, so the preview needs no runtime lookup. */
function registerParamsPreviewer(method: string, describe: (params: unknown) => string[]): void {
  registerDestructivePreviewer(method, (params) => Promise.resolve(describe(params)))
}

registerParamsPreviewer('automation.delete', (params) => {
  const parsed = AutomationId.safeParse(params)
  return parsed.success
    ? [`deletes automation ${parsed.data.id} and stops its schedule`]
    : genericEffect('automation.delete')
})

registerParamsPreviewer('orchestration.reset', (params) => {
  const parsed = ResetParams.safeParse(params)
  if (!parsed.success) {
    return genericEffect('orchestration.reset')
  }
  if (parsed.data.all) {
    return ['deletes every orchestration run, task, dispatch and message on this host']
  }
  return parsed.data.tasks
    ? ['deletes every orchestration task and dispatch on this host; messages are kept']
    : ['deletes every orchestration message on this host']
})

registerParamsPreviewer('skills.delete', (params) => {
  const parsed = SkillDeleteRequestSchema.safeParse(params)
  if (!parsed.success) {
    return genericEffect('skills.delete')
  }
  const { skills } = parsed.data
  const listed = skills.slice(0, MAX_LISTED_PATHS)
  const more = skills.length - listed.length
  return [
    ...listed.map((skill) => `deletes the skill ${skill.name} at ${skill.directoryPath}`),
    ...(more > 0 ? [`and ${more} more skills`] : [])
  ]
})

function registerAccountRemovalPreviewer(method: string, label: string): void {
  registerParamsPreviewer(method, (params) => {
    const parsed = RemoveAccountParams.safeParse(params)
    return parsed.success
      ? [`removes the ${label} account ${parsed.data.accountId} and its stored sign-in`]
      : genericEffect(method)
  })
}

registerAccountRemovalPreviewer('accounts.removeClaude', 'Claude')
registerAccountRemovalPreviewer('accounts.removeCodex', 'Codex')

registerParamsPreviewer('accounts.removeData', (params) => {
  const parsed = RemoveDataAccountParams.safeParse(params)
  return parsed.success
    ? [`removes the ${parsed.data.provider} account ${parsed.data.accountId} and its stored data`]
    : genericEffect('accounts.removeData')
})

registerParamsPreviewer('accounts.antigravityRemove', (params) => {
  const parsed = AntigravityAccountMutationParams.safeParse(params)
  return parsed.success
    ? [`removes the Antigravity account ${parsed.data.accountId} and its stored sign-in`]
    : genericEffect('accounts.antigravityRemove')
})

registerParamsPreviewer('browser.profileDelete', (params) => {
  const parsed = ProfileDelete.safeParse(params)
  return parsed.success
    ? [`deletes the browser profile ${parsed.data.profileId} with its cookies and site data`]
    : genericEffect('browser.profileDelete')
})

registerParamsPreviewer('linear.commentDelete', (params) => {
  const parsed = LinearCommentDelete.safeParse(params)
  return parsed.success
    ? [`permanently deletes Linear comment ${parsed.data.commentId}`]
    : genericEffect('linear.commentDelete')
})

registerParamsPreviewer('projectGroup.delete', (params) => {
  const parsed = ProjectGroupSelector.safeParse(params)
  const removesProjects = recordField(params, 'removeContainedProjects') === true
  return parsed.success
    ? [
        removesProjects
          ? `deletes project group ${parsed.data.groupId} and removes the projects inside it from Quirky`
          : `deletes project group ${parsed.data.groupId}; its projects stay`
      ]
    : genericEffect('projectGroup.delete')
})
