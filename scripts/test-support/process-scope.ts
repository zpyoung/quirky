import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLAIM_FILES = ['runtime.json', 'pty.pid'] as const
const POLL_INTERVAL_MS = 75
const GRACEFUL_SHUTDOWN_MS = 250
// A live guardian may wait on Bun startup and its first process-table snapshot under suite load.
const GUARDIAN_STARTUP_TIMEOUT_MS = 15_000
const HELPER_PATH = fileURLToPath(import.meta.url)
const scopeEnvironmentCache = new Map<string, boolean>()

type ProcessIdentity = {
  pid: number
  ppid: number
  pgid: number
  started: string
  command: string
}

type ProcessRecord = ProcessIdentity & {
  root: boolean
  privateGroup: boolean
}

type FileFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
  size: number
  digest: string
}

type ScopeConfig = {
  home: string
  scopeDirectory: string
  recordsDirectory: string
  readyFile: string
  doneFile: string
  disposeFile: string
  guardianFile: string
  owner: ProcessIdentity
  protectedPids: number[]
  createdAt: number
  initialFiles: Record<(typeof CLAIM_FILES)[number], FileFingerprint | null>
  removeHomeOnOwnerDeath: boolean
}
export type ProcessScopeSpawnOptions<
  In extends Bun.SpawnOptions.Writable = 'ignore',
  Out extends Bun.SpawnOptions.Readable = 'pipe',
  Err extends Bun.SpawnOptions.Readable = 'inherit'
> = Bun.SpawnOptions.OptionsObject<In, Out, Err> & {
  /** Isolates the process into its own group unless explicitly disabled. */
  detached?: boolean
}

export type ProcessScope = {
  readonly home: string
  readonly env: Record<string, string>
  /** Starts the real Bun child in an isolated group by default and returns its unwrapped subprocess. */
  spawn<
    const In extends Bun.SpawnOptions.Writable = 'ignore',
    const Out extends Bun.SpawnOptions.Readable = 'pipe',
    const Err extends Bun.SpawnOptions.Readable = 'inherit'
  >(command: string[], options?: ProcessScopeSpawnOptions<In, Out, Err>): Bun.Subprocess<In, Out, Err>
  /** Adds an already-started process to this scope using its current PID/start identity. */
  track(pid: number): void
  /** Gracefully signals owned processes, force-kills survivors and disposes the guardian. */
  cleanup(): Promise<void>
  /** Synchronously force-kills identities already visible to the scope and leaves the guardian active. */
  killNow(): void
}

type ProcessSnapshot = Map<number, ProcessIdentity>

function parseProcessTable(text: string): ProcessSnapshot {
  const rows: ProcessSnapshot = new Map()
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    const [pid, ppid, pgid] = columns.slice(0, 3).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || columns.length < 9) continue
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      started: columns.slice(3, 8).join(' '),
      command: columns.slice(8).join(' ')
    })
  }
  return rows
}

function processSnapshot(): ProcessSnapshot {
  try {
    const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='])
    return result.exitCode === 0 ? parseProcessTable(result.stdout.toString()) : new Map()
  } catch {
    return new Map()
  }
}

function sameProcess(left: ProcessIdentity | undefined, right: ProcessIdentity | undefined): boolean {
  return !!left && !!right && left.pid === right.pid && left.started === right.started &&
    (left.command === right.command || (left.ppid === right.ppid && left.pgid === right.pgid))
}

function processStartTime(identity: ProcessIdentity): number | undefined {
  const time = Date.parse(identity.started)
  return Number.isFinite(time) ? time : undefined
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

function fingerprint(path: string): FileFingerprint | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return null
    const content = readFileSync(path)
    return {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      digest: createHash('sha256').update(content).digest('hex')
    }
  } catch {
    return null
  }
}

function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size && left.digest === right.digest
}

function initialFingerprints(home: string): ScopeConfig['initialFiles'] {
  return {
    'runtime.json': fingerprint(join(home, 'runtime.json')),
    'pty.pid': fingerprint(join(home, 'pty.pid'))
  }
}

