// FORK-COPY-OF: src/renderer/src/lib/fix-checks-agent-launch.ts
// FORK-COPY-SHA: 071747853f5995ee233b36751613f09a60007c2b
// Upstream comparison baseline 1457d3966cf7b4165d17b18c57668d1e829f7674. Kept fork-owned so manual
// checks fixes share the PR Sitter's main-process policy launch without adding an upstream logic block.
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../shared/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control-ai-actions'
import { buildHostedReviewAgentPrompt } from '../../../shared/fork-hosted-review-sitter/agent-prompt'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/agent-kind'
import { translate } from '@/i18n/i18n'

type StartFixChecksAgentArgs = {
  repoId: string
  basePrompt: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  openModalFallback?: () => void
}

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

function isAgentAvailable(agent: TuiAgent, detectedAgents: TuiAgent[]): boolean {
  return (
    detectedAgents.includes(agent) &&
    isTuiAgentEnabled(agent, useAppStore.getState().settings?.disabledTuiAgents)
  )
}

async function resolveSavedAgentOverride(
  savedAgent: TuiAgent | null | undefined,
  repo: RepoHostFields | null
): Promise<SavedAgentOverrideResult> {
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
  const available = pendingAgents
    ? isAgentAvailable(savedAgent, await pendingAgents)
    : isTuiAgentEnabled(savedAgent, useAppStore.getState().settings?.disabledTuiAgents)
  if (!available) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(
  worktreeId: string,
  savedAgent: TuiAgent | null | undefined
): Promise<TuiAgent | null> {
  const detectedAgents = await ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
  if (savedAgent) {
    if (isAgentAvailable(savedAgent, detectedAgents)) {
      return savedAgent
    }
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return null
  }
  const settings = useAppStore.getState().settings
  const agent = pickSourceControlLaunchAgent({
    defaultAgent: settings?.defaultTuiAgent,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents
  })
  if (!agent) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.2ebf794906',
        'No enabled AI agent was detected on this workspace host.'
      )
    )
  }
  return agent
}

export async function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = resolveSourceControlActionRecipe({
    settings: store.settings,
    repo,
    actionId: 'fixChecks'
  })
  const savedAgentId = readSourceControlLaunchRecipeAgentId(recipe)
  const commandInput = renderSourceControlActionCommandTemplate(
    recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
    { basePrompt: args.basePrompt }
  ).trim()
  if (!commandInput) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.9f00d7df0c',
        'Fix checks prompt is empty. Update Source Control AI settings.'
      )
    )
    return false
  }

  const attachedWorkspace =
    args.worktreeId || !args.item
      ? null
      : findGithubPrWorkspaceAttachment(
          store.allWorktrees(),
          args.repoId,
          args.item.number,
          args.item.url
        )
  const targetWorktreeId = args.worktreeId ?? attachedWorkspace?.id ?? null
  if (targetWorktreeId) {
    const targetWorktree = store.allWorktrees().find((worktree) => worktree.id === targetWorktreeId)
    if (!targetWorktree) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.dfb4dd7c00',
          'Unable to find the workspace attached to these checks.'
        )
      )
      return false
    }
    // Agent selection stays renderer-owned so manual host detection and saved recipes retain their
    // existing behavior. Desktop-owned workspaces use the shared main entry; web and paired-runtime
    // workspaces keep their owning-runtime launch and use the exact same mandatory policy builder.
    const agent = await pickExistingWorktreeAgent(targetWorktreeId, savedAgentId)
    if (!agent) {
      return false
    }
    // launchAgentInNewTab and the main-process entry each create the surface; seeding here would
    // add a stray shell.
    const revealTargetWorkspace = (): boolean => {
      if (activateAndRevealWorktree(targetWorktreeId, { providesInitialSurface: true })) {
        return true
      }
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.03c1d61f83',
          'Unable to open the workspace attached to these checks.'
        )
      )
      return false
    }
    const hostedReviewAgentApi = window.api?.hostedReviewAgent
    const executionHost = parseExecutionHostId(repo?.executionHostId)
    if (hostedReviewAgentApi && executionHost?.kind !== 'runtime' && !recipe.agentArgs?.trim()) {
      if (!revealTargetWorkspace()) {
        return false
      }
      try {
        await hostedReviewAgentApi.launchFix({
          repoId: args.repoId,
          worktreeId: targetWorktreeId,
          agent,
          basePrompt: commandInput
        })
      } catch (error) {
        toast.error(
          error instanceof Error && error.message.trim()
            ? error.message
            : translate(
                'fork.hostedReviewSitter.error.launchFixFailed',
                'Could not start the AI agent for these checks.'
              )
        )
        return false
      }
      return true
    }

    // Why: the agent runs on the workspace's execution host, so its OS decides quoting (#27971).
    const latestStore = useAppStore.getState()
    const targetRepo =
      latestStore.repos.find((candidate) => candidate.id === targetWorktree.repoId) ?? repo
    const launchPlatform = targetRepo
      ? resolveRepoWorktreeLaunchPlatform(latestStore, targetRepo, targetWorktree)
      : undefined
    if (!launchPlatform) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.822bf52295',
          'Unable to resolve the workspace launch platform.'
        )
      )
      return false
    }
    const agentArgsPlan = planAgentCliArgsSuffix(
      recipe.agentArgs,
      launchPlatform === 'win32' ? 'powershell' : 'posix'
    )
    if (!agentArgsPlan.ok) {
      toast.error(agentArgsPlan.error)
      return false
    }
    let revealFailed = false
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: buildHostedReviewAgentPrompt({
        task: 'fix-checks',
        basePrompt: commandInput,
        unattended: false
      }),
      agentArgs: recipe.agentArgs,
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource,
      beforeSurfaceOpen: () => {
        revealFailed = !revealTargetWorkspace()
        return !revealFailed
      }
    })
    if (!result) {
      if (!revealFailed) {
        toast.error(
          translate(
            'auto.lib.fix.checks.agent.launch.fb6c294e85',
            'Could not build the agent launch command.'
          )
        )
      }
      return false
    }
    if (result.surface.kind === 'local-terminal') {
      focusTerminalTabSurface(result.surface.tabId)
    }
    return true
  }

  if (!args.item || !args.openModalFallback) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.027228a06b',
        'Unable to find a workspace for these checks.'
      )
    )
    return false
  }

  const agentOverride = await resolveSavedAgentOverride(savedAgentId, repo)
  if (agentOverride.kind === 'blocked') {
    return false
  }

  return await launchWorkItemDirect({
    item: {
      ...args.item,
      pasteContent: buildHostedReviewAgentPrompt({
        task: 'fix-checks',
        basePrompt: commandInput,
        unattended: false
      })
    },
    repoId: args.repoId,
    launchSource: args.launchSource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe.agentArgs,
    ...(agentOverride.kind === 'agent' ? { agentOverride: agentOverride.agent } : {}),
    openModalFallback: args.openModalFallback
  })
}
