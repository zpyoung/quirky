import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import nacl from 'tweetnacl'
import { normalizeAdvertisedEndpoint } from './network'

export type MobileDeviceRecord = {
  deviceId: string
  name: string
  token: string
  pairedAt: number
  lastSeenAt: number
}

export type MobileSettings = {
  machineName: string
  showMobileButton: boolean
  onboardingSeen: boolean
  autoRestoreFitMs: number | null
  customAddresses: string[]
}

export type MobileIdentity = {
  publicKeyB64: string
  secretKey: Uint8Array
}

export type AuthenticationResult =
  | { status: 'paired'; device: MobileDeviceRecord }
  | { status: 'unauthorized' }
  | { status: 'registry_unavailable' }

export class MobileStoreError extends Error {
  constructor(readonly code: 'device_registry_unavailable' | 'e2ee_key_unavailable', message: string) {
    super(message)
    this.name = 'MobileStoreError'
  }
}

const DEFAULT_SETTINGS: MobileSettings = {
  machineName: hostname().trim().slice(0, 128) || 'Quirky desktop',
  showMobileButton: true,
  onboardingSeen: false,
  autoRestoreFitMs: null,
  customAddresses: []
}
const TOKEN_RE = /^[0-9a-f]{48}$/


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validDevice(value: unknown): value is MobileDeviceRecord {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false
  return typeof value.deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(value.deviceId) &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 128 &&
    typeof value.token === 'string' && TOKEN_RE.test(value.token) &&
    typeof value.pairedAt === 'number' && Number.isSafeInteger(value.pairedAt) && value.pairedAt > 0 &&
    typeof value.lastSeenAt === 'number' && Number.isSafeInteger(value.lastSeenAt) && value.lastSeenAt >= 0
}
function validCustomAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.trim() !== value) return false
  const endpoint = normalizeAdvertisedEndpoint(value, 6768)
  return endpoint !== null && !endpoint.includes('?') && !endpoint.includes('#')
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function quarantine(path: string): void {
  if (!existsSync(path)) return
  const target = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
  renameSync(path, target)
  syncDirectory(dirname(path))
}

