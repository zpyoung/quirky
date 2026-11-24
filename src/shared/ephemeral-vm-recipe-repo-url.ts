import { stripCredentialsFromMessage } from './git-remote-error'
import type { QuirkyVmRecipe } from './quirky-yaml-hook-types'

export function getProvisionedRootRecipeRepoUrl(
  checkoutMode: QuirkyVmRecipe['checkoutMode'],
  remoteUrl: string | undefined
): string | undefined {
  if (checkoutMode !== 'provisioned-root' || !remoteUrl) {
    return undefined
  }
  return stripCredentialsFromMessage(remoteUrl)
}
