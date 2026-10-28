import type { MobileBundleManifestResult, MobileBundleReadResult } from '@quirky/protocol'
import type { MobileDevice, MobileHostInfo, MobileNetworkInterface, MobilePairingResult, MobileState } from '@quirky/protocol'
import type { OwnerCliPairOffer } from '@quirky/protocol'
import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { hostname } from 'node:os'
import { assertMobileCallAllowed } from './authorization'
import { configureInput, openInput, ownerPairInput, ownerRevokeInput, pairInput, revokeInput, updatePreferencesInput, type MobileConfigureInput, type MobileOpenInput, type MobilePairInput, type OwnerPairInput, type OwnerRevokeInput } from './api'
import { getMobileBundleChunk, getMobileBundleManifest, getMobileBundleRange, MobileBundleError } from './bundle'
import { bestNetworkAddress, endpointHost, isLoopbackHost, normalizeAdvertisedEndpoint, rankNetworkInterfaces } from './network'
import { createPairingResult } from './pairing'
import { MobileStore, MobileStoreError, type AuthenticationResult, type MobileDeviceRecord, type MobileSettings } from './storage'
import { OwnerGrantStore, type OwnerGrantRecord, type OwnerGrantSummary } from './owner-store'
import { MAX_MOBILE_INBOUND_FRAME_BYTES, MobileTransport, type MobilePeer } from './transport'
import { DesktopMobileE2EEV2Session, MAX_MOBILE_BINARY_BYTES, MAX_MOBILE_TEXT_BYTES } from '../crypto/e2ee-v2'

const AUTH_TIMEOUT_MS = 10_000
const MAX_REQUESTS_PER_CREDENTIAL = 16
const AUTH_FAILURE_WINDOW_MS = 60_000
const MOBILE_UNAVAILABLE_GUIDANCE = 'Mobile pairing is unavailable. Check the listener, network, and device registry, then try again.'
const INVALID_ENDPOINT_GUIDANCE = 'No usable advertised address is available. Connect to Wi-Fi or Tailscale, then refresh the network interfaces or add a custom address.'
const EXPOSURE_FAILED_GUIDANCE = 'The mobile listener could not be widened safely. It was restored to loopback; choose another reachable address or check the listener port.'
const CALLER_IDENTITY_FIELDS = [
  'role', 'scope', 'caller', 'credential', 'credentials', 'token', 'connection', 'client', 'clientId', 'deviceToken', 'ownerGrantId', 'desktopClientId'
] as const
const ENVELOPE_IDENTITY_FIELDS = [
  'deviceId', 'role', 'scope', 'caller', 'credential', 'credentials', 'token', 'connection',
  'client', 'clientId', 'ownerGrantId', 'grantId', 'desktopClientId'
] as const


export type AdmittedMobileClient = {
  readonly id: number
  receive(text: string): Promise<void>
  disconnect(): void
}

type ConnectionState = {
  peer: MobilePeer
  channel: DesktopMobileE2EEV2Session | null
  authenticated: boolean
  authTimer: ReturnType<typeof setTimeout> | undefined
  badFrames: number
  credentialScope: 'mobile' | 'owner-cli' | null
  credentialId: string | null
  token: string | null
  admitted: AdmittedMobileClient | null
  cleaned: boolean
}
type InFlightWaiter = {
  excludeConnectionId: number | undefined
  resolve(): void
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function bytesFrom(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(String(data))
}

type PairingUnavailableReason = Extract<MobilePairingResult, { available: false }>['reason']

function unavailable(reason: PairingUnavailableReason): MobilePairingResult {
  return { available: false, reason, guidance: reason === 'invalid_advertised_endpoint' ? INVALID_ENDPOINT_GUIDANCE : reason === 'network_exposure_failed' ? EXPOSURE_FAILED_GUIDANCE : MOBILE_UNAVAILABLE_GUIDANCE }
}


class SerialGate {
  private pending: Promise<void> = Promise.resolve()

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const current = this.pending.then(operation)
    this.pending = current.then(() => undefined, () => undefined)
    return current
  }
}

