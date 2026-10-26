import {
  checkSettingValue,
  parseContributionId,
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
}

const DEFAULT_THEME_ID = 'default'

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

  /** Deletes the stored value so the default applies again, and broadcasts `setting.changed`. NotFound for an unknown ID. */
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

  private build() {
    const { plugins, store } = this.options
    const stored = store.getUiState('theme')
    return buildUiModel({
      declarations: plugins.contributions({ all: true }),
      plugins: plugins.list(),
      chosenTheme: typeof stored === 'string' ? stored : DEFAULT_THEME_ID
    })
  }

  private entryOf(id: string): UiSettingEntry {
    const entry = this.build().model.settings.find((setting) => setting.id === id)
    if (!entry) throw notFound(`no setting ${id}`)
    return entry
  }

  private infoOf(entry: UiSettingEntry): SettingInfo {
    const stored = this.options.store.getSettingValue(entry.id)
    if (!stored) return { ...entry, value: entry.default }
    const valid = checkSettingValue(entry.id, entry, stored.value) === null
    return {
      ...entry,
      value: valid ? (stored.value as SettingInfo['value']) : entry.default,
      stored: { value: stored.value, valid }
    }
  }

  private changed(entry: UiSettingEntry): SettingInfo {
    const info = this.infoOf(entry)
    this.options.broadcast({ type: 'setting.changed', id: info.id, value: info.value })
    return info
  }
}
