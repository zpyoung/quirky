import type { ProjectGroup, Repo, Worktree, WorktreeCreatedBy } from '@quirky/protocol'
import { resolveRealPath } from '../../paths'
import { InvalidNameError, sanitizeName } from './naming'
import { pickGeneratedName } from './names'
import { groupRepoId, listGroup, listProject, type ListEnv } from './list'
import { insertRow } from './store'

export type FolderEnv = ListEnv & {
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
  changed(data: { repoId: string; worktreeId: string }): void
}

export type FolderCreateParams = {
  name?: string
  createdBy?: WorktreeCreatedBy
  displayName?: string
  comment?: string
  parentId?: string | null
  /** Picks the name for a blank create from the names it must avoid; defaults to a random marine name. */
  generate?: (unavailable: ReadonlySet<string>) => string
}

const randomWorktreeId = (): string => `wt_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`

/**
 * Registers a folder workspace on a folder project's folder or on a group's parent folder, with
 * no git and no files touched. A blank `name` takes a generated one, which is retired so later
 * creates don't hand it out again; a typed name is only sanitised.
 */
export async function createFolderWorkspace(env: FolderEnv, target: { repo: Repo } | { group: ProjectGroup }, params: FolderCreateParams): Promise<Worktree> {
  const isGroup = 'group' in target
  if (isGroup && !target.group.parentPath) throw env.fail('invalid-params', `group ${target.group.name} has no parent folder`)
  const repoId = isGroup ? groupRepoId(target.group.id) : target.repo.id
  const path = resolveRealPath(isGroup ? target.group.parentPath! : target.repo.path)
  const existing = isGroup ? listGroup(env, target.group) : await listProject(env, target.repo)

  const typed = params.name?.trim() ?? ''
  let name: string
  let generated = false
  if (typed === '') {
    const retired = env.store.all<{ name: string }>('SELECT name FROM retired_names WHERE repo_id = ?', repoId).map((row) => row.name)
    const unavailable = new Set([...existing.map((worktree) => worktree.name), ...retired])
    name = (params.generate ?? pickGeneratedName)(unavailable)
    generated = true
  } else {
    try {
      name = sanitizeName(typed)
    } catch (error) {
      if (error instanceof InvalidNameError) throw env.fail('invalid-params', error.message, { reason: 'invalid-name' })
      throw error
    }
  }

  const id = randomWorktreeId()
  env.store.transaction(() => {
    insertRow(env.store, {
      id,
      repoId,
      kind: 'folder',
      path,
      name,
      createdAt: Date.now(),
      createdBy: params.createdBy ?? 'api',
      displayName: params.displayName?.trim() || null,
      comment: params.comment ?? '',
      parentId: params.parentId ?? null,
      groupId: isGroup ? target.group.id : null
    })
    if (generated) env.store.run('INSERT OR IGNORE INTO retired_names (repo_id, name) VALUES (?, ?)', repoId, name)
  })
  env.changed({ repoId, worktreeId: id })
  const created = (isGroup ? listGroup(env, target.group) : await listProject(env, target.repo)).find((worktree) => worktree.id === id)
  return created!
}
