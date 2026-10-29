import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { OwnerHostIdentity, OwnerRuntimeCallResult, PluginContext, PluginStore, RegisteredOwnerHost, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import type { VmAttachmentRequest, VmBackendState, VmCheckoutMode, VmCreateOutput, VmEnvironment, VmEnvironmentRecipe, VmGuestCreateParams, VmLifecycleState, VmOperationKind, VmOperationState, VmRecipeSnapshot, VmRemoteWorkspace } from '../vm-types'
import { isRecord } from '../loop-status'

const VM_TIMEOUT_MS = 15 * 60_000
const VM_DOCTOR_TIMEOUT_MS = 15_000
const VM_KILL_GRACE_MS = 5_000
const OUTPUT_DRAIN_GRACE_MS = 1_000
const MAX_PROCESS_OUTPUT = 64 * 1024
const MAX_CREATE_OUTPUT = 16 * 1024
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ACTIVE_STATES = ['creating', 'suspending', 'resuming', 'destroying', 'retiring'] as const

type VmRow = {
  id: string
  repo_id: string
  repo_name: string
  repo_path: string
  recipe_id: string
  recipe_name: string
  recipe_hash: string
  recipe_json: string
  attachment_request_json: string | null
  canonical_create_state: 'not-started' | 'started' | 'created'
  guest_create_json: string | null
  instance_id: string
  backend_executable: string
  backend_identity_json: string | null
  state: VmLifecycleState
  backend_state: VmBackendState
  operation_id: string
  operation_kind: VmOperationKind
  operation_state: VmOperationState
  operation_started_at: number
  operation_updated_at: number
  error: string | null
  runtime_name: string
  runtime_id: string | null
  runtime_identity_json: string | null
  host_id: string | null
  host_identity_json: string | null
  mirror_json: string | null
  worktree_id: string | null
  worktree_instance_id: string | null
  host_forgotten: number
  runtime_forgotten: number
  created_at: number
  updated_at: number
}

type RepoDetails = { repo: Repo; hooks: { environmentRecipes?: VmEnvironmentRecipe[]; environmentRecipeDiagnostics?: Array<{ index: number; field?: string; message: string }> } }
type LimaInstance = { name: string; status: string; dir: string }
type VmBackendIdentity = { dir: string; dev: string; ino: string; birthtimeNs: string }
type LimaDirectoryStats = { dev: bigint; ino: bigint; birthtimeNs: bigint; isDirectory(): boolean; isSymbolicLink(): boolean }
type VmSavedRuntimeIdentity = { id: string; name: string; endpoint: string; pairedDeviceId: string; scope: 'owner-cli'; grantId: string }
type LimaExecutable = { executable: string | null; requested: string; error: string | null }
type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
type VmService = { store: PluginStore; processes: Map<number, Promise<number | null>>; operations: Set<Promise<void>>; stopping: boolean }
type ProcessOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; service?: VmService }
type VmContext = PluginContext & { call(method: string, params?: Record<string, unknown>): Promise<unknown> }
type VmCreateParams = { repo: string; recipe: string; trustHash: string; name?: string; createParams?: VmGuestCreateParams }
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function invalid(context: PluginContext, message: string): never {
  throw context.error('invalid-params', message)
}
function conflict(context: PluginContext, message: string): never {
  throw context.error('conflict', message)
}
function notFound(context: PluginContext, message: string): never {
  throw context.error('not-found', message)
}

function stringParam(context: PluginContext, params: Record<string, unknown>, key: string, options: { optional?: boolean; max?: number } = {}): string | undefined {
  const value = params[key]
  if (value === undefined && options.optional) return undefined
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > (options.max ?? 1024) || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(context, `${key} must be a non-empty, trimmed string of at most ${options.max ?? 1024} characters`)
  }
  return value
}

function normalizedRecipe(recipe: VmEnvironmentRecipe): VmRecipeSnapshot {
  return {
    id: recipe.id,
    name: recipe.name,
    create: recipe.create,
    checkoutMode: recipe.checkoutMode ?? 'orca-worktree',
    description: recipe.description ?? null,
    suspend: recipe.suspend ?? null,
    resume: recipe.resume ?? null,
    destroy: recipe.destroy ?? null,
    destroyDisabled: recipe.destroyDisabled === true
  }
}

/** Hashes every normalized recipe field; changing any lifecycle script invalidates prior consent. */
export function environmentRecipeHash(recipe: VmEnvironmentRecipe): string {
  return createHash('sha256').update(JSON.stringify(normalizedRecipe(recipe))).digest('hex')
}

export function migrateVmEnvironments(store: PluginStore): void {
  store.exec(`
    CREATE TABLE IF NOT EXISTS vm_environments (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      recipe_hash TEXT NOT NULL,
      recipe_json TEXT NOT NULL,
      attachment_request_json TEXT,
      canonical_create_state TEXT NOT NULL DEFAULT 'not-started',
      guest_create_json TEXT,
      instance_id TEXT NOT NULL UNIQUE,
      backend_executable TEXT NOT NULL,
      backend_identity_json TEXT,
      state TEXT NOT NULL,
      backend_state TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      operation_state TEXT NOT NULL,
      operation_started_at INTEGER NOT NULL,
      operation_updated_at INTEGER NOT NULL,
      error TEXT,
      runtime_name TEXT NOT NULL,
      runtime_id TEXT,
      runtime_identity_json TEXT,
      host_id TEXT,
      host_identity_json TEXT,
      mirror_json TEXT,
      worktree_id TEXT,
      worktree_instance_id TEXT,
      host_forgotten INTEGER NOT NULL DEFAULT 0,
      runtime_forgotten INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vm_environments_repo_idx ON vm_environments(repo_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS vm_environments_state_idx ON vm_environments(state, updated_at DESC);
  `)
}

function rowsForRepo(store: PluginStore, repo?: string): VmRow[] {
  return repo === undefined
    ? store.all<VmRow>('SELECT * FROM vm_environments ORDER BY updated_at DESC, id')
    : store.all<VmRow>('SELECT * FROM vm_environments WHERE repo_id = ? ORDER BY updated_at DESC, id', repo)
}

function rowById(store: PluginStore, id: string): VmRow | null {
  return store.get<VmRow>('SELECT * FROM vm_environments WHERE id = ?', id)
}

function recipeFromRow(context: PluginContext, row: VmRow): VmRecipeSnapshot {
  let recipe: unknown
  try { recipe = JSON.parse(row.recipe_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt persisted recipe snapshot`) }
  if (!isRecord(recipe) || recipe.id !== row.recipe_id || recipe.name !== row.recipe_name) {
    conflict(context, `VM ${row.id} has a corrupt persisted recipe snapshot`)
  }
  const snapshot = recipe as unknown as VmRecipeSnapshot
  if (typeof snapshot.id !== 'string' || typeof snapshot.name !== 'string' ||
    (snapshot.checkoutMode !== 'orca-worktree' && snapshot.checkoutMode !== 'provisioned-root') ||
    typeof snapshot.create !== 'string' || snapshot.create.trim() === '' ||
    (snapshot.description !== null && typeof snapshot.description !== 'string') ||
    (snapshot.suspend !== null && typeof snapshot.suspend !== 'string') ||
    (snapshot.resume !== null && typeof snapshot.resume !== 'string') ||
    (snapshot.destroy !== null && typeof snapshot.destroy !== 'string') ||
    typeof snapshot.destroyDisabled !== 'boolean') {
    conflict(context, `VM ${row.id} has an incomplete persisted recipe snapshot`)
  }
  if (createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== row.recipe_hash) {
    conflict(context, `VM ${row.id} persisted recipe snapshot no longer matches its approved lifecycle hash`)
  }
  return snapshot
}

function parseIdentity(value: unknown, label: string, context: PluginContext): OwnerHostIdentity {
  if (!isRecord(value) || typeof value.hostId !== 'string' || value.hostId.trim() === '' || value.hostId.length > 256 ||
    typeof value.generation !== 'string' || value.generation.trim() === '' || value.generation.length > 256) {
    conflict(context, `${label} did not return a valid owner host identity`)
  }
  return { hostId: value.hostId, generation: value.generation }
}

function sameIdentity(left: OwnerHostIdentity, right: OwnerHostIdentity): boolean {
  return left.hostId === right.hostId && left.generation === right.generation
}

function parseStoredIdentity(context: PluginContext, row: VmRow): OwnerHostIdentity | null {
  if (row.host_identity_json === null) return null
  try { return parseIdentity(JSON.parse(row.host_identity_json) as unknown, `VM ${row.id} saved identity`, context) } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== undefined) throw error
    conflict(context, `VM ${row.id} has a corrupt saved owner identity`)
  }
}

function parseMirror(context: PluginContext, row: VmRow): VmRemoteWorkspace | null {
  if (row.mirror_json === null) return null
  let value: unknown
  try { value = JSON.parse(row.mirror_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt saved workspace mirror`) }
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.hostId !== 'string' ||
    typeof value.connected !== 'boolean' || typeof value.fingerprint !== 'string' || !isRecord(value.worktree)) {
    conflict(context, `VM ${row.id} has an incomplete saved workspace mirror`)
  }
  const worktree = value.worktree as unknown as Worktree
  if (typeof worktree.id !== 'string' || typeof worktree.instanceId !== 'string') conflict(context, `VM ${row.id} has an incomplete saved workspace identity`)
  const identity = parseIdentity(value.identity, `VM ${row.id} saved mirror`, context)
  return { id: value.id as string, hostId: value.hostId as string, identity, worktree, connected: value.connected as boolean, fingerprint: value.fingerprint as string }
}