function processAncestors(snapshot: ProcessSnapshot, ownerPid: number): number[] {
  const protectedPids: number[] = []
  const seen = new Set<number>()
  let row = snapshot.get(ownerPid)
  while (row && !seen.has(row.pid)) {
    protectedPids.push(row.pid)
    seen.add(row.pid)
    row = snapshot.get(row.ppid)
  }
  return protectedPids
}

function identityFor(pid: number, snapshot = processSnapshot()): ProcessIdentity | undefined {
  return snapshot.get(pid)
}

function recordPath(config: ScopeConfig, identity: ProcessIdentity): string {
  const key = createHash('sha256').update(`${identity.pid}\0${identity.started}`).digest('hex').slice(0, 20)
  return join(config.recordsDirectory, `${identity.pid}-${key}.json`)
}

function writeProcessRecord(config: ScopeConfig, identity: ProcessIdentity, root = false, privateGroup = false): void {
  if (config.protectedPids.includes(identity.pid)) return
  const path = recordPath(config, identity)
  const previous = readJson(path)
  const previousRecord = previous && typeof previous === 'object' ? previous as Partial<ProcessRecord> : {}
  const record: ProcessRecord = {
    ...identity,
    root: root || previousRecord.root === true,
    privateGroup: privateGroup || previousRecord.privateGroup === true
  }
  if (
    previousRecord.pid === record.pid &&
    previousRecord.ppid === record.ppid &&
    previousRecord.pgid === record.pgid &&
    previousRecord.started === record.started &&
    previousRecord.command === record.command &&
    previousRecord.root === record.root &&
    previousRecord.privateGroup === record.privateGroup
  ) return
  writeJsonAtomically(path, record)
}

function processRecords(config: ScopeConfig): ProcessRecord[] {
  try {
    return readdirSync(config.recordsDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(config.recordsDirectory, name)))
      .filter((record): record is ProcessRecord =>
        !!record && typeof record === 'object' &&
        Number.isInteger((record as ProcessRecord).pid) &&
        typeof (record as ProcessRecord).started === 'string' &&
        typeof (record as ProcessRecord).command === 'string'
      )
  } catch {
    return []
  }
}

function parseClaimPid(path: string): number | undefined {
  try {
    const content = readFileSync(path, 'utf8').trim()
    const candidate = path.endsWith('pty.pid') ? Number(content) : Number((JSON.parse(content) as { pid?: unknown }).pid)
    return Number.isSafeInteger(candidate) && candidate > 1 ? candidate : undefined
  } catch {
    return undefined
  }
}

function claimChanged(config: ScopeConfig, name: (typeof CLAIM_FILES)[number]): FileFingerprint | null {
  const current = fingerprint(join(config.home, name))
  return sameFingerprint(config.initialFiles[name], current) ? null : current
}

function registerFreshClaims(config: ScopeConfig, snapshot: ProcessSnapshot): void {
  for (const name of CLAIM_FILES) {
    const changed = claimChanged(config, name)
    if (!changed || changed.mtimeMs < config.createdAt - 1_000) continue
    const pid = parseClaimPid(join(config.home, name))
    if (!pid || config.protectedPids.includes(pid)) continue
    const identity = snapshot.get(pid)
    if (!identity) continue
    const started = processStartTime(identity)
    // The pidfile must have been written after registration, and the process must already have
    // existed when its own PID was written. The small tolerance accounts for `ps lstart` seconds.
    if (started === undefined || started < config.createdAt - 1_000 || started > changed.mtimeMs + 1_000) continue
    writeProcessRecord(config, identity, true, identity.pgid === identity.pid)
  }
}

