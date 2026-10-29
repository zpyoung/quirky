import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button, FormRow, SectionHeader, StatusDot, TextField } from '@quirky/ui'
import type { BrowserPreferencesProps, ProfileUsage } from '../preferences/contract'
import { BROWSER_SETTING_IDS, ProfileCreator, errorMessage, profileSourceLabel, useBrowserPreferenceData } from './shared'
import { CookieImportPanel } from './CookieImportPanel'
import type { BrowserWindowSettings } from './shared'

const SEARCH_ENGINES = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
  { value: 'kagi', label: 'Kagi' }
] as const
const TERMINAL_LINK_ACTIONS = [
  { value: 'actions', label: 'Actions' },
  { value: 'open', label: 'Open URL' },
  { value: 'terminal', label: 'Leave to terminal' }
] as const
const IDENTITY_LABELS = { clean: 'Cleaned', native: 'Native' } as const
const SETTINGS_LAYOUT_STYLE = { display: 'grid', gap: 'var(--ui-space-16)', minWidth: 0, color: 'var(--ui-text)', fontSize: 'var(--ui-font-body)', accentColor: 'var(--ui-accent)' } as const
const SETTINGS_SECTION_STYLE = { display: 'grid', gap: 'var(--ui-space-12)', minWidth: 0, background: 'var(--ui-surface)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)', padding: 'var(--ui-space-12)' } as const
const SETTINGS_COPY_STYLE = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-body)', lineHeight: 1.4, margin: 0, overflowWrap: 'anywhere' } as const
const SETTINGS_MESSAGE_STYLE = { margin: 0, overflowWrap: 'anywhere' } as const
const SETTINGS_TOGGLE_STYLE = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)', minWidth: 0 } as const
const SETTINGS_LIST_STYLE = { display: 'grid', gap: 'var(--ui-space-8)', listStyle: 'none', margin: 0, minWidth: 0, padding: 0 } as const
const PROFILE_ENTRY_STYLE = { display: 'grid', gap: 'var(--ui-space-8)', minWidth: 0, background: 'var(--ui-surface)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)', padding: 'var(--ui-space-8)' } as const
const PROFILE_HEADER_STYLE = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)', minWidth: 0 } as const
const PROFILE_ACTIONS_STYLE = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--ui-space-6)', minWidth: 0 } as const
const PROFILE_ROW_STYLE = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' } as const
const STATUS_LINE_STYLE = { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-6)', margin: 0 } as const
const CHECKLIST_STYLE = { border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)', display: 'grid', gap: 'var(--ui-space-8)', minWidth: 0, padding: 'var(--ui-space-8)' } as const
const CHECKLIST_ITEMS_STYLE = { display: 'grid', gap: 'var(--ui-space-4)', margin: 0, paddingInlineStart: 'var(--ui-space-16)' } as const
const ZOOM_LEVELS = Array.from({ length: 17 }, (_, index) => -3 + index * 0.5)
function isDefaultProfile(profile: ProfileUsage['profile']): boolean {
  return profile.id === 'default' || profile.scope === 'default'
}