/** Owns the mobile listener, identity checks, RPC admission, and every resource it creates. */
export class MobileService {
  private readonly store: MobileStore
  private readonly ownerStore: OwnerGrantStore
  private readonly transport: MobileTransport | null
  private readonly connections = new Set<ConnectionState>()
  private readonly deviceConnections = new Map<string, Set<ConnectionState>>()
  private readonly ownerConnections = new Map<string, Set<ConnectionState>>()
  private readonly inFlightByCredential = new Map<string, number>()
  private readonly inFlightByConnection = new Map<number, number>()
  private readonly inFlightWaiters = new Map<string, Set<InFlightWaiter>>()
  private readonly gate = new SerialGate()
  private authFailures: number[] = []
  private authToastSent = false
  private stopped = false

  constructor(private readonly context: PluginContext, options: { portValue?: string; hostValue?: string } = {}) {
    this.store = new MobileStore(context.dataDir)
    this.ownerStore = new OwnerGrantStore(context.dataDir)
    const hasPairedHistory = (this.store.registryAvailable && this.store.devices().length > 0) || this.ownerStore.hasGrants
    try {
      this.transport = new MobileTransport({
        dataDir: context.dataDir,
        hasPairedHistory,
        portValue: options.portValue,
        hostValue: options.hostValue,
        onConnection: (peer) => this.onConnection(peer)
      })
    } catch (error) {
      context.log(`mobile listener configuration unavailable: ${error instanceof Error ? error.message : 'invalid settings'}`)
      this.transport = null
    }
  }

  async start(): Promise<void> {
    if (this.transport) await this.transport.start()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.gate.run(() => {})
    for (const state of [...this.connections]) this.cleanupConnection(state, 1001, 'Mobile plugin deactivated', true)
    await this.transport?.stop()
    this.store.dispose()
  }

  info(): MobileHostInfo {
    return { machineName: this.store.settings().machineName, platform: process.platform, deviceScope: 'mobile' }
  }

  async state(): Promise<MobileState> {
    const settings = this.store.settings()
    const interfaces = rankNetworkInterfaces()
    const listener = this.transport
    return {
      machineName: settings.machineName || hostname(),
      showMobileButton: settings.showMobileButton,
      onboardingSeen: settings.onboardingSeen,
      autoRestoreFitMs: settings.autoRestoreFitMs,
      customAddresses: [...settings.customAddresses],
      interfaces,
      devices: this.store.devices(),
      listener: { available: listener?.available ?? false, host: listener?.host ?? null, port: listener?.port ?? null },
      relay: 'unavailable'
    }
  }

  interfaces(): MobileNetworkInterface[] {
    return rankNetworkInterfaces()
  }

