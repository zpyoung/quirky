import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gitApi } from '@quirky/git'
import type { PluginStore, Repo } from '@quirky/protocol'

const PREPARATION_DIR = '.quirky-preparing'
const PREPARATION_LIMIT = 3
export const PREPARATION_TTL_MS = 5 * 60_000
const REASON_PREFIX = 'quirky.worktree/prepared:v1:'

type PreparedWorktreeRow = {
  id: string
  repo_id: string
  repo_path: string
  root_path: string
  base_ref: string
  base_oid: string
  path: string
  owner_id: string
  created_at: number
}

type PreparedEnv = {
  store: PluginStore
  ownerId: string
  log(message: string): void
}

export type PrepareResult = { prepared: boolean; reason?: string; id?: string; baseRef?: string; baseOid?: string; expiresAt?: number }

function reasonOf(row: PreparedWorktreeRow): string {
  return `${REASON_PREFIX}${row.owner_id}:${row.id}`
}

function preparedPathIsOwned(row: PreparedWorktreeRow): boolean {
  if (!isAbsolute(row.root_path) || !isAbsolute(row.path)) return false
  const directory = resolve(row.root_path, PREPARATION_DIR)
  const path = resolve(row.path)
  const child = relative(directory, path)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false
  try {
    const rootStat = lstatSync(row.root_path)
    const poolStat = lstatSync(directory)
    if (rootStat.isSymbolicLink() || poolStat.isSymbolicLink() || !rootStat.isDirectory() || !poolStat.isDirectory()) return false
    const pathStat = lstatSync(path)
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) return false
    return realpathSync(path) === path
  } catch {
    return false
  }
}

function preparedRows(store: PluginStore): PreparedWorktreeRow[] {
  return store.all<PreparedWorktreeRow>('SELECT * FROM prepared_worktrees ORDER BY created_at, id')
}

function deleteRow(store: PluginStore, id: string): void {
  store.run('DELETE FROM prepared_worktrees WHERE id = ?', id)
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', repoPath, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed (exit ${exitCode})`)
  return stdout
}

async function registrationOf(repo: Repo, row: PreparedWorktreeRow) {
  if (repo.id !== row.repo_id || repo.path !== row.repo_path || !preparedPathIsOwned(row)) return null
  const registrations = await gitApi().listRegistrations(repo.path)
  const registration = registrations.find((entry) => resolve(entry.path) === resolve(row.path))
  if (!registration || registration.branch !== null || registration.head !== row.base_oid || registration.locked !== reasonOf(row)) return null
  return registration
}
export async function isOwnedPreparedRegistration(
  store: PluginStore,
  repo: Repo,
  registration: { path: string; branch: string | null; head: string; locked: string | null; exists: boolean }
): Promise<boolean> {
  const path = resolve(registration.path)
  const rows = store.all<PreparedWorktreeRow>(
    'SELECT * FROM prepared_worktrees WHERE repo_id = ? AND repo_path = ? AND path = ?',
    repo.id,
    repo.path,
    path
  )
  for (const row of rows) {
    if (!registration.exists || registration.branch !== null || registration.head !== row.base_oid ||
      registration.locked !== reasonOf(row) || !preparedPathIsOwned(row)) continue
    try {
      if ((await gitApi().dirtyEntries(path)).length === 0) return true
    } catch {
      return false
    }
  }
  return false
}

