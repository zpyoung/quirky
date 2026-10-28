import { useEffect, useRef, useState } from 'react'
import type { BrowserPreferencesProps, ProfileUsage } from '../preferences/contract'
import { BROWSER_SETTING_IDS, ImportDetails, ProfileCreator, errorMessage, useBrowserPreferenceData } from './shared'
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
const ZOOM_LEVELS = Array.from({ length: 17 }, (_, index) => -3 + index * 0.5)

export function BrowserSettings(props: BrowserPreferencesProps & { embedded?: boolean }) {
  const { context, onError, embedded = false } = props
  const { settings, preferences, loading, stateError, refresh, saveSetting } = useBrowserPreferenceData(context, onError)
  const [savingSettings, setSavingSettings] = useState<ReadonlySet<string>>(() => new Set())
  const [profilePending, setProfilePending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importsOpen, setImportsOpen] = useState(false)
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
    const isDefault = row.profile.scope === 'default'
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

  return <div className="browser-settings" aria-label="Browser settings">
    <h1>Browser</h1>
    {stateError && <p role="alert">{stateError}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {successMessage && <p role="status">{successMessage}</p>}
    {loading && !preferences && <p>Loading Browser preferences…</p>}

    {!embedded && <>
      <section className="section-card" aria-labelledby="browser-defaults-heading">
        <h2 id="browser-defaults-heading">Browser Defaults</h2>
        <label>Default home page<input aria-label="Default home page" type="url" value={homePageDraft} onChange={(event) => {
          const value = event.currentTarget.value
          homePageDraftRef.current = value
          homePageDirtyRef.current = true
          setHomePageDraft(value)
          setHomePageDirty(true)
          setActionError(null)
          setSuccessMessage(null)
        }} onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void saveHomePage()
          }
        }} /></label>
        <button type="button" disabled={savingSettings.has(BROWSER_SETTING_IDS.homePage)} onClick={() => void saveHomePage()}>Save</button>
        <label>Default search engine<select aria-label="Default search engine" value={settings.searchEngine} disabled={savingSettings.has(BROWSER_SETTING_IDS.searchEngine)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.searchEngine, event.currentTarget.value)}>
          {SEARCH_ENGINES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Default zoom<select aria-label="Default zoom" value={String(settings.zoom)} disabled={savingSettings.has(BROWSER_SETTING_IDS.zoom)} onChange={(event) => {
          const level = Number(event.currentTarget.value)
          if (Number.isFinite(level)) void writeSetting(BROWSER_SETTING_IDS.zoom, level)
        }}>
          {ZOOM_LEVELS.map((level) => <option key={level} value={level}>{Math.round(100 * 1.2 ** level)}%</option>)}
        </select></label>
      </section>

      <section className="section-card" aria-labelledby="browser-agent-heading">
        <h2 id="browser-agent-heading">Agent Browser Use</h2>
        <label><input type="checkbox" aria-label="Use Agent Browser" checked={settings.agentBrowserUseEnabled} disabled={savingSettings.has(BROWSER_SETTING_IDS.agentBrowserUseEnabled)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.agentBrowserUseEnabled, event.currentTarget.checked)} />Enable Agent Browser setup guidance</label>
        {settings.agentBrowserUseEnabled && <AgentBrowserChecklist />}
      </section>

      <section className="section-card" aria-labelledby="browser-identity-heading">
        <h2 id="browser-identity-heading">Chrome identity</h2>
        <label>Owned Chrome identity<select aria-label="Owned Chrome identity" value={settings.identityMode} disabled={savingSettings.has(BROWSER_SETTING_IDS.identityMode)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.identityMode, event.currentTarget.value)}>
          <option value="clean">Cleaned</option>
          <option value="native">Native</option>
        </select></label>
        <IdentityStatus selected={identitySelection} active={activeIdentity} restartRequired={restartRequired} />
        <p>System webview identity cannot be changed: the public native SDK has no user-agent override.</p>
      </section>

      <RoutingSettings settings={settings} savingSettings={savingSettings} writeSetting={writeSetting} />

      <section className="section-card" aria-labelledby="browser-hint-heading">
        <h2 id="browser-hint-heading">Import browser data</h2>
        <label><input type="checkbox" aria-label="Show import browser data hint" checked={!settings.browserImportHintHidden} disabled={savingSettings.has(BROWSER_SETTING_IDS.browserImportHintHidden)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.browserImportHintHidden, !event.currentTarget.checked)} />Show the Import browser data hint</label>
      </section>
    </>}

    {embedded && <>
      <IdentityStatus selected={identitySelection} active={activeIdentity} restartRequired={restartRequired} />
      <p>System webview identity cannot be changed: the public native SDK has no user-agent override.</p>
      {settings.agentBrowserUseEnabled && <AgentBrowserChecklist />}
    </>}

    <section className="section-card" aria-labelledby="browser-session-heading">
      <h2 id="browser-session-heading">Session &amp; Cookies</h2>
      <p>Clearing or removing profile data requires a native session-clear completion capability. It is currently unavailable; failed requests preserve profile data and metadata.</p>
      <button type="button" disabled={profilePending !== null} onClick={() => { setCreateOpen(true); setActionError(null); setSuccessMessage(null) }}>Add Profile</button>
      {preferences && <ul aria-label="Browser profiles">
        {preferences.profiles.map((row) => <li key={row.profile.id}>
          <strong>{row.profile.label}</strong>
          {row.active && <span>Active</span>}
          {row.profile.scope === 'default'
            ? <button type="button" disabled={profilePending !== null || savingSettings.size > 0} onClick={() => void profileAction(row)}>Clear cookies &amp; site data</button>
            : <button type="button" disabled={row.active || profilePending !== null || savingSettings.size > 0} onClick={() => void profileAction(row)}>Remove</button>}
          {row.profile.scope !== 'default' && row.active && <small>This profile is in use and cannot be removed.</small>}
        </li>)}
      </ul>}
      {preferences && <>
        <button type="button" aria-expanded={importsOpen} onClick={() => setImportsOpen((open) => !open)}>Import Cookies</button>
        {importsOpen
          ? <ImportDetails context={context} imports={preferences.imports} onHideHint={() => void writeSetting(BROWSER_SETTING_IDS.browserImportHintHidden, true)} onError={onError} />
          : <p>Cookie import is unavailable: {preferences.imports.reason}</p>}
        <p>Google logins are not imported. Sign in to Google directly in Quirky.</p>
      </>}
      {preferences?.localhostLabels && <p>Localhost Worktree Labels unavailable: {preferences.localhostLabels.reason}</p>}
      {createOpen && <ProfileCreator context={context} onCreated={profileCreated} onCancel={() => setCreateOpen(false)} onError={onError} />}
    </section>
  </div>
}

