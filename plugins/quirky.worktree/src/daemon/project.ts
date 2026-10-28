import type { PluginStore, Repo } from '@quirky/protocol'
import type { ExternalVisibility, WorktreeProjectIdentity } from '../parity-types'
import { isSafeIcon } from '../safe-icon'
import { normalizeSharedDirectories } from '../shared-paths'
type PreferenceRow = {
  repo_id: string
  external_visibility: string | null
  external_inbox_suppressed: number
  icon: string | null
  color: string | null
  tracker_project: string | null
  shared_directories: string | null
}

type ProjectEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found', message: string): Error
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  resolveRepo(selector: string): Promise<Repo>
}

export type ProjectMetadata = {
  repoId: string
  identity: WorktreeProjectIdentity
  externalVisibility: ExternalVisibility
  effectiveExternalVisibility: 'show' | 'hide'
  externalInboxSuppressed: boolean
  sharedDirectories: string[]
}
function rowOf(store: PluginStore, repoId: string): PreferenceRow | null {
  return store.get<PreferenceRow>('SELECT * FROM project_preferences WHERE repo_id = ?', repoId)
}

export function projectPreference(store: PluginStore, repoId: string) {
  const row = rowOf(store, repoId)
  const externalVisibility: ExternalVisibility = row?.external_visibility === 'show' || row?.external_visibility === 'hide'
    ? row.external_visibility
    : 'inherit'
  let sharedDirectories: string[] = []
  try {
    sharedDirectories = normalizeSharedDirectories(JSON.parse(row?.shared_directories ?? '[]'))
  } catch {
    sharedDirectories = []
  }
  return {
    externalVisibility,
    externalInboxSuppressed: row?.external_inbox_suppressed === 1,
    icon: row?.icon !== null && row?.icon !== undefined && isSafeIcon(row.icon) ? row.icon.trim() || null : null,
    color: row?.color ?? null,
    trackerProject: row?.tracker_project ?? null,
    sharedDirectories
  }
}

export function projectMetadata(store: PluginStore, repo: Repo, globalExternalVisibility: 'show' | 'hide'): ProjectMetadata {
  const preference = projectPreference(store, repo.id)
  return {
    repoId: repo.id,
    identity: {
      displayName: repo.displayName,
      icon: preference.icon,
      color: preference.color,
      trackerProject: preference.trackerProject
    },
    externalVisibility: preference.externalVisibility,
    effectiveExternalVisibility: preference.externalVisibility === 'inherit' ? globalExternalVisibility : preference.externalVisibility,
    externalInboxSuppressed: preference.externalInboxSuppressed,
    sharedDirectories: preference.sharedDirectories
  }
}

function writePreference(
  store: PluginStore,
  repoId: string,
  patch: Partial<Pick<PreferenceRow, 'external_visibility' | 'external_inbox_suppressed' | 'icon' | 'color' | 'tracker_project' | 'shared_directories'>>
): void {
  const current = projectPreference(store, repoId)
  const externalVisibility = patch.external_visibility === undefined ? current.externalVisibility : patch.external_visibility
  const externalInboxSuppressed = patch.external_inbox_suppressed === undefined ? current.externalInboxSuppressed : patch.external_inbox_suppressed === 1
  const icon = patch.icon === undefined ? current.icon : patch.icon
  const color = patch.color === undefined ? current.color : patch.color
  const trackerProject = patch.tracker_project === undefined ? current.trackerProject : patch.tracker_project
  const sharedDirectories = patch.shared_directories === undefined ? JSON.stringify(current.sharedDirectories) : patch.shared_directories
  store.run(
    `INSERT INTO project_preferences (repo_id, external_visibility, external_inbox_suppressed, icon, color, tracker_project, shared_directories)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET external_visibility = excluded.external_visibility,
       external_inbox_suppressed = excluded.external_inbox_suppressed, icon = excluded.icon,
       color = excluded.color, tracker_project = excluded.tracker_project, shared_directories = excluded.shared_directories`,
    repoId,
    externalVisibility === 'inherit' ? null : externalVisibility,
    externalInboxSuppressed ? 1 : 0,
    icon,
    color,
    trackerProject,
    sharedDirectories
  )
}

function identityOf(value: unknown, fail: ProjectEnv['fail']): Partial<WorktreeProjectIdentity> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('invalid-params', 'identity must be an object')
  const record = value as Record<string, unknown>
  const allowed = new Set(['displayName', 'icon', 'color', 'trackerProject'])
  const extra = Object.keys(record).find((key) => !allowed.has(key))
  if (extra !== undefined) throw fail('invalid-params', `unknown project identity field "${extra}"`)
  const result: Partial<WorktreeProjectIdentity> = {}
  for (const key of ['displayName', 'icon', 'color', 'trackerProject'] as const) {
    const entry = record[key]
    if (entry === undefined) continue
    if (entry !== null && typeof entry !== 'string') throw fail('invalid-params', `${key} must be a string or null`)
    if (key === 'color' && entry !== null && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(entry as string)) {
      throw fail('invalid-params', 'color must be a #RGB or #RRGGBB value')
    }
    if (key === 'icon' && entry !== null && !isSafeIcon(entry as string)) {
      throw fail('invalid-params', 'icon must be a safe plain-text emoji or symbol; URLs, markup, and control characters are not allowed')
    }
    const maximum = key === 'icon' ? 32 : key === 'trackerProject' ? 2048 : 200
    if (entry !== null && (entry as string).length > maximum) throw fail('invalid-params', `${key} is too long`)
    result[key] = entry === null ? null : (entry as string).trim() || null
  }
  return result
}

