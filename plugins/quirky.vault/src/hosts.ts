import type { ContributionInfo, PluginContext } from '@quirky/protocol'
import type { HostOutcome, HostedSession, ScanIssue, VaultSession } from './types'

export type VaultHost = { id: string; label: string; methodPrefix: string }
export type HostSelection = { local: boolean; hosts: VaultHost[]; unavailable?: HostOutcome }

const METHOD_PREFIX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const LOCAL_HOST = { id: 'local', label: 'Local Mac' } as const

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
    hosts.push({ id: contribution.id, label, methodPrefix })
  }
  hosts.sort((a, b) => a.id.localeCompare(b.id))
  return { hosts, issues }
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

export function methodOf(host: VaultHost, method: 'list' | 'search' | 'searchStatus' | 'setSearchEnabled'): string {
  return `${host.methodPrefix}/${method}`
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
    if (typeof value.hostId !== 'string' || typeof value.sourceId !== 'string' || value.hostId === '' || value.sourceId === '') return null
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
  return /(?:^|[\s:'"])(?:\/|[A-Za-z]:[\\/])/.test(reason)
    ? 'remote host operation failed (path details redacted)'
    : reason
}

export function qualifyPublicId(hostId: string, sourceId: string): string {
  return `vault1.${Buffer.from(JSON.stringify({ hostId, sourceId }), 'utf8').toString('base64url')}`
}

function safeReason(error: unknown): string {
  return redactReason(error instanceof Error ? error.message : String(error))
}
