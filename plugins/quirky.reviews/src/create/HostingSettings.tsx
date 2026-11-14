import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, FormRow, InlineError, NoticeLine, SectionHeader } from '@quirky/ui'
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

function selectedWorktreeFromLayout(props: ReviewsSurfaceProps): string | null {
  const worktree = props.context.getLayout().worktree
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree : null
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
  const selectedWorktreeId = selectedWorktreeFromLayout(props)
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null)
  const selectionTouched = useRef(false)
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
  const [globalDefaultsReady, setGlobalDefaultsReady] = useState(false)
  const [globalDefaultsLoading, setGlobalDefaultsLoading] = useState(true)
  const [repositoryDefaultsLoading, setRepositoryDefaultsLoading] = useState(false)
  const [repositoryDefaultsFailed, setRepositoryDefaultsFailed] = useState(false)
  const [registeredWorktrees, setRegisteredWorktrees] = useState<WorkspaceOption[]>([])
  const [refreshingBudget, setRefreshingBudget] = useState(false)
  const [workspacesLoading, setWorkspacesLoading] = useState(true)
  const [workspacesError, setWorkspacesError] = useState<string | null>(null)
  const [providerRefreshPending, setProviderRefreshPending] = useState(false)
  const [budgetRefreshPending, setBudgetRefreshPending] = useState(false)
  const defaultsLoadSequence = useRef(0)
  const workspaceRequestSequence = useRef(0)
  const currentWorktree = useRef(worktree)
  currentWorktree.current = worktree
  const settingsError = settingsMatches ? settings.error : null
  const loadingProvider = worktree !== null && providerRefreshPending
  const loadingBudget = worktree !== null && (budgetRefreshPending || providerRefreshPending)
  const providerError = worktree !== null && provider === null && !loadingProvider
    ? settingsError ?? 'GitHub diagnostics are unavailable.' : null
  const accountsError = worktree !== null && accountsData === null && !loadingProvider
    ? settingsError ?? 'GitHub accounts are unavailable.' : null
  const configurationError = worktree !== null && configuration === null && !loadingProvider
    ? settingsError ?? 'Repository hosting configuration is unavailable.' : null
  const budgetError = worktree !== null && budget === null && !loadingBudget
    ? settingsError ?? 'GitHub API budget is unavailable.' : null
  const storedAccountKey = accountKey(configuration?.account ?? null)
  const repositoryDefaultsReady = worktree !== null && repoDefaultsWorktree === worktree
  const currentRepoHasOverride = repositoryDefaultsReady && repoHasOverride

  const settingsInput = props.context.getLayout().view?.input
  const contextErrorFromLayout = isRecord(settingsInput) && typeof settingsInput.contextError === 'string' ? settingsInput.contextError : null
  const loadWorktrees = useCallback(async () => {
    const request = ++workspaceRequestSequence.current
    setWorkspacesLoading(true)
    setWorkspacesError(null)
    try {
      const value = await props.context.call('quirky.worktree/list', {})
      if (workspaceRequestSequence.current !== request) return
      const workspaces = workspaceOptions(value)
      if (workspaces === null) throw new Error('The worktree service returned an invalid workspace list.')
      setRegisteredWorktrees(workspaces)
      setSelectedWorktree((current) => {
        const requested = selectionTouched.current ? current : current ?? selectedWorktreeId ?? props.state.settings.worktree
        selectionTouched.current = true
        return requested !== null && workspaces.some((item) => item.id === requested) ? requested : null
      })
    } catch (error) {
      if (workspaceRequestSequence.current === request) setWorkspacesError(errorText(error))
    } finally {
      if (workspaceRequestSequence.current === request) setWorkspacesLoading(false)
    }
  }, [props.context, props.state.settings.worktree, selectedWorktreeId])

  useEffect(() => {
    void loadWorktrees()
    return () => { workspaceRequestSequence.current += 1 }
  }, [loadWorktrees])

  const refreshBudget = useCallback(async (force: boolean) => {
    const target = worktree
    if (!target) return
    setBudgetRefreshPending(true)
    setRefreshingBudget(true)
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingBudget', { worktree: target, force })
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    } finally {
      if (currentWorktree.current === target) {
        setBudgetRefreshPending(false)
        setRefreshingBudget(false)
      }
    }
  }, [props.context, props.refresh, worktree])

  const recheckProvider = useCallback(async (forceBudget = true) => {
    const target = worktree
    if (!target) return
    setProviderRefreshPending(true)
    if (forceBudget) setBudgetRefreshPending(true)
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingSettingsRefresh', { worktree: target, forceBudget })
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setLocalSettingsError(errorText(error))
    } finally {
      if (currentWorktree.current === target) {
        setProviderRefreshPending(false)
        if (forceBudget) setBudgetRefreshPending(false)
      }
    }
  }, [props.context, props.refresh, worktree])

  const loadDefaults = useCallback(async (request: number) => {
    const target = worktree
    const isCurrent = () => defaultsLoadSequence.current === request && currentWorktree.current === target
    setGlobalDefaultsLoading(true)
    setGlobalDefaultsReady(false)
    setRepositoryDefaultsLoading(false)
    setRepositoryDefaultsFailed(false)
    setRepoDefaultsWorktree(null)
    setRepoHasOverride(false)
    setRepoId(null)
    setDefaultsError(null)
    try {
      const globalResult = await props.context.call('quirky.reviews/creationDefaults', { scope: 'global' })
      if (!isCurrent()) return
      if (!isRecord(globalResult)) throw new Error('Creation defaults returned an invalid response.')
      const global = defaultsValue(globalResult.defaults)
      if (!global) throw new Error('Creation defaults returned invalid booleans.')
      setGlobalDefaults(global)
      setRepoDefaults(global)
      setGlobalDefaultsReady(true)
      setGlobalDefaultsLoading(false)
      if (!target) {
        setDefaultScope('global')
        return
      }

      setRepositoryDefaultsLoading(true)
      try {
        const repositoryResult = await props.context.call('quirky.reviews/creationDefaults', { scope: 'repository', worktree: target })
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
        setRepoDefaultsWorktree(target)
        setDefaultScope(hasOverride ? 'repository' : 'global')
      } catch (error) {
        if (isCurrent()) {
          setRepositoryDefaultsFailed(true)
          setDefaultsError(errorText(error))
        }
      } finally {
        if (isCurrent()) setRepositoryDefaultsLoading(false)
      }
    } catch (error) {
      if (isCurrent()) {
        setGlobalDefaultsLoading(false)
        setGlobalDefaultsReady(false)
        setRepositoryDefaultsLoading(false)
        setDefaultsError(errorText(error))
      }
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
    void loadDefaults(request)
    if (worktree) void recheckProvider(true)
    return () => {
      if (defaultsLoadSequence.current === request) defaultsLoadSequence.current += 1
    }
  }, [loadDefaults, recheckProvider, worktree])

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
    if (!globalDefaultsReady || (defaultScope === 'repository' && !repositoryDefaultsReady)) return
    if (defaultScope === 'global') setGlobalDefaults((current) => ({ ...current, [key]: value }))
    else {
      setRepoDefaults((current) => ({ ...current, [key]: value }))
      setRepoHasOverride(true)
    }
  }

  const saveDefaults = async () => {
    const scope = defaultScope
    const target = worktree
    if (!globalDefaultsReady || savingDefaults ||
      (scope === 'repository' && (!target || !repositoryDefaultsReady || repositoryDefaultsLoading || repositoryDefaultsFailed))) return
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
    if (!target || !repositoryDefaultsReady || !currentRepoHasOverride || savingDefaults) return
    setSavingDefaults(true)
    setDefaultsError(null)
    try {
      const result = await props.context.call('quirky.reviews/resetCreationDefaults', { scope: 'repository', worktree: target })
      if (currentWorktree.current !== target) return
      const parsed = isRecord(result) ? defaultsValue(result.defaults) : null
      if (!parsed) throw new Error('Reset did not return the inherited defaults.')
      setGlobalDefaults(parsed)
      setRepoDefaults(parsed)
      setRepoHasOverride(false)
      setDefaultScope('global')
      await props.refresh()
    } catch (error) {
      if (currentWorktree.current === target) setDefaultsError(errorText(error))
    } finally {
      if (currentWorktree.current === target) setSavingDefaults(false)
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

  return <main className="ui-stack" aria-label="Hosting settings">
    <header className="ui-stack">
      <SectionHeader title="Hosting settings" />
      {worktree ? <p>Repository scope: <code>{repositoryDefaultsReady ? repoId ?? worktree : worktree}</code></p> : <p>Global settings are available. Select a worktree to inspect repository hosting.</p>}
    </header>

    <section className="ui-stack" aria-label="Workspace" aria-busy={workspacesLoading} aria-live="polite">
      <SectionHeader title="Workspace" />
      <FormRow label="Repository worktree" htmlFor="settings-worktree">
        <select
          id="settings-worktree"
          className="ui-text-field__input"
          value={worktree ?? ''}
          disabled={workspacesLoading || workspacesError !== null}
          onChange={(event) => {
            selectionTouched.current = true
            setSelectedWorktree(event.target.value === '' ? null : event.target.value)
          }}
        >
          <option value="">No workspace · global settings only</option>
          {registeredWorktrees.map((workspace) => <option key={workspace.id} value={workspace.id}>
            {workspace.name}{workspace.branch ? ` · ${workspace.branch}` : ''} · {workspace.path}
          </option>)}
        </select>
      </FormRow>
      {workspacesLoading && <NoticeLine>Loading registered worktrees…</NoticeLine>}
      {workspacesError && <InlineError
        message={`Could not list registered worktrees: ${workspacesError}`}
        action={{ label: 'Retry worktrees', onAction: () => { void loadWorktrees() } }}
      />}
      {!workspacesLoading && !workspacesError && registeredWorktrees.length === 0 &&
        <EmptyState message="No registered Git worktrees are available. Global creation defaults remain available." />}
      <small className="ui-text-muted">Repository hosting settings require a registered Git worktree. Global defaults are available without one.</small>
    </section>

    {contextErrorFromLayout && <InlineError message={contextErrorFromLayout} />}
    {localSettingsError && <InlineError message={localSettingsError} />}
    {settingsError && <InlineError message={`Hosting observations may be stale: ${settingsError}`} />}


    <section className="ui-stack" aria-label="Review providers" aria-busy={loadingProvider} aria-live="polite">
      <SectionHeader title="Review providers" />
      {!worktree && <EmptyState message="Select a registered Git worktree to inspect repository hosting." />}
      <article className="ui-stack" aria-label="GitHub">
        <SectionHeader title="GitHub" />
        {worktree && loadingProvider && <NoticeLine>Checking GitHub readiness…</NoticeLine>}
        {worktree && providerError && <InlineError message={providerError} />}
        {provider && <p role="status">
          <Badge tone={provider.missingScopes.length ? 'needs-you' : provider.requiredHostAuthenticated ? 'working' : 'neutral'}>{githubReadiness}</Badge>
        </p>}
        {provider && <>
          {provider.ghAvailable === false && <p>Install GitHub CLI: <code>brew install gh</code></p>}
          {provider.ghAvailable && !provider.requiredHostAuthenticated && <p>Sign in to {provider.requiredHost}: <code>{githubLoginCommand(provider)}</code></p>}
          {provider.missingScopes.length > 0 && <p>Required scopes are missing. Re-authorize with: <code>{githubScopeCommand(provider)}</code></p>}
          {activeAccount && <p>Active account: {activeAccount}</p>}
          {provider.envTokenInProcess && <p>Environment credentials are in use for this process. Credentials are never shown or stored by these settings.</p>}
        </>}
        <Button disabled={!worktree || loadingProvider} onClick={() => void recheckProvider(true)}>{loadingProvider ? 'Re-checking…' : 'Re-check GitHub'}</Button>
        {provider && <p>Required account scope: <code>{provider.requiredHost}</code>{provider.requiredScopes.length ? ` · ${provider.requiredScopes.join(', ')}` : ''}</p>}
      </article>

      <article className="ui-stack" aria-label="GitLab">
        <SectionHeader title="GitLab" />
        <p>Unsupported: this build has no public GitLab hosting methods. CLI login alone does not enable MR reads or creation.</p>
        <p>CLI setup command (not a readiness check): <code>glab auth login</code></p>
      </article>
      <article className="ui-stack" aria-label="Bitbucket">
        <SectionHeader title="Bitbucket" />
        <p>Unsupported: no public Bitbucket hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
      <article className="ui-stack" aria-label="Azure DevOps">
        <SectionHeader title="Azure DevOps" />
        <p>Unsupported: no public Azure DevOps hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
      <article className="ui-stack" aria-label="Gitea">
        <SectionHeader title="Gitea" />
        <p>Unsupported: no public Gitea hosting diagnostics or review-creation methods are registered.</p>
        <p>No install, login, account-scope, or Re-check action is available.</p>
      </article>
    </section>

    <section className="ui-stack" aria-label="Hosted-review creation defaults" aria-busy={globalDefaultsLoading || repositoryDefaultsLoading} aria-live="polite">
      <SectionHeader title="Hosted-review creation defaults" />
      {globalDefaultsLoading && <NoticeLine>Loading creation defaults…</NoticeLine>}
      {repositoryDefaultsLoading && <NoticeLine>Loading repository creation defaults…</NoticeLine>}
      <fieldset className="ui-stack">
        <legend>Apply defaults to</legend>
        <FormRow label="Global" htmlFor="creation-default-global">
          <input id="creation-default-global" type="radio" style={{ accentColor: 'var(--ui-accent)' }} name="creation-default-scope" value="global" checked={defaultScope === 'global'} disabled={!globalDefaultsReady || savingDefaults} onChange={() => {
            if (!globalDefaultsReady || savingDefaults) return
            setDefaultScope('global')
            setDefaultsError(null)
          }} />
        </FormRow>
        <FormRow label={`This repository${currentRepoHasOverride ? ' · overrides global' : ' · inherits global'}`} htmlFor="creation-default-repository">
          <input id="creation-default-repository" type="radio" style={{ accentColor: 'var(--ui-accent)' }} name="creation-default-scope" value="repository" checked={defaultScope === 'repository'} disabled={!repositoryDefaultsReady || repositoryDefaultsLoading || repositoryDefaultsFailed || savingDefaults} onChange={() => {
            if (!repositoryDefaultsReady || repositoryDefaultsLoading || repositoryDefaultsFailed || savingDefaults) return
            setDefaultScope('repository')
            if (!currentRepoHasOverride) setRepoDefaults(globalDefaults)
            setDefaultsError(null)
          }} />
        </FormRow>
      </fieldset>
      <fieldset className="ui-stack" disabled={!globalDefaultsReady || savingDefaults || (defaultScope === 'repository' && (!repositoryDefaultsReady || repositoryDefaultsLoading || repositoryDefaultsFailed))}>
        <legend>Creation options</legend>
        {DEFAULT_FIELDS.map(({ key, label }) => <FormRow key={key} label={label} htmlFor={`creation-default-${key}`}>
          <input id={`creation-default-${key}`} type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={displayedDefaults[key]} onChange={(event) => setDefault(key, event.target.checked)} />
        </FormRow>)}
      </fieldset>
      {defaultsError && <InlineError
        message={defaultsError}
        action={(!globalDefaultsReady || repositoryDefaultsFailed) ? { label: 'Retry defaults', onAction: () => {
          const request = ++defaultsLoadSequence.current
          void loadDefaults(request)
        } } : undefined}
      />}
      <div className="ui-cluster">
        <Button variant="primary" disabled={!globalDefaultsReady || savingDefaults || (defaultScope === 'repository' && (!repositoryDefaultsReady || repositoryDefaultsLoading || repositoryDefaultsFailed))} onClick={() => void saveDefaults()}>{savingDefaults ? 'Saving…' : 'Save creation defaults'}</Button>
        {defaultScope === 'repository' && currentRepoHasOverride && <Button disabled={savingDefaults || !repositoryDefaultsReady} onClick={() => void resetRepoDefaults()}>
          Reset repository defaults to global
        </Button>}
      </div>
    </section>

    <section className="ui-stack" aria-label="Repository GitHub account">
      <SectionHeader title="Repository GitHub account" />
      {worktree && loadingProvider && accountsData === null && <NoticeLine>Loading GitHub accounts…</NoticeLine>}
      {worktree && configurationError && <InlineError message={configurationError} />}
      {worktree && accountsError && <InlineError message={accountsError} />}
      {selectedBinding && !bindingAvailable && <InlineError message={`The saved binding to ${selectedBinding.user} @ ${selectedBinding.host} is unavailable. It remains saved and GitHub requests fail closed; no ambient-account fallback is used.`} />}
      <FormRow label="Account for this repository" htmlFor="hosting-account">
        <select
          id="hosting-account"
          className="ui-text-field__input"
          value={accountSelection}
          disabled={!worktree || savingAccount || loadingProvider || configuration === null || accountsData === null}
          onChange={(event) => setAccountSelection(event.target.value)}
        >
          <option value="ambient">Default (ambient gh login)</option>
          {selectedBinding && !bindingAvailable && <option value={accountOption} disabled>Unavailable saved binding · {selectedBinding.user} @ {selectedBinding.host}</option>}
          {requiredHostAccounts.map((account) => <option key={accountKey(account)} value={accountKey(account)} disabled={!account.bindable}>
            {account.user} @ {account.host}{account.bindable ? '' : ` · ${account.source} account cannot be bound`}
          </option>)}
        </select>
      </FormRow>
      {requiredHostAccounts.map((account) => <p key={`${accountKey(account)}-scope`}>
        {account.user} @ {account.host} · {account.source} · scopes: {account.scopes.length ? account.scopes.join(', ') : 'unknown'}
      </p>)}
      {accountSaveError && <InlineError message={accountSaveError} />}
      <Button variant="primary" disabled={!worktree || savingAccount || loadingProvider || configuration === null || accountsData === null} onClick={() => void saveAccount()}>{savingAccount ? 'Saving account…' : 'Save account binding'}</Button>
    </section>

    <section className="ui-stack" aria-label="GitHub API Budget" aria-busy={loadingBudget} aria-live="polite">
      <SectionHeader title="GitHub API Budget" />
      <Button disabled={!worktree || refreshingBudget || loadingBudget} onClick={() => void refreshBudget(true)}>{refreshingBudget ? 'Refreshing…' : 'Refresh budget'}</Button>
      {worktree && !budget && loadingBudget && <NoticeLine>Loading GitHub API budget…</NoticeLine>}
      {worktree && !budget && budgetError && <InlineError message={budgetError} />}
      {budget && <>
        <dl className="ui-stack">
          {([['REST', budget.core], ['Search', budget.search], ['GraphQL', budget.graphql]] as const).map(([name, bucket]) => {
            const tone = percentTone(bucket)
            const badgeTone = tone === 'critical' ? 'failing' : tone === 'warning' ? 'needs-you' : tone === 'ok' ? 'working' : 'neutral'
            return <div key={name} className="ui-cluster">
              <dt>{name}</dt>
              <dd><Badge tone={badgeTone}>{budgetLabel(bucket)}</Badge> · {bucket.remaining} / {bucket.limit} remaining · {resetLabel(bucket.resetAt)}</dd>
            </div>
          })}
        </dl>
        <small className="ui-text-muted">Updated {new Date(budget.fetchedAt).toLocaleTimeString()}. Refreshes every 60 seconds while this settings view is visible.</small>
      </>}
    </section>
  </main>
}
