import { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree } from '@quirky/protocol'
import { makeTempDir } from '../../../../packages/daemon/test/plugins/fixtures'
import { git, makeRepo } from '../../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../../quirky.repo/test/harness'

export type RealProject = {
  t: PluginHarness
  client: QuirkyClient
  /** Real path of the project's primary checkout, on `main` with one commit. */
  repoDir: string
  /** The worktrees folder the plugin is configured with. */
  root: string
  repo: Repo
}

/** A daemon on real git with one repository added and the worktrees folder pointed at a temp directory. */
export async function startRealProject(scratch: () => string, name = 'api'): Promise<RealProject> {
  const t = await startPluginHarness({ realGit: true })
  const root = realpathSync(makeTempDir('qw-'))
  await t.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repoDir = makeRepo(join(scratch(), name))
  const repo = (await t.client.callAny('quirky.repo/add', { path: repoDir })) as Repo
  return { t, client: t.client, repoDir, root, repo }
}

/** A worktree made by plain git, outside Quirky, on a new branch named `branch`. */
export function addExternalWorktree(repoDir: string, path: string, branch: string): string {
  git(repoDir, 'worktree', 'add', '-q', '-b', branch, path)
  return realpathSync(path)
}

/** The `worktrees` rows of the plugin's store, read straight from its database file. */
export function storedRows(home: string, where = '1 = 1', ...params: string[]): Record<string, unknown>[] {
  const db = new Database(join(home, 'plugin-data', 'quirky.worktree', 'store.db'), { readonly: true })
  try {
    return db.query(`SELECT * FROM worktrees WHERE ${where}`).all(...params) as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

export const listWorktrees = async (client: QuirkyClient, params: Record<string, unknown> = {}) =>
  (await client.callAny('quirky.worktree/list', params)) as Worktree[]