async function removePrepared(env: PreparedEnv, repo: Repo, row: PreparedWorktreeRow): Promise<boolean> {
  if (repo.id !== row.repo_id || repo.path !== row.repo_path || !isAbsolute(row.path)) return false
  const root = resolve(row.root_path)
  const pool = resolve(root, PREPARATION_DIR)
  const path = resolve(row.path)
  const child = relative(pool, path)
  if (!isAbsolute(row.root_path) || child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false
  let registrations
  try {
    registrations = await gitApi().listRegistrations(repo.path)
  } catch (error) {
    env.log(`could not inspect prepared checkout ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  const registration = registrations.find((entry) => resolve(entry.path) === path)
  if (!registration) {
    if (!existsSync(path)) {
      deleteRow(env.store, row.id)
      return true
    }
    env.log(`kept prepared path ${path}: Git no longer proves its exact locked checkout identity`)
    return false
  }
  if (registration.branch !== null || registration.head !== row.base_oid || registration.locked !== reasonOf(row)) {
    env.log(`kept prepared path ${path}: its branch, head, or lock reason changed`)
    return false
  }
  if (registration.exists) {
    if (!preparedPathIsOwned(row)) {
      env.log(`kept prepared path ${path}: it is no longer a real directory owned by the preparation pool`)
      return false
    }
    try {
      if ((await gitApi().dirtyEntries(path)).length > 0) {
        env.log(`kept prepared path ${path}: it contains user changes`)
        return false
      }
      await runGit(repo.path, ['worktree', 'unlock', path])
      await gitApi().removeWorktree(repo.path, path, false)
    } catch (error) {
      env.log(`could not remove prepared checkout ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  } else {
    try {
      await runGit(repo.path, ['worktree', 'unlock', path])
      await gitApi().prune(repo.path)
    } catch (error) {
      env.log(`could not prune prepared checkout ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const remaining = await gitApi().listRegistrations(repo.path).catch(() => null)
  if (remaining === null || remaining.some((entry) => resolve(entry.path) === path)) return false
  deleteRow(env.store, row.id)
  return true
}

function ensurePoolDirectory(rootPath: string): string {
  const root = resolve(rootPath)
  mkdirSync(root, { recursive: true })
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || realpathSync(root) !== root) {
    throw new Error('worktree preparation root is not a real directory')
  }
  const pool = join(root, PREPARATION_DIR)
  mkdirSync(pool, { recursive: true })
  const poolStat = lstatSync(pool)
  if (poolStat.isSymbolicLink() || !poolStat.isDirectory() || realpathSync(pool) !== pool) {
    throw new Error('worktree preparation pool is not a real directory')
  }
  return pool
}

export async function cleanupExpiredPreparedCheckouts(env: PreparedEnv, repos: Repo[], now = Date.now()): Promise<void> {
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const row of preparedRows(env.store)) {
    if (now - row.created_at < PREPARATION_TTL_MS) continue
    const repo = reposById.get(row.repo_id)
    if (repo) await removePrepared(env, repo, row)
  }
}

export async function prepareCheckout(
  env: PreparedEnv,
  repos: Repo[],
  repo: Repo,
  rootPath: string,
  baseRef: string,
  baseOid: string
): Promise<PrepareResult> {
  const now = Date.now()
  await cleanupExpiredPreparedCheckouts(env, repos, now)
  const git = gitApi()
  let primaryStatus
  try {
    primaryStatus = await git.status(repo.path)
  } catch (error) {
    return { prepared: false, reason: `repo-status-unknown: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (primaryStatus.files.length > 0) return { prepared: false, reason: 'dirty-primary-checkout' }
  if ((await git.getConfig(repo.path, 'core.sparseCheckout'))?.toLowerCase() === 'true') {
    return { prepared: false, reason: 'sparse-checkout' }
  }
  const resolvedBase = await git.resolveCommit(repo.path, baseRef)
  if (resolvedBase !== baseOid) return { prepared: false, reason: 'stale-base' }

  const owned = preparedRows(env.store).filter((row) => row.owner_id === env.ownerId && row.repo_id === repo.id)
  const matching = owned.find((row) => row.base_ref === baseRef && row.base_oid === baseOid && row.root_path === rootPath)
  if (matching && Date.now() - matching.created_at < PREPARATION_TTL_MS) {
    const registration = await registrationOf(repo, matching).catch(() => null)
    if (registration && (await git.dirtyEntries(matching.path)).length === 0) {
      return { prepared: true, id: matching.id, baseRef, baseOid, expiresAt: matching.created_at + PREPARATION_TTL_MS }
    }
    await removePrepared(env, repo, matching)
  }

  if (preparedRows(env.store).length >= PREPARATION_LIMIT) return { prepared: false, reason: 'pool-full' }
  const pool = ensurePoolDirectory(rootPath)
  const id = randomUUID()
  const path = join(pool, id)
  const row: PreparedWorktreeRow = {
    id,
    repo_id: repo.id,
    repo_path: repo.path,
    root_path: resolve(rootPath),
    base_ref: baseRef,
    base_oid: baseOid,
    path,
    owner_id: env.ownerId,
    created_at: now
  }
  try {
    await runGit(repo.path, ['worktree', 'add', '--detach', '--lock', '--reason', reasonOf(row), path, baseRef])
    const registration = await registrationOf(repo, row)
    if (!registration) throw new Error('Git did not report the exact locked detached checkout just created')
    env.store.run(
      'INSERT INTO prepared_worktrees (id, repo_id, repo_path, root_path, base_ref, base_oid, path, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.repo_id, row.repo_path, row.root_path, row.base_ref, row.base_oid, row.path, row.owner_id, row.created_at
    )
    return { prepared: true, id, baseRef, baseOid, expiresAt: now + PREPARATION_TTL_MS }
  } catch (error) {
    await removePrepared(env, repo, row).catch(() => false)
    return { prepared: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function claimPreparedCheckout(
  env: PreparedEnv,
  repo: Repo,
  rootPath: string,
  baseRef: string,
  baseOid: string,
  branch: string,
  destination: string
): Promise<boolean> {
  const git = gitApi()
  const row = preparedRows(env.store).find((candidate) =>
    candidate.owner_id === env.ownerId && candidate.repo_id === repo.id && candidate.repo_path === repo.path &&
    candidate.root_path === rootPath && candidate.base_ref === baseRef && candidate.base_oid === baseOid
  )
  if (!row) return false
  if (Date.now() - row.created_at >= PREPARATION_TTL_MS) {
    await removePrepared(env, repo, row)
    return false
  }
  try {
    const status = await git.status(repo.path)
    if (status.files.length > 0 || (await git.getConfig(repo.path, 'core.sparseCheckout'))?.toLowerCase() === 'true' ||
      await git.resolveCommit(repo.path, baseRef) !== baseOid ||
      await git.localBranchExists(repo.path, branch) || await git.remoteBranchExists(repo.path, branch)) {
      await removePrepared(env, repo, row)
      return false
    }
    const registration = await registrationOf(repo, row)
    if (!registration || (await git.dirtyEntries(row.path)).length > 0 || existsSync(destination)) {
      await removePrepared(env, repo, row)
      return false
    }
    // `git worktree move` does not create the first per-project parent directory.
    const parent = resolve(dirname(destination))
    const parentRelative = relative(resolve(rootPath), parent)
    if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative)) return false
    let directory = resolve(rootPath)
    for (const part of parentRelative.split(sep).filter(Boolean)) {
      directory = join(directory, part)
      try { mkdirSync(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) {
        throw new Error('prepared checkout destination parent is not a real owned directory')
      }
    }

    await runGit(repo.path, ['worktree', 'unlock', row.path])
    await runGit(repo.path, ['worktree', 'move', row.path, destination])
    try {
      await runGit(destination, ['checkout', '--no-track', '-b', branch, baseOid])
      deleteRow(env.store, row.id)
      return true
    } catch (error) {
      const removed = await git.removeWorktree(repo.path, destination, false).then(() => true, (cleanupError) => {
        env.log(`kept failed preparation at ${destination}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        return false
      })
      if (!removed) return false
      await git.deleteRefIfAt(repo.path, branch, baseOid).catch(() => false)
      deleteRow(env.store, row.id)
      env.log(`discarded prepared checkout after branch materialization failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  } catch (error) {
    const atPool = await git.listRegistrations(repo.path).catch(() => [])
    const registration = atPool.find((entry) => resolve(entry.path) === resolve(row.path))
    if (registration && registration.branch === null && registration.head === row.base_oid && registration.locked === null) {
      await runGit(repo.path, ['worktree', 'lock', '--reason', reasonOf(row), row.path]).catch(() => undefined)
    }
    env.log(`could not claim prepared checkout ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export async function cleanupPreparedCheckouts(env: PreparedEnv, repos: Repo[]): Promise<void> {
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const row of preparedRows(env.store)) {
    const repo = reposById.get(row.repo_id)
    if (!repo) {
      env.log(`kept prepared checkout ${row.id}: its canonical repo owner is unavailable`)
      continue
    }
    await removePrepared(env, repo, row)
  }
}