export async function getProjectMetadata(env: ProjectEnv, selector: string, globalExternalVisibility: 'show' | 'hide') {
  const repo = await env.resolveRepo(selector)
  return projectMetadata(env.store, repo, globalExternalVisibility)
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function resolveTrackerProject(env: ProjectEnv, repo: Repo, input: string): Promise<string> {
  let requested: URL
  try {
    requested = new URL(input)
  } catch {
    throw env.fail('invalid-params', 'trackerProject must be an HTTPS URL to a real provider project')
  }
  if (requested.protocol !== 'https:' || requested.username || requested.password || requested.search || requested.hash) {
    throw env.fail('invalid-params', 'trackerProject must be a credential-free HTTPS provider project URL')
  }
  const resolved = recordOf(await env.call('quirky.hosting/projectRef', { worktree: repo.path, input }))
  if (typeof resolved?.id !== 'string' || resolved.id.trim() === '' || typeof resolved.url !== 'string') {
    throw env.fail('conflict', 'The tracker provider returned an incomplete project identity; no default was saved.')
  }
  let canonical: URL
  try {
    canonical = new URL(resolved.url)
  } catch {
    throw env.fail('conflict', 'The tracker provider returned an invalid project URL; no default was saved.')
  }
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.search || canonical.hash ||
    canonical.host.toLowerCase() !== requested.host.toLowerCase()) {
    throw env.fail('conflict', 'The tracker provider returned an unsafe or mismatched project identity; no default was saved.')
  }
  return canonical.href
}

export async function setProjectMetadata(
  env: ProjectEnv,
  params: { repo: string; identity?: unknown; externalVisibility?: unknown; sharedDirectories?: unknown },
  globalExternalVisibility: 'show' | 'hide'
): Promise<ProjectMetadata> {
  if (typeof params.repo !== 'string' || params.repo.trim() === '') throw env.fail('invalid-params', 'repo must be a project selector')
  const repo = await env.resolveRepo(params.repo)
  if (params.sharedDirectories !== undefined && repo.kind !== 'git') {
    throw env.fail('invalid-params', 'shared directories require a Git project')
  }
  const identity = params.identity === undefined ? undefined : identityOf(params.identity, env.fail)
  if (params.externalVisibility !== undefined && params.externalVisibility !== 'show' && params.externalVisibility !== 'hide' && params.externalVisibility !== 'inherit') {
    throw env.fail('invalid-params', 'externalVisibility must be show, hide or inherit')
  }
  let sharedDirectories: string[] | undefined
  if (params.sharedDirectories !== undefined) {
    try {
      sharedDirectories = normalizeSharedDirectories(params.sharedDirectories)
    } catch (error) {
      throw env.fail('invalid-params', error instanceof Error ? error.message : String(error))
    }
  }
  let trackerProject: string | null | undefined = identity?.trackerProject
  if (identity?.trackerProject !== undefined) {
    const current = projectPreference(env.store, repo.id).trackerProject
    if (identity.trackerProject === current) trackerProject = current
    else if (identity.trackerProject === null) trackerProject = null
    else if (repo.kind !== 'git') throw env.fail('invalid-params', 'tracker project defaults require a Git project with an authenticated provider')
    else trackerProject = await resolveTrackerProject(env, repo, identity.trackerProject)
  }
  if (identity && Object.hasOwn(identity, 'displayName')) {
    await env.call('quirky.repo/set', { repo: repo.id, displayName: identity.displayName ?? '' })
  }
  if (identity || sharedDirectories !== undefined) {
    writePreference(env.store, repo.id, {
      ...(identity?.icon === undefined ? {} : { icon: identity.icon }),
      ...(identity?.color === undefined ? {} : { color: identity.color }),
      ...(identity?.trackerProject === undefined ? {} : { tracker_project: trackerProject ?? null }),
      ...(sharedDirectories === undefined ? {} : { shared_directories: JSON.stringify(sharedDirectories) })
    })
  }
  if (params.externalVisibility !== undefined) {
    writePreference(env.store, repo.id, { external_visibility: params.externalVisibility as ExternalVisibility })
  }
  const updatedRepo = identity && Object.hasOwn(identity, 'displayName') ? await env.resolveRepo(repo.id) : repo
  return projectMetadata(env.store, updatedRepo, globalExternalVisibility)
}

export async function setExternalInboxSuppressed(
  env: ProjectEnv,
  params: { repo: string; suppressed: unknown },
  globalExternalVisibility: 'show' | 'hide'
): Promise<ProjectMetadata> {
  if (typeof params.repo !== 'string' || params.repo.trim() === '') throw env.fail('invalid-params', 'repo must be a project selector')
  if (typeof params.suppressed !== 'boolean') throw env.fail('invalid-params', 'suppressed must be a boolean')
  const repo = await env.resolveRepo(params.repo)
  writePreference(env.store, repo.id, { external_inbox_suppressed: params.suppressed ? 1 : 0 })
  return projectMetadata(env.store, repo, globalExternalVisibility)
}