function writeSecureAtomic(path: string, value: string): void {
  const directory = dirname(path)
  secureDirectory(directory)
  const temp = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, value, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
    chmodSync(path, 0o600)
    syncDirectory(directory)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

function readJson(path: string): unknown {
  chmodSync(path, 0o600)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function normalizeSettings(value: unknown): MobileSettings | null {
  if (!isRecord(value)) return null
  const keys = ['machineName', 'showMobileButton', 'onboardingSeen', 'autoRestoreFitMs', 'customAddresses']
  if (Object.keys(value).some((key) => !keys.includes(key))) return null
  const machineName = value.machineName
  const showMobileButton = value.showMobileButton
  const onboardingSeen = value.onboardingSeen
  const autoRestoreFitMs = value.autoRestoreFitMs
  const customAddresses = value.customAddresses
  if (typeof machineName !== 'string' || machineName.trim().length === 0 || machineName.length > 128 ||
    typeof showMobileButton !== 'boolean' || typeof onboardingSeen !== 'boolean' ||
    !(autoRestoreFitMs === null || (typeof autoRestoreFitMs === 'number' && Number.isFinite(autoRestoreFitMs) && autoRestoreFitMs >= 5000 && autoRestoreFitMs <= 3_600_000)) ||
    !Array.isArray(customAddresses) || customAddresses.length > 50) return null
  const addresses: string[] = []
  for (const address of customAddresses) {
    if (!validCustomAddress(address)) return null
    addresses.push(address)
  }
  return { machineName, showMobileButton, onboardingSeen, autoRestoreFitMs, customAddresses: addresses }
}

/** Private durable pairing state; corruption is quarantined and never reinterpreted as an empty registry. */
export class MobileStore {
  private readonly identityPath: string
  private readonly registryPath: string
  private readonly settingsPath: string
  private identityValue: MobileIdentity | null = null
  private devicesValue: MobileDeviceRecord[] = []
  private settingsValue: MobileSettings = { ...DEFAULT_SETTINGS, customAddresses: [] }
  identityAvailable = false
  registryAvailable = false
  settingsAvailable = true

  constructor(readonly dataDir: string) {
    secureDirectory(dataDir)
    this.identityPath = join(dataDir, 'e2ee-keypair.json')
    this.registryPath = join(dataDir, 'devices.json')
    this.settingsPath = join(dataDir, 'settings.json')
    this.loadIdentityAndRegistry()
    this.loadSettings()
  }

  get publicKeyB64(): string | null {
    return this.identityValue?.publicKeyB64 ?? null
  }

  get secretKey(): Uint8Array | null {
    return this.identityValue?.secretKey ?? null
  }

  settings(): MobileSettings {
    if (!this.settingsAvailable) throw new MobileStoreError('device_registry_unavailable', 'Mobile settings unavailable')
    return { ...this.settingsValue, customAddresses: [...this.settingsValue.customAddresses] }
  }

  configure(settings: Partial<MobileSettings>): MobileSettings {
    this.ensureRegistry()
    const next = { ...this.settingsValue, ...settings, customAddresses: settings.customAddresses ? [...settings.customAddresses] : [...this.settingsValue.customAddresses] }
    const valid = normalizeSettings(next)
    if (!valid) throw new Error('Invalid mobile configuration')
    writeSecureAtomic(this.settingsPath, JSON.stringify(valid))
    this.settingsValue = valid
    this.settingsAvailable = true
    return this.settings()
  }

  getOrCreatePending(rotate: boolean): MobileDeviceRecord {
    this.ensureRegistry()
    if (!this.identityAvailable || !this.identityValue) throw new MobileStoreError('e2ee_key_unavailable', 'Mobile encryption identity unavailable')
    const pending = this.devicesValue.find((device) => device.lastSeenAt === 0)
    if (pending && !rotate) return { ...pending }
    const paired = this.devicesValue.filter((device) => device.lastSeenAt !== 0)
    const device: MobileDeviceRecord = {
      deviceId: randomUUID(),
      name: 'Mobile device',
      token: randomBytes(24).toString('hex'),
      pairedAt: Date.now(),
      lastSeenAt: 0
    }
    this.persistDevices([...paired, device])
    return { ...device }
  }

  authenticate(token: string, now = Date.now()): AuthenticationResult {
    if (!this.registryAvailable) return { status: 'registry_unavailable' }
    if (!TOKEN_RE.test(token)) return { status: 'unauthorized' }
    const candidate = Buffer.from(token)
    const found = this.devicesValue.find((device) => {
      const expected = Buffer.from(device.token)
      return expected.length === candidate.length && timingSafeEqual(expected, candidate)
    })
    if (!found) return { status: 'unauthorized' }
    const seen = { ...found, lastSeenAt: Math.max(1, Math.floor(now)) }
    try {
      this.persistDevices(this.devicesValue.map((device) => device.deviceId === seen.deviceId ? seen : device))
    } catch {
      return { status: 'registry_unavailable' }
    }
    return { status: 'paired', device: { ...seen } }
  }

  findDevice(deviceId: string): MobileDeviceRecord | null {
    if (!this.registryAvailable) throw new MobileStoreError('device_registry_unavailable', 'Mobile device registry unavailable')
    const device = this.devicesValue.find((entry) => entry.deviceId === deviceId)
    return device ? { ...device } : null
  }

  isCurrentCredential(deviceId: string, token: string): boolean {
    if (!this.registryAvailable || !TOKEN_RE.test(token)) return false
    const record = this.devicesValue.find((device) => device.deviceId === deviceId)
    if (!record) return false
    const expected = Buffer.from(record.token)
    const actual = Buffer.from(token)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  devices(): { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[] {
    this.ensureRegistry()
    return this.devicesValue.filter((device) => device.lastSeenAt > 0).map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt }))
  }

  revoke(deviceId: string): boolean {
    this.ensureRegistry()
    const next = this.devicesValue.filter((device) => device.deviceId !== deviceId)
    if (next.length === this.devicesValue.length) return false
    this.persistDevices(next)
    return true
  }

  dispose(): void {
    this.identityValue?.secretKey.fill(0)
    this.identityValue = null
    this.identityAvailable = false
  }

  private loadIdentityAndRegistry(): void {
    const hasIdentity = existsSync(this.identityPath)
    const hasRegistry = existsSync(this.registryPath)
    if (!hasIdentity && !hasRegistry) {
      this.createInitialIdentity()
      this.devicesValue = []
      this.registryAvailable = true
      try { this.persistDevices([]) } catch { this.registryAvailable = false }
      return
    }
    if (!hasIdentity) {
      this.identityAvailable = false
      if (hasRegistry) this.loadRegistry()
      return
    }
    this.loadIdentity()
    if (!hasRegistry) {
      this.registryAvailable = false
      return
    }
    this.loadRegistry()
  }

  private createInitialIdentity(): void {
    try {
      const pair = nacl.box.keyPair()
      const publicKeyB64 = Buffer.from(pair.publicKey).toString('base64')
      writeSecureAtomic(this.identityPath, JSON.stringify({ v: 1, publicKeyB64, secretKeyB64: Buffer.from(pair.secretKey).toString('base64') }))
      this.identityValue = { publicKeyB64, secretKey: pair.secretKey }
      this.identityAvailable = true
    } catch {
      this.identityAvailable = false
    }
  }

  private loadIdentity(): void {
    try {
      const raw = readJson(this.identityPath)
      if (!isRecord(raw) || Object.keys(raw).length !== 3 || raw.v !== 1 || typeof raw.publicKeyB64 !== 'string' || typeof raw.secretKeyB64 !== 'string') throw new Error('invalid identity file')
      const publicKey = decodeCanonicalBase64(raw.publicKeyB64, 32)
      const secretKey = decodeCanonicalBase64(raw.secretKeyB64, 32)
      if (!publicKey || !secretKey) throw new Error('invalid key encoding')
      const derived = nacl.box.keyPair.fromSecretKey(secretKey).publicKey
      if (!timingSafeEqual(publicKey, derived)) throw new Error('identity key mismatch')
      this.identityValue = { publicKeyB64: raw.publicKeyB64, secretKey }
      this.identityAvailable = true
    } catch {
      try { quarantine(this.identityPath) } catch {}
      this.identityAvailable = false
      this.identityValue = null
    }
  }

  private loadRegistry(): void {
    try {
      const raw = readJson(this.registryPath)
      if (!Array.isArray(raw) || raw.some((entry) => !validDevice(entry))) throw new Error('invalid device registry')
      const devices = raw as MobileDeviceRecord[]
      const ids = new Set<string>()
      const tokens = new Set<string>()
      let pending = 0
      for (const device of devices) {
        if (ids.has(device.deviceId) || tokens.has(device.token)) throw new Error('duplicate device record')
        ids.add(device.deviceId)
        tokens.add(device.token)
        if (device.lastSeenAt === 0) pending++
      }
      if (pending > 1) throw new Error('multiple pending devices')
      this.devicesValue = devices.map((device) => ({ ...device }))
      this.registryAvailable = true
    } catch {
      try { quarantine(this.registryPath) } catch {}
      this.devicesValue = []
      this.registryAvailable = false
    }
  }

  private loadSettings(): void {
    if (!existsSync(this.settingsPath)) return
    try {
      const settings = normalizeSettings(readJson(this.settingsPath))
      if (!settings) throw new Error('invalid settings')
      this.settingsValue = settings
    } catch {
      try { quarantine(this.settingsPath) } catch {}
      this.settingsValue = { ...DEFAULT_SETTINGS, customAddresses: [] }
      this.settingsAvailable = false
    }
  }

  private ensureRegistry(): void {
    if (!this.registryAvailable) throw new MobileStoreError('device_registry_unavailable', 'Mobile device registry unavailable')
  }

  private persistDevices(devices: MobileDeviceRecord[]): void {
    this.ensureRegistry()
    try {
      writeSecureAtomic(this.registryPath, JSON.stringify(devices))
      this.devicesValue = devices.map((device) => ({ ...device }))
    } catch (error) {
      this.registryAvailable = false
      throw new MobileStoreError('device_registry_unavailable', error instanceof Error ? error.message : 'Mobile device registry unavailable')
    }
  }
}


function decodeCanonicalBase64(value: string, length: number): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length || bytes.toString('base64') !== value) return null
  return new Uint8Array(bytes)
}
