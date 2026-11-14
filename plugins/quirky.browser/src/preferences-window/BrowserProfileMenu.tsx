import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button, InlineError, NoticeLine } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { BrowserProfile } from '../profiles/store'
import type { BrowserPreferencesProps } from '../preferences/contract'
import { browserPaneControlInstance } from '../ui-control'
import { BROWSER_SETTING_IDS, PREFERENCES_CONTROL_COMMAND, ProfileCreator, errorMessage, profileSourceLabel, registerPreferencesController, useBrowserPreferenceData } from './shared'
import type { PreferencesControlArgs } from './shared'
import { CookieImportPanel } from './CookieImportPanel'

async function requestPreferencesControl(context: UiPluginContext, args: PreferencesControlArgs): Promise<void> {
  await context.executeCommand(PREFERENCES_CONTROL_COMMAND, args, { activateOwner: false })
}

const MENU_LAYOUT_STYLE = { display: 'grid', gap: 'var(--ui-space-12)', minWidth: 0, color: 'var(--ui-text)', fontSize: 'var(--ui-font-body)' } as const
const MENU_CONTENT_STYLE = { display: 'grid', gap: 'var(--ui-space-8)', minWidth: 0 } as const
const PROFILE_ROWS_STYLE = { display: 'grid', gap: 'var(--ui-space-6)', minWidth: 0, margin: 0, padding: 'var(--ui-space-8)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)' } as const
const PROFILE_ROW_STYLE = { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-8)', minWidth: 0, padding: 'var(--ui-space-4)' } as const
const MENU_ACTIONS_STYLE = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-6)', minWidth: 0 } as const
const MENU_MESSAGE_STYLE = { margin: 0, overflowWrap: 'anywhere' } as const
const PROFILE_SOURCE_STYLE = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere' } as const

function profileIdForPane(pane: BrowserPreferencesProps['pane']): string {
  if (pane && 'profileId' in pane && typeof pane.profileId === 'string') return pane.profileId
  return 'default'
}

