import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Badge, Button, Dialog, EmptyState, FormRow, IconButton, SectionHeader, Tabs } from '@quirky/ui'
import { useStableReport, type UiReport } from './report'
import {
  ageLabel, accountSort, AccountsUiStore, canShowProviderVisibility, compactWindow, displayIdentity, displayPercent, formatReset, isConfigured, isCurrentSnapshot, maxUsed, providerSource,
  PROVIDER_BADGES, PROVIDER_LABELS, snapshotStatus, windowEntries,
  type AccountState, type CredentialStatus, type ManagedProvider, type Preferences, type ProviderId, type ProviderSnapshot, type ResetCreditResult, type ResetExpectedScope, type StaleSession, type UsageState, type WindowData
} from './model'
import { fitUsagePrefix } from './usage-fit'

const useStore = (store: AccountsUiStore) => useSyncExternalStore(store.subscribe, store.getSnapshot)
const MANAGE_LABEL = 'Manage Accounts…'
const CREDIT_BALANCE_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const MODE_TABS = [{ id: 'detailed', label: 'Detailed' }, { id: 'compact', label: 'Compact' }] as const
const DIRECTION_TABS = [{ id: 'used', label: 'Used' }, { id: 'remaining', label: 'Remaining' }] as const

export function meterColor(used: number): string {
  if (used >= 80) return 'var(--ui-failing)'
  if (used >= 60) return 'var(--ui-needs-you)'
  return 'var(--ui-accent)'
}

function Letter({ provider }: { provider: ProviderId }) {
  return <span className={`provider-letter provider-${provider}`} aria-hidden="true">{PROVIDER_BADGES[provider]}</span>
}

function Meter({ window, direction, label }: { window: WindowData; direction: Preferences['direction']; label: string }) {
  const used = Math.round(window.usedPercent)
  const value = displayPercent(window.usedPercent, direction)
  return <div className="usage-window" aria-label={`${label}: ${value}% ${direction}`}>
    <div className="usage-window-heading"><span>{label}</span><span style={{ color: meterColor(used) }}>{value}% {direction === 'used' ? 'used' : 'remaining'}</span></div>
    <div className="meter" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <span style={{ width: `${value}%`, backgroundColor: meterColor(used) }} />
    </div>
    <small>Resets {formatReset(window)}</small>
  </div>
}

export function SnapshotLine({ snapshot }: { snapshot: ProviderSnapshot }) {
  const state = snapshotStatus(snapshot)
  const tone = state.kind === 'danger' ? 'status-danger' : state.kind === 'warning' ? 'status-error' : state.kind === 'ready' ? 'status-ready' : 'status-loading'
  const source = providerSource(snapshot)
  return <div className="info-line">
    <span className={tone} aria-live="polite">{state.label}{snapshot.status === 'error' && (snapshot.session || snapshot.weekly || snapshot.monthly || snapshot.fableWeekly || snapshot.buckets?.length) ? ' — showing last good usage' : ''}</span>
    <small title={source ? `Source: ${source}. ${ageLabel(snapshot.updatedAt)}.` : `${ageLabel(snapshot.updatedAt)}.`}>{ageLabel(snapshot.updatedAt)}</small>
  </div>
}

function StatusChip({ store, snapshot, preferences }: { store: AccountsUiStore; snapshot: ProviderSnapshot; preferences: Preferences }) {
  const state = snapshotStatus(snapshot)
  const headline = compactWindow(snapshot)
  const windows = windowEntries(snapshot)
  const tooltip = [PROVIDER_LABELS[snapshot.provider], state.label, ageLabel(snapshot.updatedAt), providerSource(snapshot)]
    .filter(Boolean).join(' · ')
  const actionHeadline = headline && snapshot.status !== 'idle' && snapshot.status !== 'unavailable'
    ? headline
    : null
  const reset = actionHeadline ? formatReset(actionHeadline.window) : null
  const resetSummary = !reset || reset === 'reset time unavailable'
    ? null
    : reset === 'now'
      ? 'resets now'
      : actionHeadline && actionHeadline.window.resetsAt !== null
        ? `resets in ${reset}`
        : `resets ${reset}`
  const actionSummary = actionHeadline
    ? `${displayPercent(actionHeadline.window.usedPercent, preferences.direction)}% ${preferences.direction}${snapshot.status === 'error' || snapshot.status === 'fetching' ? ` · ${state.label}` : ''}${resetSummary ? ` · ${resetSummary}` : ''}`
    : state.label
  const chipProps = {
    type: 'button' as const,
    'data-provider': snapshot.provider,
    title: tooltip,
    'aria-label': `Open ${PROVIDER_LABELS[snapshot.provider]} usage details — ${actionSummary}`,
    onClick: () => {
      void store.setUiState({
        open: true,
        provider: snapshot.provider,
        ...(snapshot.provider === 'claude' || snapshot.provider === 'codex' ? { expanded: null } : {})
      })
    }
  }
  if (snapshot.status === 'unavailable') return <Button {...chipProps} className={`usage-chip status-${state.kind}`}>
    <Letter provider={snapshot.provider} />{preferences.density === 'normal' && <span>--</span>}
  </Button>
  if (snapshot.status === 'idle' || snapshot.status === 'fetching' && !headline) return <Button {...chipProps} className="usage-chip status-loading loading-indicator">
    <Letter provider={snapshot.provider} />{preferences.density === 'normal' && <span>···</span>}
  </Button>
  if (!headline) return <Button {...chipProps} className={`usage-chip ${snapshot.status === 'error' ? 'status-error' : 'status-loading'}`}>
    <Letter provider={snapshot.provider} />{preferences.density === 'normal' && <span>{snapshot.status === 'error' ? '! ' : ''}{state.label}</span>}
  </Button>
  return <Button {...chipProps} className="usage-chip">
    <Letter provider={snapshot.provider} />
    {preferences.density === 'normal' && (preferences.mode === 'compact'
      ? <span style={{ color: meterColor(headline.window.usedPercent) }}>{displayPercent(headline.window.usedPercent, preferences.direction)}% {formatReset(headline.window)}</span>
      : <span className="usage-detailed-chip">{windows.map(({ name, window }) => <span key={name} style={{ color: meterColor(window.usedPercent) }}>{name} {displayPercent(window.usedPercent, preferences.direction)}% <i className="meter" aria-hidden="true"><i style={{ width: `${displayPercent(window.usedPercent, preferences.direction)}%`, backgroundColor: meterColor(window.usedPercent) }} /></i></span>)}</span>)}
    {snapshot.status === 'error' && <span className="status-error" aria-label={state.label}>!</span>}
    {snapshot.status === 'fetching' && <span className="loading-indicator" aria-label="Refreshing">···</span>}
  </Button>
}

