import type { PluginContext, PluginStore, Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import type { RecipeLaunchOptions } from './recipe-options'

/** The AI actions that have a recipe, in the order the defaults view lists them. */
export const RECIPE_ACTIONS = [
  'commitMessage',
  'fixCommitFailure',
  'fixPushFailure',
  'resolveConflicts',
  'branchSummary',
  'pullRequestDetails',
  'pullRequestReview',
  'reviewConversation'
] as const
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
  launchOptions: RecipeLaunchOptions
  sources: { agent: RecipeSource; args: RecipeSource; template: RecipeSource; launchOptions: RecipeSource }
}

/** One saved recipe; a null field is not set at that scope. */
export type StoredRecipe = { agent: string | null; args: string | null; template: string | null; launchOptions: RecipeLaunchOptions | null }
type StoredRecipeRow = StoredRecipe & { launchOptionsAgent: string | null }

const FIELDS = ['agent', 'args', 'template', 'launchOptions'] as const
const TEXT_FIELDS = ['agent', 'args', 'template'] as const

const scopeOf = (worktree: Worktree, scope: 'repo' | 'global'): string => (scope === 'repo' ? worktree.repoId : GLOBAL_SCOPE)
const hasLaunchChoices = (value: RecipeLaunchOptions): boolean =>
  value.model !== undefined || Object.keys(value.optionValues ?? {}).length > 0

const sameValue = (left: unknown, right: unknown): boolean =>
  left === right || (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null && JSON.stringify(left) === JSON.stringify(right))

/** The `recipes` table: saved AI recipes by scope (`global` or a repo ID) and action. */
export class AiRecipes {
  constructor(
    private readonly store: PluginStore,
    private readonly context: Pick<PluginContext, 'emit'>
  ) {}

  stored(scope: string, action: RecipeAction): StoredRecipeRow | null {
    const row = this.store.get<{ agent: string | null; args: string | null; template: string | null; launch_options: string | null; launch_options_agent: string | null }>(
      'SELECT agent, args, template, launch_options, launch_options_agent FROM recipes WHERE scope = ? AND action = ?',
      scope,
      action
    )
    if (!row) return null
    return {
      agent: row.agent,
      args: row.args,
      template: row.template,
      launchOptions: row.launch_options === null ? null : (JSON.parse(row.launch_options) as RecipeLaunchOptions),
      launchOptionsAgent: row.launch_options_agent
    }
  }

  /** The recipe `action` runs with in the repository; options only cross scopes for their saved agent. */
  effective(action: RecipeAction, repoId: string, providerAgent?: string | null): EffectiveRecipe {
    const repo = this.stored(repoId, action)
    const global = this.stored(GLOBAL_SCOPE, action)
    const pick = <K extends 'agent' | 'args' | 'template'>(field: K, fallback: NonNullable<StoredRecipe[K]> | null) => {
      const fromRepo = repo?.[field] ?? null
      if (fromRepo !== null) return { value: fromRepo, source: 'repo' as const }
      const fromGlobal = global?.[field] ?? null
      if (fromGlobal !== null) return { value: fromGlobal, source: 'global' as const }
      return { value: fallback, source: 'default' as const }
    }
    const agent = pick('agent', null)
    const args = pick('args', '')
    const template = pick('template', DEFAULT_TEMPLATE)
    const provider = providerAgent === undefined ? agent.value : providerAgent
    const launchOptionsFor = (record: StoredRecipeRow | null) =>
      record?.launchOptions !== null &&
      record?.launchOptions !== undefined &&
      (!hasLaunchChoices(record.launchOptions) || (provider !== null && record.launchOptionsAgent === provider))
    const launchOptions = launchOptionsFor(repo)
      ? { value: repo!.launchOptions!, source: 'repo' as const }
      : launchOptionsFor(global)
        ? { value: global!.launchOptions!, source: 'global' as const }
        : { value: {}, source: 'default' as const }
    return {
      action,
      agent: agent.value,
      args: args.value ?? '',
      template: template.value ?? DEFAULT_TEMPLATE,
      launchOptions: launchOptions.value,
      sources: { agent: agent.source, args: args.source, template: template.source, launchOptions: launchOptions.source }
    }
  }

