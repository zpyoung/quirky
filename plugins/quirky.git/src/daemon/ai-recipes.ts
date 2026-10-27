import type { PluginContext, PluginStore, Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'

/** The AI actions that have a recipe, in the order the defaults view lists them. */
export const RECIPE_ACTIONS = ['commitMessage', 'fixCommitFailure', 'fixPushFailure', 'resolveConflicts'] as const
export type RecipeAction = (typeof RECIPE_ACTIONS)[number]

export const DEFAULT_TEMPLATE = '{basePrompt}'

const GLOBAL_SCOPE = 'global'

export type RecipeSource = 'repo' | 'global' | 'default'

/** What an action runs with: each field from the repository's recipe, else the global one, else the default. */
export type EffectiveRecipe = {
  action: RecipeAction
  agent: string | null
  args: string
  template: string
  sources: { agent: RecipeSource; args: RecipeSource; template: RecipeSource }
}

/** One saved recipe; a null field is not set at that scope. */
export type StoredRecipe = { agent: string | null; args: string | null; template: string | null }

const FIELDS = ['agent', 'args', 'template'] as const

const scopeOf = (worktree: Worktree, scope: 'repo' | 'global'): string => (scope === 'repo' ? worktree.repoId : GLOBAL_SCOPE)

/** The `recipes` table: saved AI recipes by scope (`global` or a repo ID) and action. */
export class AiRecipes {
  constructor(
    private readonly store: PluginStore,
    private readonly context: Pick<PluginContext, 'emit'>
  ) {}

  stored(scope: string, action: RecipeAction): StoredRecipe | null {
    return this.store.get<StoredRecipe>('SELECT agent, args, template FROM recipes WHERE scope = ? AND action = ?', scope, action)
  }

  /** The recipe `action` runs with in the repository: each field from its own recipe, else the global one, else the default. */
  effective(action: RecipeAction, repoId: string): EffectiveRecipe {
    const repo = this.stored(repoId, action)
    const global = this.stored(GLOBAL_SCOPE, action)
    const pick = <K extends keyof StoredRecipe>(field: K, fallback: NonNullable<StoredRecipe[K]> | null) => {
      const fromRepo = repo?.[field] ?? null
      if (fromRepo !== null) return { value: fromRepo, source: 'repo' as const }
      const fromGlobal = global?.[field] ?? null
      if (fromGlobal !== null) return { value: fromGlobal, source: 'global' as const }
      return { value: fallback, source: 'default' as const }
    }
    const agent = pick('agent', null)
    const args = pick('args', '')
    const template = pick('template', DEFAULT_TEMPLATE)
    return {
      action,
      agent: agent.value,
      args: args.value ?? '',
      template: template.value ?? DEFAULT_TEMPLATE,
      sources: { agent: agent.source, args: args.source, template: template.source }
    }
  }

  /** Sets the given fields of a saved recipe (a null one clears it) and drops the row once it holds nothing; false when nothing changed. */
  change(scope: string, action: RecipeAction, fields: Partial<StoredRecipe>): boolean {
    const before = this.stored(scope, action)
    const after: StoredRecipe = { agent: before?.agent ?? null, args: before?.args ?? null, template: before?.template ?? null, ...fields }
    if (FIELDS.every((field) => (before?.[field] ?? null) === after[field])) return false
    if (FIELDS.every((field) => after[field] === null)) this.remove(scope, action)
    else {
      this.store.run('INSERT OR REPLACE INTO recipes (scope, action, agent, args, template) VALUES (?, ?, ?, ?, ?)', scope, action, after.agent, after.args, after.template)
    }
    return true
  }

  /** Deletes a saved recipe; false when there was none. */
  remove(scope: string, action: RecipeAction): boolean {
    return this.store.run('DELETE FROM recipes WHERE scope = ? AND action = ?', scope, action).changes > 0
  }

  /** Tells the view and panel that recipes of `repoId` (null: the global ones) changed. */
  announce(repoId: string | null): void {
    this.context.emit('aiChanged', { repoId })
  }
}

/** The recipe action a call names; anything else is refused with reason `unknown-action`. */
export function recipeAction(env: DaemonEnv, value: unknown, allowed: readonly RecipeAction[] = RECIPE_ACTIONS): RecipeAction {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as RecipeAction
  throw env.errors.reasoned('invalid-params', 'unknown-action', `Unknown AI action ${JSON.stringify(value)}. Use ${allowed.join(', ')}.`)
}

/**
 * Saves fields of the recipe of `action` at a scope and announces it when something changed;
 * resolves with whether it wrote.
 */
export function saveRecipe(env: DaemonEnv, worktree: Worktree, action: RecipeAction, scope: 'repo' | 'global', fields: Partial<StoredRecipe>): boolean {
  const saved = env.recipes.change(scopeOf(worktree, scope), action, fields)
  if (saved) env.recipes.announce(scope === 'repo' ? worktree.repoId : null)
  return saved
}

/**
 * The agent a run without a saved or chosen one uses: the default agent, else the first
 * installed, enabled one. Never the shell; none usable is `no-agents`.
 */
export async function pickDefaultAgent(env: DaemonEnv): Promise<string> {
  try {
    const { agent } = (await env.context.call('quirky.agents/pick', { forAgentTab: true })) as { agent: string }
    return agent
  } catch {
    throw env.errors.reasoned('conflict', 'no-agents', 'No enabled AI agents. Configure agents in Settings.')
  }
}

/** The recipe of an action in the worktree's repository, with where each field comes from. */
export function aiRecipe(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = recipeAction(env, params.action)
    const worktree = await env.resolve(params, caller)
    return env.recipes.effective(action, worktree.repoId)
  }
}

/** A param as the stored field it sets: undefined leaves the field, null clears it, and so does an empty `agent` or `template`. */
function storedField(field: (typeof FIELDS)[number], value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (field !== 'args' && value === '') return null
  return String(value)
}

/**
 * Saves the fields given (an empty `agent` or `template` clears it) at `scope`, or deletes the
 * whole recipe there with `reset`. Reports whether anything was written and the recipe now in effect.
 */
export function setAiRecipe(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = recipeAction(env, params.action)
    const worktree = await env.resolve(params, caller)
    const scope = params.scope as 'repo' | 'global'
    let saved: boolean
    if (params.reset === true) {
      saved = env.recipes.remove(scopeOf(worktree, scope), action)
      if (saved) env.recipes.announce(scope === 'repo' ? worktree.repoId : null)
    } else {
      const fields: Partial<StoredRecipe> = {}
      for (const field of FIELDS) {
        const value = storedField(field, params[field])
        if (value !== undefined) fields[field] = value
      }
      saved = saveRecipe(env, worktree, action, scope, fields)
    }
    return { saved, recipe: env.recipes.effective(action, worktree.repoId) }
  }
}
