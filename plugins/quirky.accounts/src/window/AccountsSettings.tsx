import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { AccountsUiStore, accountSort, ageLabel, credentialLabel, displayIdentity, formatReset, snapshotStatus, windowEntries, type AccountState, type AccountSummary, type CredentialStatus, type ManagedProvider, type PendingLogin } from './model'
import { ACCOUNTS_CSS } from './styles'
import { meterColor, SnapshotLine, UsagePreferencesControls } from './Usage'
import { useStableReport, type UiReport } from './report'

const useStore = (store: AccountsUiStore) => useSyncExternalStore(store.subscribe, store.getSnapshot)
const SETTINGS_SECTIONS: { id: string; title: string }[] = [
  { id: 'claude', title: 'Claude' }, { id: 'codex', title: 'Codex' }, { id: 'gemini', title: 'Gemini CLI (legacy)' },
  { id: 'grok', title: 'Grok (xAI)' }, { id: 'cursor', title: 'Cursor' }, { id: 'credentials', title: 'Meter credentials' }, { id: 'appearance', title: 'Appearance' }
]
const CREDENTIAL_FIELDS: Record<string, { provider: string; label: string; help: string; kinds: { kind: string; input: 'password' | 'text' | 'url' }[] }[]> = {
  minimax: [{ provider: 'minimax', label: 'MiniMax', help: 'Configure a supported MiniMax meter credential. Values are sent only to the local accounts service and are never shown again.', kinds: [
    { kind: 'api-key', input: 'password' }, { kind: 'cookie', input: 'password' }, { kind: 'group-id', input: 'password' }, { kind: 'base-url', input: 'url' }, { kind: 'model', input: 'text' }
  ] }],
  'opencode-go': [{ provider: 'opencode-go', label: 'OpenCode Go', help: 'Configure the credential used for the OpenCode Go usage meter.', kinds: [{ kind: 'api-key', input: 'password' }, { kind: 'cookie', input: 'password' }] }],
  zcode: [{ provider: 'zcode', label: 'ZCode', help: 'Configure the credential used for the ZCode usage meter.', kinds: [{ kind: 'api-key', input: 'password' }, { kind: 'base-url', input: 'url' }] }]
}

function statusBadge(account: AccountSummary, activeId: string | null): { text: string; className: string }[] {
  return [
    ...(account.id === activeId ? [{ text: 'Active', className: 'badge active' }] : []),
    ...(account.needsSignIn ? [{ text: 'Needs sign-in', className: 'badge warning' }] : [])
  ]
}

function LoginLinkNotice({ store, pending, provider }: { store: AccountsUiStore; pending: PendingLogin | null; provider: ManagedProvider }) {
  const loginCancelling = useStore(store).loginCancelling
  if (!pending || pending.provider !== provider) return null
  const isCodex = provider === 'codex'
  const loginUrl = pending.url
  return <div className="login-notice" role="status" aria-live="polite">
    <strong>{pending.status === 'pending' ? isCodex ? 'Codex opened this sign-in link in your browser.' : 'Waiting for Claude sign-in.' : pending.status === 'error' ? 'Sign-in could not be completed.' : pending.status === 'complete' ? 'Sign-in completed.' : 'Sign-in cancelled.'}</strong>
    {isCodex && pending.status === 'pending' && <p>Copy it to finish signing in somewhere else — a private window, or another profile.</p>}
    {pending.status === 'error' && <p className="status-error">Sign-in failed. Check the provider CLI and try again.</p>}
    {loginUrl && <div className="login-actions">
      <button type="button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(loginUrl)
          store.notify('Sign-in link copied', isCodex ? 'Open it in a private window or another browser profile.' : 'Open it in a private window to sign in with a different account.')
        } catch {
          store.notify('Could not copy the link', 'Use the Open link to continue sign-in in your browser.')
        }
      }}>Copy link</button>
      {isCodex && <a href={loginUrl} target="_blank" rel="noopener noreferrer">Open</a>}
    </div>}
    {pending.status === 'pending' && <button type="button" disabled={loginCancelling} onClick={() => void store.cancelLogin()}>{loginCancelling ? 'Cancelling…' : 'Cancel'}</button>}
  </div>
}


