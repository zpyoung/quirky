import type { EffectiveRecipe, RecipeAction } from '../daemon/ai-recipes'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'

export type { EffectiveRecipe as Recipe, RecipeAction as AiAction }

/** The actions that start a terminal agent to fix, review, or draft a response. */
export type FixAction = Exclude<RecipeAction, 'commitMessage' | 'branchName' | 'conversationName'>
export type NameAction = Extract<RecipeAction, 'branchName' | 'conversationName'>
export const DEFAULT_TEMPLATE = '{basePrompt}'

/** The agent choice that runs `ai-custom-command` instead of a catalog agent. */
export const CUSTOM_AGENT = 'custom'

export const AI_SETTINGS_VIEW_ID = 'view:quirky.git/ai-settings'

/** What a launch from the dialog overrides, and where it saves the result. */
export type LaunchParams = { agent: string; args: string; template: string; launchOptions?: RecipeLaunchOptions | null; save?: 'repo' | 'global' }

/** The recipe of an action is configured when it differs from running the default agent with Orca's prompt. */
export const isConfigured = (recipe: Pick<EffectiveRecipe, 'agent' | 'args' | 'template' | 'launchOptions'>): boolean =>
  recipe.agent !== null ||
  recipe.args.trim() !== '' ||
  recipe.template !== DEFAULT_TEMPLATE ||
  recipe.launchOptions.model !== undefined ||
  Object.keys(recipe.launchOptions.optionValues ?? {}).length > 0
