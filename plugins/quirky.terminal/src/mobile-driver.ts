import type { CallerConnection, MobileTerminalState, PluginCaller, PluginContext } from '@quirky/protocol'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

type Lease = {
  driver: MobileTerminalState['driver']
  phoneFit: boolean
  cols: number
  rows: number
  desktopCols: number | null
  desktopRows: number | null
  phones: Set<number>
  watchOnly: Set<number>
  restoreGeneration: number
  restoreTimer: ReturnType<typeof setTimeout> | null
}

type MobileConnection = {
  deviceId: string
  name: string
  sessions: Map<string, number>
}

type SerializeSession = <T>(sessionId: string, work: () => Promise<T>) => Promise<T>

/** The PTY's server-side phone driver, remembered desktop viewport and post-disconnect phone-fit hold. */
export class MobileDriverService {
  private readonly leases = new Map<string, Lease>()
  private readonly connections = new Map<number, MobileConnection>()
  private removed = new Set<string>()
  private readonly exited = new Set<string>()

  constructor(private readonly context: PluginContext, private readonly serialize: SerializeSession) {}

  async attach(sessionId: string, cols: number, rows: number, caller: PluginCaller, claim = false): Promise<void> {
    if (this.removed.has(sessionId)) throw this.context.error('not-found', `session ${sessionId} was removed`)
    if (this.exited.has(sessionId)) throw this.context.error('conflict', `session ${sessionId} has exited`)
    if (caller.role !== 'mobile') {
      const lease = this.leases.get(sessionId)
      if (lease) {
        lease.desktopCols = cols
        lease.desktopRows = rows
        if (lease.driver || lease.phoneFit) {
          this.emitChanged()
          return
        }
      }
      await this.context.pty.resize(sessionId, cols, rows)
      if (lease) {
        lease.cols = cols
        lease.rows = rows
        this.emitChanged()
      }
      return
    }

    const connection = this.requireMobileConnection(caller)
    const mobile = this.registerConnection(sessionId, caller, connection)
    let lease = this.leases.get(sessionId)
    if (!lease) {
      const snapshot = await this.context.pty.snapshot(sessionId).catch(() => null)
      if (this.connections.get(connection.id) !== mobile || (mobile.sessions.get(sessionId) ?? 0) === 0) {
        throw this.context.error('conflict', 'mobile connection closed while attaching')
      }
      const desktopCols = snapshot && Number.isInteger(snapshot.cols) && snapshot.cols > 0 ? snapshot.cols : null
      const desktopRows = snapshot && Number.isInteger(snapshot.rows) && snapshot.rows > 0 ? snapshot.rows : null
      lease = {
        driver: null,
        phoneFit: false,
        cols: desktopCols ?? cols,
        rows: desktopRows ?? rows,
        desktopCols,
        desktopRows,
        phones: new Set(),
        watchOnly: new Set(),
        restoreGeneration: 0,
        restoreTimer: null
      }
      this.leases.set(sessionId, lease)
    }

    lease.phones.add(connection.id)
    this.cancelRestore(lease)
    const isOwner = lease.driver?.connectionId === connection.id && lease.driver.deviceId === mobile.deviceId
    const explicitlyClaiming = claim
    if (lease.driver && !isOwner) {
      if (explicitlyClaiming) throw this.context.error('conflict', 'another phone currently controls this terminal')
      lease.watchOnly.add(connection.id)
      this.emitChanged()
      return
    }
    if (!lease.driver && lease.watchOnly.has(connection.id) && !explicitlyClaiming) {
      this.emitChanged()
      return
    }

    await this.context.pty.resize(sessionId, cols, rows)
    lease.driver = { deviceId: mobile.deviceId, connectionId: connection.id, name: mobile.name }
    lease.phoneFit = false
    lease.cols = cols
    lease.rows = rows
    lease.watchOnly.delete(connection.id)
    this.emitChanged()
  }

