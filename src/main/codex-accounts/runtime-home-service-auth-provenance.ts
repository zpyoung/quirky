import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import {
  codexAuthCouldBelongToManagedAccount,
  codexAuthMatchesManagedAccount,
  codexAuthMatchesSystemDefaultIdentity
} from './codex-auth-identity'
import { writeFileAtomically } from './fs-utils'
import type {
  CodexReadBackMatch,
  CodexSharedRuntimeAuthPendingProvenance,
  CodexSharedRuntimeAuthProvenance,
  CodexSharedRuntimeAuthProvenanceFile,
  CodexSharedRuntimeAuthProvenanceStatus,
  CodexSystemDefaultSnapshot
} from './runtime-home-service-types'
import { CodexRuntimeHomeAuthCore } from './runtime-home-service-auth-core'

export abstract class CodexRuntimeHomeAuthProvenance extends CodexRuntimeHomeAuthCore {
  protected getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  protected findManagedAccountForRuntimeAuth(
    runtimeAuthContents: string,
    expectedAccountId?: string
  ): CodexReadBackMatch {
    const matches: {
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }[] = []
    let unreadableHomeCouldOwnRuntimeAuth = false
    for (const account of this.store.getSettings().codexManagedAccounts) {
      if (expectedAccountId && account.id !== expectedAccountId) {
        continue
      }
      const managedAuthPath = join(account.managedHomePath, 'auth.json')
      if (!existsSync(managedAuthPath)) {
        continue
      }
      let managedAuthContents: string
      try {
        managedAuthContents = readFileSync(managedAuthPath, 'utf-8')
      } catch {
        // Why: an unreadable home can never be compared, but letting the read throw abandons the
        // scan for every other account; only its record can rule it out as the owner.
        if (
          !expectedAccountId &&
          codexAuthCouldBelongToManagedAccount(runtimeAuthContents, account)
        ) {
          unreadableHomeCouldOwnRuntimeAuth = true
        }
        continue
      }
      if (codexAuthMatchesManagedAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
    }

    if (unreadableHomeCouldOwnRuntimeAuth) {
      return { kind: 'ambiguous' }
    }
    if (matches.length === 1) {
      return { kind: 'matched', ...matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
  }

  protected runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean {
    return codexAuthMatchesSystemDefaultIdentity(runtimeAuthContents, systemDefaultAuthContents)
  }

  protected persistSharedRuntimeAuthProvenance(
    provenance: CodexSharedRuntimeAuthProvenanceFile
  ): void {
    writeFileAtomically(
      this.getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { mode: 0o600 }
    )
  }

  protected markSharedRuntimeAuthManaged(accountId: string): void {
    const status = this.resolveSharedRuntimeAuthProvenanceStatus()
    if (
      status.kind === 'committed' &&
      status.provenance.owner === 'managed' &&
      status.provenance.accountId === accountId
    ) {
      return
    }
    const runtimeAuthJson = this.readRuntimeAuthForProvenance()
    const systemDefaultBaseline = this.getUntouchedSystemDefaultBaseline(status, runtimeAuthJson)
    const provenance: CodexSharedRuntimeAuthProvenance = {
      owner: 'managed',
      accountId,
      ...(systemDefaultBaseline ? { systemDefaultBaseline } : {})
    }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: provenance,
      runtimeAuthJson
    })
    if (this.readRuntimeAuthForProvenance() === runtimeAuthJson) {
      this.persistSharedRuntimeAuthProvenance(provenance)
    }
  }

  protected getUntouchedSystemDefaultBaseline(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    runtimeAuthJson: string | null
  ): { authJson: string | null } | null {
    if (status.kind !== 'committed') {
      return null
    }
    const baseline =
      status.provenance.owner === 'system-default'
        ? { authJson: status.provenance.authJson }
        : status.provenance.systemDefaultBaseline
    return baseline && runtimeAuthJson === baseline.authJson ? baseline : null
  }

  protected restoreUntouchedSystemDefaultProvenance(
    provenance: Extract<CodexSharedRuntimeAuthProvenance, { owner: 'managed' }>
  ): Extract<CodexSharedRuntimeAuthProvenance, { owner: 'system-default' }> | null {
    const baseline = provenance.systemDefaultBaseline
    if (!baseline || this.readRuntimeAuthForProvenance() !== baseline.authJson) {
      return null
    }
    const restored = { owner: 'system-default' as const, authJson: baseline.authJson }
    this.persistSharedRuntimeAuthProvenance({
      owner: 'pending',
      next: restored,
      runtimeAuthJson: baseline.authJson
    })
    if (this.readRuntimeAuthForProvenance() !== baseline.authJson) {
      return null
    }
    this.persistSharedRuntimeAuthProvenance(restored)
    return restored
  }

  protected sharedRuntimeAuthProvenanceMatches(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    expected: CodexSharedRuntimeAuthProvenance
  ): boolean {
    if (status.kind !== 'committed' || status.provenance.owner !== expected.owner) {
      return false
    }
    return expected.owner === 'system-default'
      ? status.provenance.owner === 'system-default' &&
          status.provenance.authJson === expected.authJson
      : status.provenance.owner === 'managed' && status.provenance.accountId === expected.accountId
  }

  protected resolveSharedRuntimeAuthProvenanceStatus(): CodexSharedRuntimeAuthProvenanceStatus {
    const provenancePath = this.getSharedRuntimeAuthProvenancePath()
    if (!existsSync(provenancePath)) {
      return { kind: 'missing' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(provenancePath, 'utf-8')) as unknown
    } catch {
      return { kind: 'fenced' }
    }
    const committed = this.parseSharedRuntimeAuthProvenance(parsed)
    if (committed) {
      return { kind: 'committed', provenance: committed }
    }
    const pending = this.parsePendingSharedRuntimeAuthProvenance(parsed)
    if (!pending || this.readRuntimeAuthForProvenance() !== pending.runtimeAuthJson) {
      return { kind: 'fenced' }
    }
    try {
      this.persistSharedRuntimeAuthProvenance(pending.next)
      return { kind: 'committed', provenance: pending.next }
    } catch {
      return { kind: 'fenced' }
    }
  }

  protected parseSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const provenance = value as Record<string, unknown>
    if (
      provenance.owner === 'system-default' &&
      (typeof provenance.authJson === 'string' || provenance.authJson === null)
    ) {
      return { owner: 'system-default', authJson: provenance.authJson }
    }
    if (
      provenance.owner !== 'managed' ||
      typeof provenance.accountId !== 'string' ||
      provenance.accountId.length === 0
    ) {
      return null
    }
    const baseline = this.parseSystemDefaultBaseline(provenance.systemDefaultBaseline)
    if ('systemDefaultBaseline' in provenance && !baseline) {
      return null
    }
    return {
      owner: 'managed',
      accountId: provenance.accountId,
      ...(baseline ? { systemDefaultBaseline: baseline } : {})
    }
  }