export function BrowserProfileMenu(props: BrowserPreferencesProps & { inline?: boolean }) {
  const { context, pane, onError, inline = false } = props
  const { preferences, loading, stateError, refresh, saveSetting } = useBrowserPreferenceData(context, onError)
  const menuId = useId()
  const controlInstance = pane ? browserPaneControlInstance(pane.id, 'profile-menu') : menuId
  const [menuOpen, setMenuOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedProfile, setSelectedProfile] = useState(() => profileIdForPane(pane))
  const [actionError, setActionError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [profileSwitching, setProfileSwitching] = useState(false)
  const profileSwitchingRef = useRef(false)
  const profileSelectionRequest = useRef(0)
  const paneIdentity = pane?.id
  const paneProfile = profileIdForPane(pane)


  useEffect(() => registerPreferencesController(context, controlInstance, (args) => {
    if (args.action === 'toggle-profile-menu') setMenuOpen((open) => !open)
    else if (args.action === 'open-create-profile') setCreateOpen(true)
    else if (args.action === 'close-create-profile') setCreateOpen(false)
    else if (args.action === 'toggle-import') setImportOpen((open) => !open)
  }), [context, controlInstance])
  useEffect(() => {
    profileSelectionRequest.current += 1
    profileSwitchingRef.current = false
    setProfileSwitching(false)
    setSelectedProfile(paneProfile)
  }, [paneIdentity, paneProfile])

  const profiles = preferences?.profiles ?? []
  const effectiveSelection = pane ? selectedProfile : (profiles.find((row) => row.active)?.profile.id ?? 'default')
  const currentProfile = profiles.find(({ profile }) => profile.id === effectiveSelection)?.profile
  const menuLabel = currentProfile?.label ?? (effectiveSelection === 'default' ? 'Default' : effectiveSelection)

  const runPreferencesControl = (args: Omit<PreferencesControlArgs, 'instance'>) => {
    setActionError(null)
    void requestPreferencesControl(context, { ...args, instance: controlInstance }).catch((cause: unknown) => {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
    })
  }

  const selectProfile = async (profile: BrowserProfile) => {
    if (!pane || profile.id === selectedProfile || profileSwitchingRef.current) return
    const request = ++profileSelectionRequest.current
    profileSwitchingRef.current = true
    setProfileSwitching(true)
    setActionError(null)
    try {
      await context.call('quirky.browser/profileSet', { pane: pane.id, profile: profile.id })
      if (request !== profileSelectionRequest.current) return
      setSelectedProfile(profile.id)
      await refresh().catch(() => {})
    } catch (cause) {
      if (request !== profileSelectionRequest.current) return
      // inline rows sit in a menu that closes on the pick, so the menu's own alert would never be seen
      if (inline) onError(errorMessage(cause))
      else setActionError(errorMessage(cause))
    } finally {
      if (request === profileSelectionRequest.current) {
        profileSwitchingRef.current = false
        setProfileSwitching(false)
      }
    }
  }

  const hideHint = async () => {
    setActionError(null)
    try {
      await saveSetting(BROWSER_SETTING_IDS.browserImportHintHidden, true)
    } catch (cause) {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
    }
  }

  const profileCreated = async (name: string) => {
    await refresh()
    setActionError(null)
    setSuccessMessage(`Profile "${name}" created.`)
  }

  return <div className="browser-profile-menu" style={MENU_LAYOUT_STYLE}>
    {!inline && <Button type="button" className="ui-menu__trigger" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => runPreferencesControl({ action: 'toggle-profile-menu' })}>Profile: {menuLabel}</Button>}
    {actionError && !inline && !menuOpen && <InlineError message={actionError} />}
    {(inline || menuOpen) && <div id={menuId} aria-label="Browser profile menu" style={MENU_CONTENT_STYLE}>
      {loading && !preferences && <div role="status" style={MENU_MESSAGE_STYLE}><NoticeLine>Loading browser profiles…</NoticeLine></div>}
      {stateError && <InlineError message={stateError} />}
      {preferences && <fieldset style={PROFILE_ROWS_STYLE}>
        <legend style={{ color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', fontWeight: 600 }}>Browser profiles</legend>
        {profiles.map(({ profile }) => {
          const sourceLabel = profileSourceLabel(profile)
          return <label key={profile.id} className="ui-menu__item" style={PROFILE_ROW_STYLE}>
            <input
              type="radio"
              style={{ appearance: 'auto', accentColor: 'var(--ui-accent)' }}
              name={`browser-profile-${pane?.id ?? 'current'}`}
              aria-label={`Use ${profile.label} profile`}
              checked={profile.id === effectiveSelection}
              disabled={!pane || profileSwitching}
              onChange={() => void selectProfile(profile)}
            />
            <span style={{ overflowWrap: 'anywhere' }}>{profile.id === effectiveSelection ? '✓ ' : ''}{profile.label}</span>
            {sourceLabel && <span style={PROFILE_SOURCE_STYLE}>{sourceLabel}</span>}
          </label>
        })}
      </fieldset>}
      {actionError && <InlineError message={actionError} />}
      {successMessage && <p role="status" style={MENU_MESSAGE_STYLE}>{successMessage}</p>}
      <div style={MENU_ACTIONS_STYLE}>
        <Button type="button" variant="primary" disabled={loading && !preferences} onClick={() => { setSuccessMessage(null); runPreferencesControl({ action: 'open-create-profile' }) }}>New Profile</Button>
        <Button type="button" aria-expanded={importOpen} onClick={() => runPreferencesControl({ action: 'toggle-import', profile: effectiveSelection })}>Import Cookies</Button>
        <Button type="button" onClick={() => void context.executeCommand('command:quirky.browser/browserSettings').catch((cause: unknown) => {
          const message = errorMessage(cause)
          setActionError(message)
          onError(message)
        })}>Browser Settings…</Button>
      </div>
      {importOpen && <CookieImportPanel context={context} imports={preferences?.imports ?? null} destination={{ id: effectiveSelection, label: menuLabel }} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} onImported={refresh} />}
      {createOpen && <ProfileCreator context={context} onCreated={profileCreated} onCancel={() => runPreferencesControl({ action: 'close-create-profile' })} onError={onError} />}
    </div>}
  </div>
}

export function BrowserImportHint(props: BrowserPreferencesProps) {
  const { context, pane, onError } = props
  const { preferences, loading, stateError, settings, saveSetting, refresh } = useBrowserPreferenceData(context, onError)
  const [expanded, setExpanded] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const fallbackInstance = useId()
  const controlInstance = pane ? browserPaneControlInstance(pane.id, 'import-hint') : fallbackInstance
  useEffect(() => registerPreferencesController(context, controlInstance, (args) => {
    if (args.action === 'toggle-import-hint') setExpanded((open) => !open)
  }), [context, controlInstance])
  const hintProfileId = profileIdForPane(pane)
  const hintProfile = preferences?.profiles.find(({ profile }) => profile.id === hintProfileId)?.profile
  const hintDestination = { id: hintProfileId, label: hintProfile?.label ?? (hintProfileId === 'default' ? 'Default' : hintProfileId) }

  const runPreferencesControl = () => {
    setActionError(null)
    void requestPreferencesControl(context, { action: 'toggle-import-hint', instance: controlInstance }).catch((cause: unknown) => {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
    })
  }

  const hideHint = async () => {
    setActionError(null)
    try {
      await saveSetting(BROWSER_SETTING_IDS.browserImportHintHidden, true)
    } catch (cause) {
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
    }
  }

  if (settings.browserImportHintHidden) return null
  return <aside aria-label="Import browser data hint" style={{ ...MENU_CONTENT_STYLE, background: 'var(--ui-surface)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)', padding: 'var(--ui-space-8)' }}>
    <Button type="button" className="ui-menu__trigger" aria-expanded={expanded} onClick={runPreferencesControl}>Import browser data</Button>
    {actionError && !expanded && <InlineError message={actionError} />}
    {expanded && <div style={MENU_CONTENT_STYLE}>
      {stateError && <InlineError message={stateError} />}
      {actionError && <InlineError message={actionError} />}
      {loading && !preferences ? <div role="status" style={MENU_MESSAGE_STYLE}><NoticeLine>Loading cookie import availability…</NoticeLine></div> : <CookieImportPanel context={context} imports={preferences?.imports ?? null} destination={hintDestination} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} onImported={refresh} />}
    </div>}
  </aside>
}
