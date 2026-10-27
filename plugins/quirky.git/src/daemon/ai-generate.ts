import { randomUUID } from 'node:crypto'
import { readStagedContext } from './ai-context'
import { cleanGeneratedMessage, splitCommitMessage } from './ai-output'
import { buildCommitMessagePrompt, renderTemplate } from './ai-prompts'
import { pickDefaultAgent } from './ai-recipes'
import type { DaemonEnv, Handler } from './env'

const CUSTOM_AGENT = 'custom'

type Lane = { requestId: string; cancelled: boolean; started: boolean }

/** The commit message generations that are running, one per worktree. */
export class GenerationLanes {
  private readonly lanes = new Map<string, Lane>()

  get(worktreeId: string): Lane | undefined {
    return this.lanes.get(worktreeId)
  }

  open(worktreeId: string, requestId: string): Lane {
    const lane: Lane = { requestId, cancelled: false, started: false }
    this.lanes.set(worktreeId, lane)
    return lane
  }

  close(worktreeId: string): void {
    this.lanes.delete(worktreeId)
  }
}

const given = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/**
 * Asks an AI agent for a commit message for what is staged: the agent, template and arguments of
 * the commit message recipe (each overridable for this run), the prompt Orca builds, one run of
 * `quirky.agents/generate`, and its output cleaned and split into subject and body. The commit
 * box is the caller's to fill; nothing is staged, committed or changed here. One run per worktree.
 */
export function generateCommitMessage(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    if (env.lanes.get(worktree.id)) throw env.errors.reasoned('conflict', 'busy', 'A commit message is already being generated.')
    const lane = env.lanes.open(worktree.id, given(params.requestId) ?? randomUUID())
    try {
      const recipe = env.recipes.effective('commitMessage', worktree.repoId)
      const agent = given(params.agent) ?? recipe.agent ?? (await pickDefaultAgent(env))
      let args = typeof params.args === 'string' ? params.args : recipe.args
      if (agent === CUSTOM_AGENT) {
        args = String(env.context.getSetting('ai-custom-command') ?? '').trim()
        if (args === '') throw env.errors.reasoned('invalid-params', 'no-custom-command', 'Set a custom command in Source Control AI settings.')
      }

      const staged = await readStagedContext(env, worktree)
      if (staged === null) throw env.errors.reasoned('conflict', 'nothing-staged', 'No staged changes to summarize.')
      const basePrompt = buildCommitMessagePrompt({ branch: staged.branch, stagedFiles: staged.stagedFiles, patch: staged.patch, patchOmitted: staged.patchOmitted })
      const prompt = renderTemplate(typeof params.template === 'string' ? params.template : recipe.template, {
        basePrompt,
        branch: staged.branch,
        stagedFiles: staged.stagedFiles,
        stagedPatch: staged.patch,
        linkedIssue: ''
      })
      if (prompt.trim() === '') {
        throw env.errors.reasoned('invalid-params', 'empty-prompt', 'Commit message prompt is empty. Update Source Control AI settings.')
      }

      if (lane.cancelled) throw env.errors.reasoned('conflict', 'cancelled', 'Generation was stopped.')
      lane.started = true
      const generated = (await env.context.call('quirky.agents/generate', {
        agent,
        prompt,
        requestId: lane.requestId,
        worktree: worktree.id,
        ...(args.trim() === '' ? {} : { args })
      })) as { text: string; agent: string }
      return { ...splitCommitMessage(cleanGeneratedMessage(generated.text, { custom: agent === CUSTOM_AGENT })), agent: generated.agent }
    } finally {
      env.lanes.close(worktree.id)
    }
  }
}

/** Stops the worktree's running commit message generation, agent and children included; false when none is running. */
export function cancelGenerate(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const lane = env.lanes.get(worktree.id)
    if (!lane) return { cancelled: false }
    lane.cancelled = true
    if (!lane.started) return { cancelled: true }
    const stopped = (await env.context.call('quirky.agents/cancelGenerate', { requestId: lane.requestId })) as { cancelled: boolean }
    return { cancelled: stopped.cancelled }
  }
}
