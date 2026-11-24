import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS
} from '../../shared/windows-transient-lock-removal'
import type { ManagedCodexHomeLocation } from './codex-account-service-types'
import { writeFileAtomically } from './fs-utils'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import type { CodexManagedHomePath } from './codex-managed-home-path'

function removeManagedHomeTreeSync(targetPath: string): void {
  // Why: codex login descendants can briefly keep Windows handles on files in
  // the managed home (e.g. log/codex-login.log); bounded retries absorb the
  // transient lock instead of failing with ENOTEMPTY and orphaning the home.
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  })
}

export class CodexManagedHomeLifecycle {
  constructor(private readonly paths: CodexManagedHomePath) {}

  create(accountId: string): ManagedCodexHomeLocation {
    const managedHomePath = join(this.paths.getRoot(), accountId, 'home')
    mkdirSync(managedHomePath, { recursive: true })
    // Why: marker lets future cleanup prove the path belongs to Quirky before deleting anything.
    writeFileSync(join(managedHomePath, '.quirky-managed-home'), `${accountId}\n`, 'utf-8')
    return {
      managedHomePath: this.paths.assert(managedHomePath, accountId),
      managedHomeRuntime: 'host',
      wslDistro: null,
      wslLinuxHomePath: null
    }
  }

  // Why: copy the auth.json from an already-authenticated CODEX_HOME (e.g. a temp
  // dir the CLI ran `codex login` into) into the managed home. Mirrors the login
  // step of doAddAccount without spawning an interactive browser flow.
  importAuthFromHome(sourceHome: string, managedHomePath: string, accountId: string): void {
    const trimmed = sourceHome.trim()
    if (!trimmed) {
      throw new Error('A Codex home directory path is required.')
    }
    const resolvedSourceHome = resolve(trimmed)
    let sourceAuthContents: string
    try {
      sourceAuthContents = readFileSync(join(resolvedSourceHome, 'auth.json'), 'utf-8')
    } catch (error) {
      // Why: "no credentials here, run codex login" is only true for a definitive
      // absence. A locked source file used to produce that advice, which sends the
      // user to re-run a login they had already completed.
      if (!isDefinitiveAbsence(error)) {
        throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
      }
      throw new Error(
        `No Codex credentials found in ${resolvedSourceHome}. Run \`codex login\` into this directory first.`
      )
    }
    const trustedHome = this.paths.assert(managedHomePath, accountId)
    writeFileAtomically(join(trustedHome, 'auth.json'), sourceAuthContents, { mode: 0o600 })
  }

  /**
   * Rollback deletes the managed home, so it may only run on a *proven* failure.
   * An unreadable credential file means the login may well have succeeded, and a
   * kept home is a recoverable leak where a deleted one is permanent data loss.
   */
  removeUnlessUnproven(error: unknown, managedHomePath: string, accountId: string): void {
    if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
      return
    }
    this.safeRemove(managedHomePath, accountId)
  }

  safeRemove(candidatePath: string, expectedAccountId: string): void {
    let managedHomePath: string
    try {
      managedHomePath = this.paths.assert(candidatePath, expectedAccountId)
    } catch (error) {
      console.warn('[codex-accounts] Refusing to remove untrusted managed home:', error)
      return
    }

    try {
      removeManagedHomeTreeSync(managedHomePath)
    } catch (error) {
      // Why: this runs from error-cleanup paths; a still-held Windows handle
      // must not mask the original failure with an ENOTEMPTY from rmSync.
      console.warn('[codex-accounts] Failed to remove managed home:', error)
      return
    }

    // Why: homes live at <accounts-root>/<uuid>/home; removing the home/ leaf leaves an empty <uuid>/ behind.
    try {
      const parentDir = resolve(managedHomePath, '..')
      // Why: canonicalize the root too so the prefix check works on macOS where userData resolves through /private/var.
      const root = realpathSync(this.paths.getRoot())
      if (parentDir.startsWith(root + sep) && parentDir !== root) {
        removeManagedHomeTreeSync(parentDir)
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