function parseGuestCreateResult(context: PluginContext, row: VmRow): WorktreeCreateResult | null {
  if (row.guest_create_json === null) return null
  let value: unknown
  try { value = JSON.parse(row.guest_create_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt guest-create receipt`) }
  if (!isRecord(value) || !isRecord(value.worktree) || typeof value.worktree.id !== 'string' ||
    !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === 'string') ||
    !isRecord(value.setup) || !['terminal', 'daemon', 'none', 'skipped'].includes(String(value.setup.ran))) {
    conflict(context, `VM ${row.id} has an incomplete guest-create receipt`)
  }
  return value as unknown as WorktreeCreateResult
}

function publicVm(context: PluginContext, row: VmRow): VmEnvironment {
  const recipe = recipeFromRow(context, row)
  const identity = parseStoredIdentity(context, row)
  const mirror = parseMirror(context, row)

  // A saved mirror is a historical snapshot, not a live network probe. Treat availability as unknown unless the running record, saved owner epoch, and mirror all agree.
  const mirrorConnected = row.state === 'running' && row.host_id !== null && mirror !== null && identity !== null &&
    mirror.hostId === row.host_id && sameIdentity(mirror.identity, identity) && mirror.connected
  const remoteWorkspace = mirror === null ? null : { ...mirror, connected: mirrorConnected }
  return {
    id: row.id,
    name: row.recipe_name,
    vmName: row.instance_id,
    repo: { id: row.repo_id, name: row.repo_name },
    recipe: { id: row.recipe_id, name: row.recipe_name, hash: row.recipe_hash, checkoutMode: recipe.checkoutMode },
    instanceId: row.instance_id,
    backend: 'lima',
    backendExecutable: row.backend_executable,
    state: row.state,
    backendState: row.backend_state,
    operation: {
      id: row.operation_id,
      kind: row.operation_kind,
      state: row.operation_state,
      startedAt: row.operation_started_at,
      updatedAt: row.operation_updated_at
    },
    error: row.error,
    ownerHost: row.host_id === null || identity === null ? null : { id: row.host_id, identity, connected: mirrorConnected },
    remoteWorkspace,
    guestCreateResult: parseGuestCreateResult(context, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function record(store: PluginStore, context: PluginContext, id: string): { row: VmRow; vm: VmEnvironment } {
  const row = rowById(store, id)
  if (!row) notFound(context, `VM record ${id} was not found`)
  return { row, vm: publicVm(context, row) }
}

function updateOperation(
  store: PluginStore,
  row: VmRow,
  values: { state: VmLifecycleState; backendState: VmBackendState; operationState: VmOperationState; error?: string | null; mirror?: VmRemoteWorkspace | null; identity?: OwnerHostIdentity | null }
): void {
  const now = Date.now()
  const mirror = values.mirror === undefined ? row.mirror_json : values.mirror === null ? null : JSON.stringify(values.mirror)
  const identity = values.identity === undefined ? row.host_identity_json : values.identity === null ? null : JSON.stringify(values.identity)
  store.run(
    `UPDATE vm_environments SET state = ?, backend_state = ?, operation_state = ?, operation_updated_at = ?,
      error = ?, mirror_json = ?, host_identity_json = ?, updated_at = ? WHERE id = ?`,
    values.state, values.backendState, values.operationState, now, values.error === undefined ? row.error : values.error,
    mirror, identity, now, row.id
  )
}

function beginOperation(store: PluginStore, row: VmRow, kind: VmOperationKind, state: VmLifecycleState, backendState: VmBackendState): string {
  const now = Date.now()
  const operationId = randomUUID()
  store.run(
    `UPDATE vm_environments SET state = ?, backend_state = ?, operation_id = ?, operation_kind = ?, operation_state = 'running',
      operation_started_at = ?, operation_updated_at = ?, error = NULL, updated_at = ? WHERE id = ?`,
    state, backendState, operationId, kind, now, now, now, row.id
  )
  return operationId
}

function failOperation(service: VmService, store: PluginStore, row: VmRow, backendState: VmBackendState, error: unknown): void {
  const interrupted = service.stopping
  updateOperation(store, row, {
    state: interrupted ? 'interrupted' : 'failed',
    backendState,
    operationState: interrupted ? 'interrupted' : 'failed',
    error: messageOf(error).slice(0, 2000)
  })
}

function finishOperation(store: PluginStore, row: VmRow, state: VmLifecycleState, backendState: VmBackendState, mirror?: VmRemoteWorkspace | null, identity?: OwnerHostIdentity | null): void {
  updateOperation(store, row, { state, backendState, operationState: 'complete', error: null, ...(mirror === undefined ? {} : { mirror }), ...(identity === undefined ? {} : { identity }) })
}

function requestedExecutable(): string {
  return process.env.QUIRKY_LIMACTL?.trim() || 'limactl'
}

function executableSearch(command: string): string | null {
  if (command.includes('/') || isAbsolute(command)) {
    const path = resolve(command)
    try {
      accessSync(path, fsConstants.X_OK)
      if (statSync(path).isFile()) return path
    } catch { return null }
    return null
  }
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (directory === '') continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch { /* try the next PATH entry */ }
  }
  return null
}

function selectLimaExecutable(): LimaExecutable {
  const requested = requestedExecutable()
  const executable = executableSearch(requested)
  return {
    executable,
    requested,
    error: executable === null ? `Lima executable "${requested}" is unavailable or not executable` : null
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch {
    try { process.kill(pid, signal) } catch { /* process already exited */ }
  }
}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const { promise: timeout, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  try { return await Promise.race([promise.then(() => true), timeout.then(() => false)]) }
  finally { clearTimeout(timer) }
}

function waitForChildClose(child: ChildProcess): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<number | null>()
  child.once('error', reject)
  child.once('close', (code) => resolve(code))
  return promise
}

async function runBounded(executable: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (options.service?.stopping) throw new Error('VM lifecycle stopped during plugin deactivation')
  const timeoutMs = options.timeoutMs ?? VM_TIMEOUT_MS
  let child: ChildProcess
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    throw new Error(`Could not start ${executable}: ${messageOf(error)}`)
  }
  const pid = child.pid
  const stdout = child.stdout
  const stderr = child.stderr
  const closed = waitForChildClose(child)
  if (stdout === null || stderr === null) {
    if (pid !== undefined) signalProcessGroup(pid, 'SIGKILL')
    await closed.catch(() => null)
    throw new Error(`${executable} did not provide bounded stdout/stderr pipes`)
  }
  if (pid !== undefined) options.service?.processes.set(pid, closed.then((code) => code, () => null))

  let timedOut = false
  let groupStopRequested = false
  let hardKillTimer: NodeJS.Timeout | undefined
  const { promise: hardKilled, resolve: resolveHardKilled } = Promise.withResolvers<void>()
  const stopGroup = () => {
    if (groupStopRequested || pid === undefined) return
    groupStopRequested = true
    signalProcessGroup(pid, 'SIGTERM')
    if (processGroupExists(pid)) {
      hardKillTimer = setTimeout(() => {
        signalProcessGroup(pid, 'SIGKILL')
        resolveHardKilled()
      }, VM_KILL_GRACE_MS)
    } else {
      resolveHardKilled()
    }
  }
  const timeoutTimer: NodeJS.Timeout = setTimeout(() => {
    timedOut = true
    stopGroup()
  }, timeoutMs)
  child.once('exit', () => { if (!timedOut) stopGroup() })

  let size = 0
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const drain = async (stream: Readable, chunks: Buffer[]) => {
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        const room = Math.max(0, MAX_PROCESS_OUTPUT - size)
        if (room > 0) {
          const kept = chunk.length <= room ? chunk : chunk.subarray(0, room)
          chunks.push(kept)
          size += kept.length
        }
      }
    } catch { /* stream closed while the process group was being stopped */ }
  }
  const drains = [drain(stdout, stdoutChunks), drain(stderr, stderrChunks)]
  let exitCode: number | null = null
  try {
    exitCode = await closed
    await Promise.all(drains)
  } finally {
    clearTimeout(timeoutTimer)
    if (pid !== undefined) {
      if (!groupStopRequested) stopGroup()
      if (hardKillTimer !== undefined && !processGroupExists(pid)) {
        clearTimeout(hardKillTimer)
        resolveHardKilled()
      }
      if (groupStopRequested) await hardKilled
      options.service?.processes.delete(pid)
    }
    if (!stdout.destroyed) stdout.destroy()
    if (!stderr.destroyed) stderr.destroy()
  }
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    timedOut
  }
}
export type VmProcessOptions = Pick<ProcessOptions, 'cwd' | 'env' | 'timeoutMs'>
export type VmProcessResult = ProcessResult

/** Bounded detached process-group runner used by the VM owner and its child-lifecycle tests. */
export function runVmProcessBounded(executable: string, args: string[], options: VmProcessOptions = {}): Promise<VmProcessResult> {
  return runBounded(executable, args, options)
}
function assertServiceActive(context: PluginContext, service: VmService): void {
  if (service.stopping) conflict(context, 'VM lifecycle was interrupted during worktree-plugin deactivation')
}

function trackServiceOperation<T>(service: VmService, work: () => Promise<T>): Promise<T> {
  if (service.stopping) return Promise.reject(new Error('VM service is deactivating'))
  const operation = work()
  const settled = operation.then(() => undefined, () => undefined)
  service.operations.add(settled)
  void settled.finally(() => service.operations.delete(settled))
  return operation
}

async function disposeVmService(service: VmService): Promise<void> {
  if (service.stopping) return
  service.stopping = true
  for (const pid of service.processes.keys()) signalProcessGroup(pid, 'SIGTERM')
  const exits = [...service.processes.values()].map((exited) => exited.then(() => undefined, () => undefined))
  if (exits.length > 0) await settlesWithin(Promise.all(exits), VM_KILL_GRACE_MS)
  for (const pid of service.processes.keys()) {
    if (processGroupExists(pid)) signalProcessGroup(pid, 'SIGKILL')
  }
  await Promise.all([...service.processes.values()].map((exited) => exited.then(() => undefined, () => undefined)))
  await Promise.all([...service.operations])
  const now = Date.now()
  service.store.run(
    `UPDATE vm_environments SET state = 'interrupted', operation_state = 'interrupted',
      error = CASE WHEN error IS NULL THEN 'Plugin deactivated while this VM lifecycle operation was in progress' ELSE error END,
      updated_at = ? WHERE operation_state = 'running' AND state IN (${ACTIVE_STATES.map(() => '?').join(', ')})`,
    now, ...ACTIVE_STATES
  )
}

function commandFailure(command: string, result: ProcessResult): string {
  if (result.timedOut) return `${command} exceeded its time limit and was terminated`
  const detail = result.stderr.trim().slice(0, 1000)
  return `${command} exited with status ${result.exitCode}${detail ? `: ${detail}` : ''}`
}
function recipeScriptFailure(kind: string, result: ProcessResult): string {
  return result.timedOut
    ? `${kind} script exceeded its time limit and its process group was terminated`
    : `${kind} script exited with status ${result.exitCode}`
}

function safeFailureMessage(error: unknown, secrets: string[] = []): string {
  let message = messageOf(error)
  for (const secret of secrets) {
    if (secret !== '') message = message.replaceAll(secret, '[redacted]')
  }
  return message.slice(0, 1000)
}

function parseLimaInstances(text: string): LimaInstance[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  let value: unknown
  try { value = JSON.parse(trimmed) as unknown } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean)
    try { value = lines.map((line) => JSON.parse(line) as unknown) } catch { throw new Error('limactl list --json returned malformed JSON') }
  }
  const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : null
  if (entries === null) throw new Error('limactl list --json returned an unexpected value')
  const instances: LimaInstance[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error('limactl list --all-fields --json returned an incomplete VM instance identity')
    const directory = typeof entry.dir === 'string' ? entry.dir : entry.Dir
    if (typeof entry.name !== 'string' || typeof entry.status !== 'string' ||
      typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new Error('limactl list --all-fields --json returned an incomplete VM instance identity')
    }
    instances.push({ name: entry.name, status: entry.status, dir: directory })
  }
  return instances
}

function backendStateFromStatus(status: string): VmBackendState {
  switch (status.trim().toLowerCase()) {
    case 'running': return 'running'
    case 'stopped': return 'stopped'
    case 'suspended':
    case 'paused': return 'suspended'
    default: return 'unknown'
  }
}

async function inspectLima(executable: string, service: VmService): Promise<{ version: string; instances: LimaInstance[] }> {
  const version = await runBounded(executable, ['--version'], { timeoutMs: VM_DOCTOR_TIMEOUT_MS, service })
  if (version.exitCode !== 0 || version.timedOut) throw new Error(commandFailure('limactl --version', version))
  const versionText = `${version.stdout}\n${version.stderr}`.trim()
  if (!/lima|limactl/i.test(versionText)) throw new Error('Configured executable did not identify itself as Lima/limactl')
  const listed = await runBounded(executable, ['list', '--all-fields', '--json'], { timeoutMs: VM_DOCTOR_TIMEOUT_MS, service })
  if (listed.exitCode !== 0 || listed.timedOut) throw new Error(commandFailure('limactl list --all-fields --json', listed))
  return { version: versionText.slice(0, 256), instances: parseLimaInstances(listed.stdout) }
}

async function limaDoctor(service: VmService): Promise<{ platform: string; supported: boolean; backend: { name: 'lima'; executable: string | null; requestedExecutable: string; available: boolean; version: string | null; error: string | null }; suspend: { semantics: string; ramPreserving: boolean } }> {
  const selected = selectLimaExecutable()
  const platform = process.platform
  let version: string | null = null
  let error = selected.error
  let available = false
  if (selected.executable !== null) {
    try {
      const info = await inspectLima(selected.executable, service)
      version = info.version
      available = true
      error = null
    } catch (cause) {
      error = messageOf(cause).slice(0, 1000)
    }
  }
  if (platform !== 'darwin') error = [error, 'Lima VM environments are supported only on macOS'].filter(Boolean).join('; ')
  return {
    platform,
    supported: platform === 'darwin' && available,
    backend: { name: 'lima', executable: selected.executable, requestedExecutable: selected.requested, available, version, error },
    suspend: { semantics: 'Recipe-defined; a Lima status of stopped means powered off, not RAM-preserving suspension.', ramPreserving: false }
  }
}

async function requireLima(context: PluginContext, service: VmService, executable?: string): Promise<{ executable: string; info: { version: string; instances: LimaInstance[] } }> {
  if (process.platform !== 'darwin') conflict(context, `Lima VM environments are supported only on macOS (current platform: ${process.platform})`)
  const selected = executable === undefined ? selectLimaExecutable() : { executable: executableSearch(executable), requested: executable, error: null }
  if (selected.executable === null) conflict(context, selected.error ?? `Saved Lima executable "${selected.requested}" is unavailable or not executable`)
  try { return { executable: selected.executable, info: await inspectLima(selected.executable, service) } } catch (error) {
    conflict(context, `Lima backend is unavailable: ${messageOf(error)}`)
  }
}

function limaInstanceNamed(instances: LimaInstance[], name: string): LimaInstance | null {
  const matches = instances.filter((instance) => instance.name === name)
  if (matches.length > 1) throw new Error(`limactl reports duplicate VM instance name "${name}"`)
  return matches[0] ?? null
}

function backendIdentity(context: PluginContext, instance: LimaInstance): VmBackendIdentity {
  let info: LimaDirectoryStats
  try {
    info = lstatSync(instance.dir, { bigint: true }) as unknown as LimaDirectoryStats
  } catch {
    conflict(context, `Lima instance directory for ${instance.name} is unavailable`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) conflict(context, `Lima instance directory for ${instance.name} is not a stable directory`)
  return {
    dir: resolve(instance.dir),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs.toString()
  }
}

function parseBackendIdentity(context: PluginContext, row: VmRow): VmBackendIdentity | null {
  if (row.backend_identity_json === null) return null
  let value: unknown
  try { value = JSON.parse(row.backend_identity_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt Lima instance identity`) }
  if (!isRecord(value) || typeof value.dir !== 'string' || !isAbsolute(value.dir) ||
    typeof value.dev !== 'string' || typeof value.ino !== 'string' || typeof value.birthtimeNs !== 'string') {
    conflict(context, `VM ${row.id} has an incomplete Lima instance identity`)
  }
  return { dir: value.dir, dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs }
}