function IdentityStatus({ selected, active, restartRequired }: { selected: 'clean' | 'native'; active: 'clean' | 'native'; restartRequired: boolean }) {
  return <p aria-live="polite">{restartRequired
    ? `Restart required: ${IDENTITY_LABELS[active]} identity is active now; ${IDENTITY_LABELS[selected]} will apply when the Browser plugin or daemon restarts.`
    : `${IDENTITY_LABELS[active]} identity is active.`}</p>
}

function AgentBrowserChecklist() {
  return <section aria-label="Agent Browser setup checklist">
    <h3>Agent Browser setup checklist</h3>
    <ol>
      <li>Open a Browser pane for the worktree you want to use.</li>
      <li>Choose Watch when you want an agent to observe or control that pane.</li>
      <li>Use the browser tools documented for your agent; this preference does not install skills or grant extra API access.</li>
    </ol>
    <p>Example: ask your agent to inspect the current page, then use the Browser pane to review the result.</p>
  </section>
}

function RoutingSettings({ settings, savingSettings, writeSetting }: {
  settings: BrowserWindowSettings
  savingSettings: ReadonlySet<string>
  writeSetting(id: string, value: unknown): Promise<boolean>
}) {
  const modifierLabel = settings.openLinksInAppModifierInverts
    ? `Shift+modifier-click switches the configured route to ${settings.openLinksInApp ? 'the system browser' : 'Quirky'}.`
    : 'Shift+modifier-click always opens in the system browser.'
  return <section className="section-card" aria-labelledby="browser-routing-heading">
    <h2 id="browser-routing-heading">Link Routing</h2>
    <p>Link Routing is {settings.openLinksInApp ? 'On' : 'Off'}.</p>
    <label><input type="checkbox" aria-label="Open links in Quirky" checked={settings.openLinksInApp} disabled={savingSettings.has(BROWSER_SETTING_IDS.openLinksInApp)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.openLinksInApp, event.currentTarget.checked)} />Open web links in Quirky</label>
    <label><input type="checkbox" aria-label="Invert link routing modifier" checked={settings.openLinksInAppModifierInverts} disabled={savingSettings.has(BROWSER_SETTING_IDS.openLinksInAppModifierInverts)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.openLinksInAppModifierInverts, event.currentTarget.checked)} />Invert the Shift+modifier route for one click</label>
    <p>{modifierLabel}</p>
    <label>Terminal URL clicks<select aria-label="Terminal URL clicks" value={settings.terminalLinkClick} disabled={savingSettings.has(BROWSER_SETTING_IDS.terminalLinkClick)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.terminalLinkClick, event.currentTarget.value)}>
      {TERMINAL_LINK_ACTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>Terminal URL middle click<select aria-label="Terminal URL middle click" value={settings.terminalLinkMiddleClick} disabled={savingSettings.has(BROWSER_SETTING_IDS.terminalLinkMiddleClick)} onChange={(event) => void writeSetting(BROWSER_SETTING_IDS.terminalLinkMiddleClick, event.currentTarget.value)}>
      {TERMINAL_LINK_ACTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
    </select></label>
  </section>
}
