import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { LedgerEntry, LedgerOperation, LedgerOwner, LedgerRequest, LedgerResponse, LedgerType } from './src/types'

const OPERATIONS: LedgerOperation[] = [
  'file', 'list', 'show', 'edit', 'state', 'review', 'revert', 'import', 'catalog', 'approve', 'bulk-state', 'delete-entries', 'delete-ledger', 'attach', 'settings', 'removal-preview'
]

const CONTENT_FLAGS: Record<string, string> = {
  title: 'title',
  file: 'file',
  description: 'description',
  severity: 'severity',
  'why-deferred': 'why_deferred',
  priority: 'priority',
  'file-under-test': 'file_under_test',
  'reason-skipped': 'reason_skipped',
  context: 'context',
  recommendation: 'recommendation',
  decision: 'decision',
  consequences: 'consequences',
  status: 'status'
}

const REQUIRED_CONTENT: Record<LedgerType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(args: CliArgs, flag: string): string | undefined {
  const value = args.flags[flag]
  return typeof value === 'string' ? value : undefined
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function locationFlag(value: unknown, host: unknown, external: unknown, baseKind: unknown, baseId: unknown, ctx: CliContext): unknown {
  if (typeof value !== 'string') return undefined
  const hostValue = typeof host === 'string' ? host : undefined
  const isExternal = external === true
  if (!hostValue && !isExternal && baseKind === undefined && baseId === undefined) return value
  if (isExternal && !hostValue) throw ctx.usage('External host is required when --external is set')
  if ((baseKind === undefined) !== (baseId === undefined)) throw ctx.usage('--location-base-kind and --location-base-id must be supplied together')
  const matched = value.match(/^(.*):(\d+)$/)
  const location: Record<string, unknown> = { path: matched ? matched[1] : value }
  if (matched) location.line = Number(matched[2])
  if (hostValue !== undefined) location.host = hostValue
  if (isExternal) location.external = true
  if (typeof baseKind === 'string' && typeof baseId === 'string') location.base = { kind: baseKind, id: baseId }
  return location
}

function contentOf(args: CliArgs, ctx: CliContext): Record<string, unknown> {
  const raw = args.flags.content
  const content: Record<string, unknown> = raw === undefined ? {} : object(raw) ? { ...raw } : (() => { throw ctx.usage('--content must be a JSON object') })()
  for (const [flag, field] of Object.entries(CONTENT_FLAGS)) {
    const value = args.flags[flag]
    if (value === undefined) continue
    if (field === 'file' || field === 'file_under_test') {
      content[field] = locationFlag(value, args.flags.host, args.flags.external, args.flags['location-base-kind'], args.flags['location-base-id'], ctx)
    } else {
      content[field] = value
    }
  }
  return content
}

function targetOf(args: CliArgs, operation: LedgerOperation, ctx: CliContext): LedgerRequest['target'] {
  const workspace = optionalString(args, 'workspace')
  const positionalLedger = ['approve', 'bulk-state', 'delete-entries', 'delete-ledger', 'attach', 'settings'].includes(operation) ? args.positionals[0] : undefined
  const ledgerId = optionalString(args, 'ledger') ?? positionalLedger
  const ownerId = optionalString(args, 'owner')
  const ownerTier = optionalString(args, 'owner-tier')
  const listOriginWorkspace = operation === 'list' && (ledgerId !== undefined || ownerId !== undefined) ? workspace : undefined
  if (operation !== 'list' && ledgerId && workspace) throw ctx.usage('--ledger cannot be combined with --workspace')
  const target: NonNullable<LedgerRequest['target']> = {}
  if (ledgerId) target.ledgerId = ledgerId
  if (ownerId) target.owner = { tier: (ownerTier ?? 'project') as LedgerOwner['tier'], id: ownerId }
  if (workspace && !listOriginWorkspace) target.workspaceId = workspace
  if (args.flags.group === true) target.group = true
  const groupSelector = optionalString(args, 'group-selector')
  if (groupSelector) target.groupSelector = groupSelector
  if (Object.keys(target).length === 0) return undefined
  return target
}

function filtersOf(args: CliArgs, operation: LedgerOperation): LedgerRequest['filters'] {
  if (operation !== 'list' && operation !== 'review') return undefined
  const filters: NonNullable<LedgerRequest['filters']> = {}
  for (const key of ['type', 'state', 'branch', 'search', 'sort'] as const) {
    const value = args.flags[key]
    if (value !== undefined) filters[key] = value as never
  }
  const reviewed = args.flags.reviewed
  if (reviewed === 'true' || reviewed === 'false') filters.reviewed = reviewed === 'true'
  const stale = args.flags.stale
  if (stale === 'true' || stale === 'false') filters.stale = stale === 'true'
  const originWorkspace = optionalString(args, 'origin-workspace')
  const workspaceFilter = operation === 'list' && (args.flags.ledger !== undefined || args.flags.owner !== undefined) ? optionalString(args, 'workspace') : undefined
  const selected = originWorkspace ?? workspaceFilter
  if (selected !== undefined) filters.workspaceId = selected
  return Object.keys(filters).length ? filters : undefined
}

function idOf(args: CliArgs, operation: LedgerOperation, ctx: CliContext): string | undefined {
  if (!['show', 'edit', 'state', 'revert'].includes(operation)) return undefined
  const flagId = optionalString(args, 'id')
  const positional = args.positionals[0]
  if (flagId && positional && flagId !== positional) throw ctx.usage('Use either a positional id or --id, not both')
  const id = flagId ?? positional
  if (!id) throw ctx.usage(`${operation} requires an entry id`)
  return id
}

function requestOf(operation: LedgerOperation, args: CliArgs, ctx: CliContext): LedgerRequest {
  const request: LedgerRequest = { operation }
  const target = targetOf(args, operation, ctx)
  if (operation === 'list' && target && (target.ledgerId || target.owner) && optionalString(args, 'workspace') && optionalString(args, 'origin-workspace') && optionalString(args, 'workspace') !== optionalString(args, 'origin-workspace')) {
    throw ctx.usage('--workspace and --origin-workspace select different list filters')
  }
  if (target) request.target = target
  const filters = filtersOf(args, operation)
  if (filters) request.filters = filters
  const id = idOf(args, operation, ctx)
  if (id) request.id = id
  const scalarFlags: Record<string, keyof LedgerRequest> = {
    type: 'type',
    state: 'state',
    'if-revision': 'ifRevision',
    'to-revision': 'toRevision',
    'if-ledger-revision': 'ifLedgerRevision',
    'stale-after-days': 'staleAfterDays'
  }
  for (const [flag, key] of Object.entries(scalarFlags)) {
    if ((operation === 'list' || operation === 'review') && (key === 'type' || key === 'state')) continue
    if (args.flags[flag] !== undefined) (request as Record<string, unknown>)[key] = args.flags[flag]
  }
  const content = contentOf(args, ctx)
  if (Object.keys(content).length) request.content = content
  if (args.flags.selections !== undefined) request.selections = args.flags.selections as LedgerRequest['selections']
  if (args.flags['attach-to'] !== undefined) request.attachTo = args.flags['attach-to'] as LedgerOwner
  const repoIds = stringList(args.flags['repo-id'])
  const groupIds = stringList(args.flags['group-id'])
  if (operation === 'removal-preview') {
    const supplied = args.flags.removal
    const removal = object(supplied) ? { ...supplied } : {}
    if (repoIds.length) removal.repoIds = repoIds
    if (groupIds.length) removal.groupIds = groupIds
    if (args.flags['expected-ledgers'] !== undefined) removal.expectedLedgers = args.flags['expected-ledgers']
    request.removal = removal as LedgerRequest['removal']
  }
  if (['bulk-state', 'delete-entries', 'delete-ledger', 'attach'].includes(operation)) request.confirmed = true
  return request
}

function requireFileFlags(request: LedgerRequest, ctx: CliContext): void {
  if (!request.type) throw ctx.usage('Missing required --type')
  const content = request.content ?? {}
  const required = (REQUIRED_CONTENT as Record<string, string[]>)[request.type]
  if (!required) return
  for (const field of required) {
    if (content[field] === undefined || content[field] === '') {
      const flag = Object.entries(CONTENT_FLAGS).find(([, name]) => name === field)?.[0] ?? field.replaceAll('_', '-')
      throw ctx.usage(`Missing required --${flag}`)
    }
  }
}

function entryLine(entry: LedgerEntry): string {
  return `${entry.id} [${entry.type}] ${String(entry.content.title ?? '')} (${entry.state}, r${entry.revision}, reviewed:${entry.reviewed})`
}

function textOf(operation: LedgerOperation, response: LedgerResponse): string {
  const lines = [`runtime ${response.runtime.runtimeId} profile ${response.runtime.profileId}${response.ledger ? ` ledger ${response.ledger.ledgerId}` : ''}`]
  if (operation === 'file' && response.entry) {
    lines.push(`filed ${response.entry.id} [${response.entry.type}] ${String(response.entry.content.title ?? '')}`)
    for (const match of response.matches ?? []) lines.push(`possible duplicate: ${entryLine(match)}`)
  } else if (operation === 'import' && response.importResult) {
    const result = response.importResult
    lines.push(`created ${result.created.length}, updated ${result.updated.length}, already present ${result.alreadyPresent.length}, skipped ${result.skipped.length}`)
    for (const skipped of result.skipped) lines.push(`skipped ${skipped.sourcePath ?? '-'}${skipped.anchor ? ` (${skipped.anchor})` : ''}: ${skipped.reason}`)
    for (const id of result.created) lines.push(`created ${id}`)
    for (const id of result.updated) lines.push(`updated ${id}`)
  } else if (operation === 'catalog') {
    const ledgers = response.ledgers ?? []
    if (!ledgers.length) lines.push('(no ledgers)')
    else for (const ledger of ledgers) lines.push(`${ledger.name}, ${ledger.owner?.tier ?? 'detached'} · ${ledger.entryCount} entries · revision ${ledger.revision}`)
  } else if (operation === 'removal-preview') {
    const snapshots = response.removalPreview ?? []
    if (!snapshots.length) lines.push('no ledger records will be detached')
    else for (const item of snapshots) lines.push(`${item.ledgerId} r${item.revision} · ${item.entryCount} entries retained`)
  } else if (operation === 'show' && response.entry) {
    lines.push(entryLine(response.entry))
    for (const revision of response.entry.history) lines.push(`r${revision.revision} ${revision.at} ${revision.actor.kind} changed ${revision.changedFields.join(', ')}`)
  } else if (operation === 'review') {
    for (const candidate of response.candidates ?? []) lines.push(`${entryLine(candidate.entry)} · ${candidate.stale ? 'stale' : 'fresh'} · ${candidate.reason} · ${candidate.evidence.note ?? 'evidence unavailable'}`)
    if (!response.candidates?.length) lines.push('(no ledger entries)')
  } else {
    const entries = response.entries ?? (response.entry ? [response.entry] : [])
    for (const entry of entries) lines.push(entryLine(entry))
    if (entries.length === 0 && operation !== 'settings' && operation !== 'attach' && operation !== 'delete-ledger') lines.push('(no ledger entries)')
    if (response.ledger && operation === 'settings') lines.push(`stale after ${response.ledger.staleAfterDays} days`)
    if (response.ledger && operation === 'attach') lines.push(`attached ${response.ledger.ledgerId} to ${response.ledger.name}`)
  }
  return lines.join('\n')
}

async function run(operation: LedgerOperation, args: CliArgs, ctx: CliContext): Promise<void> {
  const request = requestOf(operation, args, ctx)
  if (operation === 'file') requireFileFlags(request, ctx)
  if (operation === 'edit' && (!request.content || Object.keys(request.content).length === 0)) throw ctx.usage('Edit requires at least one content field')
  if (operation === 'state' && request.state === undefined) throw ctx.usage('Missing required --state')
  if (operation === 'state' && request.ifRevision === undefined) throw ctx.usage('Missing required --if-revision')
  if (operation === 'edit' && request.ifRevision === undefined) throw ctx.usage('Missing required --if-revision')
  if (operation === 'revert' && request.ifRevision === undefined) throw ctx.usage('Missing required --if-revision')
  if (operation === 'revert' && request.toRevision === undefined) throw ctx.usage('Missing required --to-revision')
  if (operation === 'settings' && request.staleAfterDays !== undefined && request.ifLedgerRevision === undefined) throw ctx.usage('Missing required --if-ledger-revision')
  if (operation === 'attach' && request.ifLedgerRevision === undefined) throw ctx.usage('Missing required --if-ledger-revision')
  if (operation === 'delete-ledger' && request.ifLedgerRevision === undefined) throw ctx.usage('Missing required --if-ledger-revision')
  const { operation: _operation, ...params } = request
  const response = (await ctx.call(`quirky.ledger/${operation}`, params as Record<string, unknown>)) as LedgerResponse
  ctx.out.result(response, () => textOf(operation, response))
  if (operation === 'import' && (response.importResult?.skipped.length ?? 0) > 0) {
    throw ctx.fail(`ledger import skipped ${response.importResult!.skipped.length} record${response.importResult!.skipped.length === 1 ? '' : 's'}`)
  }
}

const named: CliModule['commands'] = Object.fromEntries(
  OPERATIONS.map((operation) => [operation, (args: CliArgs, ctx: CliContext) => run(operation, args, ctx)])
)

export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, handler]) => [`cli-command:quirky.ledger/${name}`, handler]))
}
