import type { EffectiveRecipe, RecipeAction } from '../daemon/ai-recipes'

export type { EffectiveRecipe as Recipe, RecipeAction as AiAction }

/** The actions that start an agent tab with a prompt about a failure or the conflicts. */
export type FixAction = Exclude<RecipeAction, 'commitMessage'>

export const DEFAULT_TEMPLATE = '{basePrompt}'

/** The agent choice that runs `ai-custom-command` instead of a catalog agent. */
export const CUSTOM_AGENT = 'custom'

export const AI_SETTINGS_VIEW_ID = 'view:quirky.git/ai-settings'

/** What a launch from the dialog overrides, and where it saves the result. */
export type LaunchParams = { agent: string; args: string; template: string; save?: 'repo' | 'global' }

/** The recipe of an action is configured when it differs from running the default agent with Orca's prompt. */
export const isConfigured = (recipe: Pick<EffectiveRecipe, 'agent' | 'args' | 'template'>): boolean =>
  recipe.agent !== null || recipe.args.trim() !== '' || recipe.template !== DEFAULT_TEMPLATE
