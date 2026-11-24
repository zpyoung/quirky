import { createProfileStateStoreForStartup } from '../persistence/profile-state/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../persistence/profile-state/profile-state-store-factory'
import {
  ensureActiveQuirkyProfile,
  initQuirkyProfilePaths
} from '../quirky-profiles/profile-index-store'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { initQuirkydHeldFenceTokenFile } from '../ssh/quirkyd-held-fence-tokens'

export type QuirkydProfileStateProfile = {
  dataFile: string
  stateDatabaseFile: string
  profile: { id: string }
}

export type QuirkydProfileStateStartup = {
  store: ProfileStateStoreFactoryResult['store']
  authority: {
    backend: ProfileStateStoreFactoryResult['backend']
    classification: ProfileStateStoreFactoryResult['classification']
    authority_mode: 'sqlite-established'
    runtime: 'quirkyd'
    migrated: boolean
  }
}

/** Build the headless Store and publish its authority selection at one Node-only seam. */
export async function createQuirkydProfileStateStartup(
  userDataPath: string
): Promise<QuirkydProfileStateStartup> {
  initQuirkyProfilePaths()
  const profile = ensureActiveQuirkyProfile(userDataPath)
  // Why a real Store: without one, persistence-backed RPCs throw and `store?.x ?? []` reads answer
  // "empty", so a server that pairs and lists nothing looks healthy. As the runtime authority,
  // quirkyd must not load as 'desktop', which would orphan its own scheduled automations.
  const result = await createProfileStateStoreForStartup({
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'quirkyd',
    storageAuthority: 'runtime'
  })
  const authority = {
    backend: result.backend,
    classification: result.classification,
    authority_mode: 'sqlite-established' as const,
    runtime: 'quirkyd' as const,
    migrated: result.migrated
  }
  try {
    initSshHostKeyStoreFile(profile.dataFile)
    initQuirkydHeldFenceTokenFile(profile.dataFile)
    return { store: result.store, authority }
  } catch (error) {
    try {
      await result.store.freezeWritesAsync()
    } catch (closeError) {
      console.error(
        '[persistence] Failed to close profile persistence after startup failure:',
        closeError
      )
    }
    throw error
  }
}
