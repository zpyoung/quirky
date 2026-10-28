import type { GitStatusEntry, Worktree } from '@quirky/protocol'
import {
  buildFixCommitFailurePrompt,
  buildFixPushFailurePrompt,
  buildResolveConflictsPrompt,
  renderTemplate
} from './ai-prompts'
import {
  parseLaunchOptions,
  pickDefaultAgent,
  recipeAction,
  saveRecipe,
  type EffectiveRecipe,
  type RecipeAction
} from './ai-recipes'
import { sourcePrompt } from './ai-source'
import type { DaemonEnv, Handler } from './env'

type FileEntry = { path: string; status: GitStatusEntry['status']; area: GitStatusEntry['area'] }

/** A commit that a hook or the repository refused: the message tried and the files that were staged. */
export type CommitFailure = { message: string; summary: string; output: string; staged: FileEntry[] }

/** A push that a hook refused, with the branch and every changed file at that time. */
export type PushFailure = { branch: string | null; summary: string; output: string; changed: FileEntry[] }

const FIX_ACTIONS = [
  'fixCommitFailure',
  'fixPushFailure',
  'resolveConflicts',
  'branchSummary',
  'pullRequestDetails',
  'pullRequestReview',
  'reviewConversation'
] as const satisfies readonly RecipeAction[]
type FixAction = (typeof FIX_ACTIONS)[number]

const EMPTY_PROMPT: Record<FixAction, string> = {
  fixCommitFailure: 'Commit failure prompt is empty. Update Source Control AI settings.',
  fixPushFailure: 'Push failure prompt is empty. Update Source Control AI settings.',
  resolveConflicts: 'Conflict resolution prompt is empty. Update Source Control AI settings.',
  branchSummary: 'Branch summary prompt is empty. Update Source Control AI settings.',
  pullRequestDetails: 'Pull request details prompt is empty. Update Source Control AI settings.',
  pullRequestReview: 'Pull request review prompt is empty. Update Source Control AI settings.',
  reviewConversation: 'Review conversation prompt is empty. Update Source Control AI settings.'
}

/** The latest refused commit and push of each worktree, kept in memory until one succeeds. */
export class HeldFailures {
  private readonly commits = new Map<string, CommitFailure>()
  private readonly pushes = new Map<string, PushFailure>()

  commit(worktreeId: string): CommitFailure | undefined {
    return this.commits.get(worktreeId)
  }

  push(worktreeId: string): PushFailure | undefined {
    return this.pushes.get(worktreeId)
  }

  holdCommit(worktreeId: string, failure: CommitFailure): void {
    this.commits.set(worktreeId, failure)
  }

  holdPush(worktreeId: string, failure: PushFailure): void {
    this.pushes.set(worktreeId, failure)
  }

  clearCommit(worktreeId: string): void {
    this.commits.delete(worktreeId)
  }

  clearPush(worktreeId: string): void {
    this.pushes.delete(worktreeId)
  }
}

const fileEntries = (entries: GitStatusEntry[]): FileEntry[] => entries.map(({ path, status, area }) => ({ path, status, area }))

const dataOf = (error: unknown): { reason?: unknown; summary?: unknown; output?: unknown } => (error as { data?: Record<string, unknown> } | null)?.data ?? {}

/**
 * Remembers a refused commit for AI Fix: `failure` is what `commitFailure` made of the git
 * error, `message` what was attempted. Reads the staged files now, before the caller rethrows;
 * never throws itself, so the caller's error is the one that surfaces.
 */
export async function holdCommitFailure(env: DaemonEnv, worktree: Worktree, message: string, failure: unknown): Promise<void> {
  const { summary, output } = dataOf(failure)
  if (typeof summary !== 'string' || typeof output !== 'string') return
  try {
    const status = await env.readStatus(worktree)
    env.failures.holdCommit(worktree.id, { message, summary, output, staged: fileEntries(status.entries.filter((entry) => entry.area === 'staged')) })
  } catch {
    env.failures.holdCommit(worktree.id, { message, summary, output, staged: [] })
  }
}

/** Remembers a push that a hook refused (reason `lint` or `hook`), with the branch and changed files; other failures are not held. */
export async function holdPushFailure(env: DaemonEnv, worktree: Worktree, failure: unknown): Promise<void> {
  const { reason, summary, output } = dataOf(failure)
  if ((reason !== 'lint' && reason !== 'hook') || typeof summary !== 'string' || typeof output !== 'string') return
  try {
    const status = await env.readStatus(worktree)
    env.failures.holdPush(worktree.id, { branch: status.branch, summary, output, changed: fileEntries(status.entries) })
  } catch {
    env.failures.holdPush(worktree.id, { branch: null, summary, output, changed: [] })
  }
}

function fixAction(env: DaemonEnv, value: unknown): FixAction {
  return recipeAction(env, value, FIX_ACTIONS) as FixAction
}