function processEnvironment(pid: number): string {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`).toString('utf8')
    const result = Bun.spawnSync(['ps', 'eww', '-p', String(pid), '-o', 'command='])
    return result.exitCode === 0 ? result.stdout.toString() : ''
  } catch {
    return ''
  }
}

function hasScopeEnvironment(identity: ProcessIdentity, config: ScopeConfig, token: string): boolean {
  const key = `${config.scopeDirectory}:${identity.pid}:${identity.started}`
  const cached = scopeEnvironmentCache.get(key)
  if (cached !== undefined) return cached
  const environment = processEnvironment(identity.pid)
  const matches = environment.includes(`QUIRKY_HOME=${config.home}`) || environment.includes(`QUIRKY_TEST_SCOPE=${token}`)
  scopeEnvironmentCache.set(key, matches)
  return matches
}

function scopeEnvironmentDescendants(config: ScopeConfig, snapshot: ProcessSnapshot, token: string): void {
  const descendants = new Set<number>([config.owner.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of snapshot.values()) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue
      descendants.add(row.pid)
      changed = true
    }
  }
  for (const pid of descendants) {
    if (config.protectedPids.includes(pid)) continue
    const identity = snapshot.get(pid)
    if (!identity || (processStartTime(identity) ?? 0) < config.createdAt - 1_000) continue
    if (hasScopeEnvironment(identity, config, token)) writeProcessRecord(config, identity, true, identity.pgid === identity.pid)
  }
}

function collectOwned(config: ScopeConfig, token: string): { snapshot: ProcessSnapshot; records: ProcessRecord[] } {
  const snapshot = processSnapshot()
  registerFreshClaims(config, snapshot)
  scopeEnvironmentDescendants(config, snapshot, token)

  const byPid = new Map<number, ProcessRecord>()
  for (const record of processRecords(config)) {
    const current = snapshot.get(record.pid)
    if (!sameProcess(record, current) || config.protectedPids.includes(record.pid)) continue
    byPid.set(record.pid, { ...record, ...current })
  }

  let changed = true
  while (changed) {
    changed = false
    for (const row of snapshot.values()) {
      if (config.protectedPids.includes(row.pid) || byPid.has(row.pid) || !byPid.has(row.ppid)) continue
      writeProcessRecord(config, row)
      byPid.set(row.pid, { ...row, root: false, privateGroup: false })
      changed = true
    }
  }
  return { snapshot, records: [...byPid.values()] }
}

function signalRecords(config: ScopeConfig, records: ProcessRecord[], signal: NodeJS.Signals): void {
  const snapshot = processSnapshot()
  const signaledGroups = new Set<number>()
  for (const record of records) {
    if (config.protectedPids.includes(record.pid)) continue
    const current = snapshot.get(record.pid)
    if (!sameProcess(record, current)) continue
    if (process.platform !== 'win32' && record.root && record.privateGroup && record.pgid === record.pid && current?.pgid === record.pid && !signaledGroups.has(record.pid)) {
      try {
        // Only a recorded detached group leader is group-signaled; inherited test groups are never swept.
        process.kill(-record.pid, signal)
        signaledGroups.add(record.pid)
      } catch {
        // Fall through to the verified individual process signal below.
      }
    }
    try {
      process.kill(record.pid, signal)
    } catch {
      // A process may exit between the final identity check and signal delivery.
    }
  }
}

async function terminateOwned(config: ScopeConfig, token: string): Promise<void> {
  let collected = collectOwned(config, token)
  signalRecords(config, collected.records, 'SIGTERM')
  const gracefulUntil = Date.now() + GRACEFUL_SHUTDOWN_MS
  while (Date.now() < gracefulUntil) {
    await Bun.sleep(20)
    collected = collectOwned(config, token)
    if (collected.records.length === 0) break
  }
  collected = collectOwned(config, token)
  signalRecords(config, collected.records, 'SIGKILL')
  const forceUntil = Date.now() + 1_500
  while (Date.now() < forceUntil) {
    await Bun.sleep(20)
    collected = collectOwned(config, token)
    if (collected.records.length === 0) return
    signalRecords(config, collected.records, 'SIGKILL')
  }
}

function readConfig(path: string): ScopeConfig {
  const value = readJson(path)
  if (!value || typeof value !== 'object') throw new Error(`invalid process scope configuration: ${path}`)
  return value as ScopeConfig
}

async function bootstrapGuardian(configPath: string): Promise<void> {
  const config = readConfig(configPath)
  const command = [process.execPath, HELPER_PATH, '--guardian', configPath]
  const guardianOptions = {
    detached: true,
    stdin: 'ignore' as const,
    stdout: 'ignore' as const,
    stderr: 'ignore' as const,
    env: { ...process.env, QUIRKY_HOME: config.home }
  }
  const guardian = Bun.spawn(command, guardianOptions)
  const deadline = Date.now() + GUARDIAN_STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(config.readyFile)) return
    if (guardian.exitCode !== null) throw new Error(`process scope guardian exited with ${guardian.exitCode}`)
    await Bun.sleep(10)
  }
  try {
    guardian.kill('SIGKILL')
  } catch {
    // The guardian may have exited while the readiness marker was being checked.
  }
  throw new Error(`process scope guardian did not become ready for ${config.home}`)
}

function createGuardian(configPath: string, config: ScopeConfig, token: string): void {
  const command = [process.execPath, HELPER_PATH, '--bootstrap', configPath]
  const result = Bun.spawnSync(command, {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, QUIRKY_HOME: config.home, QUIRKY_TEST_SCOPE: token }
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not start process scope guardian: ${result.stderr.toString().trim()}`)
  }
}

