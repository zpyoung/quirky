import { isRecord, optionalBooleanField, optionalStringField } from './data'
import type { AuthAccount } from './auth-inventory'
import type { Handler, HostingEnv, HostingConfiguration, IssueSourcePreference } from './env'

const REQUIRED_PROJECT_SCOPES = ['project', 'read:org', 'repo']

export function runtimeMethods(env: HostingEnv): Record<string, Handler> {
  const repository: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    return {
      worktreeId: scope.worktree.id,
      origin: scope.origin,
      head: scope.origin,
      repository: scope.repository,
      candidates: scope.candidates,
      issueRepository: scope.issueRepository,
      issueSourcePreference: scope.issueSourcePreference,
      issueSourceFellBack: scope.issueSourceFellBack
    }
  }

  const diagnoseAuth: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    let accounts: AuthAccount[] = []
    let ghAvailable = true
    try {
      accounts = await env.authAccounts(scope, true)
    } catch (error) {
      ghAvailable = reasonOf(error) !== 'gh_unavailable'
      if (reasonOf(error) !== 'gh_unavailable') throw error
    }
    const hostAccounts = accounts.filter((account) => account.host === scope.origin.host)
    const activeAccount = hostAccounts.find((account) => account.active) ?? null
    const scopes = new Set(hostAccounts.flatMap((account) => account.scopes))
    return {
      ghAvailable,
      activeAccount,
      accounts,
      envTokenInProcess: tokenPresentInProcess(),
      missingScopes: REQUIRED_PROJECT_SCOPES.filter((scopeName) => !scopes.has(scopeName)),
      requiredScopes: [...REQUIRED_PROJECT_SCOPES],
      hasKeyringFallback: hostAccounts.some((account) => account.source === 'keyring'),
      requiredHost: scope.origin.host,
      requiredHostAuthenticated: hostAccounts.length > 0
    }
  }

  const viewer: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    return env.cache(env.cacheKey(scope, 'viewer'), 30_000, async () => {
      const value = await env.json(scope, ['api', 'user', '--jq', '{login: .login, email: .email}'])
      if (!isRecord(value) || typeof value.login !== 'string' || value.login.length === 0) {
        throw env.invalid('invalid_response', 'GitHub returned an invalid authenticated viewer.')
      }
      return { login: value.login, ...(typeof value.email === 'string' ? { email: value.email } : {}) }
    })
  }

  const rateLimit: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    return env.rateLimit(scope, optionalBooleanField(params, 'force') === true)
  }

  const accounts: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    return {
      requiredHost: scope.origin.host,
      accounts: (await env.authAccounts(scope, true)).map((account) => ({
        ...account,
        bindable: account.source === 'keyring'
      }))
    }
  }

  const configure: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    const current = env.configuration(scope.worktree)
    const requestedPreference = optionalStringField(params, 'issueSourcePreference', 16)
    if (requestedPreference !== undefined && !isPreference(requestedPreference)) {
      throw env.invalid('invalid_issue_source_preference', 'Issue source preference must be auto, origin, or upstream.')
    }
    let account = current.account
    const clearAccount = optionalBooleanField(params, 'clearAccount') === true
    const accountProvided = Object.hasOwn(params, 'account')
    if (clearAccount && accountProvided && params.account !== null) {
      throw env.invalid('ambiguous_account_change', 'Choose either an account binding or clearAccount.')
    }
    if (clearAccount || (accountProvided && params.account === null)) account = null
    else if (accountProvided) {
      const selected = params.account
      if (!isRecord(selected) || typeof selected.host !== 'string' || typeof selected.user !== 'string'
        || selected.user.length < 1 || selected.user.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(selected.user)) {
        throw env.invalid('invalid_binding', 'A GitHub account binding requires a valid host and user.')
      }
      if (selected.host !== scope.origin.host) {
        throw env.invalid('binding_host_mismatch', 'The selected account host does not match this repository.')
      }
      account = { host: selected.host, user: selected.user }
      await env.validateBinding(scope, account)
    }
    const config: HostingConfiguration = {
      issueSourcePreference: requestedPreference ?? current.issueSourcePreference,
      account
    }
    env.saveConfiguration(scope.worktree, config)
    env.invalidate(scope)
    return { ok: true, ...config }
  }

  const configuration: Handler = async (params, caller) => {
    const scope = await env.resolve(params, caller)
    return { worktreeId: scope.worktree.id, ...env.configuration(scope.worktree) }
  }

  return { repository, diagnoseAuth, viewer, rateLimit, accounts, configure, configuration }
}

function isPreference(value: string): value is IssueSourcePreference {
  return value === 'auto' || value === 'origin' || value === 'upstream'
}

function tokenPresentInProcess(): boolean {
  return ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
    .some((name) => (process.env[name] ?? '').length > 0)
}

function reasonOf(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.reason !== 'string') return undefined
  return error.data.reason
}

