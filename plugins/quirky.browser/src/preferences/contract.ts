import type { PluginContext, UiPluginContext } from '@quirky/protocol'
import type { BrowserProfile } from '../profiles/store'
import type { PaneTab } from '../pane-contract'
import type { LocalhostLabelRoute } from '../localhost-labels/proxy'

export type BrowserIdentityMode = 'clean' | 'native'
export type ProfileUsage = { profile: BrowserProfile; active: boolean }
export type PreferencesState = {
  profiles: ProfileUsage[]
  identity: { selected: BrowserIdentityMode; active: BrowserIdentityMode; restartRequired: boolean; nativeSupported: false }
  imports: { available: true; destination: 'managed-chrome'; nativeSupported: false; reason: string }
  localhostLabels: { available: true; enabled: boolean; reason: string; labels: LocalhostLabelRoute[] }
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
export type CookieImportPanelProps = {
  context: UiPluginContext
  imports: PreferencesState['imports'] | null
  destination: { id: string; label: string }
  loadError?: string | null
  onHideHint?(): void
  onError(message: string): void
  onImported(): Promise<void>
}
export type LocalhostLabelRequest = { url: string; worktree: string }
export type BrowserLinkRequest = { url: string; worktree: string; shift?: boolean; modifier?: boolean }
export type BrowserLinkResult = { route: 'app' | 'external'; pane?: string }
export type RegisterPreferences = (context: PluginContext, adapters: PreferencesAdapters) => PreferencesController