function AccountRow({ store, provider, account, state }: { store: AccountsUiStore; provider: ManagedProvider; account: AccountSummary; state: AccountState }) {
  const snapshot = useStore(store)
  const loginBusy = snapshot.loginStarting || snapshot.login?.status === 'pending'
  const [removing, setRemoving] = useState(false)
  const removalLock = useRef(false)
  const badges = statusBadge(account, state.active[provider])
  const providerName = provider === 'claude' ? 'Claude' : 'Codex'
  const remove = async () => {
    if (removalLock.current) return
    removalLock.current = true
    setRemoving(true)
    try {
      await store.removeAccount(provider, account.id)
    } finally {
      removalLock.current = false
      setRemoving(false)
    }
  }
  return <div className="account-row">
    <div className="account-row-main"><div className="row-badges"><strong>{account.label}</strong>{badges.map((badge) => <span key={badge.text} className={badge.className}>{badge.text}</span>)}</div>
      <small>{[account.email, account.organization, account.lastAuthenticatedAt ? `Last signed in ${new Date(account.lastAuthenticatedAt).toLocaleDateString()}` : null].filter(Boolean).join(' · ') || 'Managed account on this device'}</small>
      {account.needsSignIn && <small className="status-error">Sign in again to use this account.</small>}
    </div>
    <div className="account-actions">
      {account.needsSignIn && <>
        <button type="button" disabled={loginBusy} onClick={() => void store.beginLogin(provider, { accountId: account.id })}>{provider === 'claude' ? 'Sign in again' : 'Re-authenticate'}</button>
        {provider === 'claude' && <details><summary aria-label="More sign-in options">More sign-in options</summary><button type="button" disabled={loginBusy} onClick={() => void store.beginLogin('claude', { accountId: account.id, copyLink: true })}>Copy sign-in link instead</button></details>}
      </>}
      {!account.needsSignIn && <button type="button" aria-label={`Select ${providerName} account ${account.label}`} disabled={state.active[provider] === account.id} onClick={() => void store.selectAccount(provider, account.id)}>{state.active[provider] === account.id ? 'Active' : 'Select'}</button>}
      <button type="button" aria-label={`Remove ${providerName} account ${account.label}`} disabled={removing} onClick={() => void remove()}>{removing ? 'Removing…' : 'Remove'}</button>
    </div>
  </div>
}

function ManagedAccountsSection({ store, provider }: { store: AccountsUiStore; provider: ManagedProvider }) {
  const snapshot = useStore(store)
  const state = snapshot.accounts
  const providerName = provider === 'claude' ? 'Claude' : 'Codex'
  const system = state?.systemDefault[provider]
  const accounts = (state?.accounts ?? []).filter((account) => account.provider === provider).sort(accountSort)
  const pending = snapshot.login ?? state?.pendingLogin ?? null
  const anyPending = snapshot.loginStarting || pending?.status === 'pending'
  const configWarnings = provider === 'codex' && state
    ? state.configWarnings.filter((warning) => warning.provider === 'codex' && warning.accountId === state.active.codex)
    : []
  return <div className="account-stack">
    <section className="section-card">
      <h2>{providerName} accounts</h2>
      <p className="settings-description">Optional. Quirky can use your normal {providerName} login; add accounts only if you want quick switching without moving chat sessions. Managed accounts keep their sign-in context separate on this device.</p>
      <p className="settings-description">Account changes apply to future {providerName} launches. Running sessions keep the account they started with.</p>
      <div className="section-heading"><h3>Accounts</h3><small>Showing accounts for this device. New accounts are added there.</small></div>
      <div className="account-list">
        <div className="account-row">
          <div className="account-row-main"><strong>{system?.email ? `System default: ${system.email}` : 'System default'}</strong><small>{displayIdentity(system ?? { email: null, authKind: 'none', hasAuth: false })}</small>{provider === 'claude' && <small>Use the system default Claude login.</small>}{provider === 'codex' && !system?.hasAuth && <small>No Codex sign-in was found for this device.</small>}</div>
          <div className="account-actions">{state?.active[provider] === null && <span className="badge active">Active</span>}{provider === 'codex' && system && !system.hasAuth && <span className="badge warning">Needs sign-in</span>}<button type="button" aria-label={`Select ${providerName} System default`} disabled={!state || state.active[provider] === null} onClick={() => void store.selectAccount(provider, null)}>{state?.active[provider] === null ? 'Active' : 'Select'}</button>{system?.hasAuth && <span className="badge">{system.authKind === 'api-key' ? 'API key' : 'Signed in'}</span>}</div>
        </div>
        {accounts.length ? accounts.map((account) => <AccountRow key={account.id} store={store} provider={provider} account={account} state={state!} />) : <p className="empty-note">No managed {providerName} accounts yet.</p>}
      </div>
      {configWarnings.length > 0 && <section className="section-card" role="status" aria-label="Codex configuration warnings">
        <h3>Codex settings sync</h3>
        {configWarnings.map((warning, index) => <p className="status-error" key={`${warning.accountId ?? 'system'}-${warning.kind}-${index}`}>{warning.message}</p>)}
      </section>}
      {provider === 'claude' ? <div className="details-actions">
        <button type="button" disabled={Boolean(anyPending)} onClick={() => void store.beginLogin('claude')}>{anyPending ? 'Signing in…' : 'Add Account'}</button>
        <details><summary aria-label="More sign-in options">More sign-in options</summary><button type="button" disabled={Boolean(anyPending)} onClick={() => void store.beginLogin('claude', { copyLink: true })}>Copy sign-in link instead</button></details>
      </div> : <button type="button" disabled={Boolean(anyPending)} onClick={() => void store.beginLogin('codex')}>{anyPending ? 'Signing in…' : 'Add Account'}</button>}
      {pending?.provider === provider && <LoginLinkNotice store={store} pending={pending} provider={provider} />}
    </section>
    {provider === 'claude' && <section className="section-card">
      <h3>When you switch accounts while Claude is running</h3>
      <p className="settings-description">Restarting continues each running conversation on the new account.</p>
      <select className="form-control" aria-label="Claude running-session switch policy" value={state?.preferences.claudeSwitchPolicy ?? 'ask'} onChange={(event) => {
        const value = event.currentTarget.value
        if (value === 'ask' || value === 'always' || value === 'never') void store.setPreferences({ claudeSwitchPolicy: value })
      }}>
        <option value="ask">Ask</option><option value="always">Always restart</option><option value="never">Never restart</option>
      </select>
    </section>}
  </div>
}