function UsageControls({ preferences, setPreferences }: { preferences: Preferences; setPreferences(patch: Partial<Preferences>): Promise<void> }) {
  return <div className="usage-controls">
    <Tabs label="Usage footer detail" items={MODE_TABS} value={preferences.mode} onChange={(id) => {
      if (id === 'detailed' || id === 'compact') void setPreferences({ mode: id })
    }} />
    <Tabs label="Usage percentage display" items={DIRECTION_TABS} value={preferences.direction} onChange={(id) => {
      if (id === 'used' || id === 'remaining') void setPreferences({ direction: id })
    }} />
  </div>
}

export function UsagePreferencesControls({ store, preferences }: { store: AccountsUiStore; preferences: Preferences }) {
  const visible = new Set(preferences.visibleProviders)
  const agentDetection = useStore(store).agentDetection
  const visibilityProviders = PROVIDER_LABELS_LIST.filter(([provider]) => canShowProviderVisibility(provider, agentDetection))
  return <div className="account-stack">
    <section className="section-card">
      <SectionHeader title="Usage display" />
      <p className="settings-description">Choose how provider usage appears in the status bar and Usage popover.</p>
      <UsageControls preferences={preferences} setPreferences={(patch) => store.setPreferences(patch)} />
      <FormRow label="Hide usage from the status bar" htmlFor="accounts-hide-status">
        <input id="accounts-hide-status" type="checkbox" checked={preferences.hidden} onChange={(event) => void store.setPreferences({ hidden: event.currentTarget.checked })} />
      </FormRow>
      <FormRow label="Show provider badges only" htmlFor="accounts-icon-density">
        <input id="accounts-icon-density" type="checkbox" checked={preferences.density === 'icons'} onChange={(event) => void store.setPreferences({ density: event.currentTarget.checked ? 'icons' : 'normal' })} />
      </FormRow>
    </section>
    <section className="section-card">
      <SectionHeader title="Status bar providers" />
      <p className="settings-description">Choose which configured provider meters are visible.</p>
      {agentDetection.status !== 'ready' && <small role="status">{agentDetection.status === 'loading' ? 'Checking installed agent CLIs…' : 'Agent detection is unavailable; CLI-specific toggles are hidden. Refresh usage to retry.'}</small>}
      {visibilityProviders.map(([provider, label]) => {
        const id = `accounts-provider-usage-${provider}`
        return <FormRow key={provider} label={`${label} Usage`} htmlFor={id}>
          <input id={id} type="checkbox" aria-label={`${label} Usage`} checked={visible.has(provider)} onChange={(event) => {
            const next = new Set(visible)
            if (event.currentTarget.checked) next.add(provider)
            else next.delete(provider)
            void store.setPreferences({ visibleProviders: [...next] })
          }} />
        </FormRow>
      })}
    </section>
  </div>
}

const PROVIDER_LABELS_LIST = Object.entries(PROVIDER_LABELS) as [ProviderId, string][]

function EmptyUsage({ store }: { store: AccountsUiStore }) {
  return <div className="usage-cta">
    <EmptyState message="Configure usage tracking" action={{ label: MANAGE_LABEL, onAction: () => void store.openSettingsSection('claude') }} />
    <p>Connect your AI provider accounts to see their usage in real time and easily switch between accounts.</p>
    <Button type="button" aria-label="Hide from status bar" onClick={() => {
      void store.setPreferences({ hidden: true })
      void store.setUiState({ open: false })
    }}>Hide from status bar</Button>
  </div>
}

function ProviderRoster({ store, usage, accounts, preferences, credentials }: { store: AccountsUiStore; usage: UsageState | null; accounts: AccountState | null; preferences: Preferences; credentials: CredentialStatus[] }) {
  const configured = (usage?.providers ?? []).filter((snapshot) => isCurrentSnapshot(snapshot, accounts) && isConfigured(snapshot, accounts, credentials))
    .sort((a, b) => (maxUsed(b) ?? -1) - (maxUsed(a) ?? -1) || PROVIDER_LABELS[a.provider].localeCompare(PROVIDER_LABELS[b.provider]))
  if (!configured.length) {
    const accountConfigured = Boolean(accounts && (
      accounts.accounts.some((account) => !account.needsSignIn) || accounts.systemDefault.claude.hasAuth || accounts.systemDefault.codex.hasAuth
    ))
    const credentialConfigured = credentials.some((credential) => credential.configured)
    return accountConfigured || credentialConfigured
      ? <div role="status"><EmptyState message="Usage for the selected account is loading. Refresh if it does not appear." /></div>
      : <EmptyUsage store={store} />
  }
  const staleCodex = accounts?.staleSessions.filter((session) => session.provider === 'codex').length ?? 0
  return <div className="provider-list" aria-label="Provider usage">
    {configured.map((snapshot) => {
      const status = snapshotStatus(snapshot)
      const best = compactWindow(snapshot)
      const stale = snapshot.provider === 'codex' ? staleCodex : 0
      const rowLabel = snapshot.provider === 'claude' ? 'Open Claude details and account switcher' : snapshot.provider === 'codex' ? 'Open Codex details and account switcher' : 'Open usage details'
      return <Button type="button" className="provider-row" key={snapshot.provider} aria-label={rowLabel} onClick={() => {
        void store.setUiState({ provider: snapshot.provider, ...(snapshot.provider === 'claude' || snapshot.provider === 'codex' ? { expanded: null } : {}) })
      }}><span className="provider-row-main">
        <span className="provider-row-label"><Letter provider={snapshot.provider} /><strong>{PROVIDER_LABELS[snapshot.provider]}</strong>{snapshot.status === 'error' && <span className="status-error" aria-label={status.label}>!</span>}</span>
        <small className={best ? undefined : `status-${status.kind}`} style={best ? { color: meterColor(best.window.usedPercent) } : undefined}>{best ? `${displayPercent(best.window.usedPercent, preferences.direction)}% ${preferences.direction} · resets ${formatReset(best.window)}` : status.label}{stale ? ` · ${stale} session${stale === 1 ? '' : 's'} on old account` : ''}</small>
      </span>
      <span className="provider-summary" aria-hidden="true">{best ? `${displayPercent(best.window.usedPercent, preferences.direction)}%` : snapshot.status === 'unavailable' ? '--' : '›'}</span></Button>
    })}
  </div>
}