function removeScopeFiles(config: ScopeConfig): void {
  rmSync(config.scopeDirectory, { recursive: true, force: true })
}

function signalGuardian(config: ScopeConfig, signal: NodeJS.Signals): void {
  const guardian = readJson(config.guardianFile)
  if (!guardian || typeof guardian !== 'object') return
  const identity = guardian as ProcessIdentity
  const current = processSnapshot().get(identity.pid)
  if (!sameProcess(identity, current) || identity.pid === process.pid) return
  try {
    process.kill(identity.pid, signal)
  } catch {
    // It may have exited after the identity check.
  }
}

function cleanupSynchronously(config: ScopeConfig, token: string): void {
  const owned = collectOwned(config, token)
  signalRecords(config, owned.records, 'SIGKILL')
}

async function waitForGuardian(config: ScopeConfig, deadline: number): Promise<void> {
  const guardian = readJson(config.guardianFile)
  if (!guardian || typeof guardian !== 'object') return
  const identity = guardian as ProcessIdentity
  while (Date.now() < deadline) {
    if (!sameProcess(identity, processSnapshot().get(identity.pid))) return
    await Bun.sleep(20)
  }
  signalGuardian(config, 'SIGKILL')
}

export function createProcessScope(home?: string): ProcessScope {
  const allocatedHome = home === undefined
  const scopeHome = home ?? mkdtempSync(join(tmpdir(), 'quirky-test-home-'))
  mkdirSync(scopeHome, { recursive: true, mode: 0o700 })

  const createdAt = Date.now()
  const ownerSnapshot = processSnapshot()
  const owner = identityFor(process.pid, ownerSnapshot)
  if (!owner) throw new Error(`could not identify process scope owner ${process.pid}`)
  const protectedPids = processAncestors(ownerSnapshot, process.pid)
  const scopeDirectory = mkdtempSync(join(tmpdir(), 'quirky-test-process-scope-'))
  const recordsDirectory = join(scopeDirectory, 'processes')

  const config: ScopeConfig = {
    home: scopeHome,
    scopeDirectory,
    recordsDirectory,
    readyFile: join(scopeDirectory, 'ready'),
    doneFile: join(scopeDirectory, 'done'),
    disposeFile: join(scopeDirectory, 'dispose'),
    guardianFile: join(scopeDirectory, 'guardian.json'),
    owner,
    protectedPids,
    createdAt,
    initialFiles: initialFingerprints(scopeHome),
    removeHomeOnOwnerDeath: allocatedHome
  }
  const token = randomUUID()
  const env = { QUIRKY_HOME: scopeHome, QUIRKY_TEST_SCOPE: token }
  const configPath = join(scopeDirectory, 'scope.json')
  try {
    mkdirSync(recordsDirectory, { recursive: true, mode: 0o700 })
    writeJsonAtomically(configPath, config)
    createGuardian(configPath, config, token)
  } catch (error) {
    rmSync(scopeDirectory, { recursive: true, force: true })
    if (allocatedHome) rmSync(scopeHome, { recursive: true, force: true })
    throw error
  }

  let disposed = false
  let cleanupPromise: Promise<void> | undefined

  const scopedSpawn = <
    const In extends Bun.SpawnOptions.Writable = 'ignore',
    const Out extends Bun.SpawnOptions.Readable = 'pipe',
    const Err extends Bun.SpawnOptions.Readable = 'inherit'
  >(
    command: string[],
    options?: ProcessScopeSpawnOptions<In, Out, Err>
  ): Bun.Subprocess<In, Out, Err> => {
    if (disposed) throw new Error('cannot spawn from a disposed process scope')
    const supplied = options?.env ?? process.env
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(supplied)) if (typeof value === 'string') childEnv[key] = value
    Object.assign(childEnv, env)
    const { detached, ...spawnOptions } = options ?? {}
    const childOptions: Bun.SpawnOptions.OptionsObject<In, Out, Err> = {
      ...spawnOptions,
      env: childEnv
    }
    Object.assign(childOptions, { detached: detached ?? true })
    const child = Bun.spawn(command, childOptions)
    const snapshot = processSnapshot()
    const identity = snapshot.get(child.pid)
    if (identity) writeProcessRecord(config, identity, true, detached !== false && identity.pgid === identity.pid)
    return child
  }

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    disposed = true
    writeFileSync(config.disposeFile, String(Date.now()), { mode: 0o600 })
    cleanupPromise = (async () => {
      const cleanupDeadline = Date.now() + 5_000
      while (Date.now() < cleanupDeadline && !existsSync(config.doneFile)) await Bun.sleep(20)
      if (!existsSync(config.doneFile)) cleanupSynchronously(config, token)
      await waitForGuardian(config, Date.now() + 1_000)
      removeScopeFiles(config)
      if (allocatedHome) rmSync(scopeHome, { recursive: true, force: true })
    })()
    return cleanupPromise
  }

  return {
    home: scopeHome,
    env,
    spawn: scopedSpawn,
    track(pid: number) {
      if (disposed || config.protectedPids.includes(pid)) return
      const identity = identityFor(pid)
      if (identity) writeProcessRecord(config, identity, true, identity.pgid === identity.pid)
    },
    cleanup,
    killNow() {
      cleanupSynchronously(config, token)
    }
  }
}

