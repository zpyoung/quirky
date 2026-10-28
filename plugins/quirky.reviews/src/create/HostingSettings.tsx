import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreationDefaults, ReviewsSurfaceProps } from '../contracts'
import { isRecord } from './guards'

type Account = { host: string; user: string; source: string; bindable: boolean; scopes: string[] }
type AccountsSnapshot = { requiredHost: string; accounts: Account[] }
type HostingConfig = { account: { host: string; user: string } | null }
type Budget = { limit: number; remaining: number; resetAt: number }
type BudgetSnapshot = { core: Budget; search: Budget; graphql: Budget; fetchedAt: number }
type ProviderCheck = {
  ghAvailable: boolean
  requiredHost: string
  requiredHostAuthenticated: boolean
  missingScopes: string[]
  requiredScopes: string[]
  envTokenInProcess: boolean
  activeAccount: unknown
}

const DEFAULT_FIELDS: Array<{ key: keyof CreationDefaults; label: string }> = [
  { key: 'draft', label: 'Draft by default' },
  { key: 'useTemplate', label: 'Use review template when available' },
  { key: 'generateDetailsOnOpen', label: 'Generate details when opening Create PR' },
  { key: 'openAfterCreate', label: 'Open hosted review after creation' }
]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function defaultsValue(value: unknown): CreationDefaults | null {
  if (!isRecord(value) || DEFAULT_FIELDS.some(({ key }) => typeof value[key] !== 'boolean')) return null
  return {
    draft: value.draft as boolean,
    useTemplate: value.useTemplate as boolean,
    generateDetailsOnOpen: value.generateDetailsOnOpen as boolean,
    openAfterCreate: value.openAfterCreate as boolean
  }
}

function accountList(value: unknown): AccountsSnapshot | null {
  if (!isRecord(value) || typeof value.requiredHost !== 'string' || !Array.isArray(value.accounts)) return null
  const accounts: Account[] = []
  for (const item of value.accounts) {
    if (!isRecord(item) || typeof item.host !== 'string' || typeof item.user !== 'string' || typeof item.source !== 'string' ||
      typeof item.bindable !== 'boolean' || !Array.isArray(item.scopes) || item.scopes.some((scope) => typeof scope !== 'string')) return null
    accounts.push({ host: item.host, user: item.user, source: item.source, bindable: item.bindable, scopes: item.scopes as string[] })
  }
  return { requiredHost: value.requiredHost, accounts }
}

function providerCheck(value: unknown): ProviderCheck | null {
  if (!isRecord(value) || typeof value.ghAvailable !== 'boolean' || typeof value.requiredHostAuthenticated !== 'boolean' ||
    typeof value.requiredHost !== 'string' || typeof value.envTokenInProcess !== 'boolean' || !Array.isArray(value.missingScopes) ||
    value.missingScopes.some((scope) => typeof scope !== 'string') || !Array.isArray(value.requiredScopes) ||
    value.requiredScopes.some((scope) => typeof scope !== 'string')) return null
  return {
    ghAvailable: value.ghAvailable,
    requiredHost: value.requiredHost,
    requiredHostAuthenticated: value.requiredHostAuthenticated,
    missingScopes: value.missingScopes as string[],
    requiredScopes: value.requiredScopes as string[],
    envTokenInProcess: value.envTokenInProcess,
    activeAccount: value.activeAccount
  }
}

function hostingConfig(value: unknown): HostingConfig | null {
  if (!isRecord(value)) return null
  if (value.account === null) return { account: null }
  if (!isRecord(value.account) || typeof value.account.host !== 'string' || typeof value.account.user !== 'string') return null
  return { account: { host: value.account.host, user: value.account.user } }
}