  /** Sets the given fields of a saved recipe (null clears a field); false when nothing changed. */
  change(scope: string, action: RecipeAction, fields: Partial<StoredRecipe>, launchOptionsAgent: string | null = null): boolean {
    const before = this.stored(scope, action)
    const after: StoredRecipeRow = {
      agent: before?.agent ?? null,
      args: before?.args ?? null,
      template: before?.template ?? null,
      launchOptions: before?.launchOptions ?? null,
      ...fields,
      launchOptionsAgent:
        fields.launchOptions === undefined
          ? before?.launchOptionsAgent ?? null
          : fields.launchOptions === null
            ? null
            : launchOptionsAgent
    }
    if (
      FIELDS.every((field) => sameValue(before?.[field] ?? null, after[field])) &&
      (fields.launchOptions === undefined || (before?.launchOptionsAgent ?? null) === after.launchOptionsAgent)
    ) {
      return false
    }
    if (FIELDS.every((field) => after[field] === null)) this.remove(scope, action)
    else {
      this.store.run(
        'INSERT OR REPLACE INTO recipes (scope, action, agent, args, template, launch_options, launch_options_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
        scope,
        action,
        after.agent,
        after.args,
        after.template,
        after.launchOptions === null ? null : JSON.stringify(after.launchOptions),
        after.launchOptionsAgent
      )
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

type AgentOptions = { supported: boolean }

function invalidLaunchOptions(env: DaemonEnv, message: string): never {
  throw env.errors.reasoned('invalid-params', 'invalid-launch-options', message)
}

export function parseLaunchOptions(env: DaemonEnv, value: unknown): RecipeLaunchOptions | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object' || Array.isArray(value)) return invalidLaunchOptions(env, 'launchOptions must be an object or null.')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => key !== 'model' && key !== 'optionValues')) {
    return invalidLaunchOptions(env, 'launchOptions only accepts model and optionValues.')
  }

  const result: RecipeLaunchOptions = {}
  if (Object.hasOwn(raw, 'model')) {
    if (typeof raw.model !== 'string' || raw.model.trim() === '') return invalidLaunchOptions(env, 'launchOptions.model must be a non-empty string.')
    result.model = raw.model.trim()
  }
  if (Object.hasOwn(raw, 'optionValues')) {
    if (typeof raw.optionValues !== 'object' || raw.optionValues === null || Array.isArray(raw.optionValues)) {
      return invalidLaunchOptions(env, 'launchOptions.optionValues must be an object.')
    }
    const entries = Object.entries(raw.optionValues)
    if (entries.length > 16) return invalidLaunchOptions(env, 'launchOptions.optionValues accepts at most 16 entries.')
    const optionValues: Record<string, string | boolean> = Object.create(null)
    for (const [id, selected] of entries) {
      if (id.length > 64 || id === 'model' || id === '__proto__' || id === 'constructor' || id === 'prototype') {
        return invalidLaunchOptions(env, `launchOptions.optionValues has an invalid option ID: ${id}.`)
      }
      if (typeof selected !== 'string' && typeof selected !== 'boolean') {
        return invalidLaunchOptions(env, `launchOptions.optionValues.${id} must be a string or boolean.`)
      }
      optionValues[id] = selected
    }
    if (entries.length > 0) result.optionValues = optionValues
  }
  return result
}

/** Validates provider-specific picks through the public catalog and resolver before persistence or launch. */
export async function validateRecipeLaunchOptions(env: DaemonEnv, agent: string, value: unknown): Promise<RecipeLaunchOptions | null> {
  const options = parseLaunchOptions(env, value)
  if (options === null) return null
  if (options === undefined) return {}
  if (!hasLaunchChoices(options)) return options
  if (agent === 'custom') return invalidLaunchOptions(env, 'Custom commands do not support catalog model or option picks.')

  const catalog = (await env.context.call('quirky.agents/options', { agent })) as AgentOptions
  if (!catalog.supported) return invalidLaunchOptions(env, `${agent} does not support catalog model or option picks.`)
  await env.context.call('quirky.agents/resolveLaunch', {
    agent,
    ...(options.model === undefined ? {} : { model: options.model }),
    options: options.optionValues ?? {}
  })
  return options
}

async function defaultAgentOrNull(env: DaemonEnv): Promise<string | null> {
  try {
    return await pickDefaultAgent(env)
  } catch {
    return null
  }
}

async function providerForScope(
  env: DaemonEnv,
  worktree: Worktree,
  action: RecipeAction,
  scope: 'repo' | 'global',
  agent: string | null | undefined
): Promise<string | null> {
  const selectedAtScope = agent === undefined ? env.recipes.stored(scopeOf(worktree, scope), action)?.agent ?? null : agent
  const inherited = scope === 'repo' && selectedAtScope === null ? env.recipes.stored(GLOBAL_SCOPE, action)?.agent ?? null : selectedAtScope
  return inherited ?? defaultAgentOrNull(env)
}

async function effectiveProvider(env: DaemonEnv, recipe: EffectiveRecipe): Promise<string | null> {
  return recipe.agent ?? defaultAgentOrNull(env)
}

/**
 * Saves fields of the recipe of `action` at a scope and announces it when something changed;
 * resolves with whether it wrote.
 */
export function saveRecipe(
  env: DaemonEnv,
  worktree: Worktree,
  action: RecipeAction,
  scope: 'repo' | 'global',
  fields: Partial<StoredRecipe>,
  launchOptionsAgent: string | null = null
): boolean {
  const saved = env.recipes.change(scopeOf(worktree, scope), action, fields, launchOptionsAgent)
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
    const recipe = env.recipes.effective(action, worktree.repoId)
    return env.recipes.effective(action, worktree.repoId, await effectiveProvider(env, recipe))
  }
}