  async pair(params: unknown): Promise<MobilePairingResult> {
    let input: MobilePairInput
    try { input = pairInput(params) } catch (error) { throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid mobile pairing parameters') }
    return this.gate.run(async () => {
      const transport = this.transport
      if (this.stopped || !transport?.available) return unavailable('websocket_unavailable')
      if (!this.store.registryAvailable) return unavailable('device_registry_unavailable')
      const publicKeyB64 = this.store.publicKeyB64
      if (!this.store.identityAvailable || !publicKeyB64) return unavailable('e2ee_key_unavailable')
      const interfaces = rankNetworkInterfaces()
      const customAddresses = this.store.settingsAvailable ? this.store.settings().customAddresses : []
      const address = input.address ?? bestNetworkAddress(interfaces) ?? customAddresses[0] ?? null
      const endpoint = normalizeAdvertisedEndpoint(address, transport.port!)
      if (!endpoint) return unavailable('invalid_advertised_endpoint')
      const host = endpointHost(endpoint)
      if (!host) return unavailable('invalid_advertised_endpoint')
      if (!isLoopbackHost(host) && !await transport.ensureNetworkExposure()) return unavailable('network_exposure_failed')
      const boundPort = transport.port
      if (boundPort === null) return unavailable('websocket_unavailable')
      const actualEndpoint = normalizeAdvertisedEndpoint(address, boundPort)
      if (!actualEndpoint) return unavailable('invalid_advertised_endpoint')
      let device: MobileDeviceRecord
      try {
        device = this.store.getOrCreatePending(input.rotate === true)
      } catch (error) {
        if (error instanceof MobileStoreError) return unavailable(error.code === 'e2ee_key_unavailable' ? 'e2ee_key_unavailable' : 'device_registry_unavailable')
        return unavailable('device_registry_unavailable')
      }
      const result = await createPairingResult({ device, endpoint: actualEndpoint, publicKeyB64 })
      if (this.stopped || !transport.available) return unavailable('websocket_unavailable')
      this.emitChanged()
      return result
    })
  }

  async ownerPair(params: unknown): Promise<{ available: true; endpoint: string; offer: string; grant: OwnerGrantSummary }> {
    let input: OwnerPairInput
    try { input = ownerPairInput(params) } catch (error) {
      throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid owner grant parameters')
    }
    return this.gate.run(async () => {
      const transport = this.transport
      if (this.stopped || !transport?.available) throw this.context.error('conflict', 'Owner grant listener is unavailable')
      if (!this.ownerStore.registryAvailable) throw this.context.error('conflict', 'Owner grant registry is unavailable')
      const publicKeyB64 = this.store.publicKeyB64
      if (!this.store.identityAvailable || !publicKeyB64) throw this.context.error('conflict', 'E2EE identity is unavailable')
      const interfaces = rankNetworkInterfaces()
      const customAddresses = this.store.settingsAvailable ? this.store.settings().customAddresses : []
      const address = input.address ?? bestNetworkAddress(interfaces) ?? customAddresses[0] ?? null
      const endpoint = normalizeAdvertisedEndpoint(address, transport.port!)
      if (!endpoint) throw this.context.error('conflict', 'No usable advertised address is available')
      const host = endpointHost(endpoint)
      if (!host) throw this.context.error('conflict', 'No usable advertised address is available')
      if (!isLoopbackHost(host) && !await transport.ensureNetworkExposure()) {
        throw this.context.error('conflict', EXPOSURE_FAILED_GUIDANCE)
      }
      const boundPort = transport.port
      if (boundPort === null) throw this.context.error('conflict', 'Owner grant listener is unavailable')
      const actualEndpoint = normalizeAdvertisedEndpoint(address, boundPort)
      if (!actualEndpoint) throw this.context.error('conflict', 'No usable advertised address is available')
      let grant: OwnerGrantRecord
      try { grant = this.ownerStore.create(input.name, actualEndpoint) } catch (error) {
        throw this.context.error('conflict', error instanceof Error ? error.message : 'Owner grant registry is unavailable')
      }
      const offer: OwnerCliPairOffer = {
        v: 2,
        endpoint: actualEndpoint,
        deviceToken: grant.token,
        publicKeyB64,
        pairedDeviceId: grant.grantId,
        scope: 'owner-cli'
      }
      const safeGrant: OwnerGrantSummary = {
        grantId: grant.grantId,
        name: grant.name,
        endpoint: grant.endpoint,
        scope: 'owner-cli',
        createdAt: grant.createdAt
      }
      this.emitChanged()
      return {
        available: true,
        endpoint: actualEndpoint,
        offer: Buffer.from(JSON.stringify(offer)).toString('base64url'),
        grant: safeGrant
      }
    })
  }

  ownerGrants(): OwnerGrantSummary[] {
    try { return this.ownerStore.grants() } catch {
      throw this.context.error('conflict', 'Owner grant registry is unavailable')
    }
  }

  async ownerRevoke(params: unknown, exceptConnectionId?: number): Promise<{ revoked: boolean }> {
    let input: OwnerRevokeInput
    try { input = ownerRevokeInput(params) } catch (error) {
      throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid owner grant ID')
    }
    return this.gate.run(async () => {
      let revoked: boolean
      try { revoked = this.ownerStore.revoke(input.grantId) } catch {
        for (const connections of this.ownerConnections.values()) {
          for (const connection of [...connections]) this.cleanupConnection(connection, 4001, 'Unauthorized', false)
        }
        throw this.context.error('conflict', 'Owner grant registry is unavailable')
      }
      if (!revoked) return { revoked: false }
      for (const connection of [...(this.ownerConnections.get(input.grantId) ?? [])]) {
        this.cleanupConnection(connection, 4001, 'Unauthorized', false)
      }
      await this.waitForCredentialIdle(this.credentialKey('owner-cli', input.grantId), exceptConnectionId)
      this.emitChanged()
      return { revoked: true }
    })
  }

  async devices(): Promise<MobileDevice[]> {
    try { return this.store.devices() } catch (error) { throw this.context.error('conflict', error instanceof Error ? error.message : 'Mobile device registry unavailable') }
  }

  async revoke(params: unknown): Promise<{ revoked: boolean }> {
    let input: { deviceId: string }
    try { input = revokeInput(params) } catch (error) { throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid device ID') }
    return this.gate.run(() => {
      let revoked: boolean
      try { revoked = this.store.revoke(input.deviceId) } catch (error) { throw this.context.error('conflict', error instanceof Error ? error.message : 'Mobile device registry unavailable') }
      if (!revoked) return { revoked: false }
      for (const connection of [...(this.deviceConnections.get(input.deviceId) ?? [])]) this.cleanupConnection(connection, 4001, 'Unauthorized', false)
      this.emitChanged()
      return { revoked: true }
    })
  }

  async configure(params: unknown): Promise<MobileState> {
    let input: MobileConfigureInput
    try { input = configureInput(params) } catch (error) { throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid mobile settings') }
    return this.gate.run(async () => {
      try { this.store.configure(input) } catch (error) { throw this.context.error('conflict', error instanceof Error ? error.message : 'Mobile settings could not be persisted') }
      this.emitChanged()
      return this.state()
    })
  }

  preferences(): { autoRestoreFitMs: number | null } {
    try { return { autoRestoreFitMs: this.store.settings().autoRestoreFitMs } } catch (error) {
      throw this.context.error('conflict', error instanceof Error ? error.message : 'Mobile settings unavailable')
    }
  }

  async updatePreferences(params: unknown): Promise<{ autoRestoreFitMs: number | null }> {
    let input: Pick<MobileSettings, 'autoRestoreFitMs'>
    try { input = updatePreferencesInput(params) } catch (error) {
      throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid phone preferences')
    }
    return this.gate.run(() => {
      try { this.store.configure(input) } catch (error) {
        throw this.context.error('conflict', error instanceof Error ? error.message : 'Phone preferences could not be persisted')
      }
      this.emitChanged()
      return this.preferences()
    })
  }

  bundleManifest(): MobileBundleManifestResult {
    return this.withBundleApi(() => getMobileBundleManifest(this.context.dir))
  }

  bundleChunk(params: unknown): MobileBundleReadResult {
    return this.withBundleApi(() => getMobileBundleChunk(this.context.dir, params))
  }

  bundleRange(params: unknown): MobileBundleReadResult {
    return this.withBundleApi(() => getMobileBundleRange(this.context.dir, params))
  }

  private withBundleApi<T>(operation: () => T): T {
    try { return operation() } catch (error) {
      if (error instanceof MobileBundleError) throw this.context.error(error.kind, error.message)
      throw this.context.error('conflict', 'Mobile page bundle could not be read')
    }
  }

  async open(params: unknown): Promise<unknown> {
    let input: MobileOpenInput
    try { input = openInput(params) } catch (error) { throw this.context.error('invalid-params', error instanceof Error ? error.message : 'Invalid open parameters') }
    return this.context.call('ui.view.open', { id: input.settings ? 'view:quirky.mobile/settings' : 'view:quirky.mobile/page' })
  }

  private onConnection(peer: MobilePeer): void {
    const state: ConnectionState = {
      peer, channel: null, authenticated: false, authTimer: undefined, badFrames: 0,
      credentialScope: null, credentialId: null, token: null, admitted: null, cleaned: false
    }
    this.connections.add(state)
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) this.cleanupConnection(state, 4002, 'E2EE handshake timeout', false)
    }, AUTH_TIMEOUT_MS)
    state.authTimer.unref?.()
    peer.socket.on('message', (raw, binary) => {
      void this.onMessage(state, bytesFrom(raw), binary)
    })
    peer.socket.on('close', () => this.cleanupConnection(state, 1001, 'Connection closed', false))
    peer.socket.on('error', () => this.cleanupConnection(state, 1001, 'Connection failed', false))
  }

