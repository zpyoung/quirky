import { useEffect, useId, useRef, useState } from 'react'
import type { BrowserProfile } from '../profiles/store'
import type { BrowserPreferencesProps } from '../preferences/contract'
import { BROWSER_SETTING_IDS, ImportDetails, ProfileCreator, errorMessage, profileSourceLabel, useBrowserPreferenceData } from './shared'

function profileIdForPane(pane: BrowserPreferencesProps['pane']): string {
  if (pane && 'profileId' in pane && typeof pane.profileId === 'string') return pane.profileId
  return 'default'
}

export function BrowserProfileMenu(props: BrowserPreferencesProps & { inline?: boolean }) {
  const { context, pane, onError, inline = false } = props
  const { preferences, loading, stateError, refresh, saveSetting } = useBrowserPreferenceData(context, onError)
  const menuId = useId()
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

  useEffect(() => {
    profileSelectionRequest.current += 1
    profileSwitchingRef.current = false
    setProfileSwitching(false)
    setSelectedProfile(paneProfile)
  }, [paneIdentity, paneProfile])

  const profiles = preferences?.profiles ?? []
  const effectiveSelection = pane ? selectedProfile : (profiles.find((row) => row.active)?.profile.id ?? 'default')
  const currentProfile = profiles.find(({ profile }) => profile.id === effectiveSelection)?.profile
  const menuLabel = currentProfile?.label ?? 'Default'

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
      const message = errorMessage(cause)
      setActionError(message)
      onError(message)
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

  return <div className="browser-profile-menu">
    {!inline && <button type="button" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((open) => !open)}>Profile: {menuLabel}</button>}
    {(inline || menuOpen) && <div id={menuId} aria-label="Browser profile menu">
      {loading && !preferences && <p>Loading browser profiles…</p>}
      {stateError && <p role="alert">{stateError}</p>}
      {preferences && <fieldset>
        <legend>Browser profiles</legend>
        {profiles.map(({ profile }) => {
          const sourceLabel = profileSourceLabel(profile)
          return <label key={profile.id}>
            <input
              type="radio"
              name={`browser-profile-${pane?.id ?? 'current'}`}
              aria-label={`Use ${profile.label} profile`}
              checked={profile.id === effectiveSelection}
              disabled={!pane || profileSwitching}
              onChange={() => void selectProfile(profile)}
            />
            <span>{profile.id === effectiveSelection ? '✓ ' : ''}{profile.label}</span>
            {sourceLabel && <small>{sourceLabel}</small>}
          </label>
        })}
      </fieldset>}
      {actionError && <p role="alert">{actionError}</p>}
      {successMessage && <p role="status">{successMessage}</p>}
      <button type="button" disabled={loading && !preferences} onClick={() => { setCreateOpen(true); setActionError(null); setSuccessMessage(null) }}>New Profile</button>
      <button type="button" aria-expanded={importOpen} onClick={() => setImportOpen((open) => !open)}>Import Cookies</button>
      {importOpen && <ImportDetails context={context} imports={preferences?.imports ?? null} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} />}
      <button type="button" onClick={() => void context.executeCommand('command:quirky.browser/browserSettings').catch((cause: unknown) => {
        const message = errorMessage(cause)
        setActionError(message)
        onError(message)
      })}>Browser Settings…</button>
      {createOpen && <ProfileCreator context={context} onCreated={profileCreated} onCancel={() => setCreateOpen(false)} onError={onError} />}
    </div>}
  </div>
}

export function BrowserImportHint(props: BrowserPreferencesProps) {
  const { context, onError } = props
  const { preferences, loading, stateError, settings, saveSetting } = useBrowserPreferenceData(context, onError)
  const [expanded, setExpanded] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

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
  return <aside aria-label="Import browser data hint">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>Import browser data</button>
    {expanded && <div>
      {stateError && <p role="alert">{stateError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {loading && !preferences ? <p>Loading cookie import availability…</p> : <ImportDetails context={context} imports={preferences?.imports ?? null} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} />}
    </div>}
  </aside>
}