export function BrowserSettings(props: BrowserPreferencesProps & { embedded?: boolean }) {
  const { context, onError, embedded = false } = props
  const { settings, preferences, loading, stateError, refresh, saveSetting } = useBrowserPreferenceData(context, onError)
  const settingsId = useId()
  const [savingSettings, setSavingSettings] = useState<ReadonlySet<string>>(() => new Set())
  const [profilePending, setProfilePending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpenProfile, setImportOpenProfile] = useState<string | null>(null)
  const [homePageDraft, setHomePageDraft] = useState(settings.homePage)
  const [homePageDirty, setHomePageDirty] = useState(false)
  const homePageDraftRef = useRef(homePageDraft)
  const homePageDirtyRef = useRef(false)

  useEffect(() => {
    if (homePageDirtyRef.current) return
    homePageDraftRef.current = settings.homePage
    setHomePageDraft(settings.homePage)
  }, [settings.homePage, homePageDirty])

  const writeSetting = async (id: string, value: unknown) => {
    setSavingSettings((current) => new Set(current).add(id))
    setActionError(null)
    try {
      await saveSetting(id, value)
      return true
    } catch (cause) {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
      return false
    } finally {
      setSavingSettings((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }
  const saveHomePage = async () => {
    const id = BROWSER_SETTING_IDS.homePage
    if (savingSettings.has(id)) return
    const value = homePageDraft
    setSuccessMessage(null)
    if (!await writeSetting(id, value)) return
    if (homePageDraftRef.current === value) {
      homePageDirtyRef.current = false
      setHomePageDirty(false)
    }
    setSuccessMessage('Default home page saved.')
  }

  const profileCreated = async (name: string) => {
    await refresh()
    setActionError(null)
    setSuccessMessage(`Profile "${name}" created.`)
  }

  const profileAction = async (row: ProfileUsage) => {
    const isDefault = isDefaultProfile(row.profile)
    if (!isDefault && row.active) return
    const remove = !isDefault
    setActionError(null)
    setProfilePending(row.profile.id)
    let succeeded = false
    try {
      const confirmed = await context.confirm({
        title: remove ? `Remove ${row.profile.label}?` : 'Clear cookies and site data?',
        body: remove
          ? `Permanently remove the ${row.profile.label} browser profile and its owned site data.`
          : 'Clear the Default browser profile cookies and site data. This cannot be undone.',
        confirmLabel: remove ? 'Remove Profile' : 'Clear Data'
      })
      if (!confirmed) return
      await context.call(remove ? 'quirky.browser/profileDelete' : 'quirky.browser/profileClear', { profile: row.profile.id, yes: true })
      succeeded = true
    } catch (cause) {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
    } finally {
      setProfilePending(null)
    }
    if (succeeded) await refresh().catch(() => {})
  }

  const identitySelection = settings.identityMode
  const activeIdentity = preferences?.identity.active ?? preferences?.identity.selected ?? identitySelection
  const restartRequired = preferences?.identity.restartRequired === true || activeIdentity !== identitySelection

  return <div className="browser-settings" aria-label="Browser settings" style={SETTINGS_LAYOUT_STYLE}>
    <h1 style={{ fontSize: 'var(--ui-font-title)', margin: 0 }}>Browser</h1>
    {stateError && <p className="ui-error-text" role="alert" style={SETTINGS_MESSAGE_STYLE}>{stateError}</p>}
    {actionError && <p className="ui-error-text" role="alert" style={SETTINGS_MESSAGE_STYLE}>{actionError}</p>}
    {successMessage && <p role="status" style={SETTINGS_MESSAGE_STYLE}>{successMessage}</p>}
    {loading && !preferences && <p role="status" style={SETTINGS_MESSAGE_STYLE}>Loading Browser preferences…</p>}

    {!embedded && <>
      <section aria-label="Browser Defaults" style={SETTINGS_SECTION_STYLE}>
        <SectionHeader title="Browser Defaults" />
        <TextField
          label="Default home page"
          aria-label="Default home page"
          type="url"
          value={homePageDraft}
          onChange={(event) => {
            const value = event.currentTarget.value
            homePageDraftRef.current = value
            homePageDirtyRef.current = true
            setHomePageDraft(value)
            setHomePageDirty(true)
            setActionError(null)
            setSuccessMessage(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void saveHomePage()
            }
          }}
        />
        <div style={PROFILE_ACTIONS_STYLE}>
          <Button type="button" variant="primary" disabled={savingSettings.has(BROWSER_SETTING_IDS.homePage)} onClick={() => void saveHomePage()}>Save</Button>
        </div>
        <FormRow label="Default search engine" htmlFor={`${settingsId}-browser-default-search-engine`}>
          <select id={`${settingsId}-browser-default-search-engine`} className="ui-text-field__input" style={{ appearance: 'auto' }} aria-label="Default search engine" value={settings.searchEngine} disabled={savingSettings.has(BROWSER_SETTING_IDS.searchEngine)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.searchEngine, event.currentTarget.value)}>
            {SEARCH_ENGINES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </FormRow>
        <FormRow label="Default zoom" htmlFor={`${settingsId}-browser-default-zoom`}>
          <select id={`${settingsId}-browser-default-zoom`} className="ui-text-field__input" style={{ appearance: 'auto' }} aria-label="Default zoom" value={String(settings.zoom)} disabled={savingSettings.has(BROWSER_SETTING_IDS.zoom)} onChange={(event) => {
            const level = Number(event.currentTarget.value)
            if (Number.isFinite(level)) void writeSetting(BROWSER_SETTING_IDS.zoom, level)
          }}>
            {ZOOM_LEVELS.map((level) => <option key={level} value={level}>{Math.round(100 * 1.2 ** level)}%</option>)}
          </select>
        </FormRow>
      </section>

      <section aria-label="Agent Browser Use" style={SETTINGS_SECTION_STYLE}>
        <SectionHeader title="Agent Browser Use" />
        <label style={SETTINGS_TOGGLE_STYLE}><input type="checkbox" style={{ appearance: 'auto', accentColor: 'var(--ui-accent)' }} aria-label="Use Agent Browser" checked={settings.agentBrowserUseEnabled} disabled={savingSettings.has(BROWSER_SETTING_IDS.agentBrowserUseEnabled)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.agentBrowserUseEnabled, event.currentTarget.checked)} />Enable Agent Browser setup guidance</label>
        {settings.agentBrowserUseEnabled && <AgentBrowserChecklist />}
      </section>

      <section aria-label="Chrome identity" style={SETTINGS_SECTION_STYLE}>
        <SectionHeader title="Chrome identity" />
        <FormRow label="Owned Chrome identity" htmlFor={`${settingsId}-browser-owned-chrome-identity`}>
          <select id={`${settingsId}-browser-owned-chrome-identity`} className="ui-text-field__input" style={{ appearance: 'auto' }} aria-label="Owned Chrome identity" value={settings.identityMode} disabled={savingSettings.has(BROWSER_SETTING_IDS.identityMode)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.identityMode, event.currentTarget.value)}>
            <option value="clean">Cleaned</option>
            <option value="native">Native</option>
          </select>
        </FormRow>
        <IdentityStatus selected={identitySelection} active={activeIdentity} restartRequired={restartRequired} />
        <p style={SETTINGS_COPY_STYLE}>System webview identity cannot be changed: the public native SDK has no user-agent override.</p>
      </section>

      <RoutingSettings settings={settings} savingSettings={savingSettings} writeSetting={writeSetting} />

      <section aria-label="Import browser data" style={SETTINGS_SECTION_STYLE}>
        <SectionHeader title="Import browser data" />
        <label style={SETTINGS_TOGGLE_STYLE}><input type="checkbox" aria-label="Show import browser data hint" checked={!settings.browserImportHintHidden} disabled={savingSettings.has(BROWSER_SETTING_IDS.browserImportHintHidden)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.browserImportHintHidden, !event.currentTarget.checked)} />Show the Import browser data hint</label>
      </section>
    </>}

    {embedded && <>
      <IdentityStatus selected={identitySelection} active={activeIdentity} restartRequired={restartRequired} />
      <p style={SETTINGS_COPY_STYLE}>System webview identity cannot be changed: the public native SDK has no user-agent override.</p>
      {settings.agentBrowserUseEnabled && <AgentBrowserChecklist />}
    </>}

    <section aria-label="Session &amp; Cookies" style={SETTINGS_SECTION_STYLE}>
      <SectionHeader
        title="Session & Cookies"
        actions={<Button type="button" variant="primary" disabled={profilePending !== null} onClick={() => { setCreateOpen(true); setActionError(null); setSuccessMessage(null) }}>Add Profile</Button>}
      />
      <p style={SETTINGS_COPY_STYLE}>Clearing or removing profile data requires a native session-clear completion capability. It is currently unavailable; failed requests preserve profile data and metadata.</p>
      {preferences && <ul aria-label="Browser profiles" style={SETTINGS_LIST_STYLE}>
        {preferences.profiles.map((row) => {
          const importOpen = importOpenProfile === row.profile.id
          const sourceLabel = profileSourceLabel(row.profile)
          return <li key={row.profile.id} style={PROFILE_ENTRY_STYLE}>
            <div style={PROFILE_HEADER_STYLE}>
              <strong style={{ overflowWrap: 'anywhere' }}>{row.profile.label}</strong>
              {sourceLabel && <small style={PROFILE_ROW_STYLE}>{sourceLabel}</small>}
              {row.active && <Badge tone="working">Active</Badge>}
            </div>
            {row.active && !isDefaultProfile(row.profile) && <small style={PROFILE_ROW_STYLE}>This profile is in use and cannot be removed.</small>}
            <div style={PROFILE_ACTIONS_STYLE}>
              {isDefaultProfile(row.profile)
                ? <Button type="button" variant="destructive" disabled={profilePending !== null || savingSettings.size > 0} onClick={() => void profileAction(row)}>Clear cookies &amp; site data</Button>
                : <Button type="button" variant="destructive" disabled={row.active || profilePending !== null || savingSettings.size > 0} onClick={() => void profileAction(row)}>Remove</Button>}
              <Button type="button" aria-expanded={importOpen} onClick={() => setImportOpenProfile((current) => current === row.profile.id ? null : row.profile.id)}>Import Cookies</Button>
            </div>
            {importOpen && <CookieImportPanel context={context} imports={preferences.imports} destination={{ id: row.profile.id, label: row.profile.label }} loadError={stateError} onHideHint={() => void writeSetting(BROWSER_SETTING_IDS.browserImportHintHidden, true)} onError={onError} onImported={refresh} />}
          </li>
        })}
      </ul>}
      {preferences?.localhostLabels && <p style={SETTINGS_COPY_STYLE}>Localhost Worktree Labels unavailable: {preferences.localhostLabels.reason}</p>}
      {createOpen && <ProfileCreator context={context} onCreated={profileCreated} onCancel={() => setCreateOpen(false)} onError={onError} />}
    </section>
  </div>
}