  private async onMessage(state: ConnectionState, bytes: Buffer, binary: boolean): Promise<void> {
    if (state.cleaned || this.stopped) return
    if (bytes.byteLength > MAX_MOBILE_INBOUND_FRAME_BYTES) {
      this.cleanupConnection(state, 1009, 'Inbound frame too large', false)
      return
    }
    if (!state.channel) {
      const secretKey = this.store.secretKey
      if (binary || !this.store.identityAvailable || !secretKey) {
        this.cleanupConnection(state, 4001, 'Unauthorized', false)
        return
      }
      let hello: unknown
      try { hello = JSON.parse(bytes.toString('utf8')) as unknown } catch {
        this.cleanupConnection(state, 4001, 'Unauthorized', false)
        return
      }
      const session = DesktopMobileE2EEV2Session.create({ hello, serverSecretKey: secretKey, expectedContext: { transport: 'direct' } })
      if (!session) {
        this.cleanupConnection(state, 4001, 'Unauthorized', false)
        return
      }
      state.channel = session
      if (!state.peer.sendText(JSON.stringify(session.ready))) this.cleanupConnection(state, 1013, 'Outbound reply buffer overflow', false)
      return
    }
    if (binary) {
      const opened = state.channel.openBinary(bytes)
      if (!opened) {
        this.failedDecryption(state)
        return
      }
      state.badFrames = 0
      // The public admission API currently accepts JSON-RPC text only; do not reinterpret stream bytes as RPC.
      this.cleanupConnection(state, 1003, 'Binary input is not supported', false)
      return
    }
    const text = state.channel.openText(bytes.toString('utf8'))
    if (text === null) {
      this.failedDecryption(state)
      return
    }
    state.badFrames = 0
    if (!state.authenticated) {
      await this.authenticate(state, text)
      return
    }
    await this.receiveRpc(state, text)
  }