function budgetValue(value: unknown): BudgetSnapshot | null {
  if (!isRecord(value) || !Number.isFinite(value.fetchedAt)) return null
  const bucket = (candidate: unknown): Budget | null => {
    if (!isRecord(candidate) || !Number.isFinite(candidate.limit) || !Number.isFinite(candidate.remaining) || !Number.isFinite(candidate.resetAt)) return null
    return { limit: Number(candidate.limit), remaining: Number(candidate.remaining), resetAt: Number(candidate.resetAt) }
  }
  const core = bucket(value.core)
  const search = bucket(value.search)
  const graphql = bucket(value.graphql)
  if (!core || !search || !graphql) return null
  return { core, search, graphql, fetchedAt: Number(value.fetchedAt) }
}

function viewWorktree(props: ReviewsSurfaceProps): string | null {
  const view = props.context.getLayout().view
  if (!view) return null
  const input = view.input
  return isRecord(input) && typeof input.worktree === 'string' && input.worktree.trim() !== '' ? input.worktree : null
}
type WorkspaceOption = { id: string; name: string; path: string; branch: string | null }

function workspaceOptions(value: unknown): WorkspaceOption[] | null {
  if (!Array.isArray(value)) return null
  const workspaces: WorkspaceOption[] = []
  for (const item of value) {
    if (!isRecord(item) || (item.kind !== 'git' && item.kind !== 'folder')) return null
    if (item.kind === 'folder') continue
    if (typeof item.id !== 'string' || item.id === '' || typeof item.name !== 'string' || typeof item.path !== 'string' ||
      (item.branch !== null && typeof item.branch !== 'string')) return null
    workspaces.push({ id: item.id, name: item.name, path: item.path, branch: item.branch })
  }
  return workspaces
}

function accountKey(account: { host: string; user: string } | null): string {
  return account ? `${account.host}\u0000${account.user}` : 'ambient'
}

function percentTone(bucket: Budget): 'ok' | 'warning' | 'critical' | 'unknown' {
  if (bucket.limit <= 0 || bucket.remaining < 0) return 'unknown'
  const fraction = bucket.remaining / bucket.limit
  if (fraction < 0.1) return 'critical'
  if (fraction < 0.25) return 'warning'
  return 'ok'
}

function budgetLabel(bucket: Budget): string {
  if (bucket.limit <= 0 || bucket.remaining < 0) return 'Unknown'
  const tone = percentTone(bucket)
  return tone === 'critical' ? 'Critical' : tone === 'warning' ? 'Warning' : 'OK'
}

function resetLabel(resetAt: number): string {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return 'reset time unknown'
  return `resets ${new Date(resetAt).toLocaleTimeString()}`
}

function githubLoginCommand(check: ProviderCheck): string {
  const host = /^[A-Za-z0-9.[\]:-]+$/.test(check.requiredHost) ? check.requiredHost : 'github.com'
  return `gh auth login --hostname ${host}`
}

function githubScopeCommand(check: ProviderCheck): string {
  const host = /^[A-Za-z0-9.[\]:-]+$/.test(check.requiredHost) ? check.requiredHost : 'github.com'
  const scopes = check.missingScopes.filter((scope) => /^[A-Za-z0-9:_-]+$/.test(scope))
  return `gh auth refresh --hostname ${host}${scopes.map((scope) => ` -s ${scope}`).join('')}`
}