function IdentityStatus({ selected, active, restartRequired }: { selected: 'clean' | 'native'; active: 'clean' | 'native'; restartRequired: boolean }) {
  return <p aria-live="polite" style={STATUS_LINE_STYLE}>
    <StatusDot status={restartRequired ? 'needs-you' : 'done'} label={restartRequired ? 'Restart required' : `${IDENTITY_LABELS[active]} identity is active`} />
    <span>{restartRequired
      ? `Restart required: ${IDENTITY_LABELS[active]} identity is active now; ${IDENTITY_LABELS[selected]} will apply when the Browser plugin or daemon restarts.`
      : `${IDENTITY_LABELS[active]} identity is active.`}</span>
  </p>
}

function AgentBrowserChecklist() {
  return <section aria-label="Agent Browser setup checklist" style={CHECKLIST_STYLE}>
    <SectionHeader title="Agent Browser setup checklist" />
    <ol style={CHECKLIST_ITEMS_STYLE}>
      <li>Open a Browser pane for the worktree you want to use.</li>
      <li>Choose Watch when you want an agent to observe or control that pane.</li>
      <li>Use the browser tools documented for your agent; this preference does not install skills or grant extra API access.</li>
    </ol>
    <p style={SETTINGS_COPY_STYLE}>Example: ask your agent to inspect the current page, then use the Browser pane to review the result.</p>
  </section>
}

