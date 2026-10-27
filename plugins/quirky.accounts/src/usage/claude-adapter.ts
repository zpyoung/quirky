import { readClaudeCredentialForTarget, type CredentialRead } from './credentials'
import { mapClaudeUsage } from './mappers'
import { errorSnapshot, responseFailure, responseJson } from './provider-utils'
import type { ProviderRuntime } from './process'
import type { ProviderSnapshot, UsageTarget } from './types'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

async function readKeychain(runtime: ProviderRuntime, service: string, account: string): Promise<CredentialRead> {
  if (process.platform !== 'darwin') return { status: 'missing' }
  try {
    const result = await runtime.run('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1024
    })
    if (result.code === 0 && result.stdout.trim()) return { status: 'found', value: result.stdout.trim() }
    if (result.code === 44 || /could not be found|not found/i.test(result.stderr)) return { status: 'missing' }
    return result.code === 0 ? { status: 'missing' } : { status: 'error' }
  } catch {
    return { status: 'error' }
  }
}

function credentialMetadata(target: UsageTarget, source: string) {
  return {
    credentialSource: source,
    authProvenance: target.accountId === null ? 'system' : 'managed'
  }
}

export async function fetchClaudeUsage(runtime: ProviderRuntime, target: UsageTarget): Promise<ProviderSnapshot> {
  const credential = await readClaudeCredentialForTarget(target, (service, account) => readKeychain(runtime, service, account))
  const metadata = credentialMetadata(target, credential.source)
  if (!credential.token) {
    if (credential.keychainUnavailable) {
      return errorSnapshot('claude', runtime.now(), 'Claude usage is unavailable.', 'keychain-unavailable', 'error', metadata)
    }
    if (target.accountId === null && !credential.hasRefreshableCredentials) {
      return errorSnapshot('claude', runtime.now(), 'No subscription plan — API key billing', 'missing-credentials', 'unavailable', metadata)
    }
    return errorSnapshot('claude', runtime.now(), 'Sign in again to use this account.', 'missing-credentials', 'error', metadata)
  }
  try {
    const response = await runtime.fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
        Accept: 'application/json'
      },
      redirect: 'error',
      credentials: 'omit'
    })
    if (!response.ok) {
      if (response.status === 403) {
        const body = await response.text().catch(() => '')
        if (body.includes('user:profile')) {
          return errorSnapshot('claude', runtime.now(), 'Claude usage requires the user:profile permission', 'missing-scope', 'error', {
            source: 'oauth',
            attemptedSources: ['oauth'],
            ...metadata
          })
        }
        return responseFailure('claude', response, runtime.now(), {
          rateLimited: 'Claude usage is rate limited right now.',
          unauthorized: 'Claude usage is unavailable.',
          generic: 'Claude usage is unavailable.'
        }, { source: 'oauth', attemptedSources: ['oauth'], ...metadata })
      }
      const error = responseFailure('claude', response, runtime.now(), {
        rateLimited: 'Claude usage is rate limited right now.',
        unauthorized: target.accountId === null
          ? 'Claude usage updates the next time Claude runs.'
          : 'Claude usage has expired. Start Claude in this account to refresh it.',
        generic: response.status >= 500 ? 'Claude usage service is unavailable.' : 'Claude usage is unavailable.'
      }, { source: 'oauth', attemptedSources: ['oauth'], ...metadata })
      return error
    }
    const mapped = mapClaudeUsage(await responseJson(response), runtime.now())
    if (mapped.status !== 'ok') {
      return errorSnapshot('claude', runtime.now(), 'Claude usage response did not include quota windows', 'parse', 'error', { source: 'oauth', attemptedSources: ['oauth'], ...metadata })
    }
    return { ...mapped, usageMetadata: { source: 'oauth', attemptedSources: ['oauth'], lastSuccessfulSource: 'oauth', ...metadata } }
  } catch {
    return errorSnapshot('claude', runtime.now(), runtime.signal.aborted ? 'Claude usage refresh was cancelled' : 'Claude usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network', 'error', { source: 'oauth', attemptedSources: ['oauth'], ...metadata })
  }
}
