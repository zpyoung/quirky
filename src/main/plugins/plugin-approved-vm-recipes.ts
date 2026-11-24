import type { QuirkyVmRecipe } from '../../shared/quirky-yaml-hook-types'
import type { PluginService } from './plugin-service'

export async function getApprovedPluginVmRecipes(
  pluginService?: PluginService
): Promise<QuirkyVmRecipe[]> {
  if (!pluginService) {
    return []
  }
  await pluginService.whenReady()
  return pluginService.contentPacks.vmRecipes.list().map(({ recipe }) => recipe)
}