/** Builds the prompt from the held failure, conflicts, current branch compare or fresh hosted source. */
async function basePrompt(env: DaemonEnv, worktree: Worktree, action: FixAction): Promise<string> {
  if (action === 'fixCommitFailure') {
    const held = env.failures.commit(worktree.id)
    if (!held) throw env.errors.reasoned('conflict', 'no-failure', 'There is no commit failure to fix.')
    return buildFixCommitFailurePrompt({ summary: held.summary, error: held.output, entries: held.staged, worktreePath: worktree.path, commitMessage: held.message })
  }
  if (action === 'fixPushFailure') {
    const held = env.failures.push(worktree.id)
    if (!held) throw env.errors.reasoned('conflict', 'no-failure', 'There is no push failure to fix.')
    return buildFixPushFailurePrompt({ summary: held.summary, error: held.output, entries: held.changed, worktreePath: worktree.path, branchName: held.branch })
  }
  if (action === 'branchSummary' || action === 'pullRequestDetails' || action === 'pullRequestReview' || action === 'reviewConversation') {
    return sourcePrompt(env, worktree, action)
  }
  const status = await env.readStatus(worktree)
  const unresolved = status.entries.filter((entry) => entry.area === 'conflicts' && entry.conflict?.state === 'unresolved')
  if (unresolved.length === 0) throw env.errors.reasoned('conflict', 'no-conflicts', 'There are no conflicts to resolve.')
  return buildResolveConflictsPrompt({ conflictOperation: status.operation, entries: unresolved, worktreePath: worktree.path })
}

const given = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

type AgentEntry = { id: string; label: string; installed: boolean; enabled: boolean }

/** The agent to launch: the one asked for, else the recipe's (which must still be usable), else the default or first usable one. */
async function chooseAgent(env: DaemonEnv, asked: string | undefined, recipe: EffectiveRecipe): Promise<string> {
  const wanted = asked ?? recipe.agent
  if (wanted === null) return pickDefaultAgent(env)
  const { agents } = (await env.context.call('quirky.agents/list', {})) as { agents: AgentEntry[] }
  const entry = agents.find((candidate) => candidate.id === wanted)
  if (entry?.installed && entry.enabled) return wanted
  if (asked === undefined) {
    throw env.errors.reasoned('conflict', 'agent-unavailable', 'Saved AI agent is unavailable. Use Customize launch to choose another agent.')
  }
  throw env.errors.reasoned('invalid-params', 'agent-unavailable', `${entry?.label ?? wanted} is not installed or enabled.`)
}

type TabbedGroup = { kind: 'group'; id: string; tabs: { root: PaneNode }[] }
type PaneNode = { kind: 'pane'; session: string } | { kind: 'split'; first: PaneNode }
type GroupNode = TabbedGroup | { kind: 'split'; first: GroupNode; second: GroupNode }

function findGroup(node: GroupNode, id: string): TabbedGroup | null {
  if (node.kind === 'group') return node.id === id ? node : null
  return findGroup(node.first, id) ?? findGroup(node.second, id)
}

/** The session of the tab `quirky.terminal/newTab` appended last to the workspace's active group. */
function newestSession(workspace: { root: GroupNode; activeGroup: string }): string | null {
  let node = findGroup(workspace.root, workspace.activeGroup)?.tabs.at(-1)?.root
  while (node && node.kind === 'split') node = node.first
  return node?.session ?? null
}


/**
 * Shows the prompt aiFix would send and the provider-compatible recipe in effect; starts nothing.
 */
export function aiFixPreview(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = fixAction(env, params.action)
    const worktree = await env.resolve(params, caller)
    const stored = env.recipes.effective(action, worktree.repoId)
    let provider = stored.agent
    if (provider === null) {
      try {
        provider = await pickDefaultAgent(env)
      } catch {
        provider = null
      }
    }
    const recipe = env.recipes.effective(action, worktree.repoId, provider)
    return { prompt: renderTemplate(recipe.template, { basePrompt: await basePrompt(env, worktree, action) }), recipe }
  }
}

/**
 * Opens a new agent tab with a prompt sourced from the held failure, conflicts, current branch
 * comparison, or fresh public pull-request details, patches and conversation. Launch options still
 * flow through the terminal owner; this method does not pre-resolve or mutate hosted comments.
 */
export function aiFix(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = fixAction(env, params.action)
    const worktree = await env.resolve(params, caller)
    const base = await basePrompt(env, worktree, action)
    const savedRecipe = env.recipes.effective(action, worktree.repoId)
    const agent = await chooseAgent(env, given(params.agent), savedRecipe)
    const recipe = env.recipes.effective(action, worktree.repoId, agent)
    const launchOptions = parseLaunchOptions(
      env,
      Object.hasOwn(params, 'launchOptions') ? params.launchOptions : recipe.launchOptions
    )
    const args = typeof params.args === 'string' ? params.args : recipe.args
    const template = typeof params.template === 'string' ? params.template : recipe.template
    const prompt = renderTemplate(template, { basePrompt: base })
    if (prompt.trim() === '') throw env.errors.reasoned('invalid-params', 'empty-prompt', EMPTY_PROMPT[action])

    const choices = launchOptions ?? {}
    const optionValues = choices.optionValues ?? {}
    const { workspace } = (await env.context.call('quirky.terminal/newTab', {
      workspace: worktree.id,
      agent,
      prompt,
      ...(args.trim() === '' ? {} : { extraArgs: args }),
      ...(choices.model === undefined ? {} : { model: choices.model }),
      ...(Object.keys(optionValues).length === 0 ? {} : { options: optionValues })
    })) as { workspace: { root: GroupNode; activeGroup: string } }
    const session = newestSession(workspace)
    if (session === null) throw env.errors.reasoned('conflict', 'not-started', 'The agent tab did not start.')

    const saved =
      params.save === undefined
        ? false
        : saveRecipe(env, worktree, action, params.save, { agent, args, template, launchOptions }, agent)
    return { session, agent, prompt, saved }
  }
}
