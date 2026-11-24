import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'

export class CodexManagedHomePath {
  getRoot(): string {
    const root = join(getAppEnvironment().getPath('userData'), 'codex-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  assertHostOwnership(candidatePath: string, expectedAccountId: string): string {
    return assertOwnedHostCodexManagedHomePath({
      candidatePath,
      managedAccountsRoot: join(getAppEnvironment().getPath('userData'), 'codex-accounts'),
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId
    })
  }

  async ensureForReauthentication(account: CodexManagedAccount): Promise<string> {
    try {
      return this.assert(account.managedHomePath, account.id)
    } catch (error) {
      if (!this.isMissingHomeError(error)) {
        throw error
      }
      return this.recreateExpectedHostHome(account, error)
    }
  }

  assert(candidatePath: string, expectedAccountId?: string): string {
    return assertOwnedHostCodexManagedHomePath({
      candidatePath,
      managedAccountsRoot: this.getRoot(),
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId
    })
  }

  private recreateExpectedHostHome(account: CodexManagedAccount, originalError: unknown): string {
    const expectedPath = join(this.getRoot(), account.id, 'home')
    if (!this.pathsEqual(account.managedHomePath, expectedPath)) {
      throw originalError
    }
    // Why: re-auth may recreate a lost empty home, but only at the exact Quirky-owned path persisted for this account.
    mkdirSync(expectedPath, { recursive: true })
    writeFileSync(join(expectedPath, '.quirky-managed-home'), `${account.id}\n`, 'utf-8')
    return this.assert(expectedPath, account.id)
  }

  private isMissingHomeError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message === 'Managed Codex home directory does not exist on disk.'
    )
  }

  private pathsEqual(left: string, right: string): boolean {
    const resolvedLeft = resolve(left)
    const resolvedRight = resolve(right)
    return process.platform === 'win32'
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight
  }
}
