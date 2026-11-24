import type { AppState } from '../store/types'

type AppRootSurfaceSettingsState = Pick<AppState, 'settings'>

export function selectAppRootSurfaceVoiceEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.voice?.enabled === true
}

export function selectAppRootSurfacePetEnabled(state: AppRootSurfaceSettingsState): boolean {
  return state.settings?.experimentalPet === true
}