function stateForVmRecord(context: PluginContext, store: PluginStore, row: VmRow, instances: LimaInstance[], pinIfMissing = false): VmBackendState {
  const instance = limaInstanceNamed(instances, row.instance_id)
  if (instance === null) return 'absent'
  const actual = backendIdentity(context, instance)
  const pinned = parseBackendIdentity(context, row)
  if (pinned === null) {
    if (!pinIfMissing) conflict(context, `VM ${row.id} has no pinned Lima instance identity; refusing lifecycle operations`)
    store.run('UPDATE vm_environments SET backend_identity_json = ?, backend_state = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(actual), backendStateFromStatus(instance.status), Date.now(), row.id)
  } else if (pinned.dir !== actual.dir || pinned.dev !== actual.dev || pinned.ino !== actual.ino || pinned.birthtimeNs !== actual.birthtimeNs) {
    conflict(context, `Lima instance ${row.instance_id} was deleted and recreated; refusing to target the replacement`)
  }
  return backendStateFromStatus(instance.status)
}

function parseCreateOutput(context: PluginContext, text: string, checkoutMode: VmCheckoutMode): VmCreateOutput {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { conflict(context, 'Trusted VM create script must write valid JSON to QUIRKY_VM_OUTPUT_PATH') }
  if (!isRecord(value) || typeof value.pairingCode !== 'string' || value.pairingCode.trim() === '' || value.pairingCode.length > MAX_CREATE_OUTPUT) {
    conflict(context, 'VM create result must contain a non-empty owner-cli pairingCode')
  }
  const allowed = checkoutMode === 'provisioned-root'
    ? ['pairingCode', 'workspaceSelector']
    : ['pairingCode', 'repo', 'name']
  if (Object.keys(value).some((key) => !allowed.includes(key))) conflict(context, 'VM create result contains unsupported fields')
  if (checkoutMode === 'provisioned-root') {
    const selector = value.workspaceSelector
    if (typeof selector !== 'string' || selector !== selector.trim() || selector.length > 256 || !/^(?:id:)?[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(selector)) {
      conflict(context, 'provisioned-root create result must contain an exact workspace ID in workspaceSelector')
    }
    return { pairingCode: value.pairingCode, workspaceSelector: selector }
  }
  const repo = value.repo
  const name = value.name
  if (typeof repo !== 'string' || repo.trim() === '' || repo !== repo.trim() || repo.length > 2048 || /[\u0000-\u001f\u007f]/.test(repo)) {
    conflict(context, 'orca-worktree create result must contain a non-empty guest repo selector')
  }
  if (typeof name !== 'string' || name.trim() === '' || name !== name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    conflict(context, 'orca-worktree create result must contain a non-empty guest worktree name')
  }
  return { pairingCode: value.pairingCode, repo, name }
}

function readPrivateOutput(context: PluginContext, path: string): string {
  let descriptor: number
  try { descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) } catch {
    conflict(context, 'Trusted VM create script did not write its private result file')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_CREATE_OUTPUT) conflict(context, `VM create result must be a regular file of at most ${MAX_CREATE_OUTPUT} bytes`)
    return readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
}

function createPrivateOutput(context: PluginContext, vmId: string, operationId: string): string {
  const directory = join(context.dataDir, 'vm-environments', vmId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const path = join(directory, `${operationId}.json`)
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function cleanPrivateOutput(path: string): void {
  rmSync(path, { force: true, recursive: true })
}
/** Removes credential-bearing result files left only by a process/daemon interruption. */
function cleanStalePrivateOutputs(context: PluginContext): void {
  let records: Dirent[]
  try { records = readdirSync(join(context.dataDir, 'vm-environments'), { withFileTypes: true }) } catch { return }
  for (const record of records) {
    if (!record.isDirectory()) continue
    const directory = join(context.dataDir, 'vm-environments', record.name)
    let files: Dirent[]
    try { files = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const file of files) {
      if (file.name.endsWith('.json') && (file.isFile() || file.isSymbolicLink())) {
        try { rmSync(join(directory, file.name), { force: true }) } catch {
          context.log('could not remove an interrupted private VM recipe result file')
        }
      }
    }
  }
}


/**
 * Preserves the current trusted-backend-first recipe PATH ordering.
 * @internal
 */
export function vmRecipeSearchPath(backendExecutable: string, inheritedPath: string | undefined): string {
  const executableDir = isAbsolute(backendExecutable) ? dirname(backendExecutable) : ''
  if (executableDir === '') return inheritedPath ?? ''
  return inheritedPath ? `${executableDir}${delimiter}${inheritedPath}` : executableDir
}

/** Environment passed to every trusted lifecycle script; the create result path is meaningful only during create. */
function scriptEnvironment(row: VmRow, operationId: string, outputPath: string): Record<string, string> {
  const snapshot = JSON.parse(row.recipe_json) as VmRecipeSnapshot
  return {
    PATH: vmRecipeSearchPath(row.backend_executable, process.env.PATH),
    QUIRKY_LIMACTL: row.backend_executable,
    QUIRKY_VM_BACKEND_EXECUTABLE: row.backend_executable,
    QUIRKY_VM_NAME: row.instance_id,
    QUIRKY_VM_OPERATION_ID: operationId,
    QUIRKY_VM_OUTPUT_PATH: outputPath,
    QUIRKY_VM_RECIPE_ID: row.recipe_id,
    QUIRKY_VM_CHECKOUT_MODE: snapshot.checkoutMode,
    QUIRKY_VM_REPO_ID: row.repo_id
  }
}

async function runRecipeScript(context: PluginContext, service: VmService, row: VmRow, script: string, operationId: string): Promise<void> {
  if (script.trim() === '') conflict(context, `VM recipe "${row.recipe_id}" does not configure this lifecycle script`)
  if (!isAbsolute(row.repo_path)) conflict(context, `VM ${row.id} has no absolute repository script directory`)
  try {
    if (!statSync(row.repo_path).isDirectory()) conflict(context, `VM recipe repository path is not a directory: ${row.repo_path}`)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== undefined) conflict(context, `VM recipe repository path is unavailable: ${row.repo_path}`)
    throw error
  }
  const outputPath = createPrivateOutput(context, row.id, operationId)
  try {
    const result = await runBounded('/bin/bash', ['-c', script], {
      cwd: row.repo_path,
      env: scriptEnvironment(row, operationId, outputPath),
      timeoutMs: VM_TIMEOUT_MS,
      service
    })
    if (result.exitCode !== 0 || result.timedOut) conflict(context, recipeScriptFailure(`VM ${row.operation_kind}`, result))
  } finally { cleanPrivateOutput(outputPath) }
}

async function runGuestIdentity(context: PluginContext, service: VmService, executable: string, instanceId: string): Promise<OwnerHostIdentity> {
  const result = await runBounded(executable, [
    'shell', instanceId, '--', 'quirky', 'api', 'call', 'quirky.cli/hostIdentity', '--json'
  ], { timeoutMs: VM_DOCTOR_TIMEOUT_MS, service })
  if (result.exitCode !== 0 || result.timedOut) conflict(context, commandFailure('Lima guest hostIdentity request', result))
  try { return parseIdentity(JSON.parse(result.stdout.trim()) as unknown, 'Lima guest', context) } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== undefined) throw error
    conflict(context, 'Lima guest hostIdentity command returned malformed JSON')
  }
}

