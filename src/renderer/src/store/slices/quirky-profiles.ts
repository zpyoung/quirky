import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  QuirkyProfileSummary,
  SwitchQuirkyProfileResult,
  TransferQuirkyProfileProjectArgs,
  TransferQuirkyProfileProjectResult
} from '../../../../shared/quirky-profiles'
import type { AppState } from '../types'

export type QuirkyProfilesSlice = {
  quirkyProfiles: QuirkyProfileSummary[]
  activeQuirkyProfileId: string | null
  quirkyProfilesMultiProfileUi: boolean
  quirkyProfilesLoading: boolean
  quirkyProfileSwitching: boolean
  fetchQuirkyProfiles: () => Promise<void>
  createLocalQuirkyProfile: (name?: string) => Promise<QuirkyProfileSummary | null>
  switchQuirkyProfile: (profileId: string) => Promise<SwitchQuirkyProfileResult | null>
  transferQuirkyProfileProject: (
    args: TransferQuirkyProfileProjectArgs
  ) => Promise<TransferQuirkyProfileProjectResult | null>
}

export const createQuirkyProfilesSlice: StateCreator<AppState, [], [], QuirkyProfilesSlice> = (
  set,
  get
) => ({
  quirkyProfiles: [],
  activeQuirkyProfileId: null,
  quirkyProfilesMultiProfileUi: false,
  quirkyProfilesLoading: false,
  quirkyProfileSwitching: false,

  fetchQuirkyProfiles: async () => {
    set({ quirkyProfilesLoading: true })
    try {
      const state = await window.api.quirkyProfiles.list()
      set({
        activeQuirkyProfileId: state.activeProfileId,
        quirkyProfiles: state.profiles,
        quirkyProfilesMultiProfileUi: state.multiProfileUi,
        quirkyProfilesLoading: false
      })
    } catch (err) {
      console.error('Failed to fetch Quirky profiles:', err)
      set({ quirkyProfilesLoading: false })
    }
  },

  createLocalQuirkyProfile: async (name) => {
    try {
      const state = await window.api.quirkyProfiles.createLocal({ name })
      set({
        activeQuirkyProfileId: state.activeProfileId,
        quirkyProfiles: state.profiles
      })
      return state.profile
    } catch (err) {
      console.error('Failed to create Quirky profile:', err)
      toast.error(
        translate('auto.store.slices.quirky.profiles.612f7f6861', 'Failed to create profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  switchQuirkyProfile: async (profileId) => {
    if (!profileId || profileId === get().activeQuirkyProfileId) {
      return { status: 'already-active' }
    }
    set({ quirkyProfileSwitching: true })
    try {
      const result = await window.api.quirkyProfiles.switchProfile({ profileId })
      if (result?.status !== 'relaunching') {
        // Why: only a relaunch may keep the switcher locked; a stale
        // "already-active" answer would otherwise disable it forever.
        set({ quirkyProfileSwitching: false })
      }
      return result
    } catch (err) {
      console.error('Failed to switch Quirky profile:', err)
      set({ quirkyProfileSwitching: false })
      toast.error(
        translate('auto.store.slices.quirky.profiles.7d4bc516ee', 'Failed to switch profile'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  transferQuirkyProfileProject: async (args) => {
    try {
      const result = await window.api.quirkyProfiles.transferProject(args)
      if (result.status === 'duplicate-target') {
        toast.error(
          translate(
            'auto.store.slices.quirky.profiles.f518e89aa5',
            'Project already exists in that profile'
          )
        )
      }
      if (result.status === 'transferred' && result.willRelaunch) {
        set({ quirkyProfileSwitching: true })
      }
      return result
    } catch (err) {
      console.error('Failed to transfer Quirky profile project:', err)
      toast.error(
        translate('auto.store.slices.quirky.profiles.f03ae7f27b', 'Failed to transfer project'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  }
})
