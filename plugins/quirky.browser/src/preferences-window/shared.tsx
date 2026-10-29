import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, TextField } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { BrowserProfile } from '../profiles/store'
import type { BrowserPreferencesProps, PreferencesState, ProfileUsage } from '../preferences/contract'

export const BROWSER_SETTING_IDS = {
  homePage: 'setting:quirky.browser/defaultHomePage',
  searchEngine: 'setting:quirky.browser/defaultSearchEngine',
  zoom: 'setting:quirky.browser/defaultZoom',
  identityMode: 'setting:quirky.browser/identityMode',
  openLinksInApp: 'setting:quirky.browser/openLinksInApp',
  openLinksInAppModifierInverts: 'setting:quirky.browser/openLinksInAppModifierInverts',
  browserImportHintHidden: 'setting:quirky.browser/browserImportHintHidden',
  agentBrowserUseEnabled: 'setting:quirky.browser/agentBrowserUseEnabled',
  terminalLinkClick: 'setting:quirky.terminal/link-click',
  terminalLinkMiddleClick: 'setting:quirky.terminal/link-middle-click'
} as const

export const BROWSER_SETTINGS_COMMAND = 'command:quirky.browser/browserSettings'
const PROFILE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  arc: 'Arc',
  chromium: 'Brave',
  comet: 'Comet',
  helium: 'Helium',
  firefox: 'Firefox',
  safari: 'Safari',
  json: 'JSON file/data',
  file: 'File'
}

type SearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'
type IdentityMode = 'clean' | 'native'
type TerminalLinkAction = 'actions' | 'open' | 'terminal'
export type BrowserWindowSettings = {
  homePage: string
  searchEngine: SearchEngine
  zoom: number
  identityMode: IdentityMode
  openLinksInApp: boolean
  openLinksInAppModifierInverts: boolean
  browserImportHintHidden: boolean
  agentBrowserUseEnabled: boolean
  terminalLinkClick: TerminalLinkAction
  terminalLinkMiddleClick: TerminalLinkAction
}

type SettingKey = keyof BrowserWindowSettings
const SETTING_ID_BY_KEY: Record<SettingKey, string> = {
  homePage: BROWSER_SETTING_IDS.homePage,
  searchEngine: BROWSER_SETTING_IDS.searchEngine,
  zoom: BROWSER_SETTING_IDS.zoom,
  identityMode: BROWSER_SETTING_IDS.identityMode,
  openLinksInApp: BROWSER_SETTING_IDS.openLinksInApp,
  openLinksInAppModifierInverts: BROWSER_SETTING_IDS.openLinksInAppModifierInverts,
  browserImportHintHidden: BROWSER_SETTING_IDS.browserImportHintHidden,
  agentBrowserUseEnabled: BROWSER_SETTING_IDS.agentBrowserUseEnabled,
  terminalLinkClick: BROWSER_SETTING_IDS.terminalLinkClick,
  terminalLinkMiddleClick: BROWSER_SETTING_IDS.terminalLinkMiddleClick
}
const SETTING_KEY_BY_ID = new Map<string, SettingKey>(Object.entries(SETTING_ID_BY_KEY).map(([key, id]) => [id, key as SettingKey] as const))
const SEARCH_ENGINES: readonly SearchEngine[] = ['google', 'duckduckgo', 'bing', 'kagi']
const TERMINAL_ACTIONS: readonly TerminalLinkAction[] = ['actions', 'open', 'terminal']

const DEFAULT_SETTINGS: BrowserWindowSettings = {
  homePage: '',
  searchEngine: 'google',
  zoom: 0,
  identityMode: 'clean',
  openLinksInApp: false,
  openLinksInAppModifierInverts: false,
  browserImportHintHidden: false,
  agentBrowserUseEnabled: false,
  terminalLinkClick: 'actions',
  terminalLinkMiddleClick: 'open'
}

function normalizeSetting<K extends SettingKey>(key: K, value: unknown): BrowserWindowSettings[K] {
  if (key === 'homePage') return (typeof value === 'string' ? value : DEFAULT_SETTINGS.homePage) as BrowserWindowSettings[K]
  if (key === 'searchEngine') return (SEARCH_ENGINES.includes(value as SearchEngine) ? value : DEFAULT_SETTINGS.searchEngine) as BrowserWindowSettings[K]
  if (key === 'zoom') return (typeof value === 'number' && Number.isFinite(value) && value >= -3 && value <= 5 && Number.isInteger(value * 2) ? value : DEFAULT_SETTINGS.zoom) as BrowserWindowSettings[K]
  if (key === 'identityMode') return ((value === 'native' || value === 'clean') ? value : DEFAULT_SETTINGS.identityMode) as BrowserWindowSettings[K]
  if (key === 'terminalLinkClick' || key === 'terminalLinkMiddleClick') return (TERMINAL_ACTIONS.includes(value as TerminalLinkAction) ? value : DEFAULT_SETTINGS[key]) as BrowserWindowSettings[K]
  return (typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key]) as BrowserWindowSettings[K]
}

function loadSettings(context: UiPluginContext): BrowserWindowSettings {
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(SETTING_ID_BY_KEY) as SettingKey[]) {
    Object.assign(settings, { [key]: normalizeSetting(key, context.getSetting(SETTING_ID_BY_KEY[key])) })
  }
  return settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProfile(value: unknown): value is BrowserProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' ||
    (value.scope !== 'default' && value.scope !== 'isolated' && value.scope !== 'imported')) return false
  const source = value.source
  return source === undefined || typeof source === 'string' ||
    (isRecord(source) && typeof source.browserFamily === 'string' && source.browserFamily.length > 0 &&
      (source.profileName === undefined || typeof source.profileName === 'string') &&
      typeof source.importedAt === 'number' && Number.isFinite(source.importedAt))
}

