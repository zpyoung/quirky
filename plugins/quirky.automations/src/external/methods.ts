import type { MethodHandler, PluginContext } from '@quirky/protocol'
import type { AutomationMethods, ExternalAction, ExternalListResult, ExternalManager } from '../ui-contracts'
import { OPENCLAW_JOB_ID_RE, runOpenClawCommand } from './command'
import { inspectLocalOpenClaw, type LocalOpenClawSnapshot } from './local'

const OPENCLAW_CACHE_TTL_MS = 30_000
const MAX_CACHED_AUTHORITIES = 512
const LOCAL_AUTHORITY_KEY = 'openclaw:local'

type CacheEntry = { expiresAt: number; result: ExternalListResult }
type LocalOwner = ExternalManager['owner']
type ActionParameters = { owner: LocalOwner; jobId: string; action: ExternalAction }

function invalid(context: PluginContext, message: string): never {
  throw context.error('invalid-params', message)
}

function conflict(context: PluginContext, message: string): never {
  throw context.error('conflict', message)
}

function validateAction(context: PluginContext, value: unknown): ExternalAction {
  if (value === 'pause' || value === 'resume' || value === 'run' || value === 'delete') return value
  return invalid(context, 'External action must be pause, resume, run, or delete')
}

function validateOwner(context: PluginContext, value: unknown): LocalOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(context, 'External action requires a captured owner object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || typeof record.hostId !== 'string' || typeof record.generation !== 'string') {
    return invalid(context, 'External owner requires provider, hostId, and generation strings')
  }
  if (record.provider !== 'openclaw') {
    return conflict(context, `Unsupported external manager provider: ${record.provider}`)
  }
  if (record.hostId !== 'local') {
    return conflict(context, 'OpenClaw remote-host access is unsupported; no local fallback will be used')
  }
  if (!/^[0-9a-f]{64}(?![\s\S])/.test(record.generation)) {
    return conflict(context, 'OpenClaw owner generation is invalid; refresh the external list')
  }
  return { provider: 'openclaw', hostId: 'local', generation: record.generation }
}

function validateJobId(context: PluginContext, value: unknown): string {
  if (typeof value !== 'string' || !OPENCLAW_JOB_ID_RE.test(value)) {
    return invalid(context, 'OpenClaw job ID is unsafe; use only letters, numbers, dot, underscore, colon, or hyphen')
  }
  return value
}

function actionParameters(context: PluginContext, params: Record<string, unknown>): ActionParameters {
  const action = validateAction(context, params.action)
  const owner = validateOwner(context, params.owner)
  const jobId = validateJobId(context, params.jobId)
  return { action, owner, jobId }
}

function displayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function managerFromSnapshot(snapshot: LocalOpenClawSnapshot): ExternalManager | null {
  let error = snapshot.readError
  if (error === null && snapshot.cliError !== null) error = snapshot.cliError
  if (error === null && snapshot.executable === null && snapshot.jobs.length > 0) {
    error = 'OpenClaw jobs were found, but the openclaw CLI is not on PATH.'
  }

  const exists = snapshot.executable !== null || snapshot.jobs.length > 0 || snapshot.readError !== null || snapshot.cliError !== null
  if (!exists) return null

  return {
    id: 'openclaw:local',
    provider: 'openclaw',
    hostId: 'local',
    label: 'OpenClaw on this computer',
    status: error === null ? 'ready' : 'unavailable',
    canManage: snapshot.executable !== null && snapshot.readError === null && snapshot.cliError === null,
    error,
    jobs: snapshot.readError === null ? snapshot.jobs : [],
    owner: { provider: 'openclaw', hostId: 'local', generation: snapshot.generation }
  }
}

function trimCache(cache: Map<string, CacheEntry>): void {
  while (cache.size > MAX_CACHED_AUTHORITIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

function cachedResult(cache: Map<string, CacheEntry>): ExternalListResult | null {
  const entry = cache.get(LOCAL_AUTHORITY_KEY)
  if (!entry) return null
  if (entry.expiresAt <= performance.now()) {
    cache.delete(LOCAL_AUTHORITY_KEY)
    return null
  }
  cache.delete(LOCAL_AUTHORITY_KEY)
  cache.set(LOCAL_AUTHORITY_KEY, entry)
  return structuredClone(entry.result)
}

async function freshResult(cache: Map<string, CacheEntry>): Promise<ExternalListResult> {
  const snapshot = await inspectLocalOpenClaw()
  const manager = managerFromSnapshot(snapshot)
  const result: ExternalListResult = { managers: manager === null ? [] : [manager] }
  cache.set(LOCAL_AUTHORITY_KEY, { expiresAt: performance.now() + OPENCLAW_CACHE_TTL_MS, result })
  trimCache(cache)
  return structuredClone(result)
}

async function assertCurrentJob(
  context: PluginContext,
  owner: LocalOwner,
  jobId: string
): Promise<LocalOpenClawSnapshot> {
  const snapshot = await inspectLocalOpenClaw()
  if (snapshot.generation !== owner.generation) {
    return conflict(context, 'OpenClaw jobs or CLI changed since they were listed; refresh the external list before acting')
  }
  if (snapshot.readError !== null) return conflict(context, `OpenClaw jobs are unavailable: ${snapshot.readError}`)
  if (snapshot.executable === null) return conflict(context, snapshot.cliError ?? 'OpenClaw CLI is not on PATH; this job cannot be managed')
  if (!snapshot.jobs.some((job) => job.id === jobId)) {
    throw context.error('not-found', `OpenClaw job ${jobId} no longer exists; refresh the external list`)
  }
  return snapshot
}

export function externalMethods(context: PluginContext): AutomationMethods {
  const cache = new Map<string, CacheEntry>()

  const externalList: MethodHandler = async (params) => {
    const hostId = params.hostId
    if (hostId !== undefined && hostId !== 'local') {
      return conflict(context, 'OpenClaw is available only on the local host; remote OpenClaw access is unsupported')
    }
    const noCache = params.noCache === true
    if (params.noCache !== undefined && typeof params.noCache !== 'boolean') {
      return invalid(context, 'noCache must be a boolean')
    }
    if (noCache) cache.delete(LOCAL_AUTHORITY_KEY)
    const cached = noCache ? null : cachedResult(cache)
    return cached ?? freshResult(cache)
  }

  const externalActionDescribe: MethodHandler = async (params) => {
    const action = validateAction(context, params.action)
    if (action !== 'delete') return null
    const owner = validateOwner(context, params.owner)
    const jobId = validateJobId(context, params.jobId)
    const snapshot = await assertCurrentJob(context, owner, jobId)
    const job = snapshot.jobs.find((item) => item.id === jobId)!
    const name = displayName(job.name) || jobId
    return `Delete OpenClaw automation “${name}”? This removes the job from OpenClaw only; native automation history and workspaces are not changed.`
  }

  const externalAction: MethodHandler = async (params) => {
    const { action, owner, jobId } = actionParameters(context, params)
    const snapshot = await assertCurrentJob(context, owner, jobId)
    cache.delete(LOCAL_AUTHORITY_KEY)
    try {
      await runOpenClawCommand(snapshot.executable!, snapshot.home, jobId, action)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw context.error('conflict', message)
    } finally {
      cache.delete(LOCAL_AUTHORITY_KEY)
    }
    return { ok: true }
  }

  return { externalList, externalAction, externalActionDescribe }
}
