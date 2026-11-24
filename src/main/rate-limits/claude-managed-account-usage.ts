import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { makeClaudeUsageResult } from './claude-usage-result'

/** Usage reads the account's own folder; a host account's comes from its id, never a stored path. */
export type InactiveClaudeAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (account.managedAuthRuntime !== 'wsl') {
    // Why the router: a covered account's usage is System default's, as its launches are.
    const authPreparation = getClaudeProfileRouter()?.accountUsagePreparation(account.id)
    return authPreparation
      ? fetchActiveClaudeRateLimits({ signal: options.signal, authPreparation })
      : signInAgain()
  }
  return signInAgain()
}

function signInAgain(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
    failureKind: 'missing-credentials',
    attemptedSources: []
  })
}
