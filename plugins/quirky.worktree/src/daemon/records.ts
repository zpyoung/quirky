import type { PluginStore } from '@quirky/protocol'
import type { CallerIdentity } from '../../selector'
import type { WorktreeReference } from '../parity-types'
import type { WorktreeControl } from '../control-types'

export type RecordEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: WorktreeControl; all: WorktreeControl[] }>
  changed(data: { repoId: string; worktreeId: string }): void
}

function validReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
  } catch {
    return false
  }
}

function normalizeReferenceInput(
  fail: (message: string) => Error,
  params: { url: unknown; label?: unknown }
): { url: string; label: string } {
  if (typeof params.url !== 'string' || params.url.length > 2_048 || !validReferenceUrl(params.url)) {
    throw fail('url must be an absolute HTTP or HTTPS URL')
  }
  if (params.label !== undefined && typeof params.label !== 'string') throw fail('label must be a string')
  const label = typeof params.label === 'string' ? params.label.trim() : ''
  if (label.length > 120) throw fail('label must be at most 120 characters')
  return { url: params.url, label: label || params.url }
}

function referenceWithIdentity(
  input: { url: string; label: string },
  existing?: WorktreeReference
): WorktreeReference {
  return existing
    ? { ...existing, label: input.label }
    : { id: `ref_${crypto.randomUUID()}`, ...input, createdAt: Date.now() }
}

function referencesOf(store: PluginStore, worktreeId: string): WorktreeReference[] {
  const row = store.get<{ references_json: string }>('SELECT references_json FROM worktrees WHERE id = ?', worktreeId)
  if (!row) return []
  try {
    const value: unknown = JSON.parse(row.references_json)
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.url !== 'string' || typeof record.label !== 'string' || typeof record.createdAt !== 'number') return []
      if (!validReferenceUrl(record.url)) return []
      return [{ id: record.id, url: record.url, label: record.label, createdAt: record.createdAt }]
    })
  } catch {
    return []
  }
}

/** Validates a replacement list while retaining reference identities for URLs already linked. */
export function replacementReferences(
  store: PluginStore,
  worktreeId: string,
  inputs: unknown,
  fail: (message: string) => Error
): WorktreeReference[] {
  if (!Array.isArray(inputs)) throw fail('references must be an array')
  const existing = new Map(referencesOf(store, worktreeId).map((reference) => [reference.url, reference]))
  const replacement = new Map<string, WorktreeReference>()
  for (const item of inputs) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw fail('each reference must be an object with a url')
    }
    const record = item as Record<string, unknown>
    const input = normalizeReferenceInput(fail, { url: record.url, label: record.label })
    const previous = replacement.get(input.url) ?? existing.get(input.url)
    replacement.set(input.url, referenceWithIdentity(input, previous))
  }
  return [...replacement.values()]
}

export async function listReferences(env: RecordEnv, selector: string, identity: CallerIdentity): Promise<WorktreeReference[]> {
  const { worktree } = await env.find(selector, identity)
  return referencesOf(env.store, worktree.id)
}

export async function linkReference(
  env: RecordEnv,
  params: { worktree: string; url: unknown; label?: unknown },
  identity: CallerIdentity
): Promise<WorktreeReference> {
  const input = normalizeReferenceInput((message) => env.fail('invalid-params', message), params)
  const { worktree } = await env.find(params.worktree, identity)
  const references = referencesOf(env.store, worktree.id)
  const existing = references.find((reference) => reference.url === input.url)
  const reference = referenceWithIdentity(input, existing)
  const updated = existing
    ? references.map((item) => item.id === existing.id ? reference : item)
    : [...references, reference]
  env.store.run('UPDATE worktrees SET references_json = ? WHERE id = ?', JSON.stringify(updated), worktree.id)
  env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  return reference
}

export async function unlinkReference(
  env: RecordEnv,
  params: { worktree: string; reference: unknown },
  identity: CallerIdentity
): Promise<{ ok: true }> {
  if (typeof params.reference !== 'string' || params.reference.trim() === '') throw env.fail('invalid-params', 'reference must be a reference ID')
  const { worktree } = await env.find(params.worktree, identity)
  const references = referencesOf(env.store, worktree.id)
  const next = references.filter((reference) => reference.id !== params.reference)
  if (next.length === references.length) throw env.fail('not-found', `no reference ${params.reference} is linked to this worktree`)
  env.store.run('UPDATE worktrees SET references_json = ? WHERE id = ?', JSON.stringify(next), worktree.id)
  env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  return { ok: true }
}

export async function archiveWorktree(
  env: RecordEnv,
  params: { worktree: string; archivedAt?: unknown },
  identity: CallerIdentity
): Promise<WorktreeControl> {
  const { worktree } = await env.find(params.worktree, identity)
  let archivedAt: number | null = Date.now()
  if (params.archivedAt !== undefined) {
    if (params.archivedAt === null) archivedAt = null
    else if (typeof params.archivedAt === 'number' && Number.isSafeInteger(params.archivedAt) && params.archivedAt > 0 && params.archivedAt <= Date.now()) archivedAt = params.archivedAt
    else throw env.fail('invalid-params', 'archivedAt must be a past timestamp or null')
  }
  if (worktree.isMain || worktree.kind !== 'git') throw env.fail('invalid-params', 'only non-primary Git worktrees can be archived')
  env.store.run('UPDATE worktrees SET archived_at = ? WHERE id = ?', archivedAt, worktree.id)
  env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  return (await env.find(worktree.id, identity)).worktree
}
