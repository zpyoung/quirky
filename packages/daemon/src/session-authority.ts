import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PluginSessionAuthority, PluginSessionIdentity, PtySessionInfo } from '@quirky/protocol'
import type { PtyClient } from './pty-client'
import type { RuntimeAuthorityRow, Store } from './store'
import type { ClientConn } from './types'

type StructuredLease = {
  ownerPluginId: string
  tokenHash: string
  identity: PluginSessionIdentity
}
type TerminalIdentity = Omit<PluginSessionIdentity, 'live'> & { live: boolean }

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

function hashesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(actual, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function sameRecord(a: RuntimeAuthorityRow | null, b: RuntimeAuthorityRow): boolean {
  return (
    a !== null &&
    a.sessionId === b.sessionId &&
    a.tokenHash === b.tokenHash &&
    a.runtimeEpoch === b.runtimeEpoch &&
    a.processIncarnation === b.processIncarnation &&
    a.ptyHostPid === b.ptyHostPid &&
    a.ptyPid === b.ptyPid &&
    a.ptyCreatedAt === b.ptyCreatedAt
  )
}

function isLiveMatch(row: RuntimeAuthorityRow, hostPid: number, info: PtySessionInfo | undefined): boolean {
  return (
    row.ptyHostPid === hostPid &&
    row.ptyPid !== null &&
    row.ptyCreatedAt !== null &&
    info?.state === 'running' &&
    info.alive &&
    info.pid === row.ptyPid &&
    info.createdAt === row.ptyCreatedAt
  )
}

function isExitedMatch(row: RuntimeAuthorityRow, hostPid: number, info: PtySessionInfo | undefined): boolean {
  return (
    row.ptyHostPid === hostPid &&
    row.ptyPid !== null &&
    row.ptyCreatedAt !== null &&
    info?.state === 'exited' &&
    !info.alive &&
    info.pid === row.ptyPid &&
    info.createdAt === row.ptyCreatedAt
  )
}

/** Kernel-owned launch credentials, with PTY identity as independent terminal process evidence. */
export class RuntimeSessionAuthority {
  readonly runtimeEpoch = randomUUID()
  private readonly terminals = new Map<string, TerminalIdentity>()
  private readonly structured = new Map<string, StructuredLease>()

  constructor(
    private readonly store: Store,
    private readonly pty: PtyClient
  ) {
    pty.onExit((sessionId) => {
      const row = this.store.getRuntimeAuthority(sessionId)
      void this.refreshTerminal(sessionId).catch(() => {
        if (row) this.deleteLiveIdentityForRow(row)
      })
    })
    pty.onReconnect(() => {
      for (const [sessionId, identity] of this.terminals) {
        if (identity.live) this.terminals.delete(sessionId)
      }
      void this.restoreLiveTerminalIdentities().catch(() => undefined)
    })
  }

  issueTerminalToken(sessionId: string): string {
    if (this.terminals.get(sessionId)?.live === false) this.terminals.delete(sessionId)
    if (this.terminals.has(sessionId) || this.structured.has(sessionId) || this.hasUnreconciledTerminal(sessionId)) {
      throw new Error(`session ${sessionId} already has live runtime authority`)
    }
    const token = randomBytes(32).toString('hex')
    this.store.putRuntimeAuthority({
      sessionId,
      tokenHash: tokenHash(token),
      runtimeEpoch: this.runtimeEpoch,
      processIncarnation: randomUUID(),
      ptyHostPid: null,
      ptyPid: null,
      ptyCreatedAt: null
    })
    return token
  }

  openStructuredLease(ownerPluginId: string, sessionId: string): {
    token: string
    identity: PluginSessionIdentity
    release(): void
  } {
    if (this.terminals.get(sessionId)?.live === false) this.terminals.delete(sessionId)
    if (this.terminals.has(sessionId) || this.structured.has(sessionId) || this.hasUnreconciledTerminal(sessionId)) {
      throw new Error(`session ${sessionId} already has live runtime authority`)
    }
    this.store.deleteRuntimeAuthority(sessionId)
    const token = randomBytes(32).toString('hex')
    const lease: StructuredLease = {
      ownerPluginId,
      tokenHash: tokenHash(token),
      identity: {
        sessionId,
        runtimeEpoch: this.runtimeEpoch,
        processIncarnation: randomUUID(),
        source: 'structured_lease',
        live: true
      }
    }
    this.structured.set(sessionId, lease)
    return {
      token,
      identity: { ...lease.identity },
      release: () => {
        if (this.structured.get(sessionId) === lease) this.structured.delete(sessionId)
      }
    }
  }

  releasePlugin(pluginId: string): void {
    for (const [sessionId, lease] of this.structured) {
      if (lease.ownerPluginId === pluginId) this.structured.delete(sessionId)
    }
  }

  sessionIdentity(sessionId: string): PluginSessionIdentity | null {
    const structured = this.structured.get(sessionId)
    if (structured && structured.identity.live && structured.identity.sessionId === sessionId
      && structured.identity.runtimeEpoch === this.runtimeEpoch && structured.identity.source === 'structured_lease') {
      return { ...structured.identity }
    }
    const terminal = this.terminals.get(sessionId)
    if (terminal?.live === false) return { ...terminal } as PluginSessionIdentity
    if (!this.pty.connected) return null
    return terminal ? { ...terminal } as PluginSessionIdentity : null
  }

  async resolveForConnection(conn: ClientConn): Promise<PluginSessionAuthority | null> {
    const { sessionId, sessionToken } = conn
    if (!sessionId || !sessionToken) return null
    const suppliedHash = tokenHash(sessionToken)
    const lease = this.structured.get(sessionId)
    if (lease) return hashesMatch(lease.tokenHash, suppliedHash) ? { ...lease.identity } : null

    const row = this.store.getRuntimeAuthority(sessionId)
    if (!row || !hashesMatch(row.tokenHash, suppliedHash)) return null
    return this.verifyTerminal(row, suppliedHash)
  }

  async bindTerminalProcess(sessionId: string, env: Record<string, string>, pid: number): Promise<void> {
    const token = env.QUIRKY_SESSION_TOKEN
    if (typeof token !== 'string') return
    const row = this.store.getRuntimeAuthority(sessionId)
    if (!row || row.runtimeEpoch !== this.runtimeEpoch || !hashesMatch(row.tokenHash, tokenHash(token))) return
    const hostPid = this.pty.hostPid
    if (!this.pty.connected || hostPid === null) return
    let sessions: PtySessionInfo[]
    try {
      sessions = await this.pty.request('list', {})
    } catch {
      return
    }
    if (!this.pty.connected || this.pty.hostPid !== hostPid) return
    const current = this.store.getRuntimeAuthority(sessionId)
    if (!sameRecord(current, row)) return
    const info = sessions.find((session) => session.sessionId === sessionId)
    if (info?.state !== 'running' || !info.alive || info.pid !== pid) {
      this.deleteIfCurrent(row)
      return
    }
    const bound: RuntimeAuthorityRow = {
      ...row,
      ptyHostPid: hostPid,
      ptyPid: info.pid,
      ptyCreatedAt: info.createdAt
    }
    this.store.putRuntimeAuthority(bound)
    const verified = this.store.getRuntimeAuthority(sessionId)
    if (sameRecord(verified, bound)) this.terminals.set(sessionId, this.identityFor(bound))
  }

  revokeTerminal(sessionId: string): void {
    this.terminals.delete(sessionId)
    this.store.deleteRuntimeAuthority(sessionId)
  }

  async restoreLiveTerminalIdentities(): Promise<void> {
    for (const [sessionId, identity] of this.terminals) {
      if (identity.live) this.terminals.delete(sessionId)
    }
    const hostPid = this.pty.hostPid
    if (!this.pty.connected || hostPid === null) return
    let sessions: PtySessionInfo[]
    try {
      sessions = await this.pty.request('list', {})
    } catch {
      return
    }
    if (!this.pty.connected || this.pty.hostPid !== hostPid) return
    for (const row of this.store.listRuntimeAuthorities()) {
      if (row.ptyHostPid === null || row.ptyPid === null || row.ptyCreatedAt === null) continue
      if (!sameRecord(this.store.getRuntimeAuthority(row.sessionId), row)) continue
      this.applyPtyEvidence(row, hostPid, sessions.find((session) => session.sessionId === row.sessionId))
    }
  }

  private async verifyTerminal(row: RuntimeAuthorityRow, expectedTokenHash: string): Promise<PluginSessionIdentity | null> {
    const hostPid = this.pty.hostPid
    if (!this.pty.connected || hostPid === null) {
      this.deleteLiveIdentityForRow(row)
      return null
    }
    let sessions: PtySessionInfo[]
    try {
      sessions = await this.pty.request('list', {})
    } catch {
      this.deleteLiveIdentityForRow(row)
      return null
    }
    if (!this.pty.connected || this.pty.hostPid !== hostPid) {
      this.deleteLiveIdentityForRow(row)
      return null
    }
    const current = this.store.getRuntimeAuthority(row.sessionId)
    if (current === null || !sameRecord(current, row) || !hashesMatch(current.tokenHash, expectedTokenHash)) {
      this.deleteLiveIdentityForRow(row)
      return null
    }
    if (row.ptyHostPid === null || row.ptyPid === null || row.ptyCreatedAt === null) return null
    return this.applyPtyEvidence(row, hostPid, sessions.find((session) => session.sessionId === row.sessionId))
  }

  private applyPtyEvidence(
    row: RuntimeAuthorityRow,
    hostPid: number,
    info: PtySessionInfo | undefined
  ): PluginSessionIdentity | null {
    if (!isLiveMatch(row, hostPid, info)) {
      if (isExitedMatch(row, hostPid, info)) {
        this.terminals.set(row.sessionId, this.exitedIdentityFor(row))
      } else {
        this.terminals.delete(row.sessionId)
      }
      this.deleteIfCurrent(row)
      return null
    }
    const identity = this.identityFor(row)
    this.terminals.set(row.sessionId, identity)
    return { ...identity }
  }

  private async refreshTerminal(sessionId: string): Promise<void> {
    const row = this.store.getRuntimeAuthority(sessionId)
    if (!row || row.ptyHostPid === null || row.ptyPid === null || row.ptyCreatedAt === null) return
    await this.verifyTerminal(row, row.tokenHash)
  }

  private identityFor(row: RuntimeAuthorityRow): PluginSessionIdentity {
    return {
      sessionId: row.sessionId,
      runtimeEpoch: this.runtimeEpoch,
      processIncarnation: row.processIncarnation,
      source: row.runtimeEpoch === this.runtimeEpoch ? 'terminal_launch' : 'restored_authority',
      live: true
    }
  }
  private exitedIdentityFor(row: RuntimeAuthorityRow): TerminalIdentity {
    return {
      sessionId: row.sessionId,
      runtimeEpoch: row.runtimeEpoch,
      processIncarnation: row.processIncarnation,
      source: row.runtimeEpoch === this.runtimeEpoch ? 'terminal_launch' : 'restored_authority',
      live: false
    }
  }

  private hasUnreconciledTerminal(sessionId: string): boolean {
    const row = this.store.getRuntimeAuthority(sessionId)
    return row !== null && row.ptyHostPid !== null && row.ptyPid !== null && row.ptyCreatedAt !== null
  }

  private deleteLiveIdentityForRow(row: RuntimeAuthorityRow): void {
    const identity = this.terminals.get(row.sessionId)
    if (identity?.live && identity.processIncarnation === row.processIncarnation) {
      this.terminals.delete(row.sessionId)
    }
  }

  private deleteIfCurrent(row: RuntimeAuthorityRow): void {
    if (sameRecord(this.store.getRuntimeAuthority(row.sessionId), row)) {
      this.store.deleteRuntimeAuthority(row.sessionId)
    }
  }
}