  private async authenticate(state: ConnectionState, plaintext: string): Promise<void> {
    const message = parseJson(plaintext)
    const params = isRecord(message) ? message : null
    if (!params || !exactKeys(params, ['type', 'v', 'transcriptHashB64', 'deviceToken']) || params.type !== 'e2ee_auth' || params.v !== 2 || typeof params.transcriptHashB64 !== 'string' || typeof params.deviceToken !== 'string') {
      this.failAuthentication(state, 'bad_proof')
      return
    }
    if (params.transcriptHashB64 !== state.channel?.transcriptHashB64) {
      this.failAuthentication(state, 'bad_proof')
      return
    }
    const token = params.deviceToken
    if (!/^[0-9a-f]{48}$/.test(token)) {
      this.recordAuthFailure()
      this.failAuthentication(state, 'unauthorized')
      return
    }
    await this.gate.run(() => {
      if (!state.channel || state.cleaned || this.stopped || state.authenticated || state.admitted) return
      const ownerAuthentication = this.ownerStore.authenticate(token)
      let scope: 'mobile' | 'owner-cli'
      let credentialId: string
      let name: string
      if (ownerAuthentication.status === 'paired') {
        scope = 'owner-cli'
        credentialId = ownerAuthentication.grant.grantId
        name = ownerAuthentication.grant.name
      } else {
        let mobileAuthentication: AuthenticationResult
        try { mobileAuthentication = this.store.authenticate(token) } catch {
          mobileAuthentication = { status: 'registry_unavailable' }
        }
        if (mobileAuthentication.status !== 'paired') {
          const code = ownerAuthentication.status === 'registry_unavailable' || mobileAuthentication.status === 'registry_unavailable'
            ? 'registry_unavailable'
            : 'unauthorized'
          if (code === 'unauthorized') this.recordAuthFailure()
          this.failAuthentication(state, code)
          return
        }
        scope = 'mobile'
        credentialId = mobileAuthentication.device.deviceId
        name = mobileAuthentication.device.name
      }
      state.credentialScope = scope
      state.credentialId = credentialId
      state.token = token
      const clientIdentity = scope === 'mobile'
        ? { role: 'mobile' as const, deviceId: credentialId, name }
        : { role: 'cli' as const, ownerGrantId: credentialId, name }
      try {
        state.admitted = this.context.clients.accept({
          ...clientIdentity,
          authorize: (method, callParams) => this.authorizeConnection(scope, credentialId, token, method, callParams),
          sendText: (text) => this.sendKernelText(state, text),
          sendBinary: (bytes) => this.sendKernelBinary(state, bytes),
          close: () => this.cleanupConnection(state, 4001, 'Unauthorized', false, false)
        })
      } catch {
        this.failAuthentication(state, 'unauthorized')
        return
      }
      state.authenticated = true
      clearTimeout(state.authTimer)
      state.authTimer = undefined
      const activeMap = scope === 'mobile' ? this.deviceConnections : this.ownerConnections
      const activeConnections = activeMap.get(credentialId) ?? new Set<ConnectionState>()
      activeConnections.add(state)
      activeMap.set(credentialId, activeConnections)
      if (!state.channel?.transcriptHashB64 || !this.sendEncryptedText(state, JSON.stringify({ type: 'e2ee_authenticated', v: 2, transcriptHashB64: state.channel.transcriptHashB64 }))) {
        this.cleanupConnection(state, 1013, 'Outbound reply buffer overflow', false)
        return
      }
      this.emitChanged()
    })
  }

