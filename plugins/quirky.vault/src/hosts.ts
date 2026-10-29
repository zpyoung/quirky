import type { ContributionInfo, OwnerRuntimeCallResult, OwnerSessionHostRef, PluginContext, RegisteredOwnerHost } from '@quirky/protocol'
import type { HostOutcome, HostedSession, ScanIssue, VaultSession } from './types'

export type VaultOwnerMethod = 'list' | 'search' | 'searchStatus' | 'setSearchEnabled' | 'get' | 'firstPrompt' | 'subagents' | 'ownerResume'
export type VaultHost = { id: string; label: string; methodPrefix: string; owner?: OwnerSessionHostRef }
export type HostSelection = { local: boolean; hosts: VaultHost[]; unavailable?: HostOutcome }

const METHOD_PREFIX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const LOCAL_HOST = { id: 'local', label: 'Local Mac' } as const
const OWNER_REGISTRY_METHOD = 'quirky.worktree/remoteHostList'


export async function discoverVaultHosts(context: PluginContext): Promise<{ hosts: VaultHost[]; issues: HostOutcome[] }> {
  let raw: unknown
  try {
    raw = await context.call('plugin.contributions', { kind: 'vault-host' })
  } catch (error) {
    return {
      hosts: [],
      issues: [outcome('registry', 'Other hosts', 'error', safeReason(error), 0, null)]
    }
  }
  if (!Array.isArray(raw)) {
    return { hosts: [], issues: [outcome('registry', 'Other hosts', 'error', 'host registry returned an invalid response', 0, null)] }
  }
  const hosts: VaultHost[] = []
  const issues: HostOutcome[] = []
  let ownerMethodPrefix: string | undefined
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push(outcome('registry', 'Other hosts', 'error', 'host registry returned a malformed contribution', 0, null))
      continue
    }
    const contribution = value as ContributionInfo
    const label = typeof contribution.data?.label === 'string' && contribution.data.label.trim() !== ''
      ? contribution.data.label
      : contribution.id
    const methodPrefix = contribution.data?.methodPrefix
    if (
      typeof contribution.id !== 'string' ||
      !contribution.id.startsWith('vault-host:') ||
      typeof methodPrefix !== 'string' ||
      !METHOD_PREFIX.test(methodPrefix)
    ) {
      issues.push(outcome(typeof contribution.id === 'string' ? contribution.id : 'registry', label, 'unavailable', 'host contribution must declare a label and public methodPrefix', 0, null))
      continue
    }
    if (contribution.plugin === context.pluginId && contribution.data.ownerRuntime === true) {
      if (ownerMethodPrefix !== undefined) {
        issues.push(outcome(contribution.id, label, 'unavailable', 'only one owner-runtime Vault contribution may be effective', 0, null))
      } else {
        ownerMethodPrefix = methodPrefix
      }
      continue
    }
    hosts.push({ id: contribution.id, label, methodPrefix })
  }

  if (ownerMethodPrefix !== undefined) {
    try {
      const response = await context.call(OWNER_REGISTRY_METHOD, {})
      const rows = typeof response === 'object' && response !== null && !Array.isArray(response)
        ? (response as Record<string, unknown>).hosts
        : undefined
      if (!Array.isArray(rows)) throw new Error('registered owner list is malformed')
      const seen = new Set(hosts.map((host) => host.id))
      for (const row of rows) {
        if (!isRegisteredOwnerHost(row)) {
          issues.push(outcome('registry', 'Other hosts', 'unavailable', 'registered owner identity is malformed', 0, null))
          continue
        }
        if (row.id === LOCAL_HOST.id || seen.has(row.id)) {
          issues.push(outcome(row.id, row.runtime.name, 'unavailable', 'registered owner identity is duplicated or local', 0, null))
          continue
        }
        seen.add(row.id)
        hosts.push({
          id: row.id,
          label: row.runtime.name.trim() === '' ? row.id : row.runtime.name,
          methodPrefix: ownerMethodPrefix,
          owner: {
            hostId: row.id,
            identity: { hostId: row.identity.hostId, generation: row.identity.generation },
            runtime: { id: row.runtime.id, endpoint: row.runtime.endpoint, grantId: row.runtime.grantId }
          }
        })
      }
    } catch (error) {
      issues.push(outcome('registry', 'Other hosts', 'error', safeReason(error), 0, null))
    }
  }
  hosts.sort((a, b) => a.id.localeCompare(b.id))
  return { hosts, issues }
}

function isRegisteredOwnerHost(value: unknown): value is RegisteredOwnerHost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '' || typeof row.connected !== 'boolean' || (row.error !== null && typeof row.error !== 'string') || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return false
  const runtime = row.runtime
  const identity = row.identity
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime) ||
    typeof identity !== 'object' || identity === null || Array.isArray(identity)) return false
  const runtimeRow = runtime as Record<string, unknown>
  const identityRow = identity as Record<string, unknown>
  return typeof runtimeRow.id === 'string' &&
    runtimeRow.id !== '' &&
    typeof runtimeRow.name === 'string' &&
    typeof runtimeRow.endpoint === 'string' &&
    runtimeRow.endpoint !== '' &&
    typeof runtimeRow.grantId === 'string' &&
    runtimeRow.grantId !== '' &&
    typeof identityRow.hostId === 'string' &&
    identityRow.hostId !== '' &&
    typeof identityRow.generation === 'string' &&
    identityRow.generation !== '' &&
    row.id === identityRow.hostId
}

