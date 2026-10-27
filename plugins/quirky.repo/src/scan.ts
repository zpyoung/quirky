import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Env } from './env'
import { addRepo } from './projects'
import { createGroup, findGroupByName, setGroupMembers } from './groups'
import { resolveRealPath, expandHome } from '../paths'

export type ScanResult = { repos: { path: string; name: string }[]; truncated: boolean }

export type ImportResult = {
  results: { path: string; status: 'imported' | 'already-known' | 'failed'; repoId?: string; error?: string }[]
  imported: number
  alreadyKnown: number
  failed: number
  groupId?: string
}

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_MAX_REPOS = 100

const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'])

const skipped = (name: string): boolean => name.startsWith('.') || SKIPPED_FOLDERS.has(name)

/**
 * The git repositories under `root` (a folder with a `.git` entry), in path order. The scan goes
 * at most `maxDepth` folders below `root`, skips hidden and dependency folders and symlinks, and
 * does not descend into a repo it found. It stops once `maxRepos` are collected and sets
 * `truncated` when more were left. Rejects when `root` can't be read.
 */
export async function scanForRepos(root: string, limits: { maxDepth: number; maxRepos: number }): Promise<ScanResult> {
  const repos: ScanResult['repos'] = []
  let truncated = false

  async function visit(dir: string, depth: number): Promise<boolean> {
    if (existsSync(join(dir, '.git'))) {
      if (repos.length >= limits.maxRepos) {
        truncated = true
        return false
      }
      repos.push({ path: dir, name: basename(dir) })
      return true
    }
    if (depth >= limits.maxDepth) return true
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory() || skipped(entry.name)) continue
      if (!(await visit(join(dir, entry.name), depth + 1))) return false
    }
    return true
  }

  await visit(root, 0)
  return { repos, truncated }
}

/** The scan folder as the daemon reads it: `~` expanded and symlinks resolved. */
export function scanRoot(env: Env, path: string): string {
  const real = resolveRealPath(resolve(expandHome(path)))
  if (!existsSync(real)) throw env.fail('invalid-params', `no such directory: ${expandHome(path)}`)
  return real
}

export async function scan(env: Env, params: { path: string; maxDepth?: number; maxRepos?: number }): Promise<ScanResult> {
  const root = scanRoot(env, params.path)
  return scanForRepos(root, { maxDepth: params.maxDepth ?? DEFAULT_MAX_DEPTH, maxRepos: params.maxRepos ?? DEFAULT_MAX_REPOS })
}

/**
 * Adds every repo found under `path` that Quirky doesn't know yet. Each repo gets its own outcome,
 * so one that can't be added doesn't stop the rest. With `group`, an existing group of that name
 * (else a new one remembering `path` as its parent folder) holds every repo found.
 */
export async function importRepos(
  env: Env,
  params: { path: string; group?: string; maxDepth?: number; maxRepos?: number }
): Promise<ImportResult> {
  const root = scanRoot(env, params.path)
  const found = await scanForRepos(root, { maxDepth: params.maxDepth ?? DEFAULT_MAX_DEPTH, maxRepos: params.maxRepos ?? DEFAULT_MAX_REPOS })
  const result: ImportResult = { results: [], imported: 0, alreadyKnown: 0, failed: 0 }

  for (const { path } of found.repos) {
    const known = env.store.get<{ id: string }>('SELECT id FROM repos WHERE path = ?', resolveRealPath(path))
    if (known) {
      result.results.push({ path, status: 'already-known', repoId: known.id })
      result.alreadyKnown++
      continue
    }
    try {
      const repo = await addRepo(env, path, false)
      if (result.results.some((entry) => entry.repoId === repo.id)) {
        result.results.push({ path, status: 'already-known', repoId: repo.id })
        result.alreadyKnown++
      } else {
        result.results.push({ path, status: 'imported', repoId: repo.id })
        result.imported++
      }
    } catch (error) {
      result.results.push({ path, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      result.failed++
    }
  }

  const repoIds = result.results.flatMap((entry) => (entry.repoId ? [entry.repoId] : []))
  const name = params.group?.trim()
  if (name && repoIds.length > 0) {
    const group = findGroupByName(env, name) ?? createGroup(env, { name, parentPath: root, createdFrom: 'folder-scan' })
    setGroupMembers(env, group.id, repoIds)
    result.groupId = group.id
  }
  return result
}