  private failAuthentication(state: ConnectionState, code: string): void {
    if (code === 'bad_proof') this.recordAuthFailure()
    if (state.cleaned) return
    if (state.channel) this.sendEncryptedText(state, JSON.stringify({ type: 'e2ee_error', error: { code } }))
    state.peer.close(4001, code === 'registry_unavailable' ? 'Device registry unavailable' : 'Unauthorized')
    this.cleanupConnection(state, 4001, 'Unauthorized', false)
  }

  private failedDecryption(state: ConnectionState): void {
    if (!state.authenticated) {
      this.failAuthentication(state, 'bad_proof')
      return
    }
    state.badFrames++
    if (state.badFrames >= 5) this.cleanupConnection(state, 4003, 'Too many decrypt failures', false)
  }

  private async receiveRpc(state: ConnectionState, text: string): Promise<void> {
    const admitted = state.admitted
    const scope = state.credentialScope
    const credentialId = state.credentialId
    const token = state.token
    if (!admitted || !scope || !credentialId || !token || state.cleaned) return
    const sanitized = this.guardEnvelopeIdentity(text, token)
    const envelope = parseJson(sanitized)
    const key = this.credentialKey(scope, credentialId)
    const currentCount = this.inFlightByCredential.get(key) ?? 0
    if (currentCount >= MAX_REQUESTS_PER_CREDENTIAL) {
      const request = isRecord(envelope) ? envelope : null
      const params = request?.params ?? {}
      try {
        this.authorizeConnection(scope, credentialId, token, typeof request?.method === 'string' ? request.method : '', isRecord(params) ? params : {})
        this.sendRpcError(state, request?.id, -32002, 'runtime_busy', { code: 'runtime_busy' })
      } catch {
        this.sendRpcError(state, request?.id, -32001, 'not authorized')
      }
      return
    }
    await this.receiveThroughKernel(state, admitted, sanitized, key)
  }

  private async receiveThroughKernel(state: ConnectionState, admitted: AdmittedMobileClient, text: string, key: string): Promise<void> {
    const connectionId = admitted.id
    this.inFlightByCredential.set(key, (this.inFlightByCredential.get(key) ?? 0) + 1)
    this.inFlightByConnection.set(connectionId, (this.inFlightByConnection.get(connectionId) ?? 0) + 1)
    try {
      await admitted.receive(text)
    } catch {
      // The public kernel API reports RPC failures on sendText; receive rejects only on lifecycle failure.
    } finally {
      const remaining = (this.inFlightByCredential.get(key) ?? 1) - 1
      if (remaining <= 0) this.inFlightByCredential.delete(key)
      else this.inFlightByCredential.set(key, remaining)
      const connectionRemaining = (this.inFlightByConnection.get(connectionId) ?? 1) - 1
      if (connectionRemaining <= 0) this.inFlightByConnection.delete(connectionId)
      else this.inFlightByConnection.set(connectionId, connectionRemaining)
      this.notifyCredentialWaiters(key)
    }
  }

