import { getEphemeralVmRecipeResultCheckoutMode } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { QuirkyVmRecipe } from './quirky-yaml-hook-types'

export function getEphemeralVmRecipeResultSchemaVersion(recipe: QuirkyVmRecipe): 1 | 2 {
  return recipe.checkoutMode === 'provisioned-root' ? 2 : 1
}

export function getEphemeralVmRecipeCheckoutModeError(
  recipe: QuirkyVmRecipe,
  result: EphemeralVmRecipeResult
): string | null {
  const configuredMode = recipe.checkoutMode ?? 'quirky-worktree'
  const resultMode = getEphemeralVmRecipeResultCheckoutMode(result)
  if (configuredMode === resultMode) {
    return null
  }
  return configuredMode === 'provisioned-root'
    ? 'Provisioned-root recipes must return schemaVersion 2 with checkoutMode "provisioned-root".'
    : 'Recipe result requests provisioned-root checkout, but the recipe is not configured for it.'
}