export async function callVaultHost(
  context: PluginContext,
  host: VaultHost,
  method: VaultOwnerMethod,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const route = methodOf(host, method)
  if (!host.owner) return context.call(route, params)
  const raw = await context.call('quirky.cli/runtimeCall', {
    runtime: host.owner.runtime.id,
    method: route,
    params,
    expectedHost: host.owner.identity,
    expectedRuntime: host.owner.runtime
  })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw context.error('conflict', 'owner runtime returned an invalid call envelope')
  }
  const result = raw as OwnerRuntimeCallResult
  if (
    !result.runtime ||
    result.runtime.id !== host.owner.runtime.id ||
    result.runtime.endpoint !== host.owner.runtime.endpoint ||
    result.runtime.grantId !== host.owner.runtime.grantId
  ) {
    throw context.error('conflict', 'owner runtime pin changed during the Vault operation')
  }
  return result.result
}

export function selectHost(selector: string | undefined, hosts: VaultHost[]): HostSelection {
  if (selector === undefined || selector === 'local') return { local: true, hosts: [] }
  if (selector === 'all') return { local: true, hosts }
  const selected = hosts.find((host) => host.id === selector)
  if (selected) return { local: false, hosts: [selected] }
  return {
    local: false,
    hosts: [],
    unavailable: outcome(selector, selector, 'unavailable', 'no effective vault-host contribution has this identity', 0, null)
  }
}

export function methodOf(host: VaultHost, method: VaultOwnerMethod): string {
  return `${host.methodPrefix}/${method}`
}

export function ownerLocalId(sourceId: string): string {
  return qualifyPublicId(LOCAL_HOST.id, sourceId)
}


export function outcome(
  hostId: string,
  label: string,
  kind: HostOutcome['kind'],
  reason: string | undefined,
  scannedFiles: number,
  scannedAt: number | null
): HostOutcome {
  return {
    hostId,
    label,
    kind,
    ...(reason === undefined ? {} : { reason: redactReason(reason) }),
    scannedFiles,
    scannedAt
  }
}

export function localOutcome(kind: HostOutcome['kind'], scannedFiles = 0, scannedAt: number | null = null, reason?: string): HostOutcome {
  return outcome(LOCAL_HOST.id, LOCAL_HOST.label, kind, reason, scannedFiles, scannedAt)
}

export function hostedLocal(session: VaultSession): HostedSession {
  const { id: sourceId, filePath, codexHome, ...metadata } = session
  return {
    ...metadata,
    id: qualifyPublicId(LOCAL_HOST.id, sourceId),
    sourceId,
    hostId: LOCAL_HOST.id,
    source: { presence: session.presence, filePath, ...(codexHome === null ? {} : { codexHome }) }
  }
}

export function hostedRemote(session: VaultSession, hostId: string): HostedSession {
  const { id: sourceId, filePath: _filePath, codexHome: _codexHome, ...metadata } = session
  return {
    ...metadata,
    id: qualifyPublicId(hostId, sourceId),
    sourceId,
    hostId,
    source: { presence: session.presence }
  }
}

export function decodePublicId(id: string): { hostId: string; sourceId: string } | null {
  if (!id.startsWith('vault1.')) return null
  try {
    const raw: unknown = JSON.parse(Buffer.from(id.slice(7), 'base64url').toString('utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const value = raw as { hostId?: unknown; sourceId?: unknown }
    const keys = Object.keys(raw)
    if (
      keys.length !== 2 ||
      !Object.hasOwn(raw, 'hostId') ||
      !Object.hasOwn(raw, 'sourceId') ||
      typeof value.hostId !== 'string' ||
      typeof value.sourceId !== 'string' ||
      value.hostId === '' ||
      value.sourceId === ''
    ) return null
    return { hostId: value.hostId, sourceId: value.sourceId }
  } catch {
    return null
  }
}

export function redactIssue(issue: ScanIssue, hostId: string): ScanIssue & { hostId: string } {
  return {
    ...(issue.agent === undefined ? {} : { agent: issue.agent }),
    hostId,
    kind: issue.kind,
    reason: redactReason(issue.reason)
  }
}

export function redactReason(reason: string): string {
  if (/(?:^|[\s:'"=])(?:\/|[A-Za-z]:[\\/])/.test(reason)) {
    return 'remote host operation failed (path details redacted)'
  }
  if (/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)[A-Z0-9_]*\s*=/i.test(reason)) {
    return 'remote host operation failed (credential details redacted)'
  }
  return reason
}

export function qualifyPublicId(hostId: string, sourceId: string): string {
  return `vault1.${Buffer.from(JSON.stringify({ hostId, sourceId }), 'utf8').toString('base64url')}`
}

function safeReason(error: unknown): string {
  return redactReason(error instanceof Error ? error.message : String(error))
}
