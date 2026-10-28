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

function referencesOf(env: RecordEnv, worktreeId: string): WorktreeReference[] {
  const row = env.store.get<{ references_json: string }>('SELECT references_json FROM worktrees WHERE id = ?', worktreeId)
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

export async function listReferences(env: RecordEnv, selector: string, identity: CallerIdentity): Promise<WorktreeReference[]> {
  const { worktree } = await env.find(selector, identity)
  return referencesOf(env, worktree.id)
}

export async function linkReference(
  env: RecordEnv,
  params: { worktree: string; url: unknown; label?: unknown },
  identity: CallerIdentity
): Promise<WorktreeReference> {
  if (typeof params.url !== 'string' || params.url.length > 2_048 || !validReferenceUrl(params.url)) {
    throw env.fail('invalid-params', 'url must be an absolute HTTP or HTTPS URL')
  }
  if (params.label !== undefined && typeof params.label !== 'string') throw env.fail('invalid-params', 'label must be a string')
  const label = typeof params.label === 'string' ? params.label.trim() : ''
  if (label.length > 120) throw env.fail('invalid-params', 'label must be at most 120 characters')
  const { worktree } = await env.find(params.worktree, identity)
  const references = referencesOf(env, worktree.id)
  const existing = references.find((reference) => reference.url === params.url)
  const reference: WorktreeReference = existing
    ? { ...existing, label: label || params.url }
    : { id: `ref_${crypto.randomUUID()}`, url: params.url, label: label || params.url, createdAt: Date.now() }
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
  const references = referencesOf(env, worktree.id)
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
