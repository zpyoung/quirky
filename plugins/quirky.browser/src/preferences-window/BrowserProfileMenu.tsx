import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button } from '@quirky/ui'
import type { BrowserProfile } from '../profiles/store'
import type { BrowserPreferencesProps } from '../preferences/contract'
import { BROWSER_SETTING_IDS, ProfileCreator, errorMessage, profileSourceLabel, useBrowserPreferenceData } from './shared'
import { CookieImportPanel } from './CookieImportPanel'

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
  const menuLabel = currentProfile?.label ?? (effectiveSelection === 'default' ? 'Default' : effectiveSelection)

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

  return <div className="browser-profile-menu" style={MENU_LAYOUT_STYLE}>
    {!inline && <Button type="button" className="ui-menu__trigger" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((open) => !open)}>Profile: {menuLabel}</Button>}
    {(inline || menuOpen) && <div id={menuId} aria-label="Browser profile menu" style={MENU_CONTENT_STYLE}>
      {loading && !preferences && <p role="status" style={MENU_MESSAGE_STYLE}>Loading browser profiles…</p>}
      {stateError && <p className="ui-error-text" role="alert" style={MENU_MESSAGE_STYLE}>{stateError}</p>}
      {preferences && <fieldset style={PROFILE_ROWS_STYLE}>
        <legend style={{ color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', fontWeight: 600 }}>Browser profiles</legend>
        {profiles.map(({ profile }) => {
          const sourceLabel = profileSourceLabel(profile)
          return <label key={profile.id} style={PROFILE_ROW_STYLE}>
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
      {actionError && <p className="ui-error-text" role="alert" style={MENU_MESSAGE_STYLE}>{actionError}</p>}
      {successMessage && <p role="status" style={MENU_MESSAGE_STYLE}>{successMessage}</p>}
      <div style={MENU_ACTIONS_STYLE}>
        <Button type="button" variant="primary" disabled={loading && !preferences} onClick={() => { setCreateOpen(true); setActionError(null); setSuccessMessage(null) }}>New Profile</Button>
        <Button type="button" aria-expanded={importOpen} onClick={() => setImportOpen((open) => !open)}>Import Cookies</Button>
        <Button type="button" onClick={() => void context.executeCommand('command:quirky.browser/browserSettings').catch((cause: unknown) => {
          const message = errorMessage(cause)
          setActionError(message)
          onError(message)
        })}>Browser Settings…</Button>
      </div>
      {importOpen && <CookieImportPanel context={context} imports={preferences?.imports ?? null} destination={{ id: effectiveSelection, label: menuLabel }} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} onImported={refresh} />}
      {createOpen && <ProfileCreator context={context} onCreated={profileCreated} onCancel={() => setCreateOpen(false)} onError={onError} />}
    </div>}
  </div>
}

export function BrowserImportHint(props: BrowserPreferencesProps) {
  const { context, pane, onError } = props
  const { preferences, loading, stateError, settings, saveSetting, refresh } = useBrowserPreferenceData(context, onError)
  const [expanded, setExpanded] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const hintProfileId = profileIdForPane(pane)
  const hintProfile = preferences?.profiles.find(({ profile }) => profile.id === hintProfileId)?.profile
  const hintDestination = { id: hintProfileId, label: hintProfile?.label ?? (hintProfileId === 'default' ? 'Default' : hintProfileId) }

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
    <Button type="button" className="ui-menu__trigger" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>Import browser data</Button>
    {expanded && <div style={MENU_CONTENT_STYLE}>
      {stateError && <p className="ui-error-text" role="alert" style={MENU_MESSAGE_STYLE}>{stateError}</p>}
      {actionError && <p className="ui-error-text" role="alert" style={MENU_MESSAGE_STYLE}>{actionError}</p>}
      {loading && !preferences ? <p role="status" style={MENU_MESSAGE_STYLE}>Loading cookie import availability…</p> : <CookieImportPanel context={context} imports={preferences?.imports ?? null} destination={hintDestination} loadError={stateError} onHideHint={() => void hideHint()} onError={onError} onImported={refresh} />}
    </div>}
  </aside>
}