async function ownerIdentity(context: VmContext, service: VmService, runtime: VmSavedRuntimeIdentity, expectedHost?: OwnerHostIdentity): Promise<OwnerHostIdentity> {
  assertServiceActive(context, service)
  let response: unknown
  try {
    response = await context.call('quirky.cli/runtimeCall', {
      runtime: runtime.id,
      method: 'quirky.cli/hostIdentity',
      expectedRuntime: { id: runtime.id, endpoint: runtime.endpoint, grantId: runtime.grantId },
      ...(expectedHost === undefined ? {} : { expectedHost })
    })
  } catch (error) { conflict(context, `Saved VM owner runtime is unavailable: ${messageOf(error)}`) }
  assertServiceActive(context, service)
  if (!isRecord(response)) conflict(context, 'Saved VM owner runtime returned an invalid host identity response')
  const result = (response as OwnerRuntimeCallResult).result
  return parseIdentity(result, 'Saved VM owner endpoint', context)
}

function validateHost(context: PluginContext, host: unknown, runtimeId: string): RegisteredOwnerHost {
  if (!isRecord(host) || typeof host.id !== 'string' || host.id.trim() === '' || typeof host.connected !== 'boolean' ||
    !isRecord(host.runtime) || host.runtime.id !== runtimeId) conflict(context, 'VM owner host registration returned an invalid host record')
  const identity = parseIdentity(host.identity, 'VM owner registration', context)
  if (!host.connected) conflict(context, `VM guest owner host is disconnected${typeof host.error === 'string' ? `: ${host.error}` : ''}`)
  return host as unknown as RegisteredOwnerHost & { identity: OwnerHostIdentity }
}

function validateOfflineHostStatus(context: PluginContext, row: VmRow, value: unknown): RegisteredOwnerHost {
  if (row.host_id === null) conflict(context, `VM ${row.id} has no registered owner host`)
  const runtime = parseSavedRuntimeIdentity(context, row)
  const identity = parseStoredIdentity(context, row)
  if (!runtime || !identity || !isRecord(value) || value.id !== row.host_id || value.connected !== false ||
    !isRecord(value.runtime) || value.runtime.id !== runtime.id || value.runtime.name !== runtime.name ||
    value.runtime.endpoint !== runtime.endpoint || value.runtime.grantId !== runtime.grantId) {
    conflict(context, "Offline guest host status no longer matches this VM's pinned runtime and owner identity")
  }
  if (!sameIdentity(parseIdentity(value.identity, 'Offline guest host status', context), identity)) {
    conflict(context, 'Offline guest host generation changed; refusing to refresh a stale VM attachment')
  }
  return value as unknown as RegisteredOwnerHost
}

function validateMirror(context: PluginContext, value: unknown, host: RegisteredOwnerHost, expectedWorktree?: { id: string; instanceId: string }): VmRemoteWorkspace {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '' || value.hostId !== host.id ||
    typeof value.connected !== 'boolean' || typeof value.fingerprint !== 'string' || !isRecord(value.worktree)) {
    conflict(context, 'Guest workspace attachment returned an invalid remote mirror')
  }
  const worktree = value.worktree as unknown as Worktree
  if (typeof worktree.id !== 'string' || worktree.id.trim() === '' || typeof worktree.instanceId !== 'string' || worktree.instanceId.trim() === '') {
    conflict(context, 'Guest workspace attachment did not identify an exact workspace instance')
  }
  if (expectedWorktree !== undefined && (worktree.id !== expectedWorktree.id || worktree.instanceId !== expectedWorktree.instanceId)) {
    conflict(context, 'Guest workspace attachment selected a different workspace instance than the canonical create result')
  }
  const identity = parseIdentity(value.identity, 'Guest workspace mirror', context)
  if (!sameIdentity(identity, host.identity)) conflict(context, 'Guest workspace mirror host generation does not match the registered guest')
  if (value.connected !== true) conflict(context, 'Guest workspace mirror is disconnected; refusing to report VM attachment success')
  return { id: value.id, hostId: host.id, identity, worktree, connected: true, fingerprint: value.fingerprint }
}

function parseRuntimeIdentity(context: PluginContext, value: unknown, label: string): VmSavedRuntimeIdentity {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '' ||
    typeof value.name !== 'string' || value.name.trim() === '' || typeof value.endpoint !== 'string' || value.endpoint.trim() === '' ||
    typeof value.pairedDeviceId !== 'string' || value.pairedDeviceId.trim() === '' || value.scope !== 'owner-cli' ||
    typeof value.grantId !== 'string' || value.grantId.trim() === '' || value.grantId !== value.pairedDeviceId) {
    conflict(context, `${label} is not the exact saved owner-cli grant created for this VM`)
  }
  return {
    id: value.id,
    name: value.name,
    endpoint: value.endpoint,
    pairedDeviceId: value.pairedDeviceId,
    scope: 'owner-cli',
    grantId: value.grantId
  }
}

function validateRuntime(context: PluginContext, value: unknown): VmSavedRuntimeIdentity {
  return parseRuntimeIdentity(context, value, 'Guest pairing result')
}

