import type { PluginContext, UiPluginContext } from '@quirky/protocol'
import type { BrowserProfile } from '../profiles/store'
import type { PaneTab } from '../pane-contract'

export type BrowserIdentityMode = 'clean' | 'native'
export type ProfileUsage = { profile: BrowserProfile; active: boolean }
export type PreferencesState = {
  profiles: ProfileUsage[]
  identity: { selected: BrowserIdentityMode; active: BrowserIdentityMode; restartRequired: boolean; nativeSupported: false }
  imports: { available: false; reason: string }
  localhostLabels: { available: false; reason: string }
}
export type PreferencesAdapters = {
  listProfiles(): BrowserProfile[]
  listPanes(): PaneTab[]
  listPageProfiles(): string[]
  setPaneProfile(pane: string, profile: string): Promise<unknown>
  clearProfile(profile: string, remove: boolean): Promise<void>
}
export type PreferencesController = { deactivate(): void }
export type BrowserPreferencesProps = { context: UiPluginContext; pane?: PaneTab; onError(message: string): void }
export type BrowserLinkRequest = { url: string; worktree: string; shift?: boolean; modifier?: boolean }
export type BrowserLinkResult = { route: 'app' | 'external'; pane?: string }
export type RegisterPreferences = (context: PluginContext, adapters: PreferencesAdapters) => PreferencesController
