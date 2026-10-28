import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https'
import type { PeerCertificate } from 'node:tls'
import type { PluginCaller, PluginContext, PluginStore, RuntimePeer, RuntimePeerCall, RuntimePeerReply, RuntimePeerStatus } from '@quirky/protocol'
import type { FederationInboundHandler, FederationPeerPrincipal } from './federation/contracts'
import { fail } from './errors'
const REMOTE_HEIMDALL_METHODS: Record<string, true> = {
  'quirky.heimdall/remoteFleet': true,
  'quirky.heimdall/remoteDetail': true,
  'quirky.heimdall/remoteDebugReport': true,
  'quirky.heimdall/remoteCommand': true,
}
const FEDERATION_METHODS: Record<string, true> = {
  'quirky.orchestration/federationAttachStart': true,
  'quirky.orchestration/federationShow': true,
  'quirky.orchestration/federationRead': true,
  'quirky.orchestration/federationFleetSnapshot': true,
  'quirky.orchestration/federationStop': true,
  'quirky.orchestration/federationRelease': true,
  'quirky.orchestration/federationRetain': true,
  'quirky.orchestration/federationAbandon': true,
  'quirky.orchestration/federationPull': true,
  'quirky.orchestration/federationAck': true,
  'quirky.orchestration/federationImport': true,
}
const REMOTE_PEER_METHODS: Record<string, true> = {
  peerList: true,
  peerStatus: true,
  ...FEDERATION_METHODS,
}
const MUTATING_REMOTE_METHODS: Record<string, true> = {
  'quirky.heimdall/remoteCommand': true,
  'quirky.orchestration/federationAttachStart': true,
  'quirky.orchestration/federationStop': true,
  'quirky.orchestration/federationRelease': true,
  'quirky.orchestration/federationRetain': true,
  'quirky.orchestration/federationAbandon': true,
  'quirky.orchestration/federationAck': true,
  'quirky.orchestration/federationImport': true,
}
type InboundPeerPrincipal = Omit<FederationPeerPrincipal, 'incarnation'>
type InboundIdentity = { kind: 'bootstrap' } | { kind: 'paired'; principal: InboundPeerPrincipal }

const LISTEN_PATH = '/rpc'
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_TIMEOUT_MS = 180_000
const MIN_TOKEN_BYTES = 32
const CAPABILITIES = Object.freeze([
  'quirky.heimdall/remoteFleet',
  'quirky.heimdall/remoteDetail',
  'quirky.heimdall/remoteDebugReport',
  'quirky.heimdall/remoteCommand',
])
type PeerRow = {
  peer_id: string
  label: string
  endpoint: string
  fingerprint: string
  pairing_revision: number
  auth_token: string
  last_incarnation: string | null
  last_capabilities_json: string
}
type ListenerRow = {
  host: string
  port: number
  auth_token: string
  certificate_file: string | null
  private_key_file: string | null
  fingerprint: string
  identity_secret: string
}
type ListenerServer = HttpServer | HttpsServer

export type PeerListenerReceipt = {
  endpoint: string
  fingerprint: string
  incarnation: string
  capabilities: readonly string[]
  host: string
  port: number
}

type PeerConfigInputs = {
  peerListen: { host: string; port: number; token: string; certificateFile?: string; privateKeyFile?: string }
  peerListenStop: Record<string, never>
  peerPair: { peerId: string; label: string; endpoint: string; token: string; fingerprint: string }
  peerUnpair: { peerId: string; pairingRevision?: number }
}

function fingerprintFromCertificate(value: string | Buffer): string {
  const certificate = new X509Certificate(value)
  return createHash('sha256').update(certificate.raw).digest('hex')
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase()
}

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() === value && value.length <= 120
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= MIN_TOKEN_BYTES && Buffer.byteLength(value, 'utf8') <= 4096
}

function loopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  return false
}

function validEndpoint(context: PluginContext, value: unknown): URL {
  if (typeof value !== 'string') return fail(context, 'peer_invalid_endpoint', 'Peer endpoint must be an absolute HTTP(S) URL.')
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return fail(context, 'peer_invalid_endpoint', 'Peer endpoint must be an absolute HTTP(S) URL.')
  }
  if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.hostname || !endpoint.port) {
    return fail(context, 'peer_invalid_endpoint', 'Peer endpoint must contain only an HTTP(S) origin and explicit port.')
  }
  if (endpoint.protocol === 'http:' && !loopbackHost(endpoint.hostname)) {
    return fail(context, 'peer_tls_required', 'Non-loopback peer endpoints require HTTPS.')
  }
  endpoint.pathname = ''
  return endpoint
}