function InactiveUsage({ snapshot, direction, active = false }: { snapshot: ProviderSnapshot | undefined; direction: Preferences['direction']; active?: boolean }) {
  if (!snapshot) return <small className="muted">{active ? 'Current account usage has not been read yet.' : 'Usage will load when this account is expanded.'}</small>
  const entries = windowEntries(snapshot)
  if (!entries.length) return <small className={`status-${snapshotStatus(snapshot).kind}`}>{snapshotStatus(snapshot).label}</small>
  return <div className="usage-window-list">{entries.map(({ name, window }) => <Meter key={name} window={window} direction={direction} label={name} />)}</div>
}

function AccountSwitcher({ store, provider, state, usage }: { store: AccountsUiStore; provider: ManagedProvider; state: AccountState | null; usage: UsageState | null }) {
  const snapshot = useStore(store)
  const accounts = (state?.accounts ?? []).filter((account) => account.provider === provider).sort(accountSort)
  const selectedId = state?.active[provider] ?? null
  const selected = accounts.find((account) => account.id === selectedId)
  const system = state?.systemDefault[provider]
  const expanded = snapshot.ui.expanded === provider
  const scopeUnavailable = snapshot.scope.kind === 'remote' && snapshot.scope.status !== 'ready'
  const systemActive = state?.active[provider] === null
  const ProviderName = provider === 'claude' ? 'Claude' : 'Codex'
  const selectedLabel = selected?.label ?? (system?.email ? `System default: ${system.email}` : 'System default')
  return <section className="provider-details" aria-label={`${ProviderName} account switcher`}>
    <div className="row-heading"><strong>{ProviderName} Account</strong><Button type="button" className="account-picker" aria-label={expanded ? 'Collapse account choices' : 'Expand account choices'} aria-description={selectedLabel} title={selectedLabel} aria-expanded={expanded} onClick={() => {
      void store.setUiState({ expanded: expanded ? null : provider })
      if (!expanded && !scopeUnavailable) void store.inactiveUsage(provider)
    }}><span className="account-picker-label">{expanded ? 'Hide accounts' : selectedLabel}</span><span className="account-picker-chevron" aria-hidden="true">⌄</span></Button></div>
    {expanded && <div className="account-list" role="group" aria-label={`${ProviderName} account choices`}>
      <div className="account-row">
        <div className="account-row-main"><strong>{system?.email ? `System default: ${system.email}` : 'System default'}</strong><small>{displayIdentity(system ?? { email: null, authKind: 'none', hasAuth: false })}</small>{provider === 'claude' && <small>Use the system default Claude login.</small>}{provider === 'codex' && !system?.hasAuth && <small>No Codex sign-in was found for this device.</small>}{systemActive && <InactiveUsage snapshot={usage?.providers.find((item) => item.provider === provider && item.accountId === null)} direction={state?.preferences.direction ?? 'used'} active />}</div>
        <div className="account-actions">{systemActive && <Badge tone="accent">Active</Badge>}{provider === 'codex' && system && !system.hasAuth && <Badge tone="needs-you">Needs sign-in</Badge>}<Button type="button" aria-label={`Select ${ProviderName} System default`} disabled={!state || systemActive || scopeUnavailable} onClick={() => void store.selectAccount(provider, null)}>{!state ? 'Loading' : systemActive ? 'Active' : 'Select'}</Button></div>
      </div>
      {accounts.map((account) => {
        const active = account.id === selectedId
        const accountUsage = active
          ? usage?.providers.find((item) => item.provider === provider && item.accountId === account.id)
          : usage?.inactive[`${provider}:${account.id}`]
        return <div className="account-row" key={account.id}>
          <div className="account-row-main"><div className="row-badges"><strong>{account.label}</strong>{active && <Badge tone="accent">Active</Badge>}{account.needsSignIn && <Badge tone="needs-you">Needs sign-in</Badge>}</div><small>{[account.email, account.organization, account.lastAuthenticatedAt ? `Signed in ${new Date(account.lastAuthenticatedAt).toLocaleDateString()}` : null].filter(Boolean).join(' · ') || 'Managed account'}</small>{account.needsSignIn && <small className="status-error">Sign in again to use this account.</small>}<InactiveUsage snapshot={accountUsage} direction={state?.preferences.direction ?? 'used'} active={active} /></div>
          <div className="account-actions"><Button type="button" aria-label={`Select ${ProviderName} account ${account.label}`} disabled={!state || account.needsSignIn || active || scopeUnavailable} onClick={() => void store.selectAccount(provider, account.id)}>{active ? 'Active' : account.needsSignIn ? 'Needs sign-in' : 'Select'}</Button></div>
        </div>
      })}
      {!accounts.length && <EmptyState message={`No managed ${ProviderName} accounts. Add one in Account settings.`} />}
    </div>}
  </section>
}

