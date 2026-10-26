import {
  checkSettingValue,
  parseContributionId,
  type DistroManifest,
  type QuirkyEvent,
  type SettingInfo,
  type ThemeList,
  type UiModel,
  type UiSettingEntry
} from '@quirky/protocol'
import { invalidParams, notFound } from '../errors'
import type { Store } from '../store'
import type { PluginHost } from './host'
import { buildUiModel } from './ui-model'

export type UiServiceOptions = {
  plugins: PluginHost
  store: Store
  broadcast: (event: QuirkyEvent) => void
  /** The distro layer in effect, or null. */
  distro?: () => DistroManifest | null
  /** True in safe mode: the distro layer is skipped. */
  safeMode?: boolean
}

const DEFAULT_THEME_ID = 'default'

/**
 * A setting's effective value across the layers: a valid stored value, else the distro's value
 * when it fits the declaration, else the default. `stored` carries an unusable stored value.
 */
export function resolveSetting(
  entry: UiSettingEntry,
  stored: { value: unknown } | null,
  distro: DistroManifest | null
): SettingInfo {
  const valid = stored !== null && checkSettingValue(entry.id, entry, stored.value) === null
  const storedPart = stored ? { stored: { value: stored.value, valid } } : {}
  if (stored && valid) return { ...entry, value: stored.value as SettingInfo['value'], source: 'user', ...storedPart }
  const layered = distro?.settings?.[entry.id]
  if (layered !== undefined && checkSettingValue(entry.id, entry, layered) === null) {
    return { ...entry, value: layered, source: 'distro', ...storedPart }
  }
  return { ...entry, value: entry.default, source: 'default', ...storedPart }
}

/** The theme ID in force before fallback: the user's stored choice, else the distro's, else `default`. */
export function chosenThemeOf(stored: unknown, distro: DistroManifest | null): string {
  if (typeof stored === 'string') return stored
  return distro?.theme ?? DEFAULT_THEME_ID
}

/**
 * Serves the UI model, plugin settings and themes to the daemon's methods and to plugin contexts.
 * Nothing is cached: every call rebuilds from the host's current declarations, so enabling,
 * disabling or overriding a contribution shows up on the next call. Stored setting values are
 * deleted only by `resetSetting`, so a disabled plugin's settings survive until it returns.
 */
export class UiService {
  constructor(private readonly options: UiServiceOptions) {}

  /** The model the window renders, built for the chosen theme. */
  contributions(): UiModel {
    return this.build().model
  }

  /** Every effective setting with its current value, optionally only those declared by one plugin. */
  listSettings(filter: { pluginId?: string } = {}): SettingInfo[] {
    return this.build()
      .model.settings.filter((entry) => filter.pluginId === undefined || entry.plugin === filter.pluginId)
      .map((entry) => this.infoOf(entry))
  }

  /** One effective setting. NotFound when the ID is not an effective setting. */
  getSetting(id: string): SettingInfo {
    return this.infoOf(this.entryOf(id))
  }

  /**
   * Stores a value for an effective setting and broadcasts `setting.changed`. NotFound for an
   * unknown ID; InvalidParams with the declaration's message for a value that does not fit it.
   */
  setSetting(id: string, value: unknown): SettingInfo {
    const entry = this.entryOf(id)
    const problem = checkSettingValue(id, entry, value)
    if (problem !== null) throw invalidParams(problem)
    this.options.store.setSettingValue(id, value)
    return this.changed(entry)
  }

  /** Deletes only the user's stored value so the distro's or the default applies again, and broadcasts `setting.changed`. NotFound for an unknown ID. */
  resetSetting(id: string): SettingInfo {
    const entry = this.entryOf(id)
    this.options.store.deleteSettingValue(id)
    return this.changed(entry)
  }

  /**
   * The effective value of a setting for a plugin context. `name` is a short name in the plugin's
   * own namespace or a full setting ID; throws a plain Error naming the ID when it is not an effective setting.
   */
  valueFor(pluginId: string, name: string): unknown {
    const id = parseContributionId(name) ? name : `setting:${pluginId}/${name}`
    const entry = this.build().model.settings.find((setting) => setting.id === id)
    if (!entry) throw new Error(`no setting ${id}`)
    return this.infoOf(entry).value
  }

  /** The themes on offer and which one is chosen and in use. */
  listThemes(): ThemeList {
    const { themes, theme } = this.build().model
    return { chosen: theme.chosen, active: theme.active, themes }
  }

  /** Persists the chosen theme and broadcasts `theme.changed`. NotFound unless `id` is `default` or an effective theme. */
  setTheme(id: string): ThemeList {
    if (!this.listThemes().themes.some((theme) => theme.id === id)) throw notFound(`no theme ${id}`)
    this.options.store.setUiState('theme', id)
    const list = this.listThemes()
    this.options.broadcast({ type: 'theme.changed', chosen: list.chosen, active: list.active })
    return list
  }

  private layer(): DistroManifest | null {
    return this.options.safeMode ? null : (this.options.distro?.() ?? null)
  }

  private build() {
    const { plugins, store } = this.options
    const distro = this.layer()
    return buildUiModel({
      declarations: plugins.contributions({ all: true }),
      plugins: plugins.list(),
      chosenTheme: chosenThemeOf(store.getUiState('theme'), distro),
      distroKeybindings: Object.entries(distro?.keybindings ?? {}).map(([key, command]) => ({ key, command })),
      distroId: distro?.id ?? null
    })
  }

  private entryOf(id: string): UiSettingEntry {
    const entry = this.build().model.settings.find((setting) => setting.id === id)
    if (!entry) throw notFound(`no setting ${id}`)
    return entry
  }

  private infoOf(entry: UiSettingEntry): SettingInfo {
    return resolveSetting(entry, this.options.store.getSettingValue(entry.id), this.layer())
  }

  private changed(entry: UiSettingEntry): SettingInfo {
    const info = this.infoOf(entry)
    this.options.broadcast({ type: 'setting.changed', id: info.id, value: info.value })
    return info
  }
}