function isProfileUsage(value: unknown): value is ProfileUsage {
  if (!isRecord(value) || !isProfile(value.profile)) return false
  return typeof value.active === 'boolean'
}

function isPreferencesState(value: unknown): value is PreferencesState {
  if (!isRecord(value) || !Array.isArray(value.profiles) || !value.profiles.every(isProfileUsage)) return false
  if (!isRecord(value.identity) || (value.identity.selected !== 'clean' && value.identity.selected !== 'native') || (value.identity.active !== 'clean' && value.identity.active !== 'native') || typeof value.identity.restartRequired !== 'boolean' || typeof value.identity.nativeSupported !== 'boolean') return false
  if (!isRecord(value.imports) || value.imports.available !== true || value.imports.destination !== 'managed-chrome' || value.imports.nativeSupported !== false || typeof value.imports.reason !== 'string') return false
  if (!isRecord(value.localhostLabels) || value.localhostLabels.available !== false || typeof value.localhostLabels.reason !== 'string') return false
  return true
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'The browser preference could not be saved.'
}

export function useBrowserPreferenceData(context: UiPluginContext, onError: BrowserPreferencesProps['onError']) {
  const [settings, setSettings] = useState(() => loadSettings(context))
  const [preferences, setPreferences] = useState<PreferencesState | null>(null)
  const [loading, setLoading] = useState(true)
  const [stateError, setStateError] = useState<string | null>(null)
  const onErrorRef = useRef(onError)
  const sequence = useRef(0)
  const mounted = useRef(false)

  useEffect(() => { onErrorRef.current = onError }, [onError])

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try {
      const result = await context.call('quirky.browser/preferencesState')
      if (!isPreferencesState(result)) throw new Error('Browser preference state was not returned in the expected format.')
      if (!mounted.current || sequence.current !== request) return
      setPreferences(result)
      setStateError(null)
      if (context.getSetting(BROWSER_SETTING_IDS.identityMode) === undefined) {
        setSettings((current) => ({ ...current, identityMode: result.identity.selected }))
      }
    } catch (error) {
      if (!mounted.current || sequence.current !== request) throw error
      const message = errorMessage(error)
      setStateError(message)
      onErrorRef.current(message)
      throw error
    } finally {
      if (mounted.current && sequence.current === request) setLoading(false)
    }
  }, [context])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type === 'setting.changed') {
        const key = SETTING_KEY_BY_ID.get(event.id)
        if (key) setSettings((current) => Object.assign({}, current, { [key]: normalizeSetting(key, event.value) }))
      }
      const eventType: string = event.type
      if (eventType === 'quirky.browser/preferencesChanged') void refresh().catch(() => {})
    })
    void refresh().catch(() => {})
    return () => {
      mounted.current = false
      sequence.current += 1
      unsubscribe()
    }
  }, [context, refresh])

  const saveSetting = useCallback(async (id: string, value: unknown) => {
    await context.call('setting.set', { id, value })
    const key = SETTING_KEY_BY_ID.get(id)
    if (key) setSettings((current) => ({ ...current, [key]: normalizeSetting(key, value) }))
  }, [context])

  return { settings, preferences, loading, stateError, refresh, saveSetting }
}

export function ProfileCreator({ context, onCreated, onCancel, onError }: {
  context: UiPluginContext
  onCreated(name: string): Promise<void>
  onCancel(): void
  onError(message: string): void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter a profile name before creating it.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await context.call('quirky.browser/profileCreate', { name: trimmedName })
      await onCreated(trimmedName)
      onCancel()
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      onError(message)
    } finally {
      setSaving(false)
    }
  }
  return <div className="ui-dialog" role="dialog" aria-modal="true" aria-label="New Browser Profile">
    <div className="ui-dialog__header">
      <h3 className="ui-dialog__title">New Profile</h3>
    </div>
    <TextField
      label="Profile name"
      aria-label="Profile name"
      autoFocus
      value={name}
      onChange={(event) => setName(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit() } }}
    />
    {error && <p className="ui-error-text" role="alert" style={{ margin: 0, overflowWrap: 'anywhere' }}>{error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-8)' }}>
      <Button type="button" variant="primary" disabled={saving} onClick={() => void submit()}>{saving ? 'Creating…' : 'Create Profile'}</Button>
      <Button type="button" disabled={saving} onClick={onCancel}>Cancel</Button>
    </div>
  </div>
}


export function profileSourceLabel(profile: BrowserProfile): string | null {
  if ('sourceLabel' in profile && typeof profile.sourceLabel === 'string' && profile.sourceLabel.trim()) return profile.sourceLabel
  if (!('source' in profile)) return null
  const source: unknown = profile.source
  if (typeof source === 'string' && source.trim()) return `Imported from ${PROFILE_SOURCE_LABELS[source] ?? source}`
  if (!isRecord(source) || typeof source.browserFamily !== 'string') return null
  const family = PROFILE_SOURCE_LABELS[source.browserFamily] ?? source.browserFamily.charAt(0).toUpperCase() + source.browserFamily.slice(1)
  const profileName = typeof source.profileName === 'string' && source.profileName.trim() ? ` (${source.profileName})` : ''
  return `Imported from ${family}${profileName}`
}