function StaleSessionActions({ store, session, disabled = false }: { store: AccountsUiStore; session: StaleSession; disabled?: boolean }) {
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const submissionLock = useRef(false)
  const actionKey = `${session.sessionId}:${session.selectionRevision}`
  const failureMessage = failure?.key === actionKey ? failure.message : null
  const run = async (action: 'keep' | 'restart') => {
    if (submissionLock.current || disabled) return
    submissionLock.current = true
    setSubmitting(true)
    setFailure(null)
    try {
      const result = action === 'keep'
        ? await store.keep([session.sessionId], session.selectionRevision)
        : await store.restart([session.sessionId], session.selectionRevision)
      if (result !== 'applied') {
        setFailure({
          key: actionKey,
          message: result === 'selection-changed'
            ? 'The account selection changed. Refresh account state before choosing again.'
            : `Could not confirm ${action === 'keep' ? 'keeping' : 'restarting'} this session. Refresh account state before trying again.`
        })
      }
    } finally {
      submissionLock.current = false
      setSubmitting(false)
    }
  }
  return <div className="account-stack">
    {session.provider === 'claude' && session.busy && session.queued && <small className="status-loading">Waiting for this Claude session to finish before restarting on {session.selectedLabel}.</small>}
    {session.kept ? <small className="muted">Kept on {session.accountLabel}.</small> : <div className="details-actions">
      <Button type="button" disabled={disabled || submitting} onClick={() => void run('keep')}>{session.provider === 'codex' ? 'Keep old account' : 'Keep as is'}</Button>
      <Button type="button" disabled={disabled || submitting} onClick={() => void run('restart')}>{session.provider === 'codex' ? 'Restart' : 'Restart session'}</Button>
    </div>}
    {failureMessage && <small className="status-error" role="alert">{failureMessage}</small>}
  </div>
}

function ResetCredit({ store, snapshot, accounts, disabled = false }: { store: AccountsUiStore; snapshot: ProviderSnapshot | undefined; accounts: AccountState | null; disabled?: boolean }) {
  const offer = snapshot?.rateLimitResetCredits
  const expectedScope = offer?.expectedScope
  const [pendingOffer, setPendingOffer] = useState<{ expectedScope: ResetExpectedScope; accountLabel: string } | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<ResetCreditResult | null>(null)
  const submitLock = useRef(false)
  if (!offer && !pendingOffer && !outcome) return null
  const currentAccount = expectedScope?.accountId ? accounts?.accounts.find((account) => account.provider === 'codex' && account.id === expectedScope.accountId) : null
  const accountLabel = currentAccount?.label ?? pendingOffer?.accountLabel ?? accounts?.systemDefault.codex.label ?? 'System default'
  const submit = async (scope: ResetExpectedScope, label: string, rememberChoice = false) => {
    if (disabled || submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    setOutcome(null)
    try {
      if (rememberChoice) await store.setPreferences({ skipCodexResetConfirm: true })
      const result = await store.consumeResetCredit(store.resetRequestId(scope), scope)
      setOutcome(result)
      if (result === 'reset' || result === 'alreadyRedeemed') {
        setPendingOffer(null)
        setDontAsk(false)
      } else {
        setPendingOffer((current) => current ?? { expectedScope: scope, accountLabel: label })
      }
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }
  const requestReset = () => {
    if (disabled || !expectedScope || submitting || pendingOffer) return
    setOutcome(null)
    if (accounts?.preferences.skipCodexResetConfirm) {
      void submit(expectedScope, accountLabel)
      return
    }
    setDontAsk(false)
    setPendingOffer({ expectedScope, accountLabel })
  }
  const availableCount = offer?.availableCount ?? 0
  const outcomeMessage = outcome === 'reset' ? 'Codex limits were reset.'
    : outcome === 'alreadyRedeemed' ? 'This reset request was already redeemed.'
      : outcome === 'scope-changed' ? 'This reset offer changed before confirmation. No reset was applied. Refresh usage and confirm the current offer.'
        : outcome === 'noCredit' ? 'No Codex reset credit was available. Refresh usage before confirming again.'
          : outcome === 'nothingToReset' ? 'There are no eligible Codex limits to reset. Refresh usage before confirming again.'
            : outcome === 'failed' ? 'The reset could not be confirmed. Retry uses the same request ID and displayed account scope.'
              : null
  const refreshBeforeRetry = outcome === 'scope-changed' || outcome === 'noCredit' || outcome === 'nothingToReset'
  const cancelReset = () => {
    if (submitting) return
    setPendingOffer(null)
    setOutcome(null)
    setDontAsk(false)
  }
  return <section className="section-card" aria-label="Codex reset credits">
    {offer && <>
      <SectionHeader
        title={availableCount > 0 ? `${availableCount} rate-limit reset${availableCount === 1 ? '' : 's'} available` : 'No rate-limit resets available'}
        actions={offer.nextExpiresAt ? <small>Next expiry {new Date(offer.nextExpiresAt).toLocaleString()}</small> : undefined}
      />
      {offer.totalEarnedCount !== undefined && <small>Total earned: {offer.totalEarnedCount}</small>}
      {availableCount > 0 && <>
        <p className="settings-description">Use a Codex reset credit for the active account's eligible usage windows.</p>
        <Button type="button" variant="primary" aria-label="Reset Codex limits" disabled={disabled || !expectedScope || submitting || Boolean(pendingOffer)} title={disabled ? 'Reset credits are not available for a remote owner.' : !expectedScope ? 'A verified offer scope is unavailable.' : undefined} onClick={requestReset}>{submitting && !pendingOffer ? 'Resetting…' : 'Reset now'}</Button>
        {!expectedScope && <small className="status-error" role="status">Reset is unavailable because the displayed offer could not be bound to an account revision.</small>}
      </>}
    </>}
    {outcomeMessage && !pendingOffer && <p className={outcome === 'reset' || outcome === 'alreadyRedeemed' ? 'status-ready' : 'status-error'} role={outcome === 'reset' || outcome === 'alreadyRedeemed' ? 'status' : 'alert'}>{outcomeMessage}</p>}
    {pendingOffer && <Dialog
      open={Boolean(pendingOffer)}
      title="Reset Codex limits confirmation"
      onClose={submitting ? undefined : cancelReset}
      closeOnBackdrop={!submitting}
      actions={<>
        <Button type="button" disabled={submitting} onClick={cancelReset}>Cancel</Button>
        <Button type="button" variant="primary" disabled={disabled || submitting || refreshBeforeRetry} onClick={() => void submit(pendingOffer.expectedScope, pendingOffer.accountLabel, dontAsk || accounts?.preferences.skipCodexResetConfirm === true)}>{submitting ? 'Resetting…' : outcome === 'failed' ? 'Retry reset' : 'Reset now'}</Button>
        {refreshBeforeRetry && <Button type="button" disabled={submitting} onClick={() => void store.refresh('codex')}>Refresh usage</Button>}
      </>}
    >
      <p>This uses one Codex reset credit for the account and offer displayed when you requested it.</p>
      <small>Offer shown for {pendingOffer.accountLabel}. The confirmation remains bound to that account and offer.</small>
      <FormRow label="Don't ask again" htmlFor="codex-reset-dont-ask">
        <input id="codex-reset-dont-ask" type="checkbox" checked={dontAsk || accounts?.preferences.skipCodexResetConfirm === true} disabled={disabled || accounts?.preferences.skipCodexResetConfirm === true} onChange={(event) => setDontAsk(event.currentTarget.checked)} />
      </FormRow>
      {outcomeMessage && <p className="status-error" role="alert">{outcomeMessage}</p>}
    </Dialog>}
  </section>
}

function ProviderDetails({ store, provider, usage, accounts }: { store: AccountsUiStore; provider: ProviderId; usage: UsageState | null; accounts: AccountState | null }) {
  const snapshot = useStore(store)
  const preferences = accounts?.preferences
  const candidate = usage?.providers.find((item) => item.provider === provider)
  const providerSnapshot = candidate && isCurrentSnapshot(candidate, accounts) ? candidate : undefined
  const label = PROVIDER_LABELS[provider]
  const windows = providerSnapshot ? windowEntries(providerSnapshot) : []
  const managed = provider === 'claude' || provider === 'codex'
  const remoteOwner = snapshot.scope.kind === 'remote'
  const scopeUnavailable = snapshot.scope.kind === 'remote' && snapshot.scope.status !== 'ready'
  const scopeLoading = snapshot.scope.kind === 'remote' && snapshot.scope.status === 'loading'
  const showClaudeSessions = accounts?.preferences.claudeSwitchPolicy === 'ask'
  const stale = accounts?.staleSessions.filter((session) => session.provider === provider && (provider === 'codex' || showClaudeSessions || session.queued || session.error)) ?? []
  const status = providerSnapshot ? snapshotStatus(providerSnapshot) : null
  return <div className="provider-details" aria-label={`${label} usage details`}>
    <SectionHeader title={label} actions={<span className="provider-details-actions">
      <Button type="button" aria-label="Back to usage" onClick={() => void store.setUiState({ provider: null })}>‹ Usage</Button>
      <IconButton label="Refresh rate limits" title="Refresh usage data" disabled={snapshot.refreshing || scopeLoading} onClick={() => void store.refresh(provider)}>↻</IconButton>
    </span>} />
    {providerSnapshot ? <>
      <SnapshotLine snapshot={providerSnapshot} />
      {windows.length ? <div className="usage-window-list">{windows.map(({ name, window }) => <Meter key={name} window={window} direction={preferences?.direction ?? 'used'} label={name} />)}</div> : <p className={`empty-note status-${status?.kind ?? 'muted'}`}>{status?.label ?? 'Usage has not been read yet.'}</p>}
      {providerSnapshot.extraUsage && <ExtraUsageDetails snapshot={providerSnapshot} />}
      {providerSnapshot.planType && <div className="info-line"><span>Plan</span><span>{providerSnapshot.planType}</span></div>}
    </> : <EmptyState message="Usage has not been read yet." />}
    {managed && <AccountSwitcher store={store} provider={provider} state={accounts} usage={usage} />}
    {provider === 'codex' && <ResetCredit store={store} snapshot={providerSnapshot} accounts={accounts} disabled={remoteOwner} />}
    {stale.length > 0 && <section className="section-card" aria-label={`${label} sessions on a previous account`}>
      <SectionHeader title={`${stale.length} ${label} session${stale.length === 1 ? '' : 's'} still on the old account`} />
      {remoteOwner && <small role="status">Restart and keep actions are available only on this device.</small>}
      <div className="stale-list">{stale.map((session) => <div className="stale-row" key={session.sessionId}><span>{session.accountLabel} → {session.selectedLabel}{session.busy ? ' · Busy' : ''}</span><StaleSessionActions store={store} session={session} disabled={remoteOwner || scopeUnavailable} />{session.error && <small className="status-error" role="alert">Restart failed. Retry when the session is available.</small>}</div>)}</div>
    </section>}
    {status?.signedOut && managed && <Button type="button" disabled={remoteOwner} onClick={() => void store.openSettingsSection(provider)}>Sign in</Button>}
  </div>
}

function formatCurrency(value: number | null, code: string): string {
  if (value === null) return 'Unavailable'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value)
  } catch {
    return `${value} ${code}`
  }
}