function parseSavedRuntimeIdentity(context: PluginContext, row: VmRow): VmSavedRuntimeIdentity | null {
  if (row.runtime_identity_json === null) return null
  let value: unknown
  try { value = JSON.parse(row.runtime_identity_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt saved runtime identity`) }
  const identity = parseRuntimeIdentity(context, value, `VM ${row.id} saved runtime identity`)
  if (row.runtime_id !== identity.id) conflict(context, `VM ${row.id} saved runtime grant does not match its exact runtime ID`)
  return identity
}

function sameRuntimeIdentity(left: VmSavedRuntimeIdentity, right: VmSavedRuntimeIdentity): boolean {
  return left.id === right.id && left.name === right.name && left.endpoint === right.endpoint &&
    left.pairedDeviceId === right.pairedDeviceId && left.scope === right.scope && left.grantId === right.grantId
}

async function repoDetails(context: VmContext, repoSelector: string): Promise<RepoDetails> {
  let value: unknown
  try { value = await context.call('quirky.repo/show', { repo: repoSelector }) } catch (error) {
    conflict(context, `Could not read repository environment recipes: ${messageOf(error)}`)
  }
  if (!isRecord(value) || !isRecord(value.repo) || !isRecord(value.hooks)) conflict(context, 'Repository show returned an invalid recipe configuration')
  const repo = value.repo as unknown as Repo
  if (typeof repo.id !== 'string' || typeof repo.name !== 'string' || typeof repo.path !== 'string') conflict(context, 'Repository show did not return an exact repository path')
  if (repo.kind !== 'git') conflict(context, 'VM environment recipes require a Git repository')
  return value as unknown as RepoDetails
}

function configuredRecipes(context: PluginContext, details: RepoDetails): VmEnvironmentRecipe[] {
  const recipes = details.hooks.environmentRecipes ?? []
  if (!Array.isArray(recipes)) conflict(context, 'Repository environmentRecipes is not a valid list')
  return recipes.filter((recipe) => isRecord(recipe) && typeof recipe.id === 'string' && RECIPE_ID_RE.test(recipe.id) &&
    typeof recipe.name === 'string' && recipe.name.trim() !== '' && typeof recipe.create === 'string' && recipe.create.trim() !== '')
}

function selectRecipe(context: PluginContext, details: RepoDetails, recipeId: string): VmEnvironmentRecipe {
  const recipe = configuredRecipes(context, details).find((candidate) => candidate.id === recipeId)
  if (recipe) return recipe
  const diagnostics = details.hooks.environmentRecipeDiagnostics ?? []
  const detail = diagnostics.map((diagnostic) => diagnostic.message).filter((text) => typeof text === 'string').join(' ')
  conflict(context, `VM recipe "${recipeId}" is not a valid configured environment recipe${detail ? `: ${detail}` : ''}`)
}

const GUEST_CREATE_KEYS: Record<string, true> = {
  branch: true, branchName: true, base: true, github: true, issueCommand: true, trustIssueCommand: true,
  trustIssueCommandHash: true, displayName: true, comment: true, parent: true, noParent: true, setup: true,
  trustSetup: true, trustSetupHash: true, agent: true, prompt: true, model: true, options: true, sparsePaths: true,
  keepMain: true, defaultTabs: true, submitPrompt: true, allowLocalBaseFallback: true
}

function validateCreateParams(context: PluginContext, params: Record<string, unknown>): VmCreateParams {
  const repo = stringParam(context, params, 'repo')!
  const recipe = stringParam(context, params, 'recipe', { max: 64 })!
  if (!RECIPE_ID_RE.test(recipe)) invalid(context, 'recipe must be a valid configured environment recipe ID')
  const trustHash = stringParam(context, params, 'trustHash', { max: 64 })!
  if (!/^[0-9a-f]{64}$/.test(trustHash)) invalid(context, 'trustHash must be a lowercase SHA-256 recipe hash')
  const name = stringParam(context, params, 'name', { optional: true, max: 200 })
  let createParams: VmGuestCreateParams | undefined
  if (params.createParams !== undefined) {
    if (!isRecord(params.createParams)) invalid(context, 'createParams must be an object of canonical guest worktree-create options')
    if (Object.keys(params.createParams).some((key) => !Object.hasOwn(GUEST_CREATE_KEYS, key))) invalid(context, 'createParams contains a field that is not supported by canonical guest worktree creation')
    try { createParams = JSON.parse(JSON.stringify(params.createParams)) as VmGuestCreateParams } catch { invalid(context, 'createParams must contain only JSON values') }
  }
  return { repo, recipe, trustHash, ...(name === undefined ? {} : { name }), ...(createParams === undefined ? {} : { createParams }) }
}

function generatedInstanceId(): string {
  return `quirky-${randomUUID().replaceAll('-', '')}`
}

function insertCreatingRecord(store: PluginStore, repo: Repo, recipe: VmRecipeSnapshot, recipeHash: string, executable: string): VmRow {
  const id = randomUUID()
  const instanceId = generatedInstanceId()
  const operationId = randomUUID()
  const runtimeName = `Quirky VM ${instanceId}`
  const now = Date.now()
  store.run(
    `INSERT INTO vm_environments (
      id, repo_id, repo_name, repo_path, recipe_id, recipe_name, recipe_hash, recipe_json,
      instance_id, backend_executable, state, backend_state, operation_id, operation_kind,
      operation_state, operation_started_at, operation_updated_at, error, runtime_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', 'unknown', ?, 'create', 'running', ?, ?, NULL, ?, ?, ?)`,
    id, repo.id, repo.name, resolve(repo.path), recipe.id, recipe.name, recipeHash, JSON.stringify(recipe),
    instanceId, executable, operationId, now, now, runtimeName, now, now
  )
  return rowById(store, id)!
}


function expectedInstance(context: PluginContext, params: Record<string, unknown>): { id: string; instanceId: string } {
  const id = stringParam(context, params, 'vm', { max: 64 })!
  const instanceId = stringParam(context, params, 'instanceId', { max: 128 })!
  return { id, instanceId }
}

function assertInstance(context: PluginContext, row: VmRow, expected: string): void {
  if (row.instance_id !== expected) conflict(context, `Stale VM instance fence for ${row.id}; expected the exact current instanceId`)
}
function assertNoInFlightLifecycle(context: PluginContext, row: VmRow): void {
  if (row.operation_state === 'running') {
    conflict(context, `VM ${row.id} is already performing ${row.operation_kind} operation ${row.operation_id} (${row.state}); inspect vmShow before retrying`)
  }
}

function lockFor(locks: Map<string, Promise<unknown>>, id: string, work: () => Promise<unknown>): Promise<unknown> {
  const previous = locks.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  locks.set(id, next)
  void next.finally(() => { if (locks.get(id) === next) locks.delete(id) }).catch(() => undefined)
  return next
}

async function backendState(context: PluginContext, service: VmService, store: PluginStore, row: VmRow, pinIfMissing = false): Promise<VmBackendState> {
  const { info } = await requireLima(context, service, row.backend_executable)
  return stateForVmRecord(context, store, row, info.instances, pinIfMissing)
}

function mirrorForWorkspace(context: PluginContext, row: VmRow, workspaces: unknown, expectedIdentity: OwnerHostIdentity, expectedConnected: boolean): VmRemoteWorkspace {
  if (!Array.isArray(workspaces)) conflict(context, 'Remote workspace read returned an invalid workspace list')
  const previous = parseMirror(context, row)
  if (!previous) conflict(context, `VM ${row.id} has no saved guest workspace to refresh`)
  const value = workspaces.find((entry) => isRecord(entry) && entry.id === previous.id && entry.hostId === previous.hostId)
  if (!isRecord(value) || !isRecord(value.worktree)) conflict(context, 'Remote workspace read no longer contains this exact VM mirror')
  const worktree = value.worktree as unknown as Worktree
  if (worktree.id !== row.worktree_id || worktree.instanceId !== row.worktree_instance_id) conflict(context, 'Remote workspace read found a replacement instance; refusing to retarget this VM')
  const identity = parseIdentity(value.identity, 'Remote workspace read', context)
  if (!sameIdentity(identity, expectedIdentity)) conflict(context, 'Remote workspace read has a stale or replaced owner generation')
  if (value.connected !== expectedConnected) conflict(context, expectedConnected
    ? 'Guest owner read did not confirm the exact workspace is connected'
    : 'Guest owner status still reports an attachment connected after the Lima VM stopped')
  if (typeof value.fingerprint !== 'string') conflict(context, 'Remote workspace read omitted its fingerprint')
  return { id: previous.id, hostId: previous.hostId, identity, worktree, connected: value.connected, fingerprint: value.fingerprint }
}


type VmWorkspaceOrigin = {
  hostId: string
  identity: Pick<OwnerHostIdentity, 'hostId' | 'generation'>
  worktree: { id: string; instanceId: string }
}

/** Checks historical origin only (stable host, workspace and instance; not generation). It never authorizes a current owner operation; authenticate the current endpoint and generation separately. */
export function matchesRetainedVmWorkspaceOrigin(retained: VmWorkspaceOrigin, current: VmWorkspaceOrigin): boolean {
  return retained.hostId === current.hostId &&
    retained.identity.hostId === current.identity.hostId &&
    retained.worktree.id === current.worktree.id &&
    retained.worktree.instanceId === current.worktree.instanceId
}


async function refreshStoppedMirror(context: VmContext, service: VmService, row: VmRow): Promise<VmRemoteWorkspace> {
  if (row.host_id === null) conflict(context, `VM ${row.id} has no registered owner host to refresh`)
  const identity = parseStoredIdentity(context, row)
  if (!identity) conflict(context, `VM ${row.id} has no saved owner host identity`)
  assertServiceActive(context, service)
  const statusValue = await context.call('quirky.worktree/remoteHostStatus', { host: row.host_id })
  assertServiceActive(context, service)
  const host = validateOfflineHostStatus(context, row, statusValue)
  const listed = await context.call('quirky.worktree/remoteList', { host: host.id })
  assertServiceActive(context, service)
  const workspaces = isRecord(listed) ? listed.workspaces : undefined
  return mirrorForWorkspace(context, row, workspaces, identity, false)
}

type AttachedWorkspace = { mirror: VmRemoteWorkspace; worktreeId: string; worktreeInstanceId: string; guestCreateResult: WorktreeCreateResult | null }

function attachmentRequestForCreate(context: PluginContext, checkoutMode: VmCheckoutMode, output: VmCreateOutput, input: VmCreateParams): VmAttachmentRequest {
  if (checkoutMode === 'provisioned-root') {
    if (!('workspaceSelector' in output)) conflict(context, 'provisioned-root recipe returned canonical-create fields instead of a workspace selector')
    if (input.name !== undefined || Object.keys(input.createParams ?? {}).length > 0) {
      conflict(context, 'provisioned-root recipes attach an existing guest workspace and do not accept canonical worktree-create choices')
    }
    return { checkoutMode, workspaceSelector: output.workspaceSelector }
  }
  if (!('repo' in output)) conflict(context, 'orca-worktree recipe returned an attachment selector instead of repo/name')
  return { checkoutMode, repo: output.repo, name: input.name ?? output.name, createParams: input.createParams ?? {} }
}

function parseAttachmentRequest(context: PluginContext, row: VmRow): VmAttachmentRequest {
  if (row.attachment_request_json === null) conflict(context, `VM ${row.id} has no saved workspace attachment request`)
  let value: unknown
  try { value = JSON.parse(row.attachment_request_json) as unknown } catch { conflict(context, `VM ${row.id} has a corrupt workspace attachment request`) }
  if (!isRecord(value)) conflict(context, `VM ${row.id} has a corrupt workspace attachment request`)
  if (value.checkoutMode === 'provisioned-root' && typeof value.workspaceSelector === 'string' && value.workspaceSelector.trim() !== '') {
    return { checkoutMode: 'provisioned-root', workspaceSelector: value.workspaceSelector }
  }
  if (value.checkoutMode === 'orca-worktree' && typeof value.repo === 'string' && value.repo.trim() !== '' &&
    typeof value.name === 'string' && value.name.trim() !== '' && isRecord(value.createParams)) {
    return { checkoutMode: 'orca-worktree', repo: value.repo, name: value.name, createParams: value.createParams }
  }
  conflict(context, `VM ${row.id} has an incomplete workspace attachment request`)
}

function validateGuestCreateResult(context: PluginContext, value: unknown): WorktreeCreateResult {
  if (!isRecord(value) || !isRecord(value.worktree) || typeof value.worktree.id !== 'string' ||
    typeof value.worktree.instanceId !== 'string' || !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === 'string') || !isRecord(value.setup) ||
    !['terminal', 'daemon', 'none', 'skipped'].includes(String(value.setup.ran))) {
    conflict(context, 'Canonical guest worktree create returned an incomplete WorktreeCreateResult')
  }
  return value as unknown as WorktreeCreateResult
}

async function showGuestWorktree(context: VmContext, service: VmService, row: VmRow, host: RegisteredOwnerHost, selector: string): Promise<{ id: string; instanceId: string }> {
  if (row.runtime_id === null) conflict(context, `VM ${row.id} has no saved owner runtime to inspect the provisioned workspace`)
  const runtime = parseSavedRuntimeIdentity(context, row)
  if (!runtime) conflict(context, `VM ${row.id} has no saved owner grant identity`)
  assertServiceActive(context, service)
  const response = await context.call('quirky.cli/runtimeCall', {
    runtime: runtime.id,
    method: 'quirky.worktree/show',
    params: { worktree: selector },
    expectedRuntime: { id: runtime.id, endpoint: runtime.endpoint, grantId: runtime.grantId },
    expectedHost: host.identity
  })
  assertServiceActive(context, service)
  if (!isRecord(response) || !isRecord(response.result) || typeof response.result.id !== 'string' ||
    typeof response.result.instanceId !== 'string' || response.result.instanceId.trim() === '') {
    conflict(context, 'Guest worktree show did not return an exact workspace instance')
  }
  const expectedId = selector.startsWith('id:') ? selector.slice(3) : selector
  if (response.result.id !== expectedId) conflict(context, 'Guest worktree show resolved a different workspace ID than the trusted recipe selector')
  return { id: response.result.id, instanceId: response.result.instanceId }
}

async function attachCreatedWorkspace(context: VmContext, store: PluginStore, service: VmService, row: VmRow, host: RegisteredOwnerHost, request: VmAttachmentRequest): Promise<AttachedWorkspace> {
  if (request.checkoutMode === 'provisioned-root') {
    const shown = await showGuestWorktree(context, service, row, host, request.workspaceSelector)
    if (row.worktree_id !== null && (row.worktree_id !== shown.id || row.worktree_instance_id !== shown.instanceId)) {
      conflict(context, 'Provisioned guest workspace instance changed before attachment; refusing to retarget it')
    }
    if (row.worktree_id === null) {
      store.run('UPDATE vm_environments SET worktree_id = ?, worktree_instance_id = ?, updated_at = ? WHERE id = ?',
        shown.id, shown.instanceId, Date.now(), row.id)
    }
    const attached = await context.call('quirky.worktree/remoteAttach', { host: host.id, worktree: shown.id })
    assertServiceActive(context, service)
    const mirror = validateMirror(context, attached, host, shown)
    return { mirror, worktreeId: shown.id, worktreeInstanceId: shown.instanceId, guestCreateResult: null }
  }

  let current = row
  if (current.worktree_id === null) {
    if (current.canonical_create_state === 'started') {
      conflict(context, `Canonical guest create for VM ${current.id} has an ambiguous response; refusing to replay it. Destroy this exact VM or inspect the guest first.`)
    }
    if (current.runtime_id === null) conflict(context, `VM ${current.id} has no saved owner runtime for canonical guest worktree creation`)
    const runtime = parseSavedRuntimeIdentity(context, current)
    if (!runtime) conflict(context, `VM ${current.id} has no saved owner grant identity`)
    store.run("UPDATE vm_environments SET canonical_create_state = 'started', updated_at = ? WHERE id = ?", Date.now(), current.id)
    const canonical = await context.call('quirky.cli/runtimeCall', {
      runtime: runtime.id,
      method: 'quirky.worktree/create',
      params: { ...request.createParams, repo: request.repo, name: request.name, requireGitRepository: true },
      expectedRuntime: { id: runtime.id, endpoint: runtime.endpoint, grantId: runtime.grantId },
      expectedHost: host.identity
    })
    assertServiceActive(context, service)
    if (!isRecord(canonical)) conflict(context, 'Canonical guest worktree create returned an invalid owner-call result')
    const guestCreateResult = validateGuestCreateResult(context, canonical.result)
    store.run(
      `UPDATE vm_environments SET canonical_create_state = 'created', guest_create_json = ?, worktree_id = ?,
        worktree_instance_id = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(guestCreateResult), guestCreateResult.worktree.id, guestCreateResult.worktree.instanceId, Date.now(), current.id
    )
    current = rowById(store, current.id)!
  } else if (current.canonical_create_state !== 'created' || current.worktree_instance_id === null) {
    conflict(context, `VM ${current.id} has an incomplete canonical guest workspace identity`)
  }
  const expectedWorktree = { id: current.worktree_id!, instanceId: current.worktree_instance_id! }
  const attached = await context.call('quirky.worktree/remoteAttach', { host: host.id, worktree: expectedWorktree.id })
  assertServiceActive(context, service)
  const mirror = validateMirror(context, attached, host, expectedWorktree)
  const guestCreateResult = parseGuestCreateResult(context, current)
  return { mirror, worktreeId: expectedWorktree.id, worktreeInstanceId: expectedWorktree.instanceId, guestCreateResult }
}


async function vmCreate(context: VmContext, store: PluginStore, service: VmService, params: Record<string, unknown>): Promise<VmEnvironment> {
  assertServiceActive(context, service)
  const input = validateCreateParams(context, params)
  const details = await repoDetails(context, input.repo)
  assertServiceActive(context, service)
  const configured = selectRecipe(context, details, input.recipe)
  const recipe = normalizedRecipe(configured)
  const trustHash = environmentRecipeHash(configured)
  if (input.trustHash !== trustHash) conflict(context, `VM recipe "${recipe.name}" lifecycle scripts are not trusted at this exact hash; pass trustHash ${trustHash}`)
  if (recipe.checkoutMode === 'provisioned-root' && (input.name !== undefined || Object.keys(input.createParams ?? {}).length > 0)) {
    conflict(context, 'provisioned-root recipes attach an existing guest workspace and cannot accept canonical guest worktree-create choices')
  }
  if (!isAbsolute(details.repo.path)) conflict(context, 'VM recipe repository must have an absolute local source path')
  try {
    if (!statSync(details.repo.path).isDirectory()) conflict(context, 'VM recipe repository path is not a directory')
  } catch {
    conflict(context, 'VM recipe repository path is unavailable')
  }

  const selected = selectLimaExecutable()
  const row = insertCreatingRecord(store, details.repo, recipe, trustHash, selected.executable ?? selected.requested)
  const operationId = row.operation_id
  let outputPath: string | undefined
  let pairingCode: string | null = null
  let createScriptReturned = false
  try {
    const { executable, info } = await requireLima(context, service, selected.executable ?? undefined)
    assertServiceActive(context, service)
    if (limaInstanceNamed(info.instances, row.instance_id) !== null) {
      conflict(context, `Generated Lima VM name ${row.instance_id} already exists; refusing to use an existing instance`)
    }
    store.run('UPDATE vm_environments SET backend_executable = ? WHERE id = ?', executable, row.id)
    let current = rowById(store, row.id)!
    outputPath = createPrivateOutput(context, row.id, operationId)
    const result = await runBounded('/bin/bash', ['-c', recipe.create], {
      cwd: current.repo_path,
      env: {
        ...scriptEnvironment(current, operationId, outputPath),
        ...(input.name === undefined ? {} : { QUIRKY_VM_WORKSPACE_NAME: input.name })
      },
      timeoutMs: VM_TIMEOUT_MS,
      service
    })
    createScriptReturned = true
    assertServiceActive(context, service)
    if (result.exitCode !== 0 || result.timedOut) conflict(context, recipeScriptFailure('VM create', result))
    const output = parseCreateOutput(context, readPrivateOutput(context, outputPath), recipe.checkoutMode)
    pairingCode = output.pairingCode
    const attachment = attachmentRequestForCreate(context, recipe.checkoutMode, output, input)
    store.run('UPDATE vm_environments SET attachment_request_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(attachment), Date.now(), row.id)
    const actual = await backendState(context, service, store, current, true)
    assertServiceActive(context, service)
    if (actual !== 'running') conflict(context, `VM create script completed but Lima reports ${actual}, not running`)

    const runtimeValue = await context.call('quirky.cli/runtimeAdd', { name: current.runtime_name, pairingCode: output.pairingCode })
    assertServiceActive(context, service)
    const runtime = validateRuntime(context, runtimeValue)
    if (runtime.name !== current.runtime_name) conflict(context, 'Saved owner runtime name did not match this generated VM target')
    store.run('UPDATE vm_environments SET runtime_id = ?, runtime_identity_json = ?, updated_at = ? WHERE id = ?',
      runtime.id, JSON.stringify(runtime), Date.now(), row.id)
    cleanPrivateOutput(outputPath)
    outputPath = undefined

    current = rowById(store, row.id)!
    const hostValue = await context.call('quirky.worktree/remoteHostRegister', { runtime: runtime.id })
    assertServiceActive(context, service)
    const host = validateHost(context, hostValue, runtime.id)
    const duplicate = store.get<{ id: string }>(
      "SELECT id FROM vm_environments WHERE id <> ? AND host_id = ? AND state <> 'destroyed' LIMIT 1",
      row.id, host.id
    )
    if (duplicate) conflict(context, `Guest host ${host.id} is already owned by VM record ${duplicate.id}`)
    store.run('UPDATE vm_environments SET host_id = ?, host_identity_json = ?, updated_at = ? WHERE id = ?', host.id, JSON.stringify(host.identity), Date.now(), row.id)
    current = rowById(store, row.id)!
    const guestIdentity = await runGuestIdentity(context, service, executable, row.instance_id)
    assertServiceActive(context, service)
    const endpointIdentity = await ownerIdentity(context, service, runtime, host.identity)
    if (!sameIdentity(guestIdentity, host.identity) || !sameIdentity(endpointIdentity, host.identity)) {
      conflict(context, 'Lima guest hostIdentity does not match the authenticated saved owner endpoint; refusing workspace attachment')
    }
    const request = parseAttachmentRequest(context, current)
    const attached = await attachCreatedWorkspace(context, store, service, current, host, request)
    assertServiceActive(context, service)
    store.run('UPDATE vm_environments SET mirror_json = ?, worktree_id = ?, worktree_instance_id = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(attached.mirror), attached.worktreeId, attached.worktreeInstanceId, Date.now(), row.id)
    const final = rowById(store, row.id)!
    finishOperation(store, final, 'running', 'running', attached.mirror)
    return publicVm(context, rowById(store, row.id)!)
  } catch (error) {
    let actual: VmBackendState = 'unknown'
    try { actual = await backendState(context, service, store, rowById(store, row.id)!, createScriptReturned) } catch { /* preserve unknown if Lima cannot prove state */ }
    const message = safeFailureMessage(error, pairingCode === null ? [] : [pairingCode])
    failOperation(service, store, rowById(store, row.id)!, actual, message)
    return conflict(context, `VM creation failed; durable record ${row.id} remains ${actual}. Inspect vmShow; vmResume requires a verifiable owner binding, and vmDestroy refuses unpinned or replaced Lima instances. ${message}`)
  } finally {
    if (outputPath !== undefined) cleanPrivateOutput(outputPath)
  }
}

async function reconcileGuestAfterResume(context: VmContext, store: PluginStore, service: VmService, row: VmRow): Promise<{ host: RegisteredOwnerHost; mirror: VmRemoteWorkspace; identity: OwnerHostIdentity }> {
  const runtime = parseSavedRuntimeIdentity(context, row)
  if (!runtime) conflict(context, `VM ${row.id} has no saved owner runtime to recover`)
  const priorIdentity = parseStoredIdentity(context, row)
  const endpointIdentity = await ownerIdentity(context, service, runtime)
  const guestIdentity = await runGuestIdentity(context, service, row.backend_executable, row.instance_id)
  if (!sameIdentity(endpointIdentity, guestIdentity) || (priorIdentity !== null && endpointIdentity.hostId !== priorIdentity.hostId)) {
    conflict(context, 'Resumed Lima guest hostIdentity does not match the pinned authenticated owner endpoint')
  }
  const value = await context.call('quirky.worktree/remoteHostRegister', { runtime: runtime.id, replace: true })
  assertServiceActive(context, service)
  const host = validateHost(context, value, runtime.id)
  if ((row.host_id !== null && host.id !== row.host_id) || host.identity.hostId !== endpointIdentity.hostId ||
    !sameIdentity(host.identity, endpointIdentity)) {
    conflict(context, 'Explicit owner re-registration did not preserve the exact VM guest identity')
  }
  const duplicate = store.get<{ id: string }>(
    "SELECT id FROM vm_environments WHERE id <> ? AND host_id = ? AND state <> 'destroyed' LIMIT 1",
    row.id, host.id
  )
  if (duplicate) conflict(context, `Guest host ${host.id} is also bound to VM record ${duplicate.id}`)
  store.run('UPDATE vm_environments SET host_id = ?, host_identity_json = ?, updated_at = ? WHERE id = ?',
    host.id, JSON.stringify(host.identity), Date.now(), row.id)
  const current = rowById(store, row.id)!
  let mirror: VmRemoteWorkspace
  if (current.mirror_json !== null) {
    const previous = parseMirror(context, current)
    const savedIdentity = parseStoredIdentity(context, current)
    if (!previous || !savedIdentity || !sameIdentity(savedIdentity, host.identity) ||
      current.worktree_id === null || current.worktree_instance_id === null ||
      !matchesRetainedVmWorkspaceOrigin(previous, {
        hostId: host.id,
        identity: host.identity,
        worktree: { id: current.worktree_id, instanceId: current.worktree_instance_id }
      })) {
      conflict(context, 'Saved VM mirror no longer identifies this exact host and workspace origin')
    }
    const attached = await context.call('quirky.worktree/remoteAttach', { host: host.id, worktree: current.worktree_id })
    assertServiceActive(context, service)
    mirror = validateMirror(context, attached, host, { id: current.worktree_id, instanceId: current.worktree_instance_id })
  } else {
    const request = parseAttachmentRequest(context, current)
    const attached = await attachCreatedWorkspace(context, store, service, current, host, request)
    mirror = attached.mirror
    store.run('UPDATE vm_environments SET worktree_id = ?, worktree_instance_id = ?, updated_at = ? WHERE id = ?',
      attached.worktreeId, attached.worktreeInstanceId, Date.now(), row.id)
  }
  assertServiceActive(context, service)
  store.run('UPDATE vm_environments SET mirror_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(mirror), Date.now(), row.id)
  return { host, mirror, identity: host.identity }
}

function ensureDestroyEnabled(context: PluginContext, row: VmRow): VmRecipeSnapshot {
  const recipe = recipeFromRow(context, row)
  if (recipe.destroyDisabled || recipe.destroy === null || recipe.destroy.trim() === '') {
    conflict(context, `VM recipe "${recipe.name}" disables or does not configure destroy; refusing to remove this VM`)
  }
  return recipe
}

async function remoteRetire(context: VmContext, store: PluginStore, service: VmService, row: VmRow): Promise<void> {
  if (row.host_id !== null && row.host_forgotten === 0) {
    const other = store.get<{ id: string }>("SELECT id FROM vm_environments WHERE id <> ? AND host_id = ? AND state <> 'destroyed' LIMIT 1", row.id, row.host_id)
    if (other) conflict(context, `Host registration ${row.host_id} is also bound to VM ${other.id}; refusing to forget a shared guest host`)
    const expectedHost = parseStoredIdentity(context, row)
    const expectedRuntime = parseSavedRuntimeIdentity(context, row)
    if (!expectedHost || !expectedRuntime) conflict(context, `VM ${row.id} has no complete pinned host/runtime identity for retirement`)
    assertServiceActive(context, service)
    const listing = await context.call('quirky.worktree/remoteHostList', {})
    assertServiceActive(context, service)
    if (!isRecord(listing) || !Array.isArray(listing.hosts)) conflict(context, 'Registered host list returned an invalid result during VM retirement')
    let exactHost: unknown
    let exactMatches = 0
    let runtimeMatches = 0
    for (const value of listing.hosts) {
      if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '' || !isRecord(value.runtime) ||
        typeof value.runtime.id !== 'string' || value.runtime.id.trim() === '' ||
        typeof value.runtime.name !== 'string' || value.runtime.name.trim() === '' ||
        typeof value.runtime.endpoint !== 'string' || value.runtime.endpoint.trim() === '' ||
        typeof value.runtime.grantId !== 'string' || value.runtime.grantId.trim() === '' ||
        typeof value.connected !== 'boolean' || (value.error !== null && typeof value.error !== 'string') ||
        typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
        conflict(context, 'Registered host list contains a malformed host entry; refusing VM credential cleanup')
      }
      parseIdentity(value.identity, 'Registered host list entry', context)
      if (value.id === row.host_id) {
        exactHost = value
        exactMatches += 1
      }
      if (value.runtime.id === expectedRuntime.id) runtimeMatches += 1
    }
    if (exactMatches > 1 || runtimeMatches > 1) conflict(context, 'Registered host list contains duplicate VM host/runtime registrations')
    if (exactMatches === 0 && runtimeMatches > 0) {
      conflict(context, 'The VM runtime is registered under a replacement host ID; refusing to forget the replacement')
    }
    if (exactMatches === 1) {
      const host = validateOfflineHostStatus(context, row, exactHost)
      await context.call('quirky.worktree/remoteHostForget', {
        host: host.id,
        detach: true,
        confirmed: true,
        yes: true,
        expectedHost,
        expectedRuntime: { id: expectedRuntime.id, endpoint: expectedRuntime.endpoint, grantId: expectedRuntime.grantId }
      })
      assertServiceActive(context, service)
    }
    store.run('UPDATE vm_environments SET host_forgotten = 1, mirror_json = NULL, updated_at = ? WHERE id = ?', Date.now(), row.id)
  }
  const current = rowById(store, row.id)!
  if (current.runtime_id !== null && current.runtime_forgotten === 0) {
    const other = store.get<{ id: string }>("SELECT id FROM vm_environments WHERE id <> ? AND runtime_id = ? AND state <> 'destroyed' LIMIT 1", row.id, current.runtime_id)
    if (other) conflict(context, `Saved owner runtime ${current.runtime_id} is also bound to VM ${other.id}; refusing to remove a shared runtime`)
    const expected = parseSavedRuntimeIdentity(context, current)
    if (!expected) conflict(context, `VM ${current.id} has no saved owner-grant identity; refusing credential cleanup`)
    assertServiceActive(context, service)
    const listing = await context.call('quirky.cli/runtimeList', {})
    assertServiceActive(context, service)
    if (!isRecord(listing) || !Array.isArray(listing.runtimes)) conflict(context, 'Saved runtime list returned an invalid result while retiring the VM owner grant')
    const matches = listing.runtimes.filter((runtime) => isRecord(runtime) && runtime.id === current.runtime_id)
    if (matches.length > 1) conflict(context, 'Saved runtime list contains duplicate IDs for this VM owner grant')
    if (matches.length === 0) {
      store.run('UPDATE vm_environments SET runtime_forgotten = 1, updated_at = ? WHERE id = ?', Date.now(), row.id)
      return
    }
    const shown = await context.call('quirky.cli/runtimeShow', { selector: current.runtime_id })
    assertServiceActive(context, service)
    if (!sameRuntimeIdentity(expected, parseRuntimeIdentity(context, shown, 'Current saved runtime'))) {
      conflict(context, `Saved owner runtime ${current.runtime_id} no longer matches the grant created for this VM; refusing to remove it`)
    }
    const removed = await context.call('quirky.cli/runtimeRemove', { selector: current.runtime_id, yes: true })
    assertServiceActive(context, service)
    if (!sameRuntimeIdentity(expected, parseRuntimeIdentity(context, removed, 'Removed saved runtime'))) {
      conflict(context, `Saved owner runtime ${current.runtime_id} changed during cleanup; refusing to report retirement`)
    }
    store.run('UPDATE vm_environments SET runtime_forgotten = 1, updated_at = ? WHERE id = ?', Date.now(), row.id)
  }
}

async function lifecycleFailure(context: VmContext, store: PluginStore, service: VmService, rowId: string, error: unknown): Promise<never> {
  const current = rowById(store, rowId)
  if (current) {
    let actual: VmBackendState = 'unknown'
    try { actual = await backendState(context, service, store, current) } catch { /* Lima cannot prove the current backend state */ }
    failOperation(service, store, rowById(store, rowId)!, actual, error)
  }
  conflict(context, `VM lifecycle operation failed; its exact backend state remains visible in vmShow. Reconcile only after restoring the pinned owner/backend identity: ${messageOf(error)}`)
}

async function vmSuspend(context: VmContext, store: PluginStore, service: VmService, locks: Map<string, Promise<unknown>>, params: Record<string, unknown>): Promise<VmEnvironment> {
  const expected = expectedInstance(context, params)
  return await lockFor(locks, expected.id, async () => {
    assertServiceActive(context, service)
    const initial = record(store, context, expected.id).row
    assertInstance(context, initial, expected.instanceId)
    assertNoInFlightLifecycle(context, initial)
    const recipe = recipeFromRow(context, initial)
    if (!recipe.suspend || recipe.suspend.trim() === '') conflict(context, `VM recipe "${recipe.name}" does not configure suspend`)
    if (initial.state === 'destroyed') conflict(context, `VM ${initial.id} has already been destroyed`)
    const executable = await requireLima(context, service, initial.backend_executable)
    assertServiceActive(context, service)
    const actual = stateForVmRecord(context, store, initial, executable.info.instances)
    if ((actual === 'stopped' || actual === 'suspended') && (initial.state === 'stopped' || initial.state === 'suspended')) return publicVm(context, initial)
    if (actual !== 'running') conflict(context, `VM ${initial.instance_id} is ${actual}; suspend requires the exact pinned running Lima instance`)
    const opId = beginOperation(store, initial, 'suspend', 'suspending', actual)
    const current = rowById(store, initial.id)!
    try {
      await runRecipeScript(context, service, current, recipe.suspend, opId)
      assertServiceActive(context, service)
      const after = await backendState(context, service, store, rowById(store, current.id)!)
      assertServiceActive(context, service)
      if (after !== 'stopped' && after !== 'suspended') conflict(context, `VM suspend script succeeded but Lima reports ${after}; refusing to report suspension`)
      const mirror = await refreshStoppedMirror(context, service, rowById(store, current.id)!)
      assertServiceActive(context, service)
      finishOperation(store, rowById(store, current.id)!, after, after, mirror)
      return publicVm(context, rowById(store, current.id)!)
    } catch (error) { await lifecycleFailure(context, store, service, current.id, error) }
  }) as VmEnvironment
}

async function vmResume(context: VmContext, store: PluginStore, service: VmService, locks: Map<string, Promise<unknown>>, params: Record<string, unknown>): Promise<VmEnvironment> {
  const expected = expectedInstance(context, params)
  return await lockFor(locks, expected.id, async () => {
    assertServiceActive(context, service)
    const initial = record(store, context, expected.id).row
    assertInstance(context, initial, expected.instanceId)
    assertNoInFlightLifecycle(context, initial)
    const recipe = recipeFromRow(context, initial)
    if (initial.state === 'destroyed' || initial.state === 'destroying' || initial.state === 'retiring') conflict(context, `VM ${initial.id} cannot be resumed from ${initial.state}`)
    const executable = await requireLima(context, service, initial.backend_executable)
    assertServiceActive(context, service)
    let actual = stateForVmRecord(context, store, initial, executable.info.instances)
    if (actual === 'absent' || actual === 'unknown') conflict(context, `VM ${initial.instance_id} is ${actual}; resume never creates or guesses a replacement VM`)
    if (!recipe.resume || recipe.resume.trim() === '') conflict(context, `VM recipe "${recipe.name}" does not configure resume`)
    const previousResumeMayHaveRun = (initial.state === 'failed' || initial.state === 'interrupted') &&
      initial.operation_kind === 'resume' && actual === 'running'
    const runScript = !previousResumeMayHaveRun
    const opId = beginOperation(store, initial, 'resume', 'resuming', actual)
    const current = rowById(store, initial.id)!
    try {
      if (runScript) {
        await runRecipeScript(context, service, current, recipe.resume, opId)
        assertServiceActive(context, service)
        actual = await backendState(context, service, store, rowById(store, current.id)!)
        assertServiceActive(context, service)
        if (actual !== 'running') conflict(context, `VM resume script succeeded but Lima reports ${actual}; refusing to report resume`)
      }
      const reconciled = await reconcileGuestAfterResume(context, store, service, rowById(store, current.id)!)
      assertServiceActive(context, service)
      finishOperation(store, rowById(store, current.id)!, 'running', 'running', reconciled.mirror, reconciled.identity)
      return publicVm(context, rowById(store, current.id)!)
    } catch (error) { await lifecycleFailure(context, store, service, current.id, error) }
  }) as VmEnvironment
}

async function vmDestroy(context: VmContext, store: PluginStore, service: VmService, locks: Map<string, Promise<unknown>>, params: Record<string, unknown>): Promise<VmEnvironment> {
  const expected = expectedInstance(context, params)
  return await lockFor(locks, expected.id, async () => {
    assertServiceActive(context, service)
    const initial = record(store, context, expected.id).row
    assertInstance(context, initial, expected.instanceId)
    assertNoInFlightLifecycle(context, initial)
    const recipe = ensureDestroyEnabled(context, initial)
    const executable = await requireLima(context, service, initial.backend_executable)
    assertServiceActive(context, service)
    const actual = stateForVmRecord(context, store, initial, executable.info.instances)
    if (actual === 'unknown') conflict(context, `Lima reports an unknown state for ${initial.instance_id}; refusing destruction`)
    if (initial.state === 'destroyed') {
      if (actual !== 'absent') conflict(context, `Destroyed VM record ${initial.id} now names a replacement Lima instance; refusing to target it`)
      return publicVm(context, initial)
    }
    const opId = beginOperation(store, initial, 'destroy', 'destroying', actual)
    let current = rowById(store, initial.id)!
    try {
      if (actual !== 'absent') {
        await runRecipeScript(context, service, current, recipe.destroy!, opId)
        assertServiceActive(context, service)
        const after = await backendState(context, service, store, rowById(store, current.id)!)
        assertServiceActive(context, service)
        if (after !== 'absent') conflict(context, `VM destroy script succeeded but Lima still reports ${after}; credentials and mirror remain attached`)
      }
      current = rowById(store, initial.id)!
      updateOperation(store, current, { state: 'retiring', backendState: 'absent', operationState: 'running', error: null })
      await remoteRetire(context, store, service, rowById(store, current.id)!)
      assertServiceActive(context, service)
      finishOperation(store, rowById(store, current.id)!, 'destroyed', 'absent', null, null)
      return publicVm(context, rowById(store, current.id)!)
    } catch (error) { await lifecycleFailure(context, store, service, current.id, error) }
  }) as VmEnvironment
}

/** Registers the public VM-environment API over the private worktree store and plugin context. */
export function registerVmEnvironments(context: PluginContext, store: PluginStore): () => Promise<void> {
  const vmContext = context as VmContext
  const locks = new Map<string, Promise<unknown>>()
  const service: VmService = { store, processes: new Map(), operations: new Set(), stopping: false }
  store.run(
    `UPDATE vm_environments SET state = 'interrupted', operation_state = 'interrupted',
      error = CASE WHEN error IS NULL THEN 'Daemon stopped while this VM lifecycle operation was in progress' ELSE error END,
      updated_at = ? WHERE operation_state = 'running' AND state IN (${ACTIVE_STATES.map(() => '?').join(', ')})`,
    Date.now(), ...ACTIVE_STATES
  )
  cleanStalePrivateOutputs(context)

  context.provide('method:quirky.worktree/vmRecipes', async (params: Record<string, unknown>) => {
    const repo = stringParam(context, params, 'repo')!
    const details = await repoDetails(vmContext, repo)
    return {
      repo: { id: details.repo.id, name: details.repo.name },
      recipes: configuredRecipes(context, details).map((recipe) => ({ ...recipe, checkoutMode: recipe.checkoutMode ?? 'orca-worktree', trustHash: environmentRecipeHash(recipe) })),
      diagnostics: details.hooks.environmentRecipeDiagnostics ?? []
    }
  })
  context.provide('method:quirky.worktree/vmDoctor', () => trackServiceOperation(service, () => limaDoctor(service)))
  context.provide('method:quirky.worktree/vmCreate', (params: Record<string, unknown>) => trackServiceOperation(service, () => vmCreate(vmContext, store, service, params)))
  context.provide('method:quirky.worktree/vmList', (params: Record<string, unknown>) => {
    const repo = stringParam(context, params, 'repo', { optional: true })
    const state = stringParam(context, params, 'state', { optional: true, max: 32 })
    if (state !== undefined && !['creating', 'suspending', 'resuming', 'running', 'suspended', 'stopped', 'failed', 'interrupted', 'destroying', 'retiring', 'destroyed'].includes(state)) invalid(context, `state "${state}" is not a VM lifecycle state`)
    const rows = rowsForRepo(store, repo).filter((row) => state === undefined || row.state === state)
    return { environments: rows.map((row) => publicVm(context, row)) }
  })
  context.provide('method:quirky.worktree/vmShow', (params: Record<string, unknown>) => {
    const id = stringParam(context, params, 'vm', { max: 64 })!
    return record(store, context, id).vm
  })
  context.provide('method:quirky.worktree/vmSuspend', (params: Record<string, unknown>) => trackServiceOperation(service, () => vmSuspend(vmContext, store, service, locks, params)))
  context.provide('method:quirky.worktree/vmResume', (params: Record<string, unknown>) => trackServiceOperation(service, () => vmResume(vmContext, store, service, locks, params)))
  context.provide('method:quirky.worktree/vmDestroy', (params: Record<string, unknown>) => trackServiceOperation(service, () => vmDestroy(vmContext, store, service, locks, params)))
  return () => disposeVmService(service)
}