  private guardEnvelopeIdentity(text: string, expectedToken: string): string {
    const message = parseJson(text)
    if (!isRecord(message)) return text
    const params = isRecord(message.params) ? message.params : null
    const hasForbiddenIdentity = ENVELOPE_IDENTITY_FIELDS.some((key) => Object.hasOwn(message, key))
    const paramsHaveIdentity = params !== null && CALLER_IDENTITY_FIELDS.some((key) => Object.hasOwn(params, key))
    const hasDeviceToken = Object.hasOwn(message, 'deviceToken')
    const tokenMismatch = hasDeviceToken && message.deviceToken !== expectedToken
    if (hasForbiddenIdentity || paramsHaveIdentity || tokenMismatch) {
      const safeParams = params ? { ...params } : {}
      safeParams.deviceToken = 'mismatched-request-identity'
      return JSON.stringify({ ...message, params: safeParams })
    }
    if (hasDeviceToken) {
      const safeMessage = { ...message }
      delete safeMessage.deviceToken
      return JSON.stringify(safeMessage)
    }
    return text
  }

  private authorizeConnection(scope: 'mobile' | 'owner-cli', credentialId: string, token: string, method: string, params: Record<string, unknown>): void {
    if (CALLER_IDENTITY_FIELDS.some((key) => Object.hasOwn(params, key))) throw new Error('not authorized')
    if (scope === 'owner-cli') {
      if (!this.ownerStore.isCurrentCredential(credentialId, token) || method === 'client.hello') throw new Error('not authorized')
      return
    }
    if (!this.store.isCurrentCredential(credentialId, token)) throw new Error('not authorized')
    assertMobileCallAllowed(method, params)
  }

  private sendKernelText(state: ConnectionState, text: string): void {
    if (!state.channel || state.cleaned) return
    if (Buffer.byteLength(text) > MAX_MOBILE_TEXT_BYTES) {
      const parsed = parseJson(text)
      if (isRecord(parsed) && typeof parsed.id === 'number') {
        this.sendRpcError(state, parsed.id, -32005, 'reply_too_large', { code: 'reply_too_large' })
      } else {
        this.cleanupConnection(state, 1013, 'Outbound reply buffer overflow', false)
      }
      return
    }
    this.sendEncryptedText(state, text)
  }

  private sendKernelBinary(state: ConnectionState, bytes: Uint8Array): void {
    if (!state.channel || state.cleaned) return
    if (bytes.byteLength > MAX_MOBILE_BINARY_BYTES) {
      this.cleanupConnection(state, 1013, 'Outbound reply buffer overflow', false)
      return
    }
    try {
      state.peer.sendBinary(state.channel.sealBinary(bytes))
    } catch {
      this.cleanupConnection(state, 1013, 'Outbound reply buffer overflow', false)
    }
  }

  private sendEncryptedText(state: ConnectionState, text: string): boolean {
    if (!state.channel || state.cleaned) return false
    try { return state.peer.sendText(state.channel.sealText(text)) } catch { return false }
  }

  private sendRpcError(state: ConnectionState, id: unknown, code: number, message: string, data?: unknown): void {
    const validId = typeof id === 'number' ? id : null
    const response = { jsonrpc: '2.0', id: validId, error: { code, message, ...(data === undefined ? {} : { data }) } }
    this.sendEncryptedText(state, JSON.stringify(response))
  }

  private recordAuthFailure(): void {
    const now = Date.now()
    this.authFailures = this.authFailures.filter((time) => now - time < AUTH_FAILURE_WINDOW_MS)
    this.authFailures.push(now)
    if (this.authToastSent || this.authFailures.length < 3) return
    this.authToastSent = true
    try {
      this.context.notify({
        title: 'A device tried to connect but is not paired',
        body: 'If this was your phone or another Quirky client, re-pair it from Settings > Mobile.',
        open: { view: 'view:quirky.mobile/settings' },
        actions: [{ label: 'Open Mobile Settings', command: 'command:quirky.mobile/open-settings' }]
      })
    } catch {}
  }

