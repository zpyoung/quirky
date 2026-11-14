import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, FormRow, InlineError, NoticeLine, SectionHeader } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { CreationDefaults, ReviewsSurfaceProps } from '../contracts'
import { SETTINGS_VIEW } from '../contracts'
import {
  registerReviewsUiControl,
  requestReviewsUiControl,
  reviewsUiControlDescriptor,
  type ReviewsUiControlRequest,
  type ReviewsUiControlResult
} from '../checks/data'
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
type ControlAction = { action: string; enabled: boolean }
type ControlLease = { target: string; generation: number; changed(): void; dispose(): void }
type ControlRun = (request: ReviewsUiControlRequest, isCurrent: () => boolean, generation: number) => void
type SettingsControlOptions = {
  context: UiPluginContext
  slot: string
  worktree: string | null
  actions(): ControlAction[]
  run: ControlRun
  onError(message: string): void
}

function settingsControlTarget(slot: string, worktree: string | null): string {
  return JSON.stringify([SETTINGS_VIEW, slot, worktree, null, null, null, null])
}

function exactValue(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} received an invalid payload.`)
  }
  return value
}

function noValue(request: ReviewsUiControlRequest, action: string): void {
  if (request.value !== undefined) throw new Error(`${action} does not accept command arguments.`)
}

function settingsControlError(result: ReviewsUiControlResult): string {
  if (result.delivered) return 'The Hosting settings action could not be delivered.'
  if (result.reason === 'disabled') return 'This Hosting settings control is currently disabled.'
  if (result.reason === 'unknown-action') return 'This Hosting settings action is no longer available.'
  return 'The Hosting settings surface changed before this action was delivered.'
}

function requestSettingsControl(
  context: UiPluginContext,
  request: ReviewsUiControlRequest
): Promise<ReviewsUiControlResult> {
  const descriptor = reviewsUiControlDescriptor(request)
  return requestReviewsUiControl(context, descriptor.args)
}

function useSettingsControl(options: SettingsControlOptions) {
  const target = settingsControlTarget(options.slot, options.worktree)
  const actionsRef = useRef(options.actions)
  const runRef = useRef(options.run)
  const errorRef = useRef(options.onError)
  const registrationRef = useRef<ControlLease | null>(null)
  const [reported, setReported] = useState<{ target: string; generation: number } | null>(null)
  const actionsKey = JSON.stringify(options.actions())

  useLayoutEffect(() => {
    actionsRef.current = options.actions
    runRef.current = options.run
    errorRef.current = options.onError
  })

  useLayoutEffect(() => {
    let registrationGeneration = 0
    const registration = registerReviewsUiControl(options.context, {
      surface: SETTINGS_VIEW,
      slot: options.slot,
      target,
      actions: () => actionsRef.current(),
      run: (request, isCurrent) => {
        runRef.current(request, isCurrent, registrationGeneration)
      }
    })
    registrationGeneration = registration.generation
    const lease = {
      target,
      generation: registration.generation,
      changed: registration.changed,
      dispose: registration.dispose
    }
    registrationRef.current = lease
    setReported({ target, generation: registration.generation })
    return () => {
      registration.dispose()
      if (registrationRef.current === lease) registrationRef.current = null
    }
  }, [options.context, options.slot, target])

  useEffect(() => {
    const lease = registrationRef.current
    if (lease?.target === target) lease.changed()
  }, [actionsKey, target])

  async function request(action: string, value?: Record<string, unknown>) {
    const lease = registrationRef.current
    if (!lease || lease.target !== target) return null
    const controlRequest: ReviewsUiControlRequest = {
      target,
      generation: lease.generation,
      action,
      ...(value === undefined ? {} : { value })
    }
    try {
      const result = await requestSettingsControl(options.context, controlRequest)
      if (!result.delivered && registrationRef.current === lease) errorRef.current(settingsControlError(result))
      return result
    } catch (error) {
      if (registrationRef.current === lease) errorRef.current(errorText(error))
      return null
    }
  }
  const stableRequest = useCallback(request, [options.context, target])

  return {
    target,
    generation: reported?.target === target ? reported.generation : undefined,
    request: stableRequest
  }
}
type SettingsOperationKind = 'workspace' | 'defaults' | 'account' | 'provider' | 'budget'
type SettingsOperationOwner = {
  kind: SettingsOperationKind
  action: string
  worktree: string | null
  scope: string
  token: symbol
  isCurrent: () => boolean
  forceBudget: boolean
}
type SettingsOperationState = Record<SettingsOperationKind, SettingsOperationOwner | null>


export function HostingSettings(props: ReviewsSurfaceProps) {
  const selectedWorktreeId = selectedWorktreeFromLayout(props)
  const initialSettingsWorktree = useRef(props.state.settings.worktree).current
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
  const accountSelectionRef = useRef(accountSelection)
  accountSelectionRef.current = accountSelection
  const [accountSaveError, setAccountSaveError] = useState<string | null>(null)
  const [globalDefaults, setGlobalDefaults] = useState<CreationDefaults>({ ...props.state.defaults })
  const [repoDefaults, setRepoDefaults] = useState<CreationDefaults>({ ...props.state.defaults })
  const [repoHasOverride, setRepoHasOverride] = useState(false)
  const [repoId, setRepoId] = useState<string | null>(null)
  const [repoDefaultsWorktree, setRepoDefaultsWorktree] = useState<string | null>(null)
  const [defaultScope, setDefaultScope] = useState<'global' | 'repository'>('global')
  const globalDefaultsRef = useRef(globalDefaults)
  const repoDefaultsRef = useRef(repoDefaults)
  const repoHasOverrideRef = useRef(repoHasOverride)
  const defaultScopeRef = useRef(defaultScope)
  globalDefaultsRef.current = globalDefaults
  repoDefaultsRef.current = repoDefaults
  repoHasOverrideRef.current = repoHasOverride
  defaultScopeRef.current = defaultScope
  const setGlobalDefaultsLocal = (value: CreationDefaults) => {
    globalDefaultsRef.current = value
    setGlobalDefaults(value)
  }
  const setRepoDefaultsLocal = (value: CreationDefaults) => {
    repoDefaultsRef.current = value
    setRepoDefaults(value)
  }
  const setRepoOverride = (value: boolean) => {
    repoHasOverrideRef.current = value
    setRepoHasOverride(value)
  }
  const setDefaultScopeLocal = (value: 'global' | 'repository') => {
    defaultScopeRef.current = value
    setDefaultScope(value)
  }
  const defaultsForScope = (scope: 'global' | 'repository', target: string | null) =>
    scope === 'repository' && target !== null && repoDefaultsWorktree === target && repoHasOverrideRef.current
      ? repoDefaultsRef.current
      : globalDefaultsRef.current
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const [globalDefaultsReady, setGlobalDefaultsReady] = useState(false)
  const [globalDefaultsLoading, setGlobalDefaultsLoading] = useState(true)
  const [repositoryDefaultsLoading, setRepositoryDefaultsLoading] = useState(false)
  const [repositoryDefaultsFailed, setRepositoryDefaultsFailed] = useState(false)
  const [registeredWorktrees, setRegisteredWorktrees] = useState<WorkspaceOption[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(true)
  const [workspacesError, setWorkspacesError] = useState<string | null>(null)
  const [operationState, setOperationState] = useState<SettingsOperationState>({
    workspace: null, defaults: null, account: null, provider: null, budget: null
  })
  const operationStateRef = useRef(operationState)
  operationStateRef.current = operationState
  const operationLocks = useRef(new Map<string, SettingsOperationOwner>())
  const defaultsLoadSequence = useRef(0)
  const workspaceRequestSequence = useRef(0)
  const mounted = useRef(false)
  const currentWorktree = useRef(worktree)
  const worktreeSession = useRef({ worktree, epoch: 0 })
  if (worktreeSession.current.worktree !== worktree) {
    worktreeSession.current = { worktree, epoch: worktreeSession.current.epoch + 1 }
  }
  currentWorktree.current = worktree
  const worktreeSessionEpoch = worktreeSession.current.epoch
  const settingsError = settingsMatches ? settings.error : null
  const providerOwner = operationState.provider
  const budgetOwner = operationState.budget
  const loadingProvider = worktree !== null && providerOwner?.worktree === worktree && providerOwner.isCurrent()
  const loadingBudget = worktree !== null && (
    (budgetOwner?.worktree === worktree && budgetOwner.isCurrent()) ||
    (providerOwner?.worktree === worktree && providerOwner.isCurrent() && providerOwner.forceBudget)
  )
  const savingAccount = worktree !== null && operationState.account?.worktree === worktree && operationState.account.isCurrent()
  const savingDefaults = operationState.defaults?.worktree === worktree
    && operationState.defaults.scope === defaultScope && operationState.defaults.isCurrent()
  const refreshingBudget = worktree !== null && budgetOwner?.worktree === worktree && budgetOwner.isCurrent()
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
  const setOperationOwner = (kind: SettingsOperationKind, owner: SettingsOperationOwner | null) => {
    const next = { ...operationStateRef.current, [kind]: owner }
    operationStateRef.current = next
    setOperationState(next)
  }
  const operationKey = (kind: SettingsOperationKind, target: string | null, scope: string) => JSON.stringify([kind, target, scope])
  const operationLocked = (kind: SettingsOperationKind, target: string | null, scope: string) => operationLocks.current.has(operationKey(kind, target, scope))
  const operationOwnerIsCurrent = (kind: SettingsOperationKind, target: string | null, scope?: string) => {
    const owner = operationStateRef.current[kind]
    return owner !== null && owner.worktree === target && owner.isCurrent() && (scope === undefined || owner.scope === scope)
  }
  const startOperation = (
    kind: SettingsOperationKind,
    action: string,
    target: string | null,
    scope: string,
    isCurrent: () => boolean,
    forceBudget: boolean,
    operation: (owner: SettingsOperationOwner) => Promise<void>,
    onFailure: (message: string) => void
  ) => {
    const key = operationKey(kind, target, scope)
    if (operationLocks.current.has(key)) return false
    const owner: SettingsOperationOwner = { kind, action, worktree: target, scope, token: Symbol(action), isCurrent, forceBudget }
    operationLocks.current.set(key, owner)
    setOperationOwner(kind, owner)
    void Promise.resolve().then(() => operation(owner))
      .catch((error: unknown) => {
        if (isCurrent() && mounted.current) onFailure(errorText(error))
      })
      .finally(() => {
        if (operationLocks.current.get(key) === owner) operationLocks.current.delete(key)
        if (mounted.current && operationStateRef.current[kind] === owner) setOperationOwner(kind, null)
      })
    return true
  }

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operationLocks.current.clear()
    }
  }, [])
  useEffect(() => {
    for (const [key, owner] of operationLocks.current) {
      const replacedTarget = owner.kind !== 'workspace' && owner.worktree !== worktree
      const replacedScope = owner.kind === 'defaults' && owner.scope !== defaultScope
      if ((replacedTarget || replacedScope) && operationLocks.current.get(key) === owner) operationLocks.current.delete(key)
    }
  }, [defaultScope, worktree])

  const loadWorktrees = useCallback(async (isCurrent: () => boolean = () => mounted.current) => {
    const request = ++workspaceRequestSequence.current
    setWorkspacesLoading(true)
    setWorkspacesError(null)
    try {
      const value = await props.context.call('quirky.worktree/list', {})
      if (workspaceRequestSequence.current !== request || !mounted.current) return
      const workspaces = workspaceOptions(value)
      if (workspaces === null) throw new Error('The worktree service returned an invalid workspace list.')
      setRegisteredWorktrees(workspaces)
      setSelectedWorktree((current) => {
        const requested = selectionTouched.current ? current : current ?? selectedWorktreeId ?? initialSettingsWorktree
        selectionTouched.current = true
        return requested !== null && workspaces.some((item) => item.id === requested) ? requested : null
      })
    } catch (error) {
      if (workspaceRequestSequence.current === request && mounted.current && isCurrent()) setWorkspacesError(errorText(error))
    } finally {
      if (workspaceRequestSequence.current === request && mounted.current) setWorkspacesLoading(false)
    }
  }, [initialSettingsWorktree, props.context, selectedWorktreeId])

  useEffect(() => {
    void loadWorktrees()
    return () => { workspaceRequestSequence.current += 1 }
  }, [loadWorktrees])

  const runBudgetRefresh = useCallback(async (target: string, force: boolean, isCurrent: () => boolean) => {
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingBudget', { worktree: target, force })
    } catch (error) {
      if (!isCurrent()) return
      setLocalSettingsError(errorText(error))
    }
    if (!isCurrent()) return
    await props.refresh()
  }, [props.context, props.refresh])

  const runProviderRefresh = useCallback(async (target: string, forceBudget: boolean, isCurrent: () => boolean) => {
    setLocalSettingsError(null)
    try {
      await props.context.call('quirky.reviews/hostingSettingsRefresh', { worktree: target, forceBudget })
    } catch (error) {
      if (!isCurrent()) return
      setLocalSettingsError(errorText(error))
    }
    if (!isCurrent()) return
    await props.refresh()
  }, [props.context, props.refresh])
  const runProviderRefreshFor = async (target: string, forceBudget: boolean, owner: SettingsOperationOwner) => {
    const previous = operationStateRef.current.provider
    setOperationOwner('provider', owner)
    try {
      await runProviderRefresh(target, forceBudget, owner.isCurrent)
    } catch (error) {
      if (owner.isCurrent()) setLocalSettingsError(errorText(error))
    } finally {
      if (operationStateRef.current.provider === owner) setOperationOwner('provider', previous)
    }
  }

  const refreshBudget = useCallback((force: boolean) => {
    const target = worktree
    if (!target) return
    const session = worktreeSession.current.epoch
    const isCurrent = () => mounted.current && currentWorktree.current === target && worktreeSession.current.epoch === session
    startOperation(
      'budget',
      force ? 'budget-visible-refresh' : 'budget-timer-refresh',
      target,
      'hosting',
      isCurrent,
      force,
      () => runBudgetRefresh(target, force, isCurrent),
      setLocalSettingsError
    )
  }, [runBudgetRefresh, worktree])

  const recheckProvider = useCallback((forceBudget = true) => {
    const target = worktree
    if (!target) return
    const session = worktreeSession.current.epoch
    const isCurrent = () => mounted.current && currentWorktree.current === target && worktreeSession.current.epoch === session
    startOperation(
      'provider',
      'provider-recheck',
      target,
      'hosting',
      isCurrent,
      forceBudget,
      () => runProviderRefresh(target, forceBudget, isCurrent),
      setLocalSettingsError
    )
  }, [runProviderRefresh, worktree])

  const loadDefaults = useCallback(async (request: number, controlCurrent: () => boolean = () => true) => {
    const target = worktree
    const session = worktreeSession.current.epoch
    const isCurrent = () => mounted.current && controlCurrent()
      && defaultsLoadSequence.current === request
      && currentWorktree.current === target
      && worktreeSession.current.epoch === session
    if (!isCurrent()) return
    setGlobalDefaultsLoading(true)
    setGlobalDefaultsReady(false)
    setRepositoryDefaultsLoading(false)
    setRepositoryDefaultsFailed(false)
    setRepoDefaultsWorktree(null)
    setRepoOverride(false)
    setRepoId(null)
    setDefaultsError(null)
    try {
      const globalResult = await props.context.call('quirky.reviews/creationDefaults', { scope: 'global' })
      if (!isCurrent()) return
      if (!isRecord(globalResult)) throw new Error('Creation defaults returned an invalid response.')
      const global = defaultsValue(globalResult.defaults)
      if (!global) throw new Error('Creation defaults returned invalid booleans.')
      setGlobalDefaultsLocal(global)
      setRepoDefaultsLocal(global)
      setGlobalDefaultsReady(true)
      setGlobalDefaultsLoading(false)
      if (!target) {
        setDefaultScopeLocal('global')
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
        setRepoDefaultsLocal(repository)
        setRepoOverride(hasOverride)
        setRepoId(currentRepoId)
        setRepoDefaultsWorktree(target)
        setDefaultScopeLocal(hasOverride ? 'repository' : 'global')
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
  }, [props.context, worktree, worktreeSessionEpoch])

  useEffect(() => {
    const request = ++defaultsLoadSequence.current
    setLocalSettingsError(null)
    setAccountSaveError(null)
    setDefaultsError(null)
    setRepoDefaultsWorktree(null)
    setRepoOverride(false)
    setRepoId(null)
    setDefaultScopeLocal('global')
    void loadDefaults(request)
    if (worktree) recheckProvider(true)
    return () => {
      if (defaultsLoadSequence.current === request) defaultsLoadSequence.current += 1
    }
  }, [loadDefaults, recheckProvider, worktree])

  useEffect(() => {
    accountSelectionRef.current = storedAccountKey
    setAccountSelection(storedAccountKey)
  }, [worktree, storedAccountKey])

  useEffect(() => {
    const refreshVisibleBudget = () => {
      if (document.visibilityState === 'visible') refreshBudget(false)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshBudget(true)
    }
    const timer = window.setInterval(refreshVisibleBudget, 60_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refreshBudget])
  const selectedDefaults = defaultScope === 'global' || !repositoryDefaultsReady ? globalDefaults : repoDefaults
  const displayedDefaults = defaultScope === 'repository' && !currentRepoHasOverride ? globalDefaults : selectedDefaults
  const setDefault = (key: keyof CreationDefaults, value: boolean) => {
    const scope = defaultScopeRef.current
    if (!globalDefaultsReady || (scope === 'repository' && !repositoryDefaultsReady)) return
    const current = scope === 'global' ? globalDefaultsRef.current : repoDefaultsRef.current
    const next = { ...current, [key]: value }
    if (scope === 'global') setGlobalDefaultsLocal(next)
    else {
      setRepoDefaultsLocal(next)
      setRepoOverride(true)
    }
  }
  const updateAccountSelection = (value: string) => {
    accountSelectionRef.current = value
    setAccountSelection(value)
    setAccountSaveError(null)
  }

  const requiredHost = accountsData?.requiredHost ?? provider?.requiredHost ?? null
  const requiredHostAccounts = requiredHost === null ? [] : accounts.filter((account) =>
    account.host.toLowerCase() === requiredHost.toLowerCase())
  const selectedBinding = configuration?.account ?? null
  const bindingAvailable = selectedBinding === null || accountsData === null ||
    requiredHostAccounts.some((account) =>
      account.host.toLowerCase() === selectedBinding.host.toLowerCase() && account.user === selectedBinding.user)
  const accountOption = selectedBinding ? accountKey(selectedBinding) : 'ambient'
  const selectedAccount = accountSelectionRef.current === 'ambient' ? null
    : requiredHostAccounts.find((account) => accountKey(account) === accountSelectionRef.current && account.bindable) ?? null
  const workspaceReadBusy = operationLocked('workspace', null, 'worktrees')
  const defaultsReadBusy = operationLocked('defaults', worktree, 'read')
  const defaultsWriteBusy = operationLocked('defaults', worktree, defaultScope)
  const accountWriteBusy = operationLocked('account', worktree, 'hosting')
  const canSelectAccount = worktree !== null && configuration !== null && accountsData !== null &&
    !savingAccount && !loadingProvider && !accountWriteBusy
  const canSaveAccount = canSelectAccount && (accountSelectionRef.current === 'ambient' || selectedAccount !== null)
  const canSelectRepositoryScope = worktree !== null && repositoryDefaultsReady && !repositoryDefaultsLoading &&
    !repositoryDefaultsFailed && globalDefaultsReady && !savingDefaults && !defaultsReadBusy && !defaultsWriteBusy
  const canEditDefaults = globalDefaultsReady && !globalDefaultsLoading &&
    (defaultScope === 'global' || (repositoryDefaultsReady && !repositoryDefaultsLoading && !repositoryDefaultsFailed)) &&
    !savingDefaults && !defaultsReadBusy && !defaultsWriteBusy
  const canSaveDefaults = canEditDefaults
  const canResetDefaults = defaultScope === 'repository' && currentRepoHasOverride && !savingDefaults &&
    !repositoryDefaultsLoading && !defaultsReadBusy && !defaultsWriteBusy
  const defaultsReadFailed = defaultsError !== null && (!globalDefaultsReady || repositoryDefaultsFailed)
  const canRetryDefaults = defaultsReadFailed && !globalDefaultsLoading && !repositoryDefaultsLoading && !defaultsReadBusy
  const canRecheckProvider = worktree !== null && !loadingProvider && !operationLocked('provider', worktree, 'hosting')
  const canRefreshBudget = worktree !== null && !loadingBudget && !operationLocked('budget', worktree, 'hosting')
  const currentFor = (target: string | null, isCurrent: () => boolean, session = worktreeSessionEpoch) =>
    () => mounted.current && isCurrent() && currentWorktree.current === target && worktreeSession.current.epoch === session

  const runWorkspaceControl: ControlRun = (request, isCurrent) => {
    const target = worktree
    const current = currentFor(target, isCurrent)
    if (request.action === 'workspace-select') {
      const value = exactValue(request.value, ['worktree'], 'Worktree selection')
      if (value.worktree !== null && typeof value.worktree !== 'string') throw new Error('Choose a registered Git worktree.')
      if (workspacesLoading || workspacesError !== null) throw new Error('The registered-worktree list is not ready.')
      const selected = value.worktree
      if (selected !== null && !registeredWorktrees.some((workspace) => workspace.id === selected)) {
        throw new Error('Choose a registered Git worktree.')
      }
      if (!current()) return
      selectionTouched.current = true
      setSelectedWorktree(selected)
      return
    }
    if (request.action === 'workspaces-retry') {
      noValue(request, request.action)
      if (!workspacesError || workspacesLoading) throw new Error('Registered worktrees cannot be retried right now.')
      startOperation(
        'workspace', 'workspaces-read', null, 'worktrees', current, false,
        async (owner) => { await loadWorktrees(owner.isCurrent) },
        setWorkspacesError
      )
    }
  }

  const runDefaultsControl: ControlRun = (request, isCurrent) => {
    const target = worktree
    const scope = defaultScopeRef.current
    const current = currentFor(target, isCurrent)
    if (request.action === 'defaults-scope') {
      const value = exactValue(request.value, ['scope'], 'Defaults scope')
      if (value.scope !== 'global' && value.scope !== 'repository') throw new Error('Choose a supported creation-default scope.')
      if (value.scope === 'global' && !globalDefaultsReady) throw new Error('Global creation defaults are not ready.')
      if (value.scope === 'repository' && !canSelectRepositoryScope) throw new Error('Repository creation defaults are not ready.')
      if (savingDefaults) throw new Error('Creation defaults are being saved.')
      if (!current()) return
      setDefaultScopeLocal(value.scope)
      setDefaultsError(null)
      return
    }
    if (request.action === 'defaults-set') {
      const value = exactValue(request.value, ['key', 'value'], 'Creation default')
      const field = DEFAULT_FIELDS.find(({ key }) => key === value.key)
      if (!field || typeof value.value !== 'boolean') throw new Error('Choose a known creation default and a boolean value.')
      if (!canEditDefaults) throw new Error('Creation defaults are not ready to edit.')
      if (!current()) return
      setDefault(field.key, value.value)
      setDefaultsError(null)
      return
    }
    if (request.action === 'defaults-save') {
      noValue(request, request.action)
      if (!canSaveDefaults) throw new Error('Creation defaults are not ready to save.')
      const values = { ...defaultsForScope(scope, target) }
      setDefaultsError(null)
      startOperation('defaults', 'defaults-write', target, scope, current, false, async (owner) => {
        const params = scope === 'repository' ? { scope, worktree: target, defaults: values } : { scope, defaults: values }
        await props.context.call('quirky.reviews/setCreationDefaults', params)
        if (!owner.isCurrent()) return
        if (scope === 'repository') setRepoOverride(true)
        else setGlobalDefaultsLocal(values)
        await props.refresh()
      }, setDefaultsError)
      return
    }
    if (request.action === 'defaults-reset') {
      noValue(request, request.action)
      if (!target || !canResetDefaults) throw new Error('Repository defaults cannot be reset right now.')
      setDefaultsError(null)
      startOperation('defaults', 'defaults-write', target, scope, current, false, async (owner) => {
        const result = await props.context.call('quirky.reviews/resetCreationDefaults', { scope: 'repository', worktree: target })
        if (!owner.isCurrent()) return
        const parsed = isRecord(result) ? defaultsValue(result.defaults) : null
        if (!parsed) throw new Error('Reset did not return the inherited defaults.')
        setGlobalDefaultsLocal(parsed)
        setRepoDefaultsLocal(parsed)
        setRepoOverride(false)
        setDefaultScopeLocal('global')
        await props.refresh()
      }, setDefaultsError)
      return
    }
    if (request.action === 'defaults-retry') {
      noValue(request, request.action)
      if (!canRetryDefaults) throw new Error('Creation defaults are not currently retryable.')
      const read = ++defaultsLoadSequence.current
      startOperation('defaults', 'defaults-read', target, 'read', current, false, async (owner) => {
        await loadDefaults(read, owner.isCurrent)
      }, setDefaultsError)
    }
  }

  const runHostingControl: ControlRun = (request, isCurrent) => {
    const target = worktree
    const current = currentFor(target, isCurrent)
    if (request.action === 'account-select') {
      if (!canSelectAccount) throw new Error('Repository account selection is not ready.')
      const value = request.value
      if (isRecord(value) && Object.keys(value).length === 1 && value.ambient === true) {
        if (!current()) return
        updateAccountSelection('ambient')
        return
      }
      const accountValue = exactValue(value, ['host', 'user'], 'Account selection')
      const { host, user } = accountValue
      if (typeof host !== 'string' || host === '' || typeof user !== 'string' || user === '') {
        throw new Error('Choose a non-empty account host and user.')
      }
      const account = requiredHost === null ? null : requiredHostAccounts.find((candidate) =>
        candidate.bindable
        && candidate.host.toLowerCase() === requiredHost.toLowerCase()
        && candidate.host.toLowerCase() === host.toLowerCase()
        && candidate.user === user)
      if (!account) throw new Error('Choose an existing bindable account for this repository host.')
      if (!current()) return
      updateAccountSelection(accountKey(account))
      return
    }
    if (request.action === 'account-save') {
      noValue(request, request.action)
      if (!target || !canSaveAccount) throw new Error('Repository account binding is not ready to save.')
      const selected = accountSelectionRef.current === 'ambient' ? null
        : requiredHostAccounts.find((account) => accountKey(account) === accountSelectionRef.current && account.bindable) ?? null
      if (accountSelectionRef.current !== 'ambient' && selected === null) {
        throw new Error('Choose an existing keyring account for this repository host.')
      }
      setAccountSaveError(null)
      startOperation('account', 'account-write', target, 'hosting', current, true, async (owner) => {
        try {
          if (selected === null) await props.context.call('quirky.reviews/hostingUnbindAccount', { worktree: target })
          else await props.context.call('quirky.reviews/hostingBindAccount', { worktree: target, host: selected.host, user: selected.user })
          if (!owner.isCurrent()) return
          await runProviderRefreshFor(target, true, owner)
        } catch (error) {
          if (!owner.isCurrent()) return
          const message = errorText(error)
          setAccountSaveError(message)
          try {
            await props.refresh()
          } catch (refreshError) {
            if (owner.isCurrent()) setAccountSaveError(`${message} The displayed settings could not be refreshed: ${errorText(refreshError)}`)
          }
        }
      }, setAccountSaveError)
      return
    }
    if (request.action === 'provider-recheck') {
      noValue(request, request.action)
      if (!canRecheckProvider || !target) throw new Error('GitHub readiness cannot be rechecked right now.')
      startOperation('provider', 'provider-read', target, 'hosting', current, true,
        (owner) => runProviderRefresh(target, true, owner.isCurrent),
        setLocalSettingsError)
      return
    }
    if (request.action === 'budget-refresh') {
      noValue(request, request.action)
      if (!canRefreshBudget || !target) throw new Error('GitHub API budget cannot be refreshed right now.')
      startOperation('budget', 'budget-read', target, 'hosting', current, true,
        (owner) => runBudgetRefresh(target, true, owner.isCurrent),
        setLocalSettingsError)
    }
  }

  const workspaceControl = useSettingsControl({
    context: props.context,
    slot: 'settings-workspace',
    worktree,
    actions: () => [
      { action: 'workspace-select', enabled: !workspacesLoading && workspacesError === null && !operationLocked('workspace', null, 'worktrees') },
      { action: 'workspaces-retry', enabled: workspacesError !== null && !workspacesLoading && !operationLocked('workspace', null, 'worktrees') }
    ],
    run: runWorkspaceControl,
    onError: setLocalSettingsError
  })

  const defaultsControl = useSettingsControl({
    context: props.context,
    slot: defaultScope === 'global' ? 'settings-defaults-global' : 'settings-defaults-repository',
    worktree,
    actions: () => {
      const defaultsBusy = operationOwnerIsCurrent('defaults', worktree, defaultScope)
      const defaultsReadLocked = operationLocked('defaults', worktree, 'read')
      const defaultsWriteLocked = operationLocked('defaults', worktree, defaultScope)
      const repositoryReady = worktree !== null && repoDefaultsWorktree === worktree
      const editable = globalDefaultsReady && !globalDefaultsLoading &&
        (defaultScope === 'global' || (repositoryReady && !repositoryDefaultsLoading && !repositoryDefaultsFailed)) &&
        !defaultsBusy && !defaultsReadLocked && !defaultsWriteLocked
      const canChangeScope = globalDefaultsReady && !globalDefaultsLoading && !defaultsBusy &&
        !defaultsReadLocked && !defaultsWriteLocked
      const canRetry = defaultsError !== null && (!globalDefaultsReady || repositoryDefaultsFailed) &&
        !globalDefaultsLoading && !repositoryDefaultsLoading && !defaultsReadLocked
      const hasOverride = repositoryReady && repoHasOverride
      const actions: ControlAction[] = [
        { action: 'defaults-scope', enabled: canChangeScope },
        { action: 'defaults-set', enabled: editable },
        { action: 'defaults-save', enabled: editable },
        { action: 'defaults-retry', enabled: canRetry }
      ]
      if (defaultScope === 'repository' && hasOverride) {
        actions.push({ action: 'defaults-reset', enabled: repositoryReady && !repositoryDefaultsLoading && !defaultsBusy && !defaultsReadLocked && !defaultsWriteLocked })
      }
      return actions
    },
    run: runDefaultsControl,
    onError: setDefaultsError
  })

  const hostingControl = useSettingsControl({
    context: props.context,
    slot: 'settings-hosting',
    worktree,
    actions: () => {
      const accountBusy = operationOwnerIsCurrent('account', worktree, 'hosting')
      const providerBusy = operationOwnerIsCurrent('provider', worktree, 'hosting') || accountBusy
      const budgetBusy = operationOwnerIsCurrent('budget', worktree, 'hosting') ||
        (operationOwnerIsCurrent('provider', worktree, 'hosting') && operationStateRef.current.provider?.forceBudget === true) ||
        (accountBusy && operationStateRef.current.account?.forceBudget === true)
      const canSelect = worktree !== null && configuration !== null && accountsData !== null && !accountBusy && !providerBusy
      const selectionIsValid = accountSelectionRef.current === 'ambient' || requiredHostAccounts.some((account) =>
        accountKey(account) === accountSelectionRef.current && account.bindable)
      return [
        { action: 'provider-recheck', enabled: worktree !== null && !providerBusy && !operationLocked('provider', worktree, 'hosting') },
        { action: 'budget-refresh', enabled: worktree !== null && !budgetBusy && !operationLocked('budget', worktree, 'hosting') },
        { action: 'account-select', enabled: canSelect },
        { action: 'account-save', enabled: canSelect && selectionIsValid && !operationLocked('account', worktree, 'hosting') }
      ]
    },
    run: runHostingControl,
    onError: setLocalSettingsError
  })

  const githubReadiness = providerError ? 'Unavailable' : !provider ? 'Checking…'
    : !provider.ghAvailable ? 'Not installed'
      : !provider.requiredHostAuthenticated ? 'Not authenticated'
        : provider.missingScopes.length > 0 ? 'Connected · scope update needed'
          : 'Connected'
  const activeAccount = provider && isRecord(provider.activeAccount) && typeof provider.activeAccount.user === 'string' && typeof provider.activeAccount.host === 'string'
    ? `${provider.activeAccount.user} @ ${provider.activeAccount.host}` : null

  return <main className="ui-stack" aria-label="Hosting settings">
    <header className="ui-stack">
      <SectionHeader title="Hosting settings" />
      {worktree ? <p>Repository scope: <code>{repositoryDefaultsReady ? repoId ?? worktree : worktree}</code></p> : <p>Global settings are available. Select a worktree to inspect repository hosting.</p>}
    </header>

    <section className="ui-stack" aria-label="Workspace" aria-busy={workspacesLoading} aria-live="polite" data-review-control-target={workspaceControl.target} data-review-control-generation={workspaceControl.generation}>
      <SectionHeader title="Workspace" />
      <FormRow label="Repository worktree" htmlFor="settings-worktree">
        <select
          id="settings-worktree"
          className="ui-text-field__input"
          value={worktree ?? ''}
          disabled={workspacesLoading || workspacesError !== null || workspaceReadBusy}
          onChange={(event) => { void workspaceControl.request('workspace-select', { worktree: event.target.value === '' ? null : event.target.value }) }}
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
        action={{ label: 'Retry worktrees', onAction: () => { void workspaceControl.request('workspaces-retry') } }}
      />}
      {!workspacesLoading && !workspacesError && registeredWorktrees.length === 0 &&
        <EmptyState message="No registered Git worktrees are available. Global creation defaults remain available." />}
      <small className="ui-text-muted">Repository hosting settings require a registered Git worktree. Global defaults are available without one.</small>
    </section>

    {contextErrorFromLayout && <InlineError message={contextErrorFromLayout} />}
    {localSettingsError && <InlineError message={localSettingsError} />}
    {settingsError && <InlineError message={`Hosting observations may be stale: ${settingsError}`} />}

    <div className="ui-stack" data-review-control-target={hostingControl.target} data-review-control-generation={hostingControl.generation}>
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
        <Button disabled={!canRecheckProvider} onClick={() => { void hostingControl.request('provider-recheck') }}>{loadingProvider ? 'Re-checking…' : 'Re-check GitHub'}</Button>
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

    <section className="ui-stack" aria-label="Hosted-review creation defaults" aria-busy={globalDefaultsLoading || repositoryDefaultsLoading || savingDefaults} aria-live="polite" data-review-control-target={defaultsControl.target} data-review-control-generation={defaultsControl.generation}>
      <SectionHeader title="Hosted-review creation defaults" />
      {globalDefaultsLoading && <NoticeLine>Loading creation defaults…</NoticeLine>}
      {repositoryDefaultsLoading && <NoticeLine>Loading repository creation defaults…</NoticeLine>}
      <fieldset className="ui-stack">
        <legend>Apply defaults to</legend>
        <FormRow label="Global" htmlFor="creation-default-global">
          <input id="creation-default-global" type="radio" style={{ accentColor: 'var(--ui-accent)' }} name="creation-default-scope" value="global" checked={defaultScope === 'global'} disabled={!globalDefaultsReady || savingDefaults || defaultsReadBusy || defaultsWriteBusy} onChange={() => {
            void defaultsControl.request('defaults-scope', { scope: 'global' })
          }} />
        </FormRow>
        <FormRow label={`This repository${currentRepoHasOverride ? ' · overrides global' : ' · inherits global'}`} htmlFor="creation-default-repository">
          <input id="creation-default-repository" type="radio" style={{ accentColor: 'var(--ui-accent)' }} name="creation-default-scope" value="repository" checked={defaultScope === 'repository'} disabled={!canSelectRepositoryScope || defaultsReadBusy || defaultsWriteBusy} onChange={() => {
            void defaultsControl.request('defaults-scope', { scope: 'repository' })
          }} />
        </FormRow>
      </fieldset>
      <fieldset className="ui-stack" disabled={!canEditDefaults}>
        <legend>Creation options</legend>
        {DEFAULT_FIELDS.map(({ key, label }) => <FormRow key={key} label={label} htmlFor={`creation-default-${key}`}>
          <input id={`creation-default-${key}`} type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={displayedDefaults[key]} onChange={(event) => {
            void defaultsControl.request('defaults-set', { key, value: event.target.checked })
          }} />
        </FormRow>)}
      </fieldset>
      {defaultsError && <InlineError
        message={defaultsError}
        action={canRetryDefaults ? { label: 'Retry defaults', onAction: () => { void defaultsControl.request('defaults-retry') } } : undefined}
      />}
      <div className="ui-cluster">
        <Button variant="primary" disabled={!canSaveDefaults} onClick={() => { void defaultsControl.request('defaults-save') }}>{savingDefaults ? 'Saving…' : 'Save creation defaults'}</Button>
        {defaultScope === 'repository' && currentRepoHasOverride && <Button disabled={!canResetDefaults} onClick={() => { void defaultsControl.request('defaults-reset') }}>
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
          disabled={!canSelectAccount}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'ambient') {
              void hostingControl.request('account-select', { ambient: true })
              return
            }
            const account = requiredHostAccounts.find((candidate) => accountKey(candidate) === value)
            if (account) void hostingControl.request('account-select', { host: account.host, user: account.user })
          }}
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
      <Button variant="primary" disabled={!canSaveAccount} onClick={() => { void hostingControl.request('account-save') }}>{savingAccount ? 'Saving account…' : 'Save account binding'}</Button>
    </section>

    <section className="ui-stack" aria-label="GitHub API Budget" aria-busy={loadingBudget} aria-live="polite">
      <SectionHeader title="GitHub API Budget" />
      <Button disabled={!canRefreshBudget} onClick={() => { void hostingControl.request('budget-refresh') }}>{refreshingBudget ? 'Refreshing…' : 'Refresh budget'}</Button>
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
    </div>
  </main>
}
