import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { PluginStore, ProjectGroup, Repo, Worktree } from '@quirky/protocol'
import { gitApi } from '@quirky/git'
import { resolveRealPath, worktreeIdForPath } from '../../paths'
import { instanceIdFor, filesystemIdentitySource, type DirectoryIdentitySource } from './identity'
import { insertRow, metadataOf, rowOf, type WorktreeRow } from './store'

/** What the join needs from the plugin: the store, group lookup, identity source and in-flight removes. */
export type ListEnv = {
  store: PluginStore
  groups(): Promise<ProjectGroup[]>
  log(message: string): void
  /** Injectable internal seam; production uses the filesystem source. */
  identitySource?: DirectoryIdentitySource
  /** IDs whose remove is in flight in this daemon. */
  removing: ReadonlySet<string>
}

/** The `repoId` of a workspace that belongs to a group's parent folder rather than a project. */
export const groupRepoId = (groupId: string): string => `group:${groupId}`

type Facts = Pick<Worktree, 'id' | 'repoId' | 'path' | 'branch' | 'head' | 'isMain' | 'kind' | 'groupId'>

/** A folder's birth time in whole milliseconds, or null when it can't be read. */
export function birthtimeOf(path: string): number | null {
  try {
    return Math.round(statSync(path).birthtimeMs)
  } catch {
    return null
  }
}

/**
 * The record for a workspace: its facts (git or folder) joined with its stored metadata.
 * `name` is the display name, else the branch for a primary checkout, the given name for a
 * non-primary folder workspace and the folder name for everything else.
 */
export function joinMetadata(facts: Facts, row: WorktreeRow, removing: boolean): Worktree {
  const folderName = basename(facts.path)
  const name =
    row.display_name ||
    (facts.isMain ? (facts.branch ?? folderName) : facts.kind === 'folder' ? (row.name ?? folderName) : folderName)
  return { ...facts, name, ...metadataOf(row), removing }
}