function ExtraUsageDetails({ snapshot }: { snapshot: ProviderSnapshot }) {
  const extra = snapshot.extraUsage
  if (!extra) return null
  const balance = extra.unit === 'currency' ? formatCurrency(extra.balance, extra.currencyCode) : extra.unlimited ? 'Unlimited' : `${CREDIT_BALANCE_FORMATTER.format(extra.balance)} credits`
  return <section className="section-card" aria-label="Additional provider balance">
    <SectionHeader title={extra.unit === 'currency' ? 'Additional usage balance' : 'Additional credits'} actions={<strong>{balance}</strong>} />
    {extra.unit === 'currency' && <>
      <div className="info-line"><span>Spent</span><span>{formatCurrency(extra.spent, extra.currencyCode)}</span></div>
      <div className="info-line"><span>Spend limit</span><span>{extra.spendLimit === null ? 'Not reported' : formatCurrency(extra.spendLimit, extra.currencyCode)}</span></div>
      {extra.spentPercent !== null && <div className="info-line"><span>Limit used</span><span>{Math.round(extra.spentPercent)}%</span></div>}
    </>}
    {extra.enabled ? <small className="muted">Balance and overage metadata reported by the provider.</small> : <small className="muted">Additional usage is not enabled.</small>}
  </section>
}

