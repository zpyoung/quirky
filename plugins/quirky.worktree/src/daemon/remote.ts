import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type {
  OwnerHostIdentity,
  OwnerRuntimeIdentity,
  PluginContext,
  PluginStore,
  RegisteredOwnerHost,
  Worktree
} from '@quirky/protocol'
import { openWindowView, selectWindow } from './window'
import type {
  OwnerCallResult,
  RemoteCallParams,
  RemoteCleanupPreview,
  RemoteHostRow,
  RemoteMirrorRow,
  RemoteWorkspaceMirror
} from '../remote-types'
import { isRecord } from '../loop-status'

const REMOTE_VIEW = 'view:quirky.worktree/remote'
const MIRROR_PREFIX = 'remote_'
const WORKTREE_ID = /^wt_[0-9a-f]{12}$/i
const SAFE_WORKSPACE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?![A-Za-z]:)(?!.*\0).+$/

type ErrorKind = 'invalid-params' | 'not-found' | 'conflict'
type HostRecord = { value: RegisteredOwnerHost; runtimeSelector: string }
type CurrentMirror = { row: RemoteMirrorRow; host: HostRecord; worktree: Worktree; mirror: RemoteWorkspaceMirror }


function reject(context: PluginContext, kind: ErrorKind, message: string): never {
  throw context.error(kind, message)
}

function assertKeys(context: PluginContext, params: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(params).find((key) => !allowed.includes(key))
  if (unexpected) reject(context, 'invalid-params', `unexpected parameter ${unexpected}`)
}

function requiredString(context: PluginContext, value: unknown, field: string, max = 2048): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    reject(context, 'invalid-params', `${field} must be a non-empty string of at most ${max} characters`)
  }
  return value.trim()
}

function optionalBoolean(context: PluginContext, value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') reject(context, 'invalid-params', `${field} must be a boolean`)
  return value
}

function parseIdentity(context: PluginContext, value: unknown, source: string): OwnerHostIdentity {
  const record = isRecord(value)
  if (!record) reject(context, 'conflict', `${source} did not return an owner host identity`)
  return {
    hostId: requiredString(context, record.hostId, `${source}.hostId`, 256),
    generation: requiredString(context, record.generation, `${source}.generation`, 256)
  }
}

function parseRuntime(context: PluginContext, value: unknown, source: string): OwnerRuntimeIdentity {
  const record = isRecord(value)
  if (!record) reject(context, 'conflict', `${source} did not return an owner runtime pin`)
  return {
    id: requiredString(context, record.id, `${source}.id`, 256),
    name: requiredString(context, record.name, `${source}.name`, 512),
    endpoint: requiredString(context, record.endpoint, `${source}.endpoint`, 2048),
    grantId: requiredString(context, record.grantId, `${source}.grantId`, 256)
  }
}

function parseCallResult(context: PluginContext, value: unknown, source: string): OwnerCallResult {
  const record = isRecord(value)
  if (!record || !('result' in record)) reject(context, 'conflict', `${source} returned an incomplete authenticated runtime result`)
  return { runtime: parseRuntime(context, record.runtime, source), result: record.result }
}

function parseWorktree(context: PluginContext, value: unknown): Worktree {
  const record = isRecord(value)
  if (
    !record ||
    typeof record.id !== 'string' || !WORKTREE_ID.test(record.id) ||
    typeof record.repoId !== 'string' ||
    typeof record.path !== 'string' || record.path.length === 0 ||
    (record.branch !== null && typeof record.branch !== 'string') ||
    typeof record.head !== 'string' ||
    typeof record.isMain !== 'boolean' ||
    typeof record.name !== 'string' ||
    (record.kind !== 'git' && record.kind !== 'folder') ||
    (record.displayName !== null && typeof record.displayName !== 'string') ||
    typeof record.comment !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.pinned !== 'boolean' ||
    typeof record.unread !== 'boolean' ||
    (record.parentId !== null && typeof record.parentId !== 'string') ||
    typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) ||
    typeof record.createdBy !== 'string' ||
    (record.baseRef !== null && typeof record.baseRef !== 'string') ||
    typeof record.keepBranch !== 'boolean' ||
    typeof record.removing !== 'boolean' ||
    (record.groupId !== null && typeof record.groupId !== 'string') ||
    (record.projectGroupId !== null && typeof record.projectGroupId !== 'string') ||
    typeof record.lastActivityAt !== 'number' || !Number.isFinite(record.lastActivityAt) ||
    typeof record.instanceId !== 'string' || record.instanceId === '' || record.instanceId.startsWith('unverified:')
  ) {
    reject(context, 'conflict', 'The owner returned an incomplete worktree or unverified filesystem instance.')
  }
  return record as unknown as Worktree
}

