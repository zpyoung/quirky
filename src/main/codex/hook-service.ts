import { CodexHookService } from './codex-hook-service-implementation'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { getManagedScript } from './codex-hook-script'

export type { CodexManagedHookInstallMaterial } from './codex-hook-definition'
export { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
export { CodexHookService }

export const codexHookService = new CodexHookService()

export const _internals = {
  cleanupLegacySystemManagedHooks,
  getManagedScript
}