function ProviderReadOnlySettings({ store, provider }: { store: AccountsUiStore; provider: 'grok' | 'cursor' }) {
  const snapshot = useStore(store)
  const title = provider === 'grok' ? 'Grok (xAI)' : 'Cursor'
  const usage = snapshot.usage?.providers.find((item) => item.provider === provider)
  const status = usage ? snapshotStatus(usage) : null
  const source = usage?.usageMetadata?.credentialSource
  const signedIn = Boolean(usage && !status?.signedOut && (usage.status === 'ok' || usage.status === 'fetching' || usage.status === 'error' || source))
  const helpUrl = provider === 'grok' ? 'https://docs.x.ai/' : 'https://cursor.com/dashboard'
  const statusText = provider === 'grok'
    ? signedIn ? status?.label === 'Sign-in expired' ? 'Session expired — run grok on this computer and refresh usage.' : 'Signed in. Quirky reads the Grok CLI session without changing it.' : 'Not signed in to Grok CLI. In a terminal, run grok login, then refresh usage here.'
    : signedIn ? status?.label === 'Sign-in expired' ? 'Sign-in expired — run cursor-agent login on this computer, then refresh usage.' : `Signed in${source ? ` · ${sourceName(source)}` : ''}. Quirky only reads the existing Cursor sign-in.` : 'No Cursor sign-in found on this computer.'
  const windows = usage ? windowEntries(usage) : []
  return <section className="section-card">
    <div className="section-heading"><h2>{title}</h2><button type="button" aria-label={`Refresh ${title} usage`} disabled={snapshot.refreshing} onClick={() => void store.refresh(provider)}>Refresh usage</button></div>
    <p className="settings-description">{provider === 'grok' ? 'Shows weekly credit usage from your existing Grok CLI sign-in. Quirky never refreshes or changes Grok credentials.' : 'Shows monthly Cursor plan usage from the sign-in already on this computer. Quirky only reads it — it never changes your Cursor login.'}</p>
    <p className={status?.kind === 'warning' ? 'status-error' : ''} role="status">{statusText}</p>
    {source && <p className="muted">Credential source: {sourceName(source)} · {usage ? ageLabel(usage.updatedAt) : 'Not refreshed yet'}</p>}
    <div className="details-actions"><a href={helpUrl} target="_blank" rel="noopener noreferrer">{provider === 'grok' ? 'Grok CLI docs' : 'Cursor dashboard'}</a></div>
    {usage && <>
      <div className="usage-window-list">{windows.map(({ name, window }) => <div key={name} className="usage-window">
        <div className="usage-window-heading"><strong>{provider === 'grok' ? name === '7d' ? 'Weekly credits' : name === '30d' ? 'Monthly usage' : name : provider === 'cursor' ? name === '30d' ? 'Monthly plan usage' : name : name}</strong><span>{Math.round(window.usedPercent)}% used</span></div>
        <div className="meter" role="meter" aria-label={`${name} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.usedPercent)}><span style={{ width: `${window.usedPercent}%`, backgroundColor: meterColor(window.usedPercent) }} /></div>
        <small>Resets {formatReset(window)}</small>
      </div>)}</div>
      <SnapshotLine snapshot={usage} />
    </>}
  </section>
}

function sourceName(source: string): string {
  if (source === 'keychain' || source === 'macos-keychain') return 'macOS Keychain (cursor-agent)'
  if (source === 'cli' || source === 'cursor-agent') return 'Cursor CLI auth file'
  if (source === 'ide' || source === 'desktop') return 'Cursor IDE'
  return 'Provider sign-in'
}

function CredentialField({ store, provider, kind, inputType, statuses }: { store: AccountsUiStore; provider: string; kind: string; inputType: 'password' | 'text' | 'url'; statuses: CredentialStatus[] }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const actionLock = useRef(false)
  const status = statuses.find((candidate) => candidate.provider === provider && candidate.kind === kind)
  const busy = saving || clearing
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value || actionLock.current) return
    actionLock.current = true
    setSaving(true)
    setActionError(null)
    try {
      if (await store.setCredential(provider, kind, value)) setValue('')
      else setActionError('Could not confirm saving this credential. Check its status before retrying.')
    } finally {
      actionLock.current = false
      setSaving(false)
    }
  }
  const clear = async () => {
    if (actionLock.current) return
    actionLock.current = true
    setClearing(true)
    setActionError(null)
    try {
      if (!await store.clearCredential(provider, kind)) setActionError('Could not confirm clearing this credential. Check its status before retrying.')
    } finally {
      actionLock.current = false
      setClearing(false)
    }
  }
  return <div className="credential-row">
    <div className="account-row-main"><strong>{credentialLabel(kind)}</strong><small role="status">{status?.configured ? status.readable ? 'Configured · Readable' : 'Configured · Not readable' : 'Not configured'}</small>{actionError && <small className="status-error" role="alert">{actionError}</small>}</div>
    <form className="credential-entry" onSubmit={save}>
      <input className="form-control" aria-label={`${provider} ${credentialLabel(kind)}`} type={inputType} autoComplete="off" spellCheck={false} disabled={busy} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
      <button type="submit" disabled={!value || busy}>{saving ? 'Saving…' : 'Set'}</button>
      {status?.configured && <button type="button" disabled={busy} onClick={() => void clear()}>{clearing ? 'Clearing…' : 'Clear'}</button>}
    </form>
  </div>
}

function MeterCredentials({ store }: { store: AccountsUiStore }) {
  const snapshot = useStore(store)
  return <div className="account-stack">
    <section className="section-card">
      <h2>Provider meter credentials</h2>
      <p className="settings-description">Credential values are stored by the accounts service. Values never appear in account state or usage reports. Password fields clear after a successful save.</p>
    </section>
    {Object.values(CREDENTIAL_FIELDS).flat().map((group) => <section className="section-card" key={group.provider}>
      <h3>{group.label}</h3><p className="settings-description">{group.help}</p>
      {group.kinds.map((field) => <CredentialField key={field.kind} store={store} provider={group.provider} kind={field.kind} inputType={field.input} statuses={snapshot.credentials} />)}
    </section>)}
  </div>
}

const GEMINI_CLI_OAUTH_SETTING_ID = 'setting:quirky.accounts/gemini-cli-oauth-enabled'

function GeminiCliSettings({ context }: { context: UiPluginContext }) {
  const [enabled, setEnabled] = useState(() => context.getSetting(GEMINI_CLI_OAUTH_SETTING_ID) === true)
  const [saving, setSaving] = useState(false)

  useEffect(() => context.subscribe((event) => {
    if (event.type === 'setting.changed' && event.id === GEMINI_CLI_OAUTH_SETTING_ID) {
      setEnabled(context.getSetting(GEMINI_CLI_OAUTH_SETTING_ID) === true)
    }
  }), [context])

  const update = async (value: boolean) => {
    setSaving(true)
    try {
      await context.call('setting.set', { id: GEMINI_CLI_OAUTH_SETTING_ID, value })
      setEnabled(value)
    } catch {
      context.toast('Could not update Gemini CLI access', 'The setting could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="section-card">
    <h2>Gemini CLI (legacy)</h2>
    <p className="settings-description">Gemini CLI OAuth credential refresh is opt-in. When enabled, Quirky may let Gemini CLI refresh its local OAuth credentials for quota checks. It is off until you explicitly enable it.</p>
    <p className="settings-description">Usage checks do not send prompts, run models, sign you in, or change the active Gemini account.</p>
    <label className="checkbox-row"><input type="checkbox" aria-label="Allow Gemini CLI OAuth credential refresh" checked={enabled} disabled={saving} onChange={(event) => void update(event.currentTarget.checked)} />Allow Gemini CLI OAuth credential refresh</label>
    {saving && <small className="loading-indicator">Saving…</small>}
  </section>
}


function SettingsSection({ context, store, id }: { context: UiPluginContext; store: AccountsUiStore; id: string }) {
  const state = useStore(store).accounts
  if (id === 'claude' || id === 'codex') return <ManagedAccountsSection store={store} provider={id} />
  if (id === 'gemini') return <GeminiCliSettings context={context} />
  if (id === 'grok' || id === 'cursor') return <ProviderReadOnlySettings store={store} provider={id} />
  if (id === 'credentials') return <MeterCredentials store={store} />
  return <UsagePreferencesControls store={store} preferences={state?.preferences ?? { mode: 'compact', direction: 'used', hidden: false, visibleProviders: [], density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false }} />
}

function selectedAccountReport(state: AccountState | null, provider: ManagedProvider): { label: string; status: string } {
  if (!state) return { label: 'Loading', status: 'Loading' }
  const id = state.active[provider]
  if (id === null) return { label: 'System default', status: state.systemDefault[provider].hasAuth ? 'Signed in' : 'Not signed in' }
  const account = state.accounts.find((candidate) => candidate.provider === provider && candidate.id === id)
  if (!account) return { label: 'Unavailable', status: 'Unavailable' }
  return { label: account.label, status: account.needsSignIn ? 'Needs sign-in' : 'Active' }
}

export function AccountsSettings({ context, store, report }: { context: UiPluginContext; store: AccountsUiStore; report?: UiReport }) {
  const snapshot = useStore(store)
  const section = SETTINGS_SECTIONS.some((item) => item.id === snapshot.ui.settingsSection) ? snapshot.ui.settingsSection! : 'claude'
  const warnings = snapshot.accounts?.configWarnings.filter((warning) => warning.provider === 'codex' && warning.accountId === snapshot.accounts?.active.codex).map(({ kind, message }) => ({ kind, message })) ?? []
  const reportState = {
    view: 'accounts-settings',
    section,
    accounts: {
      claude: selectedAccountReport(snapshot.accounts, 'claude'),
      codex: selectedAccountReport(snapshot.accounts, 'codex')
    },
    configWarnings: warnings,
    pendingLogin: snapshot.login ? { provider: snapshot.login.provider, status: snapshot.login.status } : null,
    pendingRestarts: snapshot.accounts?.staleSessions.map((session) => ({
      provider: session.provider, accountLabel: session.accountLabel, selectedLabel: session.selectedLabel,
      busy: session.busy, queued: session.queued, kept: session.kept, hasError: Boolean(session.error)
    })) ?? [],
    loading: snapshot.loading,
    refreshing: snapshot.refreshing
  }
  useStableReport(report, reportState)
  return <div className="accounts-ui settings-shell">
    <style>{ACCOUNTS_CSS}</style>
    <nav className="settings-nav" aria-label="AI Provider Accounts settings">
      <strong>AI Provider Accounts</strong>
      {SETTINGS_SECTIONS.map((item) => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => void store.setUiState({ settingsSection: item.id })}>{item.title}</button>)}
      <button type="button" onClick={() => void store.refresh()}>Refresh usage</button>
      <button type="button" onClick={() => context.closeView()}>Close settings</button>
    </nav>
    <main className="settings-content" aria-label={`${SETTINGS_SECTIONS.find((item) => item.id === section)?.title ?? 'Accounts'} settings`}>
      <section>
        <div className="section-heading"><h1>{SETTINGS_SECTIONS.find((item) => item.id === section)?.title ?? 'Accounts'}</h1>{snapshot.refreshing && <small className="loading-indicator">Refreshing…</small>}</div>
        {snapshot.error && <p className="status-error" role="alert">{snapshot.error}</p>}
        <SettingsSection key={section} context={context} store={store} id={section} />
      </section>
    </main>
  </div>
}