  protected parseSystemDefaultBaseline(value: unknown): { authJson: string | null } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const baseline = value as Record<string, unknown>
    return typeof baseline.authJson === 'string' || baseline.authJson === null
      ? { authJson: baseline.authJson }
      : null
  }

  protected parsePendingSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthPendingProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const pending = value as Record<string, unknown>
    const next = this.parseSharedRuntimeAuthProvenance(pending.next)
    return pending.owner === 'pending' &&
      next &&
      (typeof pending.runtimeAuthJson === 'string' || pending.runtimeAuthJson === null)
      ? { owner: 'pending', next, runtimeAuthJson: pending.runtimeAuthJson }
      : null
  }

  protected readRuntimeAuthForProvenance(): string | null {
    try {
      return readFileSync(this.getRuntimeAuthPath(), 'utf-8')
    } catch {
      return null
    }
  }

  protected readSystemDefaultSnapshot(snapshotPath: string): CodexSystemDefaultSnapshot | null {
    let rawContents: string
    try {
      rawContents = readFileSync(snapshotPath, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(rawContents) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'authJson' in parsed &&
        (typeof (parsed as { authJson: unknown }).authJson === 'string' ||
          (parsed as { authJson: unknown }).authJson === null)
      ) {
        return parsed as CodexSystemDefaultSnapshot
      }
      // Why: pre-PR snapshots stored raw auth.json; treat objects lacking an authJson wrapper as legacy so upgraders don't lose their auth.
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('authJson' in parsed)
      ) {
        return { authJson: rawContents }
      }
    } catch {
      return null
    }
    return null
  }

  clearSystemDefaultSnapshot(): void {
    rmSync(this.getSystemDefaultSnapshotPath(), { force: true })
  }
}