function UsagePopover({ store, accounts, usage, credentials }: { store: AccountsUiStore; accounts: AccountState | null; usage: UsageState | null; credentials: CredentialStatus[] }) {
  const current = useStore(store)
  const preferences = accounts?.preferences
  const scopeLoading = current.scope.kind === 'remote' && current.scope.status === 'loading'
  if (!current.ui.open) return null
  return <div className="usage-popover" role="dialog" aria-label="Usage" onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) void store.setUiState({ open: false })
  }}>
    <SectionHeader title="Usage" actions={<span className="usage-popover-header-actions">
      <small>all agents</small>
      <IconButton label="Refresh rate limits" title="Refresh usage data" disabled={current.refreshing || scopeLoading} onClick={() => void store.refresh()}>↻</IconButton>
      <IconButton label="Close Usage" onClick={() => void store.setUiState({ open: false })}>×</IconButton>
    </span>} />
    {current.scope.kind === 'remote' && <p className={current.scope.status === 'unavailable' ? 'status-error' : ''} role="status">
      {current.scope.status === 'loading'
        ? `Loading Usage from ${current.scope.hostName ?? 'the remote owner'}…`
        : current.scope.status === 'unavailable'
          ? `${current.scope.hostName ?? 'Remote owner'} usage is unavailable.`
          : `Usage on ${current.scope.hostName ?? 'the remote owner'}.`}
    </p>}
    {preferences && <UsageControls preferences={preferences} setPreferences={(patch) => store.setPreferences(patch)} />}
    {current.ui.provider && isProvider(current.ui.provider)
      ? <ProviderDetails store={store} provider={current.ui.provider} usage={usage} accounts={accounts} />
      : <ProviderRoster store={store} usage={usage} accounts={accounts} preferences={preferences ?? { ...DEFAULT_USAGE_PREFERENCES }} credentials={credentials} />}
    <div className="usage-footer"><span className="muted">Usage updates from provider quota snapshots.</span><Button type="button" onClick={() => void store.openSettingsSection(current.ui.provider && isManaged(current.ui.provider) ? current.ui.provider : 'claude')}>{MANAGE_LABEL}</Button></div>
  </div>
}

const DEFAULT_USAGE_PREFERENCES: Preferences = { mode: 'compact', direction: 'used', hidden: false, visibleProviders: [], density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false }
const isProvider = (value: string): value is ProviderId => (Object.hasOwn(PROVIDER_LABELS, value))
const isManaged = (value: string): value is ManagedProvider => value === 'claude' || value === 'codex'
function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function contentBoxWidth(element: HTMLElement): number {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return rect.width
    - cssPixels(style.borderLeftWidth) - cssPixels(style.borderRightWidth)
    - cssPixels(style.paddingLeft) - cssPixels(style.paddingRight)
}