function parseObject(context: PluginContext, value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(context, 'peer_invalid_response', `${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function parsePeerStatus(context: PluginContext, value: unknown): RuntimePeerStatus {
  const object = parseObject(context, value, 'peer status')
  if (typeof object.fingerprint !== 'string' || typeof object.incarnation !== 'string' ||
    !Array.isArray(object.capabilities) || !object.capabilities.every((capability) => typeof capability === 'string')) {
    return fail(context, 'peer_invalid_response', 'Peer returned an invalid status response.')
  }
  return {
    fingerprint: normalizeFingerprint(object.fingerprint),
    incarnation: object.incarnation,
    capabilities: object.capabilities as string[],
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length)
}

function tokensEqual(first: string, second: string): boolean {
  const left = Buffer.from(first, 'utf8')
  const right = Buffer.from(second, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeReason(error: unknown): { code: string; message: string } {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: 'Peer request could not be completed.' }
  }
  return { code: 'peer_call_failed', message: 'Peer request could not be completed.' }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(body)
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(new Error('Peer request exceeds size limit.'), { code: 'peer_request_too_large' })
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
}

function requestPeer(
  context: PluginContext,
  endpoint: string,
  token: string,
  fingerprint: string,
  method: string,
  params: Record<string, unknown>,
  requestId?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  sourceIncarnation?: string,
): Promise<{ status: RuntimePeerStatus; result: unknown }> {
  const target = validEndpoint(context, endpoint)
  const body = Buffer.from(JSON.stringify({ method, params, ...(requestId ? { requestId } : {}) }), 'utf8')
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return Promise.reject(Object.assign(new Error('Peer request exceeds size limit.'), { code: 'peer_request_too_large' }))
  }
  const timeout = Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(timeoutMs)))
  const expectedFingerprint = normalizeFingerprint(fingerprint)
  const { promise, resolve, reject } = Promise.withResolvers<{ status: RuntimePeerStatus; result: unknown }>()
  let request: ClientRequest
  const onResponse = (response: IncomingMessage) => {
    const chunks: Buffer[] = []
    let bytes = 0
    response.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        request.destroy(Object.assign(new Error('Peer response exceeds size limit.'), { code: 'peer_response_too_large' }))
        return
      }
      chunks.push(value)
    })
    response.on('end', () => {
      let result: unknown
      try {
        result = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown
      } catch {
        reject(Object.assign(new Error('Peer returned invalid JSON.'), { code: 'peer_invalid_response' }))
        return
      }
      if (response.statusCode !== 200 || !isObject(result)) {
        const error = isObject(result) && isObject(result.error) ? result.error : {}
        const code = typeof error.code === 'string' ? error.code : 'peer_unavailable'
        reject(Object.assign(new Error('Peer rejected the request.'), { code }))
        return
      }
      try {
        resolve({ status: parsePeerStatus(context, result.status), result: result.result })
      } catch (error) {
        reject(error)
      }
    })
  }
  const options = {
    hostname: target.hostname.replace(/^\\[|\\]$/g, ''),
    port: Number(target.port),
    path: LISTEN_PATH,
    method: 'POST',
    agent: false,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      connection: 'close',
      ...(sourceIncarnation ? { 'x-quirky-peer-incarnation': sourceIncarnation } : {}),
    },
  }
  request = target.protocol === 'https:'
    ? httpsRequest({
      ...options,
      rejectUnauthorized: false,
      checkServerIdentity: (_host: string, certificate: PeerCertificate) => {
        if (fingerprintFromCertificate(certificate.raw) !== expectedFingerprint) {
          return Object.assign(new Error('Peer TLS fingerprint does not match the pinned certificate.'), { code: 'peer_pin_mismatch' })
        }
        return undefined
      },
    }, onResponse)
    : httpRequest(options, onResponse)
  request.setTimeout(timeout, () => request.destroy(Object.assign(new Error('Peer request timed out.'), { code: 'peer_timeout' })))
  request.once('error', reject)
  request.end(body)
  return promise
}

export class PeerManager {
  private readonly incarnation = randomUUID()
  private server: ListenerServer | null = null
  private disposed = false
  private federationHandler: FederationInboundHandler | null = null

  constructor(private readonly context: PluginContext, private readonly store: PluginStore) {}

  get localIncarnation(): string {
    return this.incarnation
  }

  setFederationHandler(handler: FederationInboundHandler | null): void {
    if (this.disposed) fail(this.context, 'peer_listener_unavailable', 'Peer manager is deactivated.')
    if (handler !== null && this.federationHandler !== null && this.federationHandler !== handler) {
      throw new Error('federation peer handler is already registered')
    }
    this.federationHandler = handler
  }

  getPeer(peerId: string): RuntimePeer {
    return publicPeer(this.requirePeer(peerId))
  }

  async remoteStatus(peerId: string, pairingRevision?: number): Promise<{ peer: RuntimePeer; status: RuntimePeerStatus }> {
    const peer = this.requirePeer(peerId)
    this.checkRevision(peer, pairingRevision)
    const status = await this.getRemoteStatus(peer)
    this.recordRemoteStatus(peer, status)
    return { peer: publicPeer(peer), status }
  }

  async callFederation(
    peerId: string,
    pairingRevision: number,
    method: string,
    params: Record<string, unknown>,
    requestId?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<RuntimePeerReply> {
    const peer = this.requirePeer(peerId)
    this.checkRevision(peer, pairingRevision)
    if (!Object.hasOwn(FEDERATION_METHODS, method)) {
      fail(this.context, 'peer_method_forbidden', `Remote method ${method} is outside the federation method ceiling.`, { method })
    }
    return this.performPeerCall(peer, method, params, requestId, timeoutMs)
  }

  readonly methods: Record<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown> = {
    peerList: (params, caller) => this.peerList(params, caller),
    peerStatus: (params, caller) => this.peerStatus(params, caller),
    peerCall: (params, caller) => this.peerCall(params as unknown as RuntimePeerCall, caller),
    peerListen: (params, caller) => this.peerListen(params as unknown as PeerConfigInputs['peerListen'], caller),
    peerListenStop: (_params, caller) => this.peerListenStop(caller),
    peerPair: (params, caller) => this.peerPair(params as unknown as PeerConfigInputs['peerPair'], caller),
    peerUnpair: (params, caller) => this.peerUnpair(params as unknown as PeerConfigInputs['peerUnpair'], caller),
  }

  async restore(): Promise<void> {
    if (this.disposed) return
    const row = this.store.get<ListenerRow>(
      `SELECT host, port, auth_token, certificate_file, private_key_file, fingerprint, identity_secret
       FROM orchestration_peer_listener WHERE singleton = 1 AND active = 1`,
    )
    if (!row) return
    try {
      await this.bindListener(row.host, row.port, row.auth_token, row.certificate_file, row.private_key_file, row.fingerprint, row.identity_secret)
    } catch (error) {
      this.context.log(`peer listener restore failed: ${safeReason(error).code}`)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.closeListener()
  }

  private async peerList(_params: Record<string, unknown>, _caller: PluginCaller): Promise<{ peers: RuntimePeer[] }> {
    const rows = this.store.all<PeerRow>(
      `SELECT peer_id, label, endpoint, fingerprint, pairing_revision, auth_token, last_incarnation, last_capabilities_json
       FROM orchestration_peers ORDER BY label COLLATE NOCASE, peer_id`,
    )
    return { peers: rows.map(publicPeer) }
  }

  private async peerStatus(params: Record<string, unknown>, _caller: PluginCaller): Promise<RuntimePeerStatus> {
    const peerId = typeof params.peerId === 'string' ? params.peerId : ''
    const peer = this.requirePeer(peerId)
    this.checkRevision(peer, params.pairingRevision)
    const status = await this.getRemoteStatus(peer)
    this.store.run(
      `UPDATE orchestration_peers SET last_incarnation = ?, last_capabilities_json = ? WHERE peer_id = ? AND pairing_revision = ?`,
      status.incarnation,
      JSON.stringify(status.capabilities),
      peer.peer_id,
      peer.pairing_revision,
    )
    return status
  }

  private async peerCall(input: RuntimePeerCall, caller: PluginCaller): Promise<RuntimePeerReply> {
    if (caller.role !== 'plugin') {
      return fail(this.context, 'peer_plugin_only', 'peerCall is available only to authenticated local plugin callers.')
    }
    if (typeof input.peerId !== 'string' || typeof input.method !== 'string' || !isObject(input.params)) {
      return fail(this.context, 'peer_invalid_call', 'peerCall requires peerId, method, and an object params value.')
    }
    const peer = this.requirePeer(input.peerId)
    this.checkRevision(peer, input.pairingRevision)
    return this.performPeerCall(peer, input.method, input.params, input.requestId, input.timeoutMs ?? REQUEST_TIMEOUT_MS)
  }

  private async performPeerCall(
    peer: PeerRow,
    method: string,
    params: Record<string, unknown>,
    requestId: string | undefined,
    timeoutMs: number,
  ): Promise<RuntimePeerReply> {
    this.assertRemoteMethod(method, params, requestId)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      return fail(this.context, 'peer_invalid_call', `Peer timeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`)
    }
    const status = await this.getRemoteStatus(peer)
    this.recordRemoteStatus(peer, status)
    const expectedIncarnation = params.expectedIncarnation
    if (typeof expectedIncarnation === 'string' && expectedIncarnation !== status.incarnation) {
      return fail(this.context, 'peer_incarnation_changed', 'Remote peer process incarnation changed before the call.', {
        peerId: peer.peer_id,
        expectedIncarnation,
        actualIncarnation: status.incarnation,
      })
    }
    const requiredCapability = method.startsWith('quirky.heimdall/') || Object.hasOwn(FEDERATION_METHODS, method) ? method : null
    if (requiredCapability !== null && !status.capabilities.includes(requiredCapability)) {
      return fail(this.context, 'peer_capability_missing', `Peer ${peer.peer_id} does not advertise ${requiredCapability}.`, {
        peerId: peer.peer_id,
        capability: requiredCapability,
      })
    }
    if (method === 'peerStatus') return { peer: publicPeer(peer), status, result: status }
    let response: { status: RuntimePeerStatus; result: unknown }
    try {
      response = await requestPeer(
        this.context,
        peer.endpoint,
        peer.auth_token,
        peer.fingerprint,
        method,
        params,
        requestId,
        timeoutMs,
        this.incarnation,
      )
    } catch (error) {
      const reason = safeReason(error)
      if (reason.code === 'peer_pin_mismatch') fail(this.context, 'peer_pin_mismatch', 'Remote peer certificate does not match the pinned fingerprint.', { peerId: peer.peer_id })
      if (reason.code === 'peer_auth_failed') fail(this.context, 'peer_auth_failed', 'Remote peer rejected the paired credential.', { peerId: peer.peer_id })
      if (reason.code === 'peer_incarnation_changed') fail(this.context, 'peer_incarnation_changed', 'Remote peer process incarnation changed before the call.', { peerId: peer.peer_id })
      if (reason.code === 'peer_method_forbidden') fail(this.context, 'peer_method_forbidden', 'Remote peer refused a method outside its current method ceiling.', { peerId: peer.peer_id })
      fail(this.context, 'peer_unavailable', `Remote peer ${peer.peer_id} could not complete the call (${reason.code}).`, { peerId: peer.peer_id })
    }
    this.assertPinnedStatus(peer, response.status)
    if (response.status.incarnation !== status.incarnation) {
      return fail(this.context, 'peer_incarnation_changed', 'Remote peer process incarnation changed during the call.', {
        peerId: peer.peer_id,
        expectedIncarnation: status.incarnation,
        actualIncarnation: response.status.incarnation,
      })
    }
    this.recordRemoteStatus(peer, response.status)
    return { peer: publicPeer(peer), status: response.status, result: response.result }
  }

  private async peerListen(input: PeerConfigInputs['peerListen'], caller: PluginCaller): Promise<PeerListenerReceipt> {
    this.requireOperator(caller)
    if (typeof input.host !== 'string' || input.host.trim() !== input.host || input.host.length === 0 || input.host.length > 255) {
      return fail(this.context, 'peer_invalid_listener', 'Listener host must be an explicit bind host.')
    }
    if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535) {
      return fail(this.context, 'peer_invalid_listener', 'Listener port must be an integer from 0 through 65535.')
    }
    if (!validToken(input.token)) return fail(this.context, 'peer_invalid_credential', `Listener token must contain at least ${MIN_TOKEN_BYTES} UTF-8 bytes.`)
    const certificateFile = input.certificateFile ?? null
    const privateKeyFile = input.privateKeyFile ?? null
    if ((certificateFile === null) !== (privateKeyFile === null)) {
      return fail(this.context, 'peer_invalid_listener', 'certificateFile and privateKeyFile must be provided together.')
    }
    if (!loopbackHost(input.host) && certificateFile === null) {
      return fail(this.context, 'peer_tls_required', 'Non-loopback listeners require HTTPS certificate and private-key files.')
    }
    const identitySecret = randomBytes(32).toString('hex')
    const fingerprint = certificateFile === null
      ? createHash('sha256').update(identitySecret).digest('hex')
      : fingerprintFromCertificate(this.readPrivateCredential(certificateFile, false))
    await this.closeListener()
    const receipt = await this.bindListener(input.host, input.port, input.token, certificateFile, privateKeyFile, fingerprint, identitySecret)
    const endpoint = new URL(receipt.endpoint)
    const actualPort = Number(endpoint.port)
    this.store.run(
      `INSERT INTO orchestration_peer_listener
       (singleton, host, port, auth_token, certificate_file, private_key_file, fingerprint, identity_secret, active)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(singleton) DO UPDATE SET host = excluded.host, port = excluded.port, auth_token = excluded.auth_token,
         certificate_file = excluded.certificate_file, private_key_file = excluded.private_key_file,
         fingerprint = excluded.fingerprint, identity_secret = excluded.identity_secret, active = 1`,
      input.host,
      actualPort,
      input.token,
      certificateFile,
      privateKeyFile,
      fingerprint,
      identitySecret,
    )
    return { ...receipt, port: actualPort }
  }

  private async peerListenStop(caller: PluginCaller): Promise<{ stopped: boolean }> {
    this.requireOperator(caller)
    const wasListening = this.server !== null
    await this.closeListener()
    this.store.run(`UPDATE orchestration_peer_listener SET active = 0 WHERE singleton = 1`)
    return { stopped: wasListening }
  }

  private async peerPair(input: PeerConfigInputs['peerPair'], caller: PluginCaller): Promise<{ peer: RuntimePeer }> {
    this.requireOperator(caller)
    if (typeof input.peerId !== 'string' || input.peerId.trim() !== input.peerId || input.peerId.length < 1 || input.peerId.length > 120) {
      return fail(this.context, 'peer_invalid_pairing', 'peerId must be a non-empty stable identifier.')
    }
    if (!validLabel(input.label) || !validToken(input.token)) {
      return fail(this.context, 'peer_invalid_pairing', 'Peer label and shared token must be valid.')
    }
    const endpoint = validEndpoint(this.context, input.endpoint)
    const fingerprint = normalizeFingerprint(input.fingerprint)
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return fail(this.context, 'peer_invalid_pairing', 'Pinned fingerprint must be a SHA-256 hexadecimal value.')
    const currentPeers = this.store.all<{ peer_id: string; auth_token: string }>(
      `SELECT peer_id, auth_token FROM orchestration_peers WHERE peer_id != ?`,
      input.peerId,
    )
    if (currentPeers.some((peer) => tokensEqual(peer.auth_token, input.token))) {
      return fail(this.context, 'peer_credential_reuse', 'A shared pairing credential cannot identify more than one peer.')
    }
    let remote: { status: RuntimePeerStatus; result: unknown }
    try {
      remote = await requestPeer(this.context, endpoint.toString(), input.token, fingerprint, 'peerStatus', {}, undefined, REQUEST_TIMEOUT_MS, this.incarnation)
    } catch (error) {
      const reason = safeReason(error)
      if (reason.code === 'peer_pin_mismatch') return fail(this.context, 'peer_pin_mismatch', 'Peer certificate does not match the supplied pin.', { peerId: input.peerId })
      if (reason.code === 'peer_auth_failed') return fail(this.context, 'peer_auth_failed', 'Peer rejected the supplied shared credential.', { peerId: input.peerId })
      return fail(this.context, 'peer_unavailable', `Could not verify peer ${input.peerId} (${reason.code}).`, { peerId: input.peerId })
    }
    if (remote.status.fingerprint !== fingerprint) return fail(this.context, 'peer_pin_mismatch', 'Peer identity does not match the supplied pin.', { peerId: input.peerId })
    const existing = this.store.get<{ pairing_revision: number }>(
      `SELECT pairing_revision FROM orchestration_peers WHERE peer_id = ?`, input.peerId,
    )
    const pairingRevision = (existing?.pairing_revision ?? 0) + 1
    this.store.run(
      `INSERT INTO orchestration_peers
       (peer_id, label, endpoint, fingerprint, pairing_revision, auth_token, last_incarnation, last_capabilities_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET label = excluded.label, endpoint = excluded.endpoint,
         fingerprint = excluded.fingerprint, pairing_revision = excluded.pairing_revision,
         auth_token = excluded.auth_token, last_incarnation = excluded.last_incarnation,
         last_capabilities_json = excluded.last_capabilities_json`,
      input.peerId,
      input.label,
      endpoint.origin,
      fingerprint,
      pairingRevision,
      input.token,
      remote.status.incarnation,
      JSON.stringify(remote.status.capabilities),
    )
    return { peer: this.requirePeerPublic(input.peerId) }
  }

  private peerUnpair(input: PeerConfigInputs['peerUnpair'], caller: PluginCaller): { unpaired: boolean } {
    this.requireOperator(caller)
    if (typeof input.peerId !== 'string' || input.peerId.length === 0) return fail(this.context, 'peer_invalid_pairing', 'peerId is required.')
    const peer = this.requirePeer(input.peerId)
    this.checkRevision(peer, input.pairingRevision)
    const removed = this.store.run(
      `DELETE FROM orchestration_peers WHERE peer_id = ? AND pairing_revision = ?`,
      peer.peer_id,
      peer.pairing_revision,
    )
    return { unpaired: removed.changes === 1 }
  }

  private async bindListener(
    host: string,
    port: number,
    token: string,
    certificateFile: string | null,
    privateKeyFile: string | null,
    fingerprint: string,
    identitySecret: string,
  ): Promise<PeerListenerReceipt> {
    const handler = (request: IncomingMessage, response: ServerResponse) => { void this.handleRequest(request, response, token, fingerprint) }
    let server: ListenerServer
    if (certificateFile !== null && privateKeyFile !== null) {
      const cert = this.readPrivateCredential(certificateFile, false)
      const key = this.readPrivateCredential(privateKeyFile, true)
      if (fingerprintFromCertificate(cert) !== normalizeFingerprint(fingerprint)) {
        return fail(this.context, 'peer_invalid_listener', 'Configured certificate fingerprint changed.')
      }
      server = createHttpsServer({ cert, key }, handler)
    } else {
      if (createHash('sha256').update(identitySecret).digest('hex') !== normalizeFingerprint(fingerprint)) {
        return fail(this.context, 'peer_invalid_listener', 'Configured loopback identity changed.')
      }
      server = createHttpServer(handler)
    }
    server.maxConnections = 64
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port, exclusive: true })
    }).catch((error: unknown) => {
      if (server.listening) server.close()
      const reason = safeReason(error)
      return fail(this.context, 'peer_listener_failed', `Could not bind peer listener (${reason.code}).`)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      return fail(this.context, 'peer_listener_failed', 'Peer listener returned no network address.')
    }
    const endpointHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
    const protocol = certificateFile === null ? 'http' : 'https'
    const endpoint = `${protocol}://${endpointHost}:${address.port}`
    this.server = server
    server.unref()
    return {
      endpoint,
      fingerprint: normalizeFingerprint(fingerprint),
      incarnation: this.incarnation,
      capabilities: CAPABILITIES,
      host,
      port: address.port,
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, bootstrapToken: string, fingerprint: string): Promise<void> {
    if (request.method !== 'POST' || request.url !== LISTEN_PATH) {
      writeJson(response, 404, { error: { code: 'not_found', message: 'Peer endpoint not found.' } })
      return
    }
    const supplied = bearerToken(request)
    const inbound = supplied === null ? null : this.identifyInbound(supplied, bootstrapToken)
    if (!inbound) {
      writeJson(response, 401, { error: { code: 'peer_auth_failed', message: 'Peer credential rejected.' } })
      return
    }
    let value: unknown
    try {
      value = await readRequestBody(request)
    } catch (error) {
      const reason = safeReason(error)
      writeJson(response, reason.code === 'peer_request_too_large' ? 413 : 400, { error: reason })
      return
    }
    if (!isObject(value) || typeof value.method !== 'string' || !isObject(value.params) ||
      (value.requestId !== undefined && typeof value.requestId !== 'string')) {
      writeJson(response, 400, { error: { code: 'peer_invalid_call', message: 'Peer request shape is invalid.' } })
      return
    }
    try {
      if (inbound.kind === 'bootstrap' && value.method !== 'peerStatus') {
        fail(this.context, 'peer_unpaired', 'Bootstrap credential authorizes status only.')
      }
      this.assertRemoteMethod(value.method, value.params, value.requestId as string | undefined)
      const expectedIncarnation = value.params.expectedIncarnation
      if (typeof expectedIncarnation === 'string' && expectedIncarnation !== this.incarnation) {
        fail(this.context, 'peer_incarnation_changed', 'Peer process incarnation changed.')
      }
      let result: unknown
      if (value.method === 'peerStatus') {
        result = this.localStatus(fingerprint)
      } else if (Object.hasOwn(FEDERATION_METHODS, value.method)) {
        if (inbound.kind !== 'paired' || this.federationHandler === null) {
          fail(this.context, 'peer_method_forbidden', 'Federation handler is not connected.')
        }
        const sourceIncarnation = request.headers['x-quirky-peer-incarnation']
        if (typeof sourceIncarnation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceIncarnation)) {
          fail(this.context, 'peer_invalid_call', 'Federation calls require the transport source incarnation header.')
        }
        const sourcePeer = this.requirePeer(inbound.principal.peerId)
        this.checkRevision(sourcePeer, inbound.principal.pairingRevision)
        if (normalizeFingerprint(sourcePeer.fingerprint) !== inbound.principal.fingerprint) {
          fail(this.context, 'peer_pin_mismatch', 'Authenticated source fingerprint no longer matches its pairing.', { peerId: sourcePeer.peer_id })
        }
        const liveSource = await this.getRemoteStatus(sourcePeer)
        if (liveSource.incarnation !== sourceIncarnation) {
          fail(this.context, 'peer_incarnation_changed', 'Federation request source process incarnation is not current.', {
            peerId: sourcePeer.peer_id,
            expectedIncarnation: liveSource.incarnation,
            actualIncarnation: sourceIncarnation,
          })
        }
        const principal: FederationPeerPrincipal = { ...inbound.principal, incarnation: sourceIncarnation }
        result = await this.federationHandler(value.method, value.params, principal, value.requestId as string | undefined)
      } else {
        result = await this.context.call(
          value.method === 'peerList' ? `${this.context.pluginId}/peerList` : value.method,
          value.params,
        )
      }
      writeJson(response, 200, { status: this.localStatus(fingerprint), result })
    } catch (error) {
      const reason = safeReason(error)
      const statusCode = reason.code === 'peer_method_forbidden' || reason.code === 'peer_unpaired' ? 403
        : reason.code === 'peer_auth_failed' ? 401 : 409
      writeJson(response, statusCode, { error: reason })
    }
  }
  private identifyInbound(supplied: string, bootstrapToken: string): InboundIdentity | null {
    const peers = this.store.all<PeerRow>(
      `SELECT peer_id, label, endpoint, fingerprint, pairing_revision, auth_token, last_incarnation, last_capabilities_json
       FROM orchestration_peers`,
    )
    let matched: PeerRow | null = null
    for (const peer of peers) {
      if (!tokensEqual(supplied, peer.auth_token)) continue
      if (matched !== null) return null
      matched = peer
    }
    if (matched) {
      return {
        kind: 'paired',
        principal: {
          peerId: matched.peer_id,
          fingerprint: normalizeFingerprint(matched.fingerprint),
          pairingRevision: matched.pairing_revision,
        },
      }
    }
    return tokensEqual(supplied, bootstrapToken) ? { kind: 'bootstrap' } : null
  }


  private localStatus(fingerprint?: string): RuntimePeerStatus {
    const currentFingerprint = fingerprint ?? this.store.get<{ fingerprint: string }>(
      `SELECT fingerprint FROM orchestration_peer_listener WHERE singleton = 1`,
    )?.fingerprint
    if (!currentFingerprint) return fail(this.context, 'peer_listener_unavailable', 'Peer listener identity is not configured.')
    return {
      fingerprint: normalizeFingerprint(currentFingerprint),
      incarnation: this.incarnation,
      capabilities: [...CAPABILITIES, ...(this.federationHandler === null ? [] : Object.keys(FEDERATION_METHODS))],
    }
  }

  private async getRemoteStatus(peer: PeerRow): Promise<RuntimePeerStatus> {
    let result: { status: RuntimePeerStatus; result: unknown }
    try {
      result = await requestPeer(this.context, peer.endpoint, peer.auth_token, peer.fingerprint, 'peerStatus', {}, undefined, REQUEST_TIMEOUT_MS, this.incarnation)
    } catch (error) {
      const reason = safeReason(error)
      if (reason.code === 'peer_pin_mismatch') return fail(this.context, 'peer_pin_mismatch', 'Peer certificate does not match the pinned fingerprint.', { peerId: peer.peer_id })
      if (reason.code === 'peer_auth_failed') return fail(this.context, 'peer_auth_failed', 'Peer rejected the paired credential.', { peerId: peer.peer_id })
      return fail(this.context, 'peer_unavailable', `Peer ${peer.peer_id} is unavailable (${reason.code}).`, { peerId: peer.peer_id })
    }
    this.assertPinnedStatus(peer, result.status)
    this.recordRemoteStatus(peer, result.status)
    return result.status
  }

  private recordRemoteStatus(peer: PeerRow, status: RuntimePeerStatus): void {
    this.store.run(
      `UPDATE orchestration_peers SET last_incarnation = ?, last_capabilities_json = ? WHERE peer_id = ? AND pairing_revision = ?`,
      status.incarnation,
      JSON.stringify(status.capabilities),
      peer.peer_id,
      peer.pairing_revision,
    )
  }

  private assertPinnedStatus(peer: PeerRow, status: RuntimePeerStatus): void {
    if (normalizeFingerprint(status.fingerprint) !== normalizeFingerprint(peer.fingerprint)) {
      fail(this.context, 'peer_pin_mismatch', 'Remote peer identity changed from the pinned fingerprint.', { peerId: peer.peer_id })
    }
  }

  private assertRemoteMethod(method: string, params: Record<string, unknown>, requestId?: string): void {
    const allowed = Object.hasOwn(REMOTE_PEER_METHODS, method) || Object.hasOwn(REMOTE_HEIMDALL_METHODS, method)
    if (!allowed) fail(this.context, 'peer_method_forbidden', `Remote method ${method} is outside the peer method ceiling.`, { method })
    if (Object.hasOwn(FEDERATION_METHODS, method) &&
      (typeof params.expectedIncarnation !== 'string' || params.expectedIncarnation.length === 0)) {
      fail(this.context, 'peer_invalid_call', `Federation method ${method} requires expectedIncarnation.`, { method })
    }
    if (Object.hasOwn(MUTATING_REMOTE_METHODS, method)) {
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        fail(this.context, 'peer_request_id_required', `Remote mutation ${method} requires a UUID requestId.`, { method })
      }
      if (typeof params.expectedIncarnation !== 'string' || params.expectedIncarnation.length === 0) {
        fail(this.context, 'peer_invalid_call', `Remote mutation ${method} requires expectedIncarnation.`, { method })
      }
    }
    if (method === 'quirky.heimdall/remoteCommand' && params.requestId !== requestId) {
      fail(this.context, 'peer_invalid_call', 'remoteCommand requires matching outer and inner requestId values.')
    }
    if ((method === 'peerStatus' || method === 'peerList') && Object.keys(params).length !== 0) {
      fail(this.context, 'peer_invalid_call', `${method} takes no parameters.`)
    }
  }

  private requirePeer(peerId: string): PeerRow {
    const peer = this.store.get<PeerRow>(
      `SELECT peer_id, label, endpoint, fingerprint, pairing_revision, auth_token, last_incarnation, last_capabilities_json
       FROM orchestration_peers WHERE peer_id = ?`,
      peerId,
    )
    if (!peer) return fail(this.context, 'peer_not_found', `Paired peer ${peerId} does not exist.`, { peerId })
    return peer
  }

  private requirePeerPublic(peerId: string): RuntimePeer {
    return publicPeer(this.requirePeer(peerId))
  }

  private checkRevision(peer: PeerRow, value: unknown): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value !== peer.pairing_revision)) {
      fail(this.context, 'peer_revision_mismatch', `Peer ${peer.peer_id} pairing revision changed.`, {
        peerId: peer.peer_id,
        expectedRevision: value,
        actualRevision: peer.pairing_revision,
      })
    }
  }

  private requireOperator(caller: PluginCaller): void {
    if (caller.role !== 'cli' || caller.sessionId !== undefined) {
      fail(this.context, 'peer_operator_required', 'Peer configuration is available only to an unbound operator CLI.')
    }
  }

  private readPrivateCredential(path: string, privateKey: boolean): Buffer {
    let info
    try {
      info = lstatSync(path)
    } catch {
      return fail(this.context, 'peer_invalid_listener', `Peer credential file is not readable: ${path}`)
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 64 * 1024 ||
      (privateKey && (info.mode & 0o077) !== 0)) {
      return fail(this.context, 'peer_invalid_listener', privateKey
        ? 'Private-key file must be a regular non-symlink file with mode 0600 or stricter.'
        : 'Certificate file must be a regular non-symlink file no larger than 64 KiB.')
    }
    try {
      return readFileSync(path)
    } catch {
      return fail(this.context, 'peer_invalid_listener', `Peer credential file is not readable: ${path}`)
    }
  }

  private async closeListener(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server || !server.listening) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}

function publicPeer(peer: PeerRow): RuntimePeer {
  return {
    id: peer.peer_id,
    label: peer.label,
    endpoint: peer.endpoint,
    fingerprint: normalizeFingerprint(peer.fingerprint),
    pairingRevision: peer.pairing_revision,
  }
}