function parseJson<T>(context: PluginContext, value: string, source: string, parse: (decoded: unknown) => T): T {
  try {
    return parse(JSON.parse(value) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The ')) throw error
    reject(context, 'conflict', `Stored ${source} data is invalid; no remote operation was attempted.`)
  }
}

function sameIdentity(left: OwnerHostIdentity, right: OwnerHostIdentity): boolean {
  return left.hostId === right.hostId && left.generation === right.generation
}

function sameRuntimePin(left: OwnerRuntimeIdentity, right: OwnerRuntimeIdentity): boolean {
  return left.id === right.id && left.endpoint === right.endpoint && left.grantId === right.grantId
}

function hashBinding(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function mirrorFingerprint(host: RegisteredOwnerHost, worktree: Worktree): string {
  return hashBinding([
    1,
    host.id,
    host.identity.hostId,
    host.identity.generation,
    host.runtime.id,
    host.runtime.endpoint,
    host.runtime.grantId,
    worktree.id,
    worktree.instanceId
  ])
}

function mirrorId(host: RegisteredOwnerHost, worktree: Worktree): string {
  return `${MIRROR_PREFIX}${mirrorFingerprint(host, worktree)}`
}

function hostFromRow(context: PluginContext, row: RemoteHostRow): HostRecord {
  const runtime = parseJson(context, row.runtime_json, 'remote owner runtime', (value) => parseRuntime(context, value, 'stored runtime'))
  const identity = parseJson(context, row.identity_json, 'remote owner identity', (value) => parseIdentity(context, value, 'stored identity'))
  if (row.id !== identity.hostId || typeof row.runtime_selector !== 'string' || row.runtime_selector.trim() === '') {
    reject(context, 'conflict', 'Stored remote host registration is inconsistent; no remote operation was attempted.')
  }
  return {
    value: {
      id: row.id,
      runtime,
      identity,
      connected: row.connected === 1,
      error: row.error,
      updatedAt: row.updated_at
    },
    runtimeSelector: row.runtime_selector
  }
}

function mirrorFromRow(context: PluginContext, row: RemoteMirrorRow, host: HostRecord): RemoteWorkspaceMirror {
  const identity = parseJson(context, row.identity_json, 'remote mirror identity', (value) => parseIdentity(context, value, 'stored mirror identity'))
  const runtime = parseJson(context, row.runtime_json, 'remote mirror runtime pin', (value) => parseRuntime(context, value, 'stored mirror runtime'))
  const worktree = parseJson(context, row.worktree_json, 'remote worktree snapshot', (value) => parseWorktree(context, value))
  const expectedFingerprint = mirrorFingerprint(host.value, worktree)
  const bindingIsCurrent =
    row.host_id === host.value.id &&
    row.worktree_id === worktree.id &&
    row.instance_id === worktree.instanceId &&
    sameIdentity(identity, host.value.identity) &&
    sameRuntimePin(runtime, host.value.runtime) &&
    row.fingerprint === expectedFingerprint &&
    row.id === mirrorId(host.value, worktree)
  return {
    id: row.id,
    hostId: row.host_id,
    identity,
    worktree,
    connected: row.connected === 1 && host.value.connected && bindingIsCurrent,
    fingerprint: row.fingerprint
  }
}

function hostRow(store: PluginStore, id: string): RemoteHostRow | null {
  return store.get<RemoteHostRow>('SELECT * FROM remote_hosts WHERE id = ?', id)
}

function allHostRows(store: PluginStore): RemoteHostRow[] {
  return store.all<RemoteHostRow>('SELECT * FROM remote_hosts ORDER BY id')
}

function requireHost(context: PluginContext, store: PluginStore, idValue: unknown): HostRecord {
  const id = requiredString(context, idValue, 'host', 256)
  const row = hostRow(store, id)
  if (!row) reject(context, 'not-found', `No registered remote owner host ${id} exists.`)
  return hostFromRow(context, row)
}

function mirrorRow(store: PluginStore, id: string): RemoteMirrorRow | null {
  return store.get<RemoteMirrorRow>('SELECT * FROM remote_workspaces WHERE id = ?', id)
}

function requireMirror(context: PluginContext, store: PluginStore, value: unknown): RemoteMirrorRow {
  const id = requiredString(context, value, 'workspace', 256)
  if (!id.startsWith(MIRROR_PREFIX)) reject(context, 'invalid-params', 'workspace must be a registered remote mirror ID')
  const row = mirrorRow(store, id)
  if (!row) reject(context, 'not-found', `Remote mirror ${id} no longer exists; refresh the remote workspace list.`)
  return row
}

function publicHost(host: HostRecord): RegisteredOwnerHost {
  return { ...host.value }
}

function setHostAvailable(store: PluginStore, host: HostRecord, runtime?: OwnerRuntimeIdentity): void {
  const currentRuntime = runtime ? { ...host.value.runtime, name: runtime.name } : host.value.runtime
  store.run(
    'UPDATE remote_hosts SET runtime_json = ?, connected = 1, error = NULL, updated_at = ? WHERE id = ?',
    JSON.stringify(currentRuntime),
    Date.now(),
    host.value.id
  )
}

function setHostUnavailable(store: PluginStore, hostId: string, error: string): void {
  const safeError = error.length > 1000 ? `${error.slice(0, 997)}...` : error
  store.transaction(() => {
    store.run('UPDATE remote_hosts SET connected = 0, error = ?, updated_at = ? WHERE id = ?', safeError, Date.now(), hostId)
    store.run('UPDATE remote_workspaces SET connected = 0 WHERE host_id = ?', hostId)
  })
}

function setMirrorUnavailable(store: PluginStore, mirrorIdValue: string): void {
  store.run('UPDATE remote_workspaces SET connected = 0 WHERE id = ?', mirrorIdValue)
}

function ownerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function probePinnedHost(context: PluginContext, store: PluginStore, host: HostRecord): Promise<void> {
  try {
    const response = parseCallResult(context, await context.call('quirky.cli/runtimeCall', {
      runtime: host.runtimeSelector,
      method: 'quirky.cli/hostIdentity',
      params: {},
      expectedHost: host.value.identity,
      expectedRuntime: {
        id: host.value.runtime.id,
        endpoint: host.value.runtime.endpoint,
        grantId: host.value.runtime.grantId
      }
    }), 'Pinned owner probe')
    const identity = parseIdentity(context, response.result, 'Pinned owner probe')
    if (!sameRuntimePin(response.runtime, host.value.runtime) || !sameIdentity(identity, host.value.identity)) {
      throw new Error('The authenticated owner runtime or host generation no longer matches its registration.')
    }
    setHostAvailable(store, host, response.runtime)
  } catch (error) {
    setHostUnavailable(store, host.value.id, ownerError(error))
    throw error
  }
}

async function callHost(
  context: PluginContext,
  store: PluginStore,
  host: HostRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  let raw: unknown
  try {
    raw = await context.call('quirky.cli/runtimeCall', {
      runtime: host.runtimeSelector,
      method,
      params,
      expectedHost: host.value.identity,
      expectedRuntime: {
        id: host.value.runtime.id,
        endpoint: host.value.runtime.endpoint,
        grantId: host.value.runtime.grantId
      }
    })
  } catch (error) {
    try {
      await probePinnedHost(context, store, host)
    } catch {
      setHostUnavailable(store, host.value.id, ownerError(error))
      throw context.error('conflict', `Remote owner ${host.value.id} is unavailable or its host generation changed: ${ownerError(error)}`)
    }
    throw context.error('conflict', `Remote owner ${host.value.id} rejected ${method}: ${ownerError(error)}`)
  }

  let response: OwnerCallResult
  try {
    response = parseCallResult(context, raw, `Remote ${method}`)
  } catch (error) {
    setHostUnavailable(store, host.value.id, ownerError(error))
    throw error
  }
  if (!sameRuntimePin(response.runtime, host.value.runtime)) {
    const message = 'The saved owner grant or runtime endpoint changed; explicitly register the host again.'
    setHostUnavailable(store, host.value.id, message)
    reject(context, 'conflict', message)
  }
  setHostAvailable(store, host, response.runtime)
  return response.result
}

function normalizeRuntimeSelector(context: PluginContext, value: unknown): string {
  const raw = requiredString(context, value, 'runtime')
  const selector = raw.startsWith('runtime:') ? raw.slice('runtime:'.length).trim() : raw
  if (selector === '') reject(context, 'invalid-params', 'runtime must select a saved owner-cli target')
  return selector
}

async function callUnpinned(
  context: PluginContext,
  selector: string,
  method: string
): Promise<OwnerCallResult> {
  let raw: unknown
  try {
    raw = await context.call('quirky.cli/runtimeCall', { runtime: selector, method, params: {} })
  } catch (error) {
    reject(context, 'conflict', `Could not authenticate saved owner target for host registration: ${ownerError(error)}`)
  }
  return parseCallResult(context, raw, `Remote ${method}`)
}

function sameRegistration(left: HostRecord, runtime: OwnerRuntimeIdentity, identity: OwnerHostIdentity): boolean {
  return sameRuntimePin(left.value.runtime, runtime) && sameIdentity(left.value.identity, identity)
}

function matchingRegistrations(context: PluginContext, store: PluginStore, runtime: OwnerRuntimeIdentity, identity: OwnerHostIdentity): HostRecord[] {
  return allHostRows(store)
    .map((row) => hostFromRow(context, row))
    .filter((host) => host.value.id === identity.hostId || host.value.runtime.id === runtime.id || host.value.runtime.grantId === runtime.grantId)
}

function persistHost(
  store: PluginStore,
  id: string,
  selector: string,
  runtime: OwnerRuntimeIdentity,
  identity: OwnerHostIdentity
): void {
  store.run(
    `INSERT INTO remote_hosts (id, runtime_selector, runtime_json, identity_json, connected, error, updated_at)
     VALUES (?, ?, ?, ?, 1, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       runtime_selector = excluded.runtime_selector,
       runtime_json = excluded.runtime_json,
       identity_json = excluded.identity_json,
       connected = 1,
       error = NULL,
       updated_at = excluded.updated_at`,
    id,
    selector,
    JSON.stringify(runtime),
    JSON.stringify(identity),
    Date.now()
  )
}

function persistMirror(
  store: PluginStore,
  host: HostRecord,
  worktree: Worktree,
  connected: boolean
): RemoteWorkspaceMirror {
  const fingerprint = mirrorFingerprint(host.value, worktree)
  const id = mirrorId(host.value, worktree)
  store.run(
    'UPDATE remote_workspaces SET connected = 0 WHERE host_id = ? AND worktree_id = ? AND instance_id <> ?',
    host.value.id,
    worktree.id,
    worktree.instanceId
  )
  const updatedAt = Date.now()
  store.run(
    `INSERT INTO remote_workspaces
       (id, host_id, identity_json, runtime_json, worktree_id, instance_id, worktree_json, connected, fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       host_id = excluded.host_id,
       identity_json = excluded.identity_json,
       runtime_json = excluded.runtime_json,
       worktree_id = excluded.worktree_id,
       instance_id = excluded.instance_id,
       worktree_json = excluded.worktree_json,
       connected = excluded.connected,
       fingerprint = excluded.fingerprint,
       updated_at = excluded.updated_at`,
    id,
    host.value.id,
    JSON.stringify(host.value.identity),
    JSON.stringify(host.value.runtime),
    worktree.id,
    worktree.instanceId,
    JSON.stringify(worktree),
    connected ? 1 : 0,
    fingerprint,
    updatedAt
  )
  return { id, hostId: host.value.id, identity: host.value.identity, worktree, connected, fingerprint }
}

function currentHostForMirror(context: PluginContext, store: PluginStore, row: RemoteMirrorRow): HostRecord {
  const host = requireHost(context, store, row.host_id)
  const mirror = mirrorFromRow(context, row, host)
  const expectedFingerprint = mirrorFingerprint(host.value, mirror.worktree)
  if (
    row.host_id !== host.value.id ||
    row.worktree_id !== mirror.worktree.id ||
    row.instance_id !== mirror.worktree.instanceId ||
    row.fingerprint !== expectedFingerprint ||
    row.id !== mirrorId(host.value, mirror.worktree) ||
    !sameIdentity(mirror.identity, host.value.identity)
  ) {
    reject(context, 'conflict', 'This remote mirror no longer matches its saved host generation or workspace instance; refresh and select the current workspace.')
  }
  const storedRuntime = parseJson(context, row.runtime_json, 'remote mirror runtime pin', (value) => parseRuntime(context, value, 'stored mirror runtime'))
  if (!sameRuntimePin(storedRuntime, host.value.runtime)) {
    reject(context, 'conflict', 'This remote mirror belongs to a different saved owner grant; refresh and select the current workspace.')
  }
  return host
}

async function freshMirror(context: PluginContext, store: PluginStore, row: RemoteMirrorRow): Promise<CurrentMirror> {
  const host = currentHostForMirror(context, store, row)
  const mirror = mirrorFromRow(context, row, host)
  const selector = `id:${row.worktree_id}`
  let worktree: Worktree
  try {
    worktree = parseWorktree(context, await callHost(context, store, host, 'quirky.worktree/show', { worktree: selector }))
  } catch (error) {
    setMirrorUnavailable(store, row.id)
    throw error
  }
  if (worktree.id !== row.worktree_id || worktree.instanceId !== row.instance_id || mirror.id !== row.id) {
    setMirrorUnavailable(store, row.id)
    reject(context, 'conflict', 'The owner worktree instance changed; refresh the remote workspaces and select the replacement.')
  }
  const updated = persistMirror(store, host, worktree, true)
  const updatedRow = mirrorRow(store, updated.id)
  if (!updatedRow) reject(context, 'conflict', 'The owner snapshot could not be persisted safely.')
  return { row: updatedRow, host, worktree, mirror: updated }
}

function exactWorktreeId(context: PluginContext, value: unknown, field: string): string {
  const raw = requiredString(context, value, field, 256)
  const id = raw.startsWith('id:') ? raw.slice(3) : raw
  if (!WORKTREE_ID.test(id)) reject(context, 'invalid-params', `${field} must be an exact canonical worktree ID, not a path or selector`)
  return id
}

function validateSessionList(context: PluginContext, result: unknown, worktreeId: string): Record<string, unknown>[] {
  if (!Array.isArray(result)) reject(context, 'conflict', 'The remote session owner returned an incomplete session list.')
  const sessions: Record<string, unknown>[] = []
  for (const item of result) {
    const session = isRecord(item)
    if (!session || typeof session.id !== 'string' || typeof session.worktreeId !== 'string') {
      reject(context, 'conflict', 'The remote session owner returned an incomplete session identity.')
    }
    if (session.worktreeId === worktreeId) sessions.push(session)
  }
  return sessions
}

async function requireBoundSession(
  context: PluginContext,
  store: PluginStore,
  current: CurrentMirror,
  sessionValue: unknown
): Promise<string> {
  const sessionId = requiredString(context, sessionValue, 'session', 1024)
  const sessions = validateSessionList(
    context,
    await callHost(context, store, current.host, 'quirky.session/list', { worktree: current.worktree.id }),
    current.worktree.id
  )
  if (!sessions.some((session) => session.id === sessionId)) {
    reject(context, 'not-found', `Remote terminal session ${sessionId} is not bound to this remote workspace.`)
  }
  return sessionId
}

function relativeDiffPath(context: PluginContext, value: unknown): string {
  const path = requiredString(context, value, 'path', 2048)
  if (!SAFE_WORKSPACE_RELATIVE_PATH.test(path) || path === '.' || path.split('/').some((part) => part === '' || part === '.')) {
    reject(context, 'invalid-params', 'path must be a normalized relative file path inside the remote workspace')
  }
  return path
}

function callParameters(context: PluginContext, params: Record<string, unknown>): RemoteCallParams {
  const operation = requiredString(context, params.operation, 'operation', 64)
  const allowed: RemoteCallParams['operation'][] = [
    'changes', 'diff', 'sessions', 'terminalWorkspace', 'terminalCreate', 'terminalRead', 'terminalWrite'
  ]
  if (!allowed.includes(operation as RemoteCallParams['operation'])) {
    reject(context, 'invalid-params', 'operation must be one of changes, diff, sessions, terminalWorkspace, terminalCreate, terminalRead, terminalWrite')
  }
  const base = { workspace: requiredString(context, params.workspace, 'workspace', 256), operation: operation as RemoteCallParams['operation'] }
  switch (base.operation) {
    case 'changes':
    case 'sessions':
    case 'terminalWorkspace':
      assertKeys(context, params, ['workspace', 'operation'])
      return base
    case 'diff': {
      assertKeys(context, params, ['workspace', 'operation', 'path', 'source'])
      let source: 'unstaged' | 'staged' | undefined
      if (params.source !== undefined) {
        if (params.source !== 'unstaged' && params.source !== 'staged') reject(context, 'invalid-params', 'source must be unstaged or staged')
        source = params.source
      }
      return { ...base, path: relativeDiffPath(context, params.path), ...(source ? { source } : {}) }
    }
    case 'terminalCreate':
      assertKeys(context, params, ['workspace', 'operation', 'title'])
      return {
        ...base,
        ...(params.title === undefined ? {} : { title: requiredString(context, params.title, 'title', 200) })
      }
    case 'terminalRead': {
      assertKeys(context, params, ['workspace', 'operation', 'session', 'lines'])
      const lines = params.lines
      if (lines !== undefined && (!Number.isSafeInteger(lines) || (lines as number) < 0 || (lines as number) > 5000)) {
        reject(context, 'invalid-params', 'lines must be an integer from 0 to 5000')
      }
      return { ...base, session: requiredString(context, params.session, 'session', 1024), ...(lines === undefined ? {} : { lines: lines as number }) }
    }
    case 'terminalWrite':
      assertKeys(context, params, ['workspace', 'operation', 'session', 'data'])
      if (typeof params.data !== 'string' || params.data.length === 0 || Buffer.byteLength(params.data, 'utf8') > 64 * 1024) {
        reject(context, 'invalid-params', 'data must contain between 1 and 65536 UTF-8 bytes')
      }
      return { ...base, session: requiredString(context, params.session, 'session', 1024), data: params.data }
  }
}

async function doRemoteCall(context: PluginContext, store: PluginStore, params: RemoteCallParams): Promise<unknown> {
  const row = requireMirror(context, store, params.workspace)
  const current = await freshMirror(context, store, row)
  const worktreeId = current.worktree.id
  try {
    switch (params.operation) {
      case 'changes':
        return await callHost(context, store, current.host, 'quirky.git/status', { worktree: worktreeId })
      case 'diff':
        return await callHost(context, store, current.host, 'quirky.git/diff', {
          worktree: worktreeId,
          path: params.path!,
          ...(params.source ? { source: params.source } : {})
        })
      case 'sessions':
        return validateSessionList(
          context,
          await callHost(context, store, current.host, 'quirky.session/list', { worktree: worktreeId }),
          worktreeId
        )
      case 'terminalWorkspace':
        return await callHost(context, store, current.host, 'quirky.terminal/workspace', { workspace: worktreeId })
      case 'terminalCreate': {
        const latest = await freshMirror(context, store, current.row)
        const session = isRecord(await callHost(context, store, latest.host, 'quirky.session/create', {
          worktree: latest.worktree.id,
          agent: 'shell',
          ...(params.title ? { title: params.title } : {})
        }))
        if (!session || typeof session.id !== 'string' || session.worktreeId !== latest.worktree.id) {
          reject(context, 'conflict', 'The remote session owner did not return a session bound to this workspace.')
        }
        return session
      }
      case 'terminalRead': {
        const session = await requireBoundSession(context, store, current, params.session)
        const latest = await freshMirror(context, store, current.row)
        await requireBoundSession(context, store, latest, session)
        return await callHost(context, store, latest.host, 'quirky.terminal/read', {
          session,
          ...(params.lines === undefined ? {} : { lines: params.lines })
        })
      }
      case 'terminalWrite': {
        const session = await requireBoundSession(context, store, current, params.session)
        const latest = await freshMirror(context, store, current.row)
        await requireBoundSession(context, store, latest, session)
        return await callHost(context, store, latest.host, 'quirky.terminal/write', { session, data: params.data! })
      }
    }
  } catch (error) {
    setMirrorUnavailable(store, current.mirror.id)
    throw error
  }
}


async function refreshHost(context: PluginContext, store: PluginStore, host: HostRecord): Promise<RemoteWorkspaceMirror[]> {
  let result: unknown
  try {
    result = await callHost(context, store, host, 'quirky.worktree/list')
  } catch (error) {
    store.run('UPDATE remote_workspaces SET connected = 0 WHERE host_id = ?', host.value.id)
    throw error
  }
  let worktrees: Worktree[]
  try {
    if (!Array.isArray(result)) reject(context, 'conflict', 'The remote worktree owner returned an incomplete workspace list.')
    worktrees = result.map((value) => parseWorktree(context, value))
    const ids = new Set<string>()
    for (const worktree of worktrees) {
      if (ids.has(worktree.id)) reject(context, 'conflict', 'The remote owner returned duplicate worktree identities; no snapshots were replaced.')
      ids.add(worktree.id)
    }
  } catch (error) {
    setHostUnavailable(store, host.value.id, ownerError(error))
    throw error
  }
  const updated: RemoteWorkspaceMirror[] = []
  store.transaction(() => {
    store.run('UPDATE remote_workspaces SET connected = 0 WHERE host_id = ?', host.value.id)
    for (const worktree of worktrees) updated.push(persistMirror(store, host, worktree, true))
  })
  return updated
}

async function hostStatus(context: PluginContext, store: PluginStore, hostId: string): Promise<RegisteredOwnerHost> {
  let host = requireHost(context, store, hostId)
  try {
    const result = await callHost(context, store, host, 'quirky.cli/hostIdentity')
    const identity = parseIdentity(context, result, 'Remote host status')
    if (!sameIdentity(identity, host.value.identity)) {
      const message = 'The remote host generation changed; explicitly register it again before using its workspaces.'
      setHostUnavailable(store, host.value.id, message)
    }
  } catch (error) {
    const currentRow = hostRow(store, host.value.id)
    if (currentRow?.connected) setHostUnavailable(store, host.value.id, ownerError(error))
  }
  const updatedRow = hostRow(store, host.value.id)
  if (updatedRow) host = hostFromRow(context, updatedRow)
  return publicHost(host)
}

function storeMigration(store: PluginStore): void {
  store.exec(`
    CREATE TABLE remote_hosts (
      id TEXT PRIMARY KEY,
      runtime_selector TEXT NOT NULL,
      runtime_json TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE remote_workspaces (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      runtime_json TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      worktree_json TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX remote_workspaces_host_idx ON remote_workspaces(host_id, worktree_id);
  `)
}

/** Appended by the worktree store owner after its existing schema migrations. */
export function migrateRemoteWorkspaces(store: PluginStore): void {
  storeMigration(store)
}

/** Registers the authenticated remote-owner workspace APIs over their own durable projection tables. */
export function registerRemoteWorkspaces(context: PluginContext, store: PluginStore): void {
  store.run('UPDATE remote_hosts SET connected = 0, error = ?, updated_at = ?', 'Status was not rechecked after daemon activation.', Date.now())
  store.run('UPDATE remote_workspaces SET connected = 0')

  const provide = (name: string, handler: (params: Record<string, unknown>) => unknown) => {
    context.provide(`method:${context.pluginId}/${name}`, handler)
  }

  provide('remoteHostRegister', async (params) => {
    assertKeys(context, params, ['runtime', 'replace'])
    const selector = normalizeRuntimeSelector(context, params.runtime)
    const replace = optionalBoolean(context, params.replace, 'replace') === true
    const call = await callUnpinned(context, selector, 'quirky.cli/hostIdentity')
    const identity = parseIdentity(context, call.result, 'Remote host registration')
    const matches = matchingRegistrations(context, store, call.runtime, identity)
    const changed = matches.some((match) => !sameRegistration(match, call.runtime, identity))
    if (changed && !replace) {
      reject(context, 'conflict', 'The owner generation, saved grant or host identity changed; pass replace:true to pin this exact authenticated owner.')
    }
    if (replace) {
      for (const prior of matches) {
        if (prior.value.id !== identity.hostId) {
          setHostUnavailable(store, prior.value.id, 'Owner identity was explicitly replaced by a different host identity.')
        } else if (!sameRegistration(prior, call.runtime, identity)) {
          store.run('UPDATE remote_workspaces SET connected = 0 WHERE host_id = ?', prior.value.id)
        }
      }
    }
    persistHost(store, identity.hostId, selector, call.runtime, identity)
    const row = hostRow(store, identity.hostId)
    if (!row) reject(context, 'conflict', 'The owner registration could not be persisted.')
    return publicHost(hostFromRow(context, row))
  })

  provide('remoteHostList', async (params) => {
    assertKeys(context, params, [])
    const hosts: RegisteredOwnerHost[] = []
    for (const row of allHostRows(store)) hosts.push(await hostStatus(context, store, row.id))
    return { hosts }
  })

  provide('remoteHostStatus', async (params) => {
    assertKeys(context, params, ['host'])
    const host = requireHost(context, store, params.host)
    return await hostStatus(context, store, host.value.id)
  })

  provide('remoteHostForget', (params) => {
    assertKeys(context, params, ['host', 'detach', 'confirmed'])
    const host = requireHost(context, store, params.host)
    const detach = optionalBoolean(context, params.detach, 'detach') === true
    if (params.confirmed !== true) reject(context, 'invalid-params', 'confirmed must be true after reviewing the local detach.')
    const attached = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM remote_workspaces WHERE host_id = ?', host.value.id)?.count ?? 0
    if (attached > 0 && !detach) {
      reject(context, 'conflict', `Host ${host.value.id} still has ${attached} remote mirror attachment(s); use confirmed local detach to forget them without deleting the remote source.`)
    }
    store.transaction(() => {
      if (detach) store.run('DELETE FROM remote_workspaces WHERE host_id = ?', host.value.id)
      store.run('DELETE FROM remote_hosts WHERE id = ?', host.value.id)
    })
    return { ok: true, detached: detach ? attached : 0 }
  })

  provide('remoteAttach', async (params) => {
    assertKeys(context, params, ['host', 'worktree'])
    const host = requireHost(context, store, params.host)
    const worktreeId = exactWorktreeId(context, params.worktree, 'worktree')
    const worktree = parseWorktree(context, await callHost(context, store, host, 'quirky.worktree/show', { worktree: `id:${worktreeId}` }))
    if (worktree.id !== worktreeId) reject(context, 'conflict', 'The owner returned a different worktree than the exact attachment requested.')
    return persistMirror(store, host, worktree, true)
  })

  provide('remoteRefresh', async (params) => {
    assertKeys(context, params, ['host'])
    const host = requireHost(context, store, params.host)
    return { workspaces: await refreshHost(context, store, host) }
  })

  provide('remoteList', async (params) => {
    assertKeys(context, params, ['host'])
    let hosts: HostRecord[]
    if (params.host === undefined) {
      hosts = allHostRows(store).map((row) => hostFromRow(context, row))
    } else {
      hosts = [requireHost(context, store, params.host)]
    }
    for (const host of hosts) await hostStatus(context, store, host.value.id)
    const hostById = new Map<string, HostRecord>()
    for (const row of allHostRows(store)) hostById.set(row.id, hostFromRow(context, row))
    const workspaces: RemoteWorkspaceMirror[] = []
    const rows = params.host === undefined
      ? store.all<RemoteMirrorRow>('SELECT * FROM remote_workspaces ORDER BY host_id, worktree_id, id')
      : store.all<RemoteMirrorRow>('SELECT * FROM remote_workspaces WHERE host_id = ? ORDER BY worktree_id, id', requiredString(context, params.host, 'host', 256))
    for (const row of rows) {
      const host = hostById.get(row.host_id)
      if (!host) continue
      workspaces.push(mirrorFromRow(context, row, host))
    }
    return { workspaces }
  })

  provide('remoteShow', async (params) => {
    assertKeys(context, params, ['workspace'])
    const row = requireMirror(context, store, params.workspace)
    try {
      return (await freshMirror(context, store, row)).mirror
    } catch {
      const currentRow = mirrorRow(store, row.id) ?? row
      const hostRowValue = hostRow(store, currentRow.host_id)
      if (!hostRowValue) reject(context, 'not-found', 'The registered owner for this mirror has been forgotten.')
      const host = hostFromRow(context, hostRowValue)
      return { ...mirrorFromRow(context, currentRow, host), connected: false }
    }
  })

  provide('remoteNavigate', async (params) => {
    assertKeys(context, params, ['workspace', 'window'])
    const row = requireMirror(context, store, params.workspace)
    const selected = await selectWindow({
      fail: (kind, message) => context.error(kind, message),
      call: (method, callParams) => context.call(method, callParams)
    }, params.window)
    const current = await freshMirror(context, store, row)
    await openWindowView({
      fail: (kind, message) => context.error(kind, message),
      call: (method, callParams) => context.call(method, callParams)
    }, selected.connId, REMOTE_VIEW, { workspace: current.mirror.id })
    return { workspace: current.mirror.id, connId: selected.connId, view: REMOTE_VIEW }
  })

  provide('remoteCall', (params) => doRemoteCall(context, store, callParameters(context, params)))

  provide('remoteCleanupPreview', async (params) => {
    assertKeys(context, params, ['workspace'])
    const row = requireMirror(context, store, params.workspace)
    const current = await freshMirror(context, store, row)
    const result = isRecord(await callHost(context, store, current.host, 'quirky.worktree/cleanupPreview'))
    if (!result || typeof result.generatedAt !== 'number' || !Array.isArray(result.candidates)) {
      reject(context, 'conflict', 'The canonical owner returned an incomplete cleanup preview.')
    }
    const candidateValue = result.candidates.find((value) => isRecord(value)?.worktreeId === current.worktree.id)
    let candidate: RemoteCleanupPreview['candidate'] = null
    if (candidateValue !== undefined) {
      const record = isRecord(candidateValue)
      if (
        !record || typeof record.worktreeId !== 'string' || typeof record.name !== 'string' ||
        typeof record.fingerprint !== 'string' || typeof record.reason !== 'string' ||
        typeof record.ignored !== 'boolean' || typeof record.eligible !== 'boolean' || !Array.isArray(record.blockers)
      ) reject(context, 'conflict', 'The canonical owner returned an incomplete cleanup candidate.')
      candidate = record as unknown as RemoteCleanupPreview['candidate']
    }
    return {
      workspace: current.mirror.id,
      hostId: current.host.value.id,
      identity: current.host.value.identity,
      instanceId: current.worktree.instanceId,
      generatedAt: result.generatedAt,
      candidate
    } satisfies RemoteCleanupPreview
  })

  provide('remoteRemove', async (params) => {
    assertKeys(context, params, ['workspace', 'fingerprint', 'confirmed'])
    if (params.confirmed !== true) reject(context, 'invalid-params', 'confirmed must be true after reviewing the remote workspace removal.')
    const row = requireMirror(context, store, params.workspace)
    const current = await freshMirror(context, store, row)
    const fingerprint = requiredString(context, params.fingerprint, 'fingerprint', 128)
    if (fingerprint !== current.mirror.fingerprint) reject(context, 'conflict', 'The remote workspace selection changed; refresh and confirm the current mirror before removal.')
    let rawResult: unknown
    try {
      rawResult = await callHost(context, store, current.host, 'quirky.worktree/remove', {
        worktree: `id:${current.worktree.id}`,
        safeOnly: true,
        expectedInstanceId: current.worktree.instanceId,
        yes: true
      })
    } catch (error) {
      setMirrorUnavailable(store, current.mirror.id)
      throw error
    }
    const result = isRecord(rawResult)
    if (result?.ok !== true || !Array.isArray(result.removed) || !result.removed.includes(current.worktree.id)) {
      setMirrorUnavailable(store, current.mirror.id)
      reject(context, 'conflict', 'The canonical owner did not confirm removal of this exact remote workspace instance; refresh before acting again.')
    }
    retireMirror(store, current)
    return { ok: true, workspace: current.mirror.id, result }
  })

  provide('remoteCleanupRemove', async (params) => {
    assertKeys(context, params, ['workspace', 'fingerprint', 'confirmed'])
    if (params.confirmed !== true) reject(context, 'invalid-params', 'confirmed must be true after reviewing the canonical cleanup suggestion.')
    const row = requireMirror(context, store, params.workspace)
    const current = await freshMirror(context, store, row)
    const fingerprint = requiredString(context, params.fingerprint, 'fingerprint', 128)
    const livePreview = isRecord(await callHost(context, store, current.host, 'quirky.worktree/cleanupPreview'))
    if (!livePreview || !Array.isArray(livePreview.candidates)) reject(context, 'conflict', 'The canonical owner returned an incomplete cleanup preview.')
    const candidateValue = livePreview.candidates.find((value) => isRecord(value)?.worktreeId === current.worktree.id)
    const candidate = isRecord(candidateValue)
    if (!candidate || candidate.fingerprint !== fingerprint || candidate.eligible !== true) {
      reject(context, 'conflict', 'Cleanup evidence is missing, blocked or stale; refresh and review the exact remote instance again.')
    }
    let rawResult: unknown
    try {
      rawResult = await callHost(context, store, current.host, 'quirky.worktree/cleanupRemove', {
        selection: [{
          worktreeId: current.worktree.id,
          fingerprint,
          expectedInstanceId: current.worktree.instanceId
        }],
        confirmed: true,
        yes: true
      })
    } catch (error) {
      setMirrorUnavailable(store, current.mirror.id)
      throw error
    }
    const result = isRecord(rawResult)
    const results = Array.isArray(result?.results) ? result.results : null
    const outcome = results?.map(isRecord).find((item) => item?.worktreeId === current.worktree.id)
    if (!outcome || outcome.removed !== true) {
      reject(context, 'conflict', typeof outcome?.error === 'string' ? outcome.error : 'The canonical owner did not remove this exact cleanup candidate.')
    }
    retireMirror(store, current)
    return { ok: true, workspace: current.mirror.id, result }
  })
}

function retireMirror(store: PluginStore, current: CurrentMirror): void {
  store.transaction(() => {
    store.run('DELETE FROM remote_workspaces WHERE id = ? AND host_id = ? AND identity_json = ? AND instance_id = ?',
      current.row.id,
      current.host.value.id,
      current.row.identity_json,
      current.worktree.instanceId
    )
    store.run('UPDATE remote_workspaces SET connected = 0 WHERE host_id = ? AND worktree_id = ?', current.host.value.id, current.worktree.id)
  })
}