async function runGuardian(configPath: string): Promise<void> {
  const config = readConfig(configPath)
  const token = process.env.QUIRKY_TEST_SCOPE ?? ''
  const identity = identityFor(process.pid)
  if (!identity) throw new Error(`could not identify process scope guardian ${process.pid}`)
  config.protectedPids = [...new Set([...config.protectedPids, process.pid])]
  writeJsonAtomically(config.guardianFile, identity)
  writeFileSync(config.readyFile, String(process.pid), { mode: 0o600 })

  for (;;) {
    const { records, snapshot } = collectOwned(config, token)
    const ownerAlive = sameProcess(config.owner, snapshot.get(config.owner.pid))
    if (!ownerAlive || existsSync(config.disposeFile)) {
      await terminateOwned(config, token)
      writeFileSync(config.doneFile, String(Date.now()), { mode: 0o600 })
      if (!ownerAlive) {
        if (config.removeHomeOnOwnerDeath) rmSync(config.home, { recursive: true, force: true })
        removeScopeFiles(config)
      }
      return
    }
    // Ensure the latest tree snapshot reaches disk while every ancestor relation is still visible.
    for (const record of records) writeProcessRecord(config, record, record.root, record.privateGroup)
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

if (import.meta.main) {
  const mode = process.argv[2]
  const configPath = process.argv[3]
  if (mode === '--bootstrap' && configPath) {
    await bootstrapGuardian(configPath)
    process.exit(0)
  }
  if (mode === '--guardian' && configPath) await runGuardian(configPath)
}