  async resize(sessionId: string, cols: number, rows: number, params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> {
    if (caller.role === 'mobile') {
      const deviceId = caller.deviceId
      if (!deviceId) throw this.context.error('invalid-params', 'mobile terminal caller has no authenticated device identity')
      if (params.claim === true) {
        const connectionId = this.connectionForDevice(sessionId, deviceId)
        await this.claimPhone(sessionId, cols, rows, deviceId, connectionId)
        return { ok: true }
      }
      this.assertCanInput(sessionId, caller)
      await this.context.pty.resize(sessionId, cols, rows)
      const lease = this.leases.get(sessionId)
      if (lease) {
        lease.cols = cols
        lease.rows = rows
        this.emitChanged()
      }
      return { ok: true }
    }

    const lease = this.leases.get(sessionId)
    if (lease) {
      lease.desktopCols = cols
      lease.desktopRows = rows
      if (lease.driver || lease.phoneFit) {
        this.emitChanged()
        return { ok: true }
      }
    }
    await this.context.pty.resize(sessionId, cols, rows)
    if (lease) {
      lease.cols = cols
      lease.rows = rows
      this.emitChanged()
    }
    return { ok: true }
  }

  assertCanInput(sessionId: string, caller: PluginCaller): void {
    if (caller.role === 'plugin') return
    const driver = this.leases.get(sessionId)?.driver
    if (caller.role === 'mobile') {
      if (!caller.deviceId || driver?.deviceId !== caller.deviceId) {
        throw this.context.error('conflict', 'this phone does not control the terminal')
      }
      return
    }
    if (driver) throw this.context.error('conflict', 'phone is controlling the terminal; take back control before typing')
  }

  async claim(sessionId: string, cols: number, rows: number, caller: PluginCaller): Promise<{ ok: true }> {
    if (caller.role === 'mobile') {
      const connection = this.requireMobileConnection(caller)
      const deviceId = caller.deviceId
      if (!deviceId) throw this.context.error('invalid-params', 'mobile terminal caller has no authenticated device identity')
      await this.claimPhone(sessionId, cols, rows, deviceId, connection.id)
      return { ok: true }
    }

    const lease = this.leases.get(sessionId)
    if (lease?.driver) throw this.context.error('conflict', 'phone is controlling the terminal; take it back before claiming a desktop size')
    await this.context.pty.resize(sessionId, cols, rows)
    if (lease) {
      this.cancelRestore(lease)
      lease.phoneFit = false
      lease.cols = cols
      lease.rows = rows
      lease.desktopCols = cols
      lease.desktopRows = rows
      this.emitChanged()
    }
    return { ok: true }
  }

  mobileState(params: Record<string, unknown>, caller: PluginCaller): { terminals: MobileTerminalState[] } {
    const session = params.session
    const attachedBy = caller.role === 'mobile' ? caller.deviceId : null
    if (caller.role === 'mobile' && !attachedBy) throw this.context.error('invalid-params', 'mobile terminal caller has no authenticated device identity')
    const visibleSessions = attachedBy === null ? null : new Set(
      [...this.connections.values()]
        .filter((mobile) => mobile.deviceId === attachedBy)
        .flatMap((mobile) => [...mobile.sessions.keys()])
    )
    const terminals = this.states().filter((item) =>
      (session === undefined || item.session === session) &&
      (visibleSessions === null || visibleSessions.has(item.session))
    )
    return { terminals }
  }

  async takeBack(params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> {
    this.requireLocal(caller)
    const sessions = await this.sessionsToRestore(params)
    const failures: unknown[] = []
    await Promise.all(sessions.map((session) => this.serialize(session, async () => {
      try {
        await this.takeBackOne(session)
      } catch (error) {
        failures.push(error)
      }
    })))
    if (failures.length > 0) throw failures[0]
    return { ok: true }
  }

  async restoreFit(params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> {
    this.requireLocal(caller)
    const sessions = await this.sessionsToRestore(params)
    const failures: unknown[] = []
    await Promise.all(sessions.map((session) => this.serialize(session, async () => {
      try {
        await this.restoreOne(session, true)
      } catch (error) {
        failures.push(error)
      }
    })))
    if (failures.length > 0) throw failures[0]
    return { ok: true }
  }

  detach(sessionId: string, connectionId: number): void {
    const mobile = this.connections.get(connectionId)
    if (!mobile) return
    const count = mobile.sessions.get(sessionId) ?? 0
    if (count <= 1) mobile.sessions.delete(sessionId)
    else mobile.sessions.set(sessionId, count - 1)

    const lease = this.leases.get(sessionId)
    if (!lease || count > 1) return
    lease.phones.delete(connectionId)
    lease.watchOnly.delete(connectionId)
    if (lease.driver?.connectionId === connectionId) {
      lease.driver = null
      lease.phoneFit = true
    }
    if (lease.phoneFit && lease.phones.size === 0) this.scheduleRestore(sessionId, lease)
    else if (!lease.phoneFit && !lease.driver && lease.phones.size === 0) this.deleteLease(sessionId, lease)
    this.emitChanged()
  }

  sessionRemoved(sessionId: string): void {
    this.removed.add(sessionId)
    this.exited.add(sessionId)
    this.clearSession(sessionId)
  }

  sessionExited(sessionId: string): void {
    this.exited.add(sessionId)
    this.clearSession(sessionId)
  }

  sessionRestored(sessionId: string): void {
    this.exited.delete(sessionId)
  }

  connectionClosed(connectionId: number): void {
    const mobile = this.connections.get(connectionId)
    if (!mobile) return
    this.connections.delete(connectionId)
    for (const sessionId of mobile.sessions.keys()) {
      const lease = this.leases.get(sessionId)
      if (!lease) continue
      lease.phones.delete(connectionId)
      lease.watchOnly.delete(connectionId)
      if (lease.driver?.connectionId === connectionId) {
        lease.driver = null
        lease.phoneFit = true
      }
      if (lease.phoneFit && lease.phones.size === 0) this.scheduleRestore(sessionId, lease)
      else if (!lease.phoneFit && !lease.driver && lease.phones.size === 0) this.deleteLease(sessionId, lease)
    }
    mobile.sessions.clear()
    this.emitChanged()
  }

  shutdown(): void {
    for (const lease of this.leases.values()) this.cancelRestore(lease)
    this.leases.clear()
    this.connections.clear()
  }

  private async claimPhone(sessionId: string, cols: number, rows: number, deviceId: string, connectionId: number): Promise<void> {
    const mobile = this.connections.get(connectionId)
    if (!mobile || mobile.deviceId !== deviceId || (mobile.sessions.get(sessionId) ?? 0) === 0) {
      throw this.context.error('conflict', 'attach to the terminal before claiming it')
    }
    let lease = this.leases.get(sessionId)
    if (!lease) {
      const snapshot = await this.context.pty.snapshot(sessionId).catch(() => null)
      if (this.connections.get(connectionId) !== mobile || (mobile.sessions.get(sessionId) ?? 0) === 0) {
        throw this.context.error('conflict', 'mobile connection closed while claiming')
      }
      lease = {
        driver: null,
        phoneFit: false,
        cols: snapshot?.cols ?? cols,
        rows: snapshot?.rows ?? rows,
        desktopCols: snapshot?.cols ?? null,
        desktopRows: snapshot?.rows ?? null,
        phones: new Set([connectionId]),
        watchOnly: new Set(),
        restoreGeneration: 0,
        restoreTimer: null
      }
      this.leases.set(sessionId, lease)
    }
    if (lease.driver && lease.driver.connectionId !== connectionId) {
      throw this.context.error('conflict', 'another phone currently controls this terminal')
    }
    this.cancelRestore(lease)
    await this.context.pty.resize(sessionId, cols, rows)
    lease.phones.add(connectionId)
    lease.driver = { deviceId, connectionId, name: mobile.name }
    lease.phoneFit = false
    lease.cols = cols
    lease.rows = rows
    lease.watchOnly.delete(connectionId)
    this.emitChanged()
  }

  private async takeBackOne(sessionId: string): Promise<void> {
    const lease = this.leases.get(sessionId)
    if (!lease?.driver) return
    const driver = lease.driver
    lease.driver = null
    lease.watchOnly.add(driver.connectionId)
    this.cancelRestore(lease)
    try {
      await this.restoreDesktopViewport(sessionId, lease)
      lease.phoneFit = false
      if (lease.phones.size === 0) this.deleteLease(sessionId, lease)
    } catch (error) {
      lease.phoneFit = true
      this.emitChanged()
      throw error
    }
    this.emitChanged()
  }

  private async restoreOne(sessionId: string, explicit: boolean): Promise<void> {
    const lease = this.leases.get(sessionId)
    if (!lease) return
    if (lease.driver) {
      if (explicit) throw this.context.error('conflict', 'phone is still driving this terminal; use takeBack first')
      return
    }
    this.cancelRestore(lease)
    try {
      await this.restoreDesktopViewport(sessionId, lease)
    } catch (error) {
      lease.phoneFit = true
      this.emitChanged()
      if (explicit) throw error
      return
    }
    lease.phoneFit = false
    if (lease.phones.size === 0) this.deleteLease(sessionId, lease)
    this.emitChanged()
  }

  private async restoreDesktopViewport(sessionId: string, lease: Lease): Promise<void> {
    if (lease.desktopCols === null || lease.desktopRows === null) {
      throw this.context.error('conflict', 'no desktop viewport has been reported yet; terminal remains sized for your phone')
    }
    await this.context.pty.resize(sessionId, lease.desktopCols, lease.desktopRows)
    lease.cols = lease.desktopCols
    lease.rows = lease.desktopRows
  }

  private async sessionsToRestore(params: Record<string, unknown>): Promise<string[]> {
    if (params.session !== undefined) {
      if (typeof params.session !== 'string' || params.session === '') throw this.context.error('invalid-params', 'session must be a non-empty string')
      const record = await this.context.call('quirky.session/get', { session: params.session })
      if (!record || typeof record !== 'object' || !('kind' in record) || record.kind !== 'terminal') {
        throw this.context.error('invalid-params', `session ${params.session} has no terminal`)
      }
      return [params.session]
    }
    return [...this.leases.keys()]
  }

  private registerConnection(sessionId: string, caller: PluginCaller, connection: CallerConnection): MobileConnection {
    const deviceId = caller.deviceId
    if (!deviceId) throw this.context.error('invalid-params', 'mobile terminal caller has no authenticated device identity')
    let mobile = this.connections.get(connection.id)
    if (mobile && mobile.deviceId !== deviceId) throw this.context.error('conflict', 'connection identity changed')
    if (!mobile) {
      mobile = { deviceId, name: caller.name || 'Phone', sessions: new Map() }
      this.connections.set(connection.id, mobile)
      connection.onClose(() => this.connectionClosed(connection.id))
    }
    if (this.connections.get(connection.id) !== mobile) throw this.context.error('conflict', 'mobile connection is closed')
    mobile.sessions.set(sessionId, (mobile.sessions.get(sessionId) ?? 0) + 1)
    return mobile
  }

  private requireMobileConnection(caller: PluginCaller): CallerConnection {
    if (caller.role !== 'mobile' || !caller.connection) throw this.context.error('invalid-params', 'mobile terminal attach needs an authenticated client connection')
    if (!caller.deviceId) throw this.context.error('invalid-params', 'mobile terminal caller has no authenticated device identity')
    return caller.connection
  }

  private connectionForDevice(sessionId: string, deviceId: string): number {
    const matches = [...this.connections.entries()].filter(([, mobile]) => mobile.deviceId === deviceId && (mobile.sessions.get(sessionId) ?? 0) > 0)
    if (matches.length !== 1) throw this.context.error('conflict', matches.length === 0 ? 'attach to the terminal before claiming it' : 'multiple connections share this device; use quirky.terminal/claim')
    return matches[0]![0]
  }

  private requireLocal(caller: PluginCaller): void {
    if (caller.role === 'mobile') throw this.context.error('invalid-params', 'mobile terminal administration is available only to local clients')
  }

  private async scheduleRestore(sessionId: string, lease: Lease): Promise<void> {
    this.cancelRestore(lease)
    const generation = lease.restoreGeneration
    let delay: number | null
    try {
      const raw = await this.context.call('quirky.mobile/state', {})
      const value = raw && typeof raw === 'object' && 'autoRestoreFitMs' in raw ? raw.autoRestoreFitMs : undefined
      delay = value === null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 5000 && value <= 3_600_000 ? value : null
    } catch {
      delay = null
    }
    if (delay === null || this.leases.get(sessionId) !== lease || lease.restoreGeneration !== generation || !lease.phoneFit || lease.driver || lease.phones.size > 0) return
    lease.restoreTimer = setTimeout(() => {
      lease.restoreTimer = null
      void this.serialize(sessionId, async () => {
        if (this.leases.get(sessionId) !== lease || lease.restoreGeneration !== generation || !lease.phoneFit || lease.driver || lease.phones.size > 0) return
        await this.restoreOne(sessionId, false)
      }).catch((error: unknown) => this.context.log(`could not restore phone-fit terminal ${sessionId}: ${messageOf(error)}`))
    }, delay)
  }

  private cancelRestore(lease: Lease): void {
    lease.restoreGeneration++
    clearTimeout(lease.restoreTimer ?? undefined)
    lease.restoreTimer = null
  }

  private clearSession(sessionId: string): void {
    const lease = this.leases.get(sessionId)
    if (lease) this.deleteLease(sessionId, lease)
    for (const mobile of this.connections.values()) mobile.sessions.delete(sessionId)
    this.emitChanged()
  }

  private deleteLease(sessionId: string, lease: Lease): void {
    this.cancelRestore(lease)
    if (this.leases.get(sessionId) === lease) this.leases.delete(sessionId)
  }

  private states(): MobileTerminalState[] {
    return [...this.leases.entries()]
      .filter(([, lease]) => lease.driver !== null || lease.phoneFit)
      .map(([session, lease]) => ({
        session,
        driver: lease.driver ? { ...lease.driver } : null,
        phoneFit: lease.phoneFit,
        cols: lease.cols,
        rows: lease.rows,
        desktopCols: lease.desktopCols,
        desktopRows: lease.desktopRows
      }))
  }

  private emitChanged(): void {
    this.context.emit('mobileChanged', { terminals: this.states() })
  }
}