/** A recipe field; undefined leaves it, null clears it, and empty agent/template values clear it. */
function storedTextField(env: DaemonEnv, field: (typeof TEXT_FIELDS)[number], value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw env.context.error('invalid-params', `${field} must be a string or null.`)
  if (field !== 'args' && value === '') return null
  return value
}

/**
 * Saves recipe fields at a scope or deletes that scope with reset. Launch options are checked
 * against the selected provider before any field is persisted.
 */
export function setAiRecipe(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = recipeAction(env, params.action)
    const worktree = await env.resolve(params, caller)
    const scope = params.scope as 'repo' | 'global'
    let saved: boolean
    if (params.reset === true) {
      const launchOptions = parseLaunchOptions(env, params.launchOptions)
      if (launchOptions !== undefined && launchOptions !== null && hasLaunchChoices(launchOptions)) {
        const provider = await providerForScope(env, worktree, action, scope, undefined)
        if (provider === null) return invalidLaunchOptions(env, 'Choose an installed agent before validating model or option picks.')
        await validateRecipeLaunchOptions(env, provider, launchOptions)
      }
      saved = env.recipes.remove(scopeOf(worktree, scope), action)
      if (saved) env.recipes.announce(scope === 'repo' ? worktree.repoId : null)
    } else {
      const fields: Partial<StoredRecipe> = {}
      for (const field of TEXT_FIELDS) {
        const value = storedTextField(env, field, params[field])
        if (value !== undefined) fields[field] = value
      }

      const launchOptions = parseLaunchOptions(env, params.launchOptions)
      let launchOptionsAgent: string | null = null
      if (launchOptions !== undefined) {
        fields.launchOptions = launchOptions
        if (launchOptions !== null) {
          launchOptionsAgent = await providerForScope(env, worktree, action, scope, fields.agent)
          if (hasLaunchChoices(launchOptions)) {
            if (launchOptionsAgent === null) return invalidLaunchOptions(env, 'Choose an installed agent before saving model or option picks.')
            fields.launchOptions = await validateRecipeLaunchOptions(env, launchOptionsAgent, launchOptions)
          }
        }
      } else if (fields.agent !== undefined) {
        const existing = env.recipes.stored(scopeOf(worktree, scope), action)
        const targetAgent = await providerForScope(env, worktree, action, scope, fields.agent)
        if (
          existing?.launchOptions !== null &&
          existing?.launchOptions !== undefined &&
          hasLaunchChoices(existing.launchOptions) &&
          existing.launchOptionsAgent !== targetAgent
        ) {
          fields.launchOptions = null
        }
      }

      saved = env.recipes.change(scopeOf(worktree, scope), action, fields, launchOptionsAgent)
      if (saved) env.recipes.announce(scope === 'repo' ? worktree.repoId : null)
    }
    const current = env.recipes.effective(action, worktree.repoId)
    return { saved, recipe: env.recipes.effective(action, worktree.repoId, await effectiveProvider(env, current)) }
  }
}