export function StatusBarUsage({ store, report }: { store: AccountsUiStore; report?: UiReport }) {
  const snapshot = useStore(store)
  const [contextMenu, setContextMenu] = useState(false)
  const [visibleCount, setVisibleCount] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const moreMeasureRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  const preferences = snapshot.accounts?.preferences
  const scopeLoading = snapshot.scope.kind === 'remote' && snapshot.scope.status === 'loading'
  const visibilityProviders = PROVIDER_LABELS_LIST.filter(([provider]) => canShowProviderVisibility(provider, snapshot.agentDetection))
  const configuredProviders = useMemo(() => (snapshot.usage?.providers ?? []).filter((provider) => isCurrentSnapshot(provider, snapshot.accounts) && isConfigured(provider, snapshot.accounts, snapshot.credentials)), [snapshot.usage, snapshot.accounts, snapshot.credentials])
  const chips = useMemo(() => configuredProviders.filter((provider) => preferences?.visibleProviders.includes(provider.provider)), [configuredProviders, preferences])
  const showEmptyCta = snapshot.accounts !== null && snapshot.usage !== null && configuredProviders.length === 0

  useLayoutEffect(() => {
    const measureContainer = measureRef.current
    const moreMeasureContainer = moreMeasureRef.current
    if (!measureContainer || !moreMeasureContainer) return
    if (!preferences || preferences.hidden) {
      setVisibleCount(null)
      return
    }

    const measuredChips = [...measureContainer.children].filter((child) => child instanceof HTMLElement) as HTMLElement[]
    const suffixButtons = [...moreMeasureContainer.querySelectorAll<HTMLButtonElement>('[data-collapsed-count]')]
    const measure = () => {
      const chipsContainer = chipsRef.current
      if (!chipsContainer) { setVisibleCount(null); return }
      const clearMeasurement = () => {
        chipsContainer.style.setProperty('--usage-more-min-width', '0px')
        chipsContainer.style.removeProperty('--usage-chips-width')
        setVisibleCount(null)
      }
      if (!measuredChips.length) { clearMeasurement(); return }

      const widths = measuredChips.map((child) => child.getBoundingClientRect().width)
      if (widths.some((width) => width <= 0)) { clearMeasurement(); return }

      const suffixWidths = new Array(measuredChips.length + 1).fill(Number.POSITIVE_INFINITY)
      let widestSuffixWidth = 0
      for (const button of suffixButtons) {
        const collapsedCount = Number(button.dataset.collapsedCount)
        if (!Number.isInteger(collapsedCount) || collapsedCount < 1 || collapsedCount > measuredChips.length) continue
        const width = button.getBoundingClientRect().width
        if (width <= 0) { clearMeasurement(); return }
        suffixWidths[collapsedCount] = width
        widestSuffixWidth = Math.max(widestSuffixWidth, width)
      }
      for (let collapsedCount = 1; collapsedCount < suffixWidths.length; collapsedCount += 1) {
        if (!Number.isFinite(suffixWidths[collapsedCount])) { clearMeasurement(); return }
      }

      const gap = cssPixels(getComputedStyle(chipsContainer).columnGap)
      const desiredWidth = widths.reduce((total, width) => total + width, 0) + gap * (widths.length - 1)
      chipsContainer.style.setProperty('--usage-chips-width', `${desiredWidth}px`)
      chipsContainer.style.setProperty('--usage-more-min-width', `${widestSuffixWidth}px`)
      const availableWidth = contentBoxWidth(chipsContainer)
      if (availableWidth <= 0) { clearMeasurement(); return }
      const nextCount = fitUsagePrefix(widths, suffixWidths, availableWidth, gap)
      setVisibleCount((current) => current === nextCount ? current : nextCount)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [
      chipsRef.current, measureContainer, moreMeasureContainer,
      triggerRef.current, refreshRef.current, ...measuredChips, ...suffixButtons
    ]) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [chips, preferences, showEmptyCta, snapshot.ui.open])
  useEffect(() => {
    if (!snapshot.ui.open) return
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      void store.setUiState({ open: false })
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [snapshot.ui.open, store])

  const hidden = preferences?.hidden ?? false
  const visibleChips = visibleCount === null ? chips : chips.slice(0, visibleCount)
  const collapsed = visibleCount === null ? [] : chips.slice(visibleCount)
  const tooltip = collapsed.length ? `Also: ${collapsed.map((item) => {
    const best = compactWindow(item)
    return `${PROVIDER_LABELS[item.provider]}${best ? ` ${displayPercent(best.window.usedPercent, preferences?.direction ?? 'used')}%` : ''}`
  }).join(', ')}` : ''
  const reportState = {
    view: 'accounts-usage',
    presentation: { hidden, mode: preferences?.mode ?? 'compact', direction: preferences?.direction ?? 'used', density: preferences?.density ?? 'normal' },
    availableProviders: configuredProviders.map((provider) => provider.provider),
    agentDetection: { status: snapshot.agentDetection.status, installedProviders: snapshot.agentDetection.installedProviders },
    visibleProviders: hidden ? [] : visibleChips.map((provider) => provider.provider),
    visibleProviderStatus: hidden ? [] : visibleChips.map((provider) => ({ provider: provider.provider, label: PROVIDER_LABELS[provider.provider], status: snapshotStatus(provider).label, usedPercent: maxUsed(provider) })),
    collapsedProviders: hidden ? [] : collapsed.map((provider) => provider.provider),
    emptyCtaVisible: !hidden && showEmptyCta && snapshot.ui.open,
    ui: { popoverOpen: snapshot.ui.open, provider: snapshot.ui.provider && isProvider(snapshot.ui.provider) ? snapshot.ui.provider : null, expanded: snapshot.ui.expanded }
  }
  useStableReport(report, reportState)
  const updateVisibility = (provider: ProviderId, checked: boolean) => {
    if (!preferences) return
    const next = new Set(preferences.visibleProviders)
    if (checked) next.add(provider)
    else next.delete(provider)
    void store.setPreferences({ visibleProviders: [...next] })
  }
  return <div ref={rootRef} className={`accounts-ui usage-status-bar${hidden ? ' usage-status-bar--hidden' : ''}`} onContextMenu={(event) => {
    event.preventDefault()
    setContextMenu((open) => !open)
  }}>
    {!hidden && <>
      <Button ref={triggerRef} type="button" className="usage-trigger" aria-label="Open Usage" aria-expanded={snapshot.ui.open} onClick={() => void store.setUiState({ open: !snapshot.ui.open })}>Usage <small>{preferences?.direction === 'remaining' ? 'Remaining' : 'Used'}</small></Button>
      {!showEmptyCta && <div ref={chipsRef} className="usage-chips" aria-label="Provider usage status bar">
            {visibleChips.map((provider) => <StatusChip key={provider.provider} store={store} snapshot={provider} preferences={preferences ?? DEFAULT_USAGE_PREFERENCES} />)}
            {collapsed.length > 0 && <Button type="button" className="usage-chip" aria-label={`${collapsed.length} more providers`} title={tooltip} onClick={() => void store.setUiState({ open: true })}>+{collapsed.length}</Button>}
          </div>}
      <IconButton ref={refreshRef} className="usage-refresh" label="Refresh rate limits" title="Refresh usage data" disabled={snapshot.refreshing || scopeLoading} onClick={() => void store.refresh()}>↻</IconButton>
    </>}
    {contextMenu && <div className="context-menu" role="menu" aria-label="Usage visibility" onClick={(event) => event.stopPropagation()}>
      {snapshot.agentDetection.status !== 'ready' && <small role="status">{snapshot.agentDetection.status === 'loading' ? 'Checking installed agent CLIs…' : 'Agent detection is unavailable; CLI-specific toggles are hidden. Refresh usage to retry.'}</small>}
      {visibilityProviders.map(([provider, label]) => <label key={provider} role="menuitemcheckbox" aria-checked={preferences?.visibleProviders.includes(provider) ?? false}>
        <input type="checkbox" aria-label={`${label} Usage`} checked={preferences?.visibleProviders.includes(provider) ?? false} onChange={(event) => updateVisibility(provider, event.currentTarget.checked)} />{label} Usage
      </label>)}
      <Button type="button" onClick={() => setContextMenu(false)}>Close menu</Button>
    </div>}
    <UsagePopover store={store} accounts={snapshot.accounts} usage={snapshot.usage} credentials={snapshot.credentials} />
    <div ref={measureRef} className="usage-measure" aria-hidden="true" inert>{chips.map((provider) => <StatusChip key={provider.provider} store={store} snapshot={provider} preferences={preferences ?? DEFAULT_USAGE_PREFERENCES} />)}</div>
    <div ref={moreMeasureRef} className="usage-measure" aria-hidden="true" inert>{chips.map((_, index) => <Button key={index + 1} type="button" className="usage-chip" data-collapsed-count={index + 1} aria-hidden="true" tabIndex={-1} disabled>+{index + 1}</Button>)}</div>
  </div>
}

export function SessionAccessory({ store, input, report }: { store: AccountsUiStore; input: unknown; report?: UiReport }) {
  const snapshot = useStore(store)
  const sessionId = input && typeof input === 'object' && 'sessionId' in input && typeof input.sessionId === 'string' ? input.sessionId : null
  const paneId = input && typeof input === 'object' && 'paneId' in input && typeof input.paneId === 'string' ? input.paneId : null
  const session = snapshot.scope.kind === 'local' && sessionId ? snapshot.accounts?.staleSessions.find((item) => item.sessionId === sessionId) : null
  const visible = Boolean(session && (session.provider === 'codex' || session.queued || session.error))
  useStableReport(report, {
    view: 'session-accessory',
    visible,
    provider: session?.provider ?? null,
    accountLabel: session?.accountLabel ?? null,
    selectedLabel: session?.selectedLabel ?? null,
    busy: session?.busy ?? false,
    queued: session?.queued ?? false,
    kept: session?.kept ?? false,
    hasError: Boolean(session?.error)
  })
  if (!session || (session.provider === 'claude' && !session.queued && !session.error)) return null
  const providerName = session.provider === 'codex' ? 'Codex' : 'Claude'
  const sessionCopy = session.provider === 'codex'
    ? session.kept
      ? `Codex is still signed in as ${session.accountLabel}. This session is kept on that previous account.`
      : `Codex is still signed in as ${session.accountLabel}. Restart this session to use ${session.selectedLabel}. It stays on the previous account until you do.`
    : `Claude is still running as ${session.accountLabel}. Restarting continues this conversation on ${session.selectedLabel}.`
  return <div className="accounts-ui provider-details session-accessory" data-pane={paneId ?? undefined} aria-label={`${providerName} account switched`}>
    <SectionHeader title={`${providerName} account switched`} />
    <p>{sessionCopy}</p>
    <StaleSessionActions store={store} session={session} />
    {session.error && <small className="status-error" role="alert">Restart failed. The session remains on its previous account; retry when available.</small>}
  </div>
}

export function AccountSwitchDialog({ store, report }: { store: AccountsUiStore; report?: UiReport }) {
  const snapshot = useStore(store)
  const [dontAskChoice, setDontAskChoice] = useState<{ key: string; checked: boolean }>({ key: '', checked: false })
  const [submitting, setSubmitting] = useState(false)
  const [actionFailure, setActionFailure] = useState<{ key: string; message: string } | null>(null)
  const [pinnedSessions, setPinnedSessions] = useState<{ key: string; sessions: StaleSession[] } | null>(null)
  const submissionLock = useRef(false)
  const state = snapshot.accounts
  const askSessions = snapshot.scope.kind === 'local' && state?.preferences.claudeSwitchPolicy === 'ask'
    ? state.staleSessions.filter((session) => session.provider === 'claude' && !session.kept && !session.queued)
    : []
  const currentVisible = askSessions
  const dialogKey = state ? `${state.active.claude ?? 'system'}:${state.revision}` : 'loading'
  const visible = snapshot.scope.kind === 'remote' ? [] : [...currentVisible, ...(pinnedSessions?.key === dialogKey ? pinnedSessions.sessions.filter((session) => !currentVisible.some((candidate) => candidate.sessionId === session.sessionId)) : [])]
  const dontAskAgain = dontAskChoice.key === dialogKey && dontAskChoice.checked
  const failureMessage = actionFailure?.key === dialogKey ? actionFailure.message : null
  useStableReport(report, {
    view: 'switch-dialog',
    visible: visible.length > 0,
    sessions: visible.map((session) => ({
      accountLabel: session.accountLabel,
      selectedLabel: session.selectedLabel,
      busy: session.busy,
      queued: session.queued,
      kept: session.kept,
      hasError: Boolean(session.error),
      selectionRevision: session.selectionRevision
    }))
  })
  const choose = async (action: 'keep' | 'restart') => {
    if (submissionLock.current || !state) return
    submissionLock.current = true
    setSubmitting(true)
    setActionFailure(null)
    const sessionsToActOn = [...visible]
    const selectionKey = dialogKey
    setPinnedSessions({ key: selectionKey, sessions: sessionsToActOn })
    try {
      if (dontAskAgain) await store.setPreferences({ claudeSwitchPolicy: 'always' })
      const groups = new Map<number, string[]>()
      for (const session of sessionsToActOn) groups.set(session.selectionRevision, [...(groups.get(session.selectionRevision) ?? []), session.sessionId])
      for (const [selectionRevision, sessions] of groups) {
        const result = action === 'keep'
          ? await store.keep(sessions, selectionRevision)
          : await store.restart(sessions, selectionRevision)
        if (result !== 'applied') {
          setActionFailure({
            key: selectionKey,
            message: result === 'selection-changed'
              ? 'The account selection changed. Review the refreshed sessions before choosing again.'
              : `Could not confirm ${action === 'keep' ? 'keeping' : 'restarting'} the Claude sessions. Refresh account state before trying again.`
          })
          const latest = store.getSnapshot().accounts
          if (!latest || `${latest.active.claude ?? 'system'}:${latest.revision}` !== selectionKey) setPinnedSessions(null)
          return
        }
      }
      setPinnedSessions(null)
    } finally {
      submissionLock.current = false
      setSubmitting(false)
    }
  }
  if (!visible.length) return null
  const revisions = new Set(visible.map((session) => session.selectionRevision))
  return <div className="accounts-ui accounts-switch-dialog-root">
    <Dialog open={visible.length > 0} title={`Switched to ${visible[0]?.selectedLabel ?? 'another account'}`} closeOnBackdrop={false} actions={<>
      <Button type="button" disabled={submitting} onClick={() => void choose('keep')}>Keep as is</Button>
      <Button type="button" variant="primary" disabled={submitting} onClick={() => void choose('restart')}>{visible.length === 1 ? 'Restart session' : `Restart ${visible.length} sessions`}</Button>
    </>}>
      <div className="switch-dialog-content">
        <p>{visible.length} Claude session{visible.length === 1 ? '' : 's'} {visible.length === 1 ? 'is' : 'are'} still running on {visible[0]?.accountLabel}. Restarting continues each conversation on {visible[0]?.selectedLabel}. Busy sessions wait for idle before restarting.</p>
        <div className="stale-list">{visible.map((session) => <div className="stale-row" key={session.sessionId}>
          <strong>{session.accountLabel} → {session.selectedLabel}</strong>
          {session.queued ? <small className="status-loading">Restart queued; waiting for Claude to become idle.</small> : null}
          {session.busy && <small>Busy now. Restart will wait until this turn finishes.</small>}
          {session.error && <small className="status-error" role="alert">Restart failed. This session remains on its old account.</small>}
          <StaleSessionActions store={store} session={session} disabled={submitting} />
        </div>)}</div>
        <FormRow label="Don't ask again (restart automatically)" htmlFor="switch-dialog-dont-ask" help="You can turn this off in Settings → AI Provider Accounts.">
          <input id="switch-dialog-dont-ask" type="checkbox" checked={dontAskAgain} disabled={submitting} onChange={(event) => setDontAskChoice({ key: dialogKey, checked: event.currentTarget.checked })} />
        </FormRow>
        {failureMessage && <p className="status-error" role="alert">{failureMessage}</p>}
        {revisions.size > 1 && <small className="muted">Sessions from different account selections are protected by their own selection revisions.</small>}
      </div>
    </Dialog>
  </div>
}