export function HostingSettings(props: ReviewsSurfaceProps) {
  const inputWorktree = viewWorktree(props)
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(() => inputWorktree ?? props.state.settings.worktree)
  const worktree = selectedWorktree
  const settings = props.state.settings
  const settingsMatches = worktree !== null && settings.worktree === worktree
  const diagnostics = settingsMatches ? providerCheck(settings.diagnostics) : null
  const provider = diagnostics
  const accountsData = settingsMatches ? accountList(settings.accounts) : null
  const accounts = accountsData?.accounts ?? []
  const configuration = settingsMatches ? hostingConfig(settings.configuration) : null
  const budget = settingsMatches ? budgetValue(settings.budget) : null
  const [localSettingsError, setLocalSettingsError] = useState<string | null>(null)
  const [accountSelection, setAccountSelection] = useState('ambient')
  const [savingAccount, setSavingAccount] = useState(false)
  const [accountSaveError, setAccountSaveError] = useState<string | null>(null)
  const [globalDefaults, setGlobalDefaults] = useState<CreationDefaults>({ ...props.state.defaults })
  const [repoDefaults, setRepoDefaults] = useState<CreationDefaults>({ ...props.state.defaults })
  const [repoHasOverride, setRepoHasOverride] = useState(false)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [repoDefaultsWorktree, setRepoDefaultsWorktree] = useState<string | null>(null)
  const [defaultScope, setDefaultScope] = useState<'global' | 'repository'>('global')
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const [settingsContextError, setSettingsContextError] = useState<string | null>(null)
  const [registeredWorktrees, setRegisteredWorktrees] = useState<WorkspaceOption[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(true)
  const [workspacesError, setWorkspacesError] = useState<string | null>(null)
  const [refreshingBudget, setRefreshingBudget] = useState(false)
  const defaultsLoadSequence = useRef(0)
  const currentWorktree = useRef(worktree)
  currentWorktree.current = worktree
  const settingsError = settingsMatches ? settings.error : null
  const providerError = !worktree ? 'Select a registered worktree to check GitHub readiness.'
    : diagnostics === null && settingsMatches ? settingsError : null
  const accountsError = !worktree ? 'Select a worktree to list host accounts.' : accountsData === null && settingsMatches ? settingsError : null
  const configurationError = !worktree ? 'Repository account binding is unavailable without a worktree.' : configuration === null && settingsMatches ? settingsError : null
  const budgetError = !worktree ? 'Select a registered worktree to read the GitHub API budget.' : budget === null && settingsMatches ? settingsError : null
  const loadingProvider = worktree !== null && (!settingsMatches || settings.loading)
  const storedAccountKey = accountKey(configuration?.account ?? null)
  const repositoryDefaultsReady = worktree !== null && repoDefaultsWorktree === worktree
  const currentRepoHasOverride = repositoryDefaultsReady && repoHasOverride

  useEffect(() => {
    let active = true
    setWorkspacesLoading(true)
    setWorkspacesError(null)
    if (inputWorktree !== null) setSelectedWorktree(inputWorktree)
    void props.context.call('quirky.worktree/list', {})
      .then((value: unknown) => {
        if (!active) return
        const workspaces = workspaceOptions(value)
        if (workspaces === null) throw new Error('The worktree service returned an invalid workspace list.')
        setRegisteredWorktrees(workspaces)
        setSelectedWorktree((current) => {
          const requested = inputWorktree ?? current
          return requested !== null && workspaces.some((item) => item.id === requested) ? requested : null
        })
      })
      .catch((error: unknown) => {
        if (active) setWorkspacesError(errorText(error))
      })
      .finally(() => {
        if (active) setWorkspacesLoading(false)
      })
    return () => { active = false }
  }, [props.context, inputWorktree])

  const refreshBudget = useCallback(async (force: boolean) => {
    const target = worktree
    if (!target) return
    setRefreshingBudget(true)
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingBudget', { worktree: target, force })
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    }
    try {
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    } finally {
      setRefreshingBudget(false)
    }
  }, [props.context, props.refresh, worktree])

  const recheckProvider = useCallback(async (forceBudget = true) => {
    const target = worktree
    if (!target) return
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingSettingsRefresh', { worktree: target, forceBudget })
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    }
    try {
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    }
  }, [props.context, props.refresh, worktree])

  const loadDefaults = useCallback(async (request: number) => {
    const isCurrent = () => defaultsLoadSequence.current === request && currentWorktree.current === worktree
    try {
      const globalResult = await props.context.call('quirky.reviews/creationDefaults', { scope: 'global' })
      if (!isCurrent()) return
      if (!isRecord(globalResult)) throw new Error('Creation defaults returned an invalid response.')
      const global = defaultsValue(globalResult.defaults)
      if (!global) throw new Error('Creation defaults returned invalid booleans.')
      setGlobalDefaults(global)
      setRepoDefaults(global)
      setRepoHasOverride(false)
      setRepoId(null)
      setRepoDefaultsWorktree(null)
      if (!worktree) {
        setDefaultScope('global')
        return
      }
      const repositoryResult = await props.context.call('quirky.reviews/creationDefaults', { scope: 'repository', worktree })
      if (!isCurrent()) return
      if (!isRecord(repositoryResult)) throw new Error('Repository creation defaults returned an invalid response.')
      const repository = defaultsValue(repositoryResult.defaults)
      const currentRepoId = typeof repositoryResult.repoId === 'string' ? repositoryResult.repoId : null
      if (!repository || currentRepoId === null) throw new Error('Repository creation defaults returned invalid scope data.')
      const overrides = isRecord(repositoryResult.overrides) ? repositoryResult.overrides : null
      const hasOverride = overrides !== null && Object.keys(overrides).length > 0
      setRepoDefaults(repository)
      setRepoHasOverride(hasOverride)
      setRepoId(currentRepoId)
      setRepoDefaultsWorktree(worktree)
      setDefaultScope(hasOverride ? 'repository' : 'global')
    } catch (error) {
      if (isCurrent()) setDefaultsError(errorText(error))
    }
  }, [props.context, worktree])

  useEffect(() => {
    const request = ++defaultsLoadSequence.current
    setLocalSettingsError(null)
    setAccountSaveError(null)
    setDefaultsError(null)
    setRepoDefaultsWorktree(null)
    setRepoHasOverride(false)
    setRepoId(null)
    setDefaultScope('global')
    const input = props.context.getLayout().view?.input
    setSettingsContextError(isRecord(input) && typeof input.contextError === 'string' ? input.contextError : null)
    void loadDefaults(request)
    void recheckProvider(true)
    return () => {
      if (defaultsLoadSequence.current === request) defaultsLoadSequence.current += 1
    }
  }, [loadDefaults, props.context, recheckProvider])

  useEffect(() => {
    setAccountSelection(storedAccountKey)
  }, [worktree, storedAccountKey])

  useEffect(() => {
    const refreshVisibleBudget = () => {
      if (document.visibilityState === 'visible') void refreshBudget(false)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshBudget(true)
    }
    const timer = window.setInterval(refreshVisibleBudget, 60_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refreshBudget])

  const selectedDefaults = defaultScope === 'global' || !repositoryDefaultsReady ? globalDefaults : repoDefaults
  const setDefault = (key: keyof CreationDefaults, value: boolean) => {
    if (defaultScope === 'global') setGlobalDefaults((current) => ({ ...current, [key]: value }))
    else {
      setRepoDefaults((current) => ({ ...current, [key]: value }))
      setRepoHasOverride(true)
    }
  }

  const saveDefaults = async () => {
    const scope = defaultScope
    const target = worktree
    if (scope === 'repository' && (!target || !repositoryDefaultsReady)) return
    const values = { ...selectedDefaults }
    setSavingDefaults(true)
    setDefaultsError(null)
    try {
      const params = scope === 'repository' ? { scope, worktree: target, defaults: values } : { scope, defaults: values }
      await props.context.call('quirky.reviews/setCreationDefaults', params)
      if (scope === 'repository') {
        if (currentWorktree.current === target) setRepoHasOverride(true)
      } else setGlobalDefaults(values)
      await props.refresh()
    } catch (error) {
      if (scope === 'global' || currentWorktree.current === target) setDefaultsError(errorText(error))
    } finally {
      setSavingDefaults(false)
    }
  }

  const resetRepoDefaults = async () => {
    const target = worktree
    if (!target || !repositoryDefaultsReady) return
    setSavingDefaults(true)
    setDefaultsError(null)
    try {
      const result = await props.context.call('quirky.reviews/resetCreationDefaults', { scope: 'repository', worktree: target })
      if (currentWorktree.current !== target) return
      const parsed = isRecord(result) ? defaultsValue(result.defaults) : null
      if (!parsed) throw new Error('Reset did not return the inherited defaults.')
      setRepoDefaults(parsed)
      setRepoHasOverride(false)
      setDefaultScope('global')
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setDefaultsError(errorText(error))
    } finally {
      setSavingDefaults(false)
    }
  }

  const saveAccount = async () => {
    const target = worktree
    if (!target) return
    setSavingAccount(true)
    setAccountSaveError(null)
    try {
      if (accountSelection === 'ambient') {
        await props.context.call('quirky.reviews/hostingUnbindAccount', { worktree: target })
      } else {
        const selected = accounts.find((account) => accountKey(account) === accountSelection)
        if (!selected || !selected.bindable) throw new Error('Choose an existing keyring account for this repository host.')
        await props.context.call('quirky.reviews/hostingBindAccount', { worktree: target, host: selected.host, user: selected.user })
      }
      if (currentWorktree.current === target) await recheckProvider(true)
    } catch (error) {
      if (currentWorktree.current === target) {
        const message = errorText(error)
        setAccountSaveError(message)
        try {
          await props.refresh()
        } catch (refreshError) {
          setAccountSaveError(`${message} The displayed settings could not be refreshed: ${errorText(refreshError)}`)
        }
      }
    } finally {
      setSavingAccount(false)
    }
  }

  const requiredHost = accountsData?.requiredHost ?? provider?.requiredHost ?? null
  const requiredHostAccounts = requiredHost === null ? [] : accounts.filter((account) => account.host.toLowerCase() === requiredHost.toLowerCase())
  const selectedBinding = configuration?.account ?? null
  const bindingAvailable = selectedBinding === null || accountsData === null ||
    requiredHostAccounts.some((account) => account.host.toLowerCase() === selectedBinding.host.toLowerCase() && account.user === selectedBinding.user)
  const accountOption = selectedBinding ? accountKey(selectedBinding) : 'ambient'
  const githubReadiness = providerError ? 'Unavailable' : !provider ? 'Checking…'
    : !provider.ghAvailable ? 'Not installed'
      : !provider.requiredHostAuthenticated ? 'Not authenticated'
        : provider.missingScopes.length > 0 ? 'Connected · scope update needed'
          : 'Connected'
  const activeAccount = provider && isRecord(provider.activeAccount) && typeof provider.activeAccount.user === 'string' && typeof provider.activeAccount.host === 'string'
    ? `${provider.activeAccount.user} @ ${provider.activeAccount.host}` : null
  const displayedDefaults = defaultScope === 'repository' && !currentRepoHasOverride ? globalDefaults : selectedDefaults

  return <main className="reviews-settings" aria-labelledby="reviews-settings-title">
    <header>
      <h1 id="reviews-settings-title">Hosting settings</h1>
      {worktree ? <p>Repository scope: <code>{repositoryDefaultsReady ? repoId ?? worktree : worktree}</code></p> : <p>Global settings are available. Select a worktree to inspect repository hosting.</p>}
    </header>

    <section aria-labelledby="settings-worktree-title">
      <h2 id="settings-worktree-title">Workspace</h2>
      <label htmlFor="settings-worktree">Repository worktree</label>
      <select
        id="settings-worktree"
        value={worktree ?? ''}
        disabled={workspacesLoading || workspacesError !== null}
        onChange={(event) => setSelectedWorktree(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">No workspace · global settings only</option>
        {registeredWorktrees.map((workspace) => <option key={workspace.id} value={workspace.id}>
          {workspace.name}{workspace.branch ? ` · ${workspace.branch}` : ''} · {workspace.path}
        </option>)}
      </select>
      {workspacesLoading && <p role="status">Loading registered worktrees…</p>}
      {workspacesError && <p role="alert">Could not list registered worktrees: {workspacesError}</p>}
      {!workspacesLoading && !workspacesError && registeredWorktrees.length === 0 &&
        <p role="status">No registered Git worktrees are available. Global creation defaults remain available.</p>}
      <small>Repository hosting settings require a registered Git worktree. Global defaults are available without one.</small>
    </section>

    {settingsContextError && <p role="alert">Could not resolve the settings worktree: {settingsContextError}</p>}
    {localSettingsError && <p role="alert">{localSettingsError}</p>}
    {settingsError && <p className="reviews-error" role="alert">Hosting observations may be stale: {settingsError}</p>}

    <section aria-labelledby="reviews-providers-title">
      <h2 id="reviews-providers-title">Review providers</h2>
      <article className="hosting-provider-card" aria-labelledby="github-provider-title">
        <h3 id="github-provider-title">GitHub</h3>
        <p role={providerError ? 'alert' : 'status'}>{githubReadiness}{providerError ? `: ${providerError}` : ''}</p>
        {provider && <>
          {provider.ghAvailable === false && <p>Install GitHub CLI: <code>brew install gh</code></p>}
          {provider.ghAvailable && !provider.requiredHostAuthenticated && <p>Sign in to {provider.requiredHost}: <code>{githubLoginCommand(provider)}</code></p>}
          {provider.missingScopes.length > 0 && <p>Required scopes are missing. Re-authorize with: <code>{githubScopeCommand(provider)}</code></p>}
          {activeAccount && <p>Active account: {activeAccount}</p>}
          {provider.envTokenInProcess && <p>Environment credentials are in use for this process. Credentials are never shown or stored by these settings.</p>}
        </>}
        <button type="button" disabled={!worktree || loadingProvider} onClick={() => void recheckProvider(true)}>
          {loadingProvider ? 'Re-checking…' : 'Re-check GitHub'}
        </button>
        {provider && <p>Required account scope: <code>{provider.requiredHost}</code>{provider.requiredScopes.length ? ` · ${provider.requiredScopes.join(', ')}` : ''}</p>}
      </article>

      <article className="hosting-provider-card" aria-labelledby="gitlab-provider-title">
        <h3 id="gitlab-provider-title">GitLab</h3>
        <p>Unsupported: this build has no public GitLab hosting methods. CLI login alone does not enable MR reads or creation.</p>
        <p>CLI setup command (not a readiness check): <code>glab auth login</code></p>
      </article>
      <article className="hosting-provider-card" aria-labelledby="bitbucket-provider-title">
        <h3 id="bitbucket-provider-title">Bitbucket</h3>
        <p>Unsupported: no public Bitbucket hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
      <article className="hosting-provider-card" aria-labelledby="azure-provider-title">
        <h3 id="azure-provider-title">Azure DevOps</h3>
        <p>Unsupported: no public Azure DevOps hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
      <article className="hosting-provider-card" aria-labelledby="gitea-provider-title">
        <h3 id="gitea-provider-title">Gitea</h3>
        <p>Unsupported: no public Gitea hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
    </section>

    <section aria-labelledby="creation-defaults-title">
      <h2 id="creation-defaults-title">Hosted-review creation defaults</h2>
      <fieldset>
        <legend>Apply defaults to</legend>
        <label>
          <input type="radio" name="creation-default-scope" value="global" checked={defaultScope === 'global'} onChange={() => {
            setDefaultScope('global')
            setDefaultsError(null)
          }} />
          Global
        </label>
        <label>
          <input type="radio" name="creation-default-scope" value="repository" checked={defaultScope === 'repository'} disabled={!repositoryDefaultsReady} onChange={() => {
            setDefaultScope('repository')
            if (!currentRepoHasOverride) setRepoDefaults(globalDefaults)
            setDefaultsError(null)
          }} />
          This repository{currentRepoHasOverride ? ' · overrides global' : ' · inherits global'}
        </label>
      </fieldset>
      <fieldset disabled={savingDefaults || (defaultScope === 'repository' && !repositoryDefaultsReady)}>
        <legend>Creation options</legend>
        {DEFAULT_FIELDS.map(({ key, label }) => <label key={key}>
          <input type="checkbox" checked={displayedDefaults[key]} onChange={(event) => setDefault(key, event.target.checked)} />
          {label}
        </label>)}
      </fieldset>
      {defaultsError && <p role="alert">{defaultsError}</p>}
      <button type="button" disabled={savingDefaults || (defaultScope === 'repository' && !repositoryDefaultsReady)} onClick={() => void saveDefaults()}>
        {savingDefaults ? 'Saving…' : 'Save creation defaults'}
      </button>
      {defaultScope === 'repository' && currentRepoHasOverride && <button type="button" disabled={savingDefaults || !repositoryDefaultsReady} onClick={() => void resetRepoDefaults()}>
        Reset repository defaults to global
      </button>}
    </section>

    <section aria-labelledby="github-binding-title">
      <h2 id="github-binding-title">Repository GitHub account</h2>
      {configurationError && <p role="alert">{configurationError}</p>}
      {accountsError && <p role="alert">{accountsError}</p>}
      {selectedBinding && !bindingAvailable && <p role="alert">
        The saved binding to {selectedBinding.user} @ {selectedBinding.host} is unavailable. It remains saved and GitHub requests fail closed; no ambient-account fallback is used.
      </p>}
      <label htmlFor="hosting-account">Account for this repository</label>
      <select
        id="hosting-account"
        value={accountSelection}
        disabled={!worktree || savingAccount || configuration === null}
        onChange={(event) => setAccountSelection(event.target.value)}
      >
        <option value="ambient">Default (ambient gh login)</option>
        {selectedBinding && !bindingAvailable && <option value={accountOption} disabled>Unavailable saved binding · {selectedBinding.user} @ {selectedBinding.host}</option>}
        {requiredHostAccounts.map((account) => <option key={accountKey(account)} value={accountKey(account)} disabled={!account.bindable}>
          {account.user} @ {account.host}{account.bindable ? '' : ` · ${account.source} account cannot be bound`}
        </option>)}
      </select>
      {requiredHostAccounts.map((account) => <p key={`${accountKey(account)}-scope`}>
        {account.user} @ {account.host} · {account.source} · scopes: {account.scopes.length ? account.scopes.join(', ') : 'unknown'}
      </p>)}
      {accountSaveError && <p role="alert">{accountSaveError}</p>}
      <button type="button" disabled={!worktree || savingAccount || configuration === null} onClick={() => void saveAccount()}>
        {savingAccount ? 'Saving account…' : 'Save account binding'}
      </button>
    </section>

    <section aria-labelledby="github-budget-title">
      <h2 id="github-budget-title">GitHub API Budget</h2>
      <button type="button" disabled={!worktree || refreshingBudget} onClick={() => void refreshBudget(true)}>
        {refreshingBudget ? 'Refreshing…' : 'Refresh budget'}
      </button>
      {budgetError && <p role="alert">Budget unavailable: {budgetError}</p>}
      {!budget && !budgetError && <p role="status">Loading GitHub API budget…</p>}
      {budget && <>
        <dl className="hosting-budget-list">
          {([['REST', budget.core], ['Search', budget.search], ['GraphQL', budget.graphql]] as const).map(([name, bucket]) => {
            const tone = percentTone(bucket)
            const color = tone === 'critical' ? 'var(--danger, #e5534b)' : tone === 'warning' ? 'var(--amber, #f0b429)' : tone === 'ok' ? 'var(--green, #3fb950)' : 'var(--muted, #8a909e)'
            return <div key={name} className={`hosting-budget hosting-budget-${tone}`}>
              <dt>{name}</dt>
              <dd><span style={{ color }}>{budgetLabel(bucket)}</span> · {bucket.remaining} / {bucket.limit} remaining · {resetLabel(bucket.resetAt)}</dd>
            </div>
          )}
        </dl>
        <small>Updated {new Date(budget.fetchedAt).toLocaleTimeString()}. Refreshes every 60 seconds while this settings view is visible.</small>
      </>}
    </section>
  </main>
}