  private cleanupConnection(state: ConnectionState, code: number, reason: string, terminate: boolean, disconnectCore = true): void {
    if (state.cleaned) return
    state.cleaned = true
    clearTimeout(state.authTimer)
    state.authTimer = undefined
    state.channel?.dispose()
    state.channel = null
    if (state.credentialScope && state.credentialId) {
      const activeMap = state.credentialScope === 'mobile' ? this.deviceConnections : this.ownerConnections
      const active = activeMap.get(state.credentialId)
      active?.delete(state)
      if (active?.size === 0) activeMap.delete(state.credentialId)
    }
    if (state.admitted) {
      const admitted = state.admitted
      state.admitted = null
      if (disconnectCore) {
        try { admitted.disconnect() } catch {}
      }
    }
    this.connections.delete(state)
    if (terminate) state.peer.terminate()
    else state.peer.close(code, reason)
  }

  private credentialKey(scope: 'mobile' | 'owner-cli', credentialId: string): string {
    return `${scope}:${credentialId}`
  }

  private waitForCredentialIdle(key: string, excludeConnectionId: number | undefined): Promise<void> {
    const inFlight = this.inFlightByCredential.get(key) ?? 0
    const excluded = excludeConnectionId === undefined ? 0 : this.inFlightByConnection.get(excludeConnectionId) ?? 0
    if (inFlight <= excluded) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    const waiters = this.inFlightWaiters.get(key) ?? new Set<InFlightWaiter>()
    waiters.add({ excludeConnectionId, resolve })
    this.inFlightWaiters.set(key, waiters)
    return promise
  }

  private notifyCredentialWaiters(key: string): void {
    const waiters = this.inFlightWaiters.get(key)
    if (!waiters) return
    const inFlight = this.inFlightByCredential.get(key) ?? 0
    for (const waiter of waiters) {
      const excluded = waiter.excludeConnectionId === undefined
        ? 0
        : this.inFlightByConnection.get(waiter.excludeConnectionId) ?? 0
      if (inFlight <= excluded) {
        waiters.delete(waiter)
        waiter.resolve()
      }
    }
    if (waiters.size === 0) this.inFlightWaiters.delete(key)
  }

  private emitChanged(): void {
    this.context.emit('changed', {})
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}

export function registerMobileMethods(context: PluginContext, service: MobileService): void {
  const requireLocal = (caller: PluginCaller): void => {
    if (caller.role === 'mobile') throw new Error('Mobile clients cannot call pairing administration methods')
  }
  const requireFullOwner = (caller: PluginCaller): void => {
    if (caller.role !== 'cli' && caller.role !== 'desktop' && caller.role !== 'ui') {
      throw new Error('Owner grants require a local or authenticated full-owner client')
    }
  }
  const methods: Record<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown> = {
    info: () => service.info(),
    state: (_params, caller) => { requireLocal(caller); return service.state() },
    interfaces: (_params, caller) => { requireLocal(caller); return service.interfaces() },
    pair: (params, caller) => { requireLocal(caller); return service.pair(params) },
    devices: (_params, caller) => { requireLocal(caller); return service.devices() },
    revoke: (params, caller) => { requireLocal(caller); return service.revoke(params) },
    ownerPair: (params, caller) => { requireFullOwner(caller); return service.ownerPair(params) },
    ownerGrants: (_params, caller) => { requireFullOwner(caller); return service.ownerGrants() },
    ownerRevoke: (params, caller) => {
      requireFullOwner(caller)
      return service.ownerRevoke(params, caller.role === 'plugin' ? undefined : caller.connection?.id)
    },
    configure: (params, caller) => { requireLocal(caller); return service.configure(params) },
    preferences: () => service.preferences(),
    updatePreferences: (params) => service.updatePreferences(params),
    bundleManifest: () => service.bundleManifest(),
    bundleChunk: (params) => service.bundleChunk(params),
    bundleRange: (params) => service.bundleRange(params),
    open: (params, caller) => { requireLocal(caller); return service.open(params) }
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:quirky.mobile/${name}`, handler)
  context.provide('command:quirky.mobile/open', () => context.call('ui.view.open', { id: 'view:quirky.mobile/page' }))
  context.provide('command:quirky.mobile/open-settings', () => context.call('ui.view.open', { id: 'view:quirky.mobile/settings' }))
}
