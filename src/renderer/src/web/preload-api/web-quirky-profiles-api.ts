import type { PreloadApi } from '../../../../preload/api-types'
import {
  DEFAULT_LOCAL_QUIRKY_PROFILE_ID,
  createDefaultLocalQuirkyProfile
} from '../../../../shared/quirky-profiles'

export function createWebQuirkyProfilesApi(): Partial<PreloadApi> {
  return {
    quirkyProfiles: {
      list: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_QUIRKY_PROFILE_ID,
          profiles: [createDefaultLocalQuirkyProfile(0)],
          multiProfileUi: false
        }),
      createLocal: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_QUIRKY_PROFILE_ID,
          profiles: [createDefaultLocalQuirkyProfile(0)],
          profile: createDefaultLocalQuirkyProfile(0)
        }),
      switchProfile: () => Promise.resolve({ status: 'already-active' }),
      transferProject: (args) =>
        Promise.resolve({
          status: 'duplicate-target',
          sourceProfileId: args.sourceProfileId,
          targetProfileId: args.targetProfileId,
          sourceRepoId: args.repoId,
          duplicateRepoId: args.repoId
        }),
      findProjectProfiles: async () => ({ projects: [] })
    }
  }
}