/** Primary first, then oldest first, then by ID so the order is total. */
function compare(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The row for a workspace seen on disk: the stored one, or defaults written on first sight. A row
 * whose recorded birth time differs from the folder's belongs to an earlier folder at the same
 * path, so it is discarded and the workspace starts from defaults.
 */
function rowForFolder(env: ListEnv, repoId: string, kind: 'git' | 'folder', path: string, id: string, fallbackCreatedAt: number): WorktreeRow {
  const identitySource = env.identitySource ?? filesystemIdentitySource
  const identity = identitySource.stat(path)
  const instanceId = identity === null ? null : instanceIdFor(identity)
  const birthtime = identity === null ? birthtimeOf(path) : Math.round(identity.birthtimeMs)
  let row = rowOf(env.store, id)
  const differentBirthtime = row && row.birthtime !== null && birthtime !== null && row.birthtime !== birthtime
  const differentInstance =
    row && instanceId !== null && row.instance_id !== '' && !row.instance_id.startsWith('unverified:') && row.instance_id !== instanceId
  if (row && (differentBirthtime || differentInstance || row.repo_id !== repoId)) {
    // a row of a removed and re-added project is the same case: its metadata must not carry over
    if (differentBirthtime || differentInstance) env.log(`discarded the metadata of ${id}: ${path} is a different folder than the one it was recorded for`)
    env.store.run('DELETE FROM worktrees WHERE id = ?', id)
    row = null
  }
  const complete =
    row && row.birthtime !== null && row.created_at !== null && row.path === path && row.kind === kind && (instanceId === null || row.instance_id === instanceId)
  if (complete) return row!
  return insertRow(env.store, {
    id,
    repoId,
    kind,
    path,
    createdAt: birthtime ?? fallbackCreatedAt,
    createdBy: 'external',
    birthtime,
    instanceId: instanceId ?? (row?.instance_id ? row.instance_id : undefined)
  })
}

/**
 * The workspaces of a git project: its registrations that are neither prunable nor missing,
 * joined with their metadata. Rows are removed only when git answered and neither a registration
 * nor a folder remains for them, so a failed git call (which throws) changes nothing.
 * `prune: false` skips that removal for callers that only need the IDs.
 */
async function listGitProject(env: ListEnv, repo: Repo, prune: boolean): Promise<Worktree[]> {
  const registrations = await gitApi().listRegistrations(repo.path)
  const registered = new Set(registrations.map((registration) => worktreeIdForPath(registration.path)))
  return env.store.transaction(() => {
    const result: Worktree[] = []
    for (const registration of registrations) {
      if (registration.prunable || !registration.exists) continue
      const id = worktreeIdForPath(registration.path)
      const path = resolveRealPath(registration.path)
      const row = rowForFolder(env, repo.id, 'git', path, id, Date.now())
      const facts: Facts = {
        id,
        repoId: repo.id,
        path,
        branch: registration.branch,
        head: registration.head,
        isMain: registration.isMain,
        kind: 'git',
        groupId: null
      }
      result.push(joinMetadata(facts, row, env.removing.has(id)))
    }
    if (prune) {
      for (const row of env.store.all<WorktreeRow>("SELECT * FROM worktrees WHERE repo_id = ? AND kind = 'git' AND group_id IS NULL", repo.id)) {
        if (registered.has(row.id) || (row.path !== null && existsSync(row.path))) continue
        env.store.run('DELETE FROM worktrees WHERE id = ?', row.id)
      }
    }
    return result.sort(compare)
  })
}

/** A folder project's workspaces: the synthesised primary plus its folder-workspace rows. */
function listFolderProject(env: ListEnv, repo: Repo): Worktree[] {
  return env.store.transaction(() => {
    const path = resolveRealPath(repo.path)
    const primaryId = worktreeIdForPath(repo.path)
    const primary = rowForFolder(env, repo.id, 'folder', path, primaryId, repo.addedAt)
    const result = [
      joinMetadata({ id: primaryId, repoId: repo.id, path, branch: null, head: '', isMain: true, kind: 'folder', groupId: null }, primary, env.removing.has(primaryId))
    ]
    for (const row of env.store.all<WorktreeRow>("SELECT * FROM worktrees WHERE repo_id = ? AND kind = 'folder' AND id != ?", repo.id, primaryId)) {
      const rowPath = row.path ?? path
      const metadata = rowForFolder(env, repo.id, 'folder', rowPath, row.id, row.created_at ?? repo.addedAt)
      const facts: Facts = { id: row.id, repoId: repo.id, path: rowPath, branch: null, head: '', isMain: false, kind: 'folder', groupId: null }
      result.push(joinMetadata(facts, metadata, env.removing.has(row.id)))
    }
    return result.sort(compare)
  })
}

/**
 * Every workspace of a project, primary first. A git project's list throws when git can't be
 * asked; a folder project needs no git.
 */
export async function listProject(env: ListEnv, repo: Repo, options: { prune?: boolean } = {}): Promise<Worktree[]> {
  return repo.kind === 'folder' ? listFolderProject(env, repo) : listGitProject(env, repo, options.prune !== false)
}

/** The folder workspaces on a group's parent folder. */
export function listGroup(env: ListEnv, group: ProjectGroup): Worktree[] {
  const rows = env.store.all<WorktreeRow>('SELECT * FROM worktrees WHERE group_id = ?', group.id)
  return env.store.transaction(() =>
    rows
      .map((row) => {
        const path = row.path ?? group.parentPath ?? ''
        const metadata = rowForFolder(env, row.repo_id, 'folder', path, row.id, row.created_at ?? Date.now())
        return joinMetadata(
          { id: row.id, repoId: groupRepoId(group.id), path, branch: null, head: '', isMain: false, kind: 'folder', groupId: group.id },
          metadata,
          env.removing.has(row.id)
        )
      })
      .sort(compare)
  )
}

/** Every project's workspaces, then every group's; a project git can't list is logged and left out. */
export async function listEverything(env: ListEnv, repos: Repo[]): Promise<Worktree[]> {
  const lists = await Promise.all(
    repos.map((repo) =>
      listProject(env, repo).catch((error) => {
        env.log(`could not list the workspaces of ${repo.name}: ${error instanceof Error ? error.message : String(error)}`)
        return [] as Worktree[]
      })
    )
  )
  const groups = await env.groups().catch(() => [] as ProjectGroup[])
  return [...lists.flat(), ...groups.flatMap((group) => listGroup(env, group))]
}
