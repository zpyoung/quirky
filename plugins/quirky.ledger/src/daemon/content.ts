import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { LedgerLocation, LedgerType } from '../types'
import type { OwnerCatalog, WorkspaceContext } from './owners'

type Fail = (domain: string, message: string, data?: Record<string, unknown>) => never

const LOCATION_FIELD: Partial<Record<LedgerType, string>> = { bug: 'file', 'test-gap': 'file_under_test' }
const REQUIRED: Record<LedgerType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}
const ENUMS: Partial<Record<LedgerType, Record<string, string[]>>> = {
  bug: { severity: ['critical', 'high', 'medium', 'low'] },
  deferred: { priority: ['high', 'medium', 'low'] },
  decision: { status: ['proposed', 'accepted', 'superseded'] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null'
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function baseRoot(base: LedgerLocation['base'], catalog: OwnerCatalog, fail: Fail): string {
  if (base.kind === 'project') {
    const repo = catalog.repos.find((item) => item.id === base.id)
    if (!repo) fail('owner-missing', `project location base ${base.id} is unavailable`)
    return repo.path
  }
  const workspace = catalog.worktrees.find((item) => item.id === base.id)
  if (!workspace) fail('workspace-missing', `workspace location base ${base.id} is unavailable`)
  return workspace.path
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function canonicalExisting(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function parseRawPath(value: string, fail: Fail): { path: string; line?: number } {
  const matched = value.match(/^(.*):(\d+)$/)
  if (!matched) return { path: value }
  const line = Number(matched[2])
  if (!Number.isSafeInteger(line) || line <= 0) fail('invalid-request', 'location line must be a positive safe integer')
  return { path: matched[1]!, line }
}

function locationOf(
  value: unknown,
  catalog: OwnerCatalog,
  workspace: WorkspaceContext | undefined,
  fail: Fail,
  externalHost?: string
): LedgerLocation {
  const raw = typeof value === 'string' ? { ...parseRawPath(value, fail) } : isRecord(value) ? { ...value } : null
  if (!raw) fail('invalid-request', 'location must be a path string or structured location')
  if (typeof raw.path !== 'string' || !raw.path.trim()) fail('invalid-request', 'location path must be a non-empty string')
  let base: LedgerLocation['base']
  if (isRecord(raw.base)) {
    const kind = raw.base.kind
    const id = raw.base.id
    if ((kind !== 'project' && kind !== 'workspace') || typeof id !== 'string' || !id.trim()) fail('invalid-request', 'location base must identify a project or workspace')
    if (raw.base.host !== undefined && typeof raw.base.host !== 'string') fail('invalid-request', 'location base host must be a string')
    base = { kind, id, ...(raw.base.host !== undefined ? { host: raw.base.host as string } : {}) }
  } else if (workspace) {
    base = workspace.repo.kind === 'git'
      ? { kind: 'project', id: workspace.repo.id }
      : { kind: 'workspace', id: workspace.workspace.id }
  } else {
    fail('invalid-target', 'a workspace is required to normalize a raw location')
  }

  const root = baseRoot(base, catalog, fail)
  const given = raw.path.trim()
  const absolutePath = isAbsolute(given) ? resolve(given) : resolve(root, given)
  const explicitExternal = raw.external === true
  let external = explicitExternal || !inside(resolve(root), absolutePath)
  const real = canonicalExisting(absolutePath)
  if (real && !inside(canonicalExisting(root) ?? resolve(root), real)) external = true
  if (!real && !external) {
    // A missing leaf can still traverse a symlink outside the owner root; resolve the nearest existing parent.
    let parent = dirname(absolutePath)
    let resolvedParent = canonicalExisting(parent)
    while (!resolvedParent && parent !== dirname(parent)) {
      parent = dirname(parent)
      resolvedParent = canonicalExisting(parent)
    }
    if (resolvedParent && !inside(canonicalExisting(root) ?? resolve(root), resolvedParent)) external = true
  }

  const line = raw.line
  if (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line <= 0)) fail('invalid-request', 'location line must be a positive safe integer')
  const suppliedHost = raw.host
  if (suppliedHost !== undefined && (typeof suppliedHost !== 'string' || suppliedHost.trim() === '')) fail('invalid-request', 'external host must be a non-empty string')
  if (raw.external !== undefined && typeof raw.external !== 'boolean') fail('invalid-request', 'external must be a boolean')
  const host = external && typeof suppliedHost === 'string' ? suppliedHost.trim() : external ? externalHost : undefined
  if (external && !host) fail('invalid-request', 'external locations require a host')
  const path = external ? absolutePath : relative(resolve(root), absolutePath).split(sep).join('/')
  return {
    path,
    ...(line !== undefined ? { line: line as number } : {}),
    base,
    ...(external ? { external: true, host } : {})
  }
}

export function validateContent(
  type: LedgerType,
  content: Record<string, unknown>,
  options: { catalog: OwnerCatalog; workspace?: WorkspaceContext; normalizeFields?: Set<string>; externalHost?: string; fail: Fail }
): Record<string, unknown> {
  const result = { ...content }
  const locationField = LOCATION_FIELD[type]
  if (locationField && result[locationField] !== undefined && options.normalizeFields?.has(locationField)) {
    result[locationField] = locationOf(result[locationField], options.catalog, options.workspace, options.fail, options.externalHost)
  }

  for (const field of REQUIRED[type]) {
    const value = result[field]
    if (field === locationField) {
      if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim()) options.fail('invalid-request', `${field} must be a scoped location`)
      const base = value.base
      if (!isRecord(base) || (base.kind !== 'project' && base.kind !== 'workspace') || typeof base.id !== 'string' || !base.id.trim()) options.fail('invalid-request', `${field} must have a valid location base`)
      if (value.line !== undefined && (typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line <= 0)) options.fail('invalid-request', `${field} line must be a positive safe integer`)
      if (value.external === true && (typeof value.host !== 'string' || !value.host.trim())) options.fail('invalid-request', `${field} external host is required`)
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') options.fail('invalid-request', `${field} is required and must not be blank`)
  }
  for (const [field, allowed] of Object.entries(ENUMS[type] ?? {})) {
    if (!allowed.includes(String(result[field]))) options.fail('invalid-enum', `Invalid ${field}: ${String(result[field])}`, { field, eligible: allowed })
  }
  return result
}

export function mergeAndValidateContent(
  type: LedgerType,
  previous: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
  options: { catalog: OwnerCatalog; workspace?: WorkspaceContext; normalizeFields?: Set<string>; externalHost?: string; fail: Fail }
): Record<string, unknown> {
  return validateContent(type, { ...(previous ?? {}), ...patch }, options)
}

export function locationFieldOf(type: LedgerType): string | undefined {
  return LOCATION_FIELD[type]
}

export function editableFieldsOf(type: LedgerType): string[] {
  return REQUIRED[type]
}

export function canonicalPathForEvidence(root: string, path: string): string | null {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const realRoot = canonicalExisting(root) ?? resolve(root)
  if (!inside(realRoot, absolutePath)) return null
  const realPath = canonicalExisting(absolutePath)
  if (realPath) return inside(realRoot, realPath) ? realPath : null
  let parent = dirname(absolutePath)
  let realParent = canonicalExisting(parent)
  while (!realParent && parent !== dirname(parent)) {
    parent = dirname(parent)
    realParent = canonicalExisting(parent)
  }
  if (realParent && !inside(realRoot, realParent)) return null
  return absolutePath
}

export function fileExistsSafely(root: string, path: string): boolean | null {
  const safe = canonicalPathForEvidence(root, path)
  if (safe === null) return null
  return existsSync(safe)
}