function RoutingSettings({ settings, savingSettings, writeSetting }: {
  settings: BrowserWindowSettings
  savingSettings: ReadonlySet<string>
  writeSetting(id: string, value: unknown): Promise<boolean>
}) {
  const settingsId = useId()
  const modifierLabel = settings.openLinksInAppModifierInverts
    ? `Shift+modifier-click switches the configured route to ${settings.openLinksInApp ? 'the system browser' : 'Quirky'}.`
    : 'Shift+modifier-click always opens in the system browser.'
  return <section aria-label="Link Routing" style={SETTINGS_SECTION_STYLE}>
    <SectionHeader title="Link Routing" />
    <p style={STATUS_LINE_STYLE}><StatusDot status={settings.openLinksInApp ? 'working' : 'idle'} label={`Link routing ${settings.openLinksInApp ? 'on' : 'off'}`} />Link Routing is {settings.openLinksInApp ? 'On' : 'Off'}.</p>
    <label style={SETTINGS_TOGGLE_STYLE}><input type="checkbox" style={{ appearance: 'auto', accentColor: 'var(--ui-accent)' }} aria-label="Open links in Quirky" checked={settings.openLinksInApp} disabled={savingSettings.has(BROWSER_SETTING_IDS.openLinksInApp)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.openLinksInApp, event.currentTarget.checked)} />Open web links in Quirky</label>
    <label style={SETTINGS_TOGGLE_STYLE}><input type="checkbox" style={{ appearance: 'auto', accentColor: 'var(--ui-accent)' }} aria-label="Invert link routing modifier" checked={settings.openLinksInAppModifierInverts} disabled={savingSettings.has(BROWSER_SETTING_IDS.openLinksInAppModifierInverts)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.openLinksInAppModifierInverts, event.currentTarget.checked)} />Invert the Shift+modifier route for one click</label>
    <p style={SETTINGS_COPY_STYLE}>{modifierLabel}</p>
    <FormRow label="Terminal URL clicks" htmlFor={`${settingsId}-browser-terminal-url-clicks`}>
      <select id={`${settingsId}-browser-terminal-url-clicks`} className="ui-text-field__input" style={{ appearance: 'auto' }} aria-label="Terminal URL clicks" value={settings.terminalLinkClick} disabled={savingSettings.has(BROWSER_SETTING_IDS.terminalLinkClick)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.terminalLinkClick, event.currentTarget.value)}>
        {TERMINAL_LINK_ACTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
    </FormRow>
    <FormRow label="Terminal URL middle click" htmlFor={`${settingsId}-browser-terminal-url-middle-click`}>
      <select id={`${settingsId}-browser-terminal-url-middle-click`} className="ui-text-field__input" style={{ appearance: 'auto' }} aria-label="Terminal URL middle click" value={settings.terminalLinkMiddleClick} disabled={savingSettings.has(BROWSER_SETTING_IDS.terminalLinkMiddleClick)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.terminalLinkMiddleClick, event.currentTarget.value)}>
        {TERMINAL_LINK_ACTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
    </FormRow>
  </section>
}
