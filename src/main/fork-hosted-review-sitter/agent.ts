import {
  buildHostedReviewAgentPrompt,
  type HostedReviewAgentLaunchInput,
  type HostedReviewAgentLaunchResult
} from '../../shared/fork-hosted-review-sitter/agent-prompt'
import { sanitizeWorktreeDisplayName } from '../ipc/worktree-display-name'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'

/**
 * Human-only entry shared by the manual "Fix Broken Checks" surfaces.
 * Watcher actions must use ExecuteContext.dispatchWorker instead.
 */
export async function launchHostedReviewSitterFixAgent(
  runtime: QuirkyRuntimeService,
  store: Store,
  input: HostedReviewAgentLaunchInput
): Promise<HostedReviewAgentLaunchResult> {
  if (!store.getRepo(input.repoId) || !input.worktreeId) {
    throw new Error('An explicit repository and workspace are required to launch a checks agent.')
  }
  if (!input.basePrompt.trim()) {
    throw new Error('Fix checks prompt is empty.')
  }
  const workspace = await runtime.showManagedWorktree(`id:${input.worktreeId}`)
  if (workspace.repoId !== input.repoId) {
    throw new Error('The selected workspace does not belong to the explicit repository.')
  }
  runtime.validateOrchestrationAgentLauncher(input.agent)
  const prompt = buildHostedReviewAgentPrompt({
    task: 'fix-checks',
    basePrompt: input.basePrompt,
    unattended: false
  })
  const terminal = await runtime.launchAgentTerminal(`id:${input.worktreeId}`, {
    agent: input.agent,
    prompt,
    title: sanitizeWorktreeDisplayName(input.title ?? '') ?? 'Fix broken hosted review checks'
  })
  return { handle: terminal.handle, worktreeId: terminal.worktreeId }
}
