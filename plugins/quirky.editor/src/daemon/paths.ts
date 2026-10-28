import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import type { PluginCaller, PluginContext } from '@quirky/protocol'

export type ResolvedWorktree = { id: string; path: string }
export type AuthorizedPath = { path: string; relativePath: string; root: string }

type ResolveResult = { id: string; path: string }
type PathOptions = { create?: boolean }

export class WorktreePaths {
  constructor(private readonly context: PluginContext) {}

  async resolve(worktree?: string, caller?: PluginCaller): Promise<ResolvedWorktree> {
    const identity = caller?.role === 'plugin' || caller === undefined ? {} : {
      ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
      ...(caller.worktreeId === undefined ? {} : { worktreeId: caller.worktreeId })
    }
    const selector = worktree ?? (identity.worktreeId === undefined ? 'current' : `id:${identity.worktreeId}`)
    const resolved = await this.context.call('quirky.worktree/resolve', { selector, ...identity }) as ResolveResult
    const root = await realpath(resolved.path)
    const rootInfo = await stat(root)
    if (!rootInfo.isDirectory()) throw this.context.error('invalid-params', `worktree root is not a directory: ${root}`)
    return { id: resolved.id, path: root }
  }

  async forId(worktreeId: string): Promise<ResolvedWorktree> {
    return this.resolve(`id:${worktreeId}`)
  }

  async path(worktreeId: string, requestedPath: string, options: PathOptions = {}): Promise<AuthorizedPath> {
    const worktree = await this.forId(worktreeId)
    if (requestedPath.length === 0 || requestedPath.includes('\0')) {
      throw this.context.error('invalid-params', 'path must be a non-empty path without NUL bytes')
    }
    const candidate = isAbsolute(requestedPath)
      ? resolvePath(requestedPath)
      : resolvePath(worktree.path, requestedPath)
    if (!this.isWithin(worktree.path, candidate)) {
      throw this.context.error('invalid-params', `path is outside worktree ${worktree.id}`)
    }

    let cursor = worktree.path
    const parts = relative(worktree.path, candidate).split(sep).filter((part) => part !== '' && part !== '.')
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      if (part === '..') throw this.context.error('invalid-params', 'path traversal is not allowed')
      cursor = join(cursor, part)
      let info
      try {
        info = await lstat(cursor)
      } catch (error) {
        if (!options.create || this.errorCode(error) !== 'ENOENT') throw this.translatePathError(error, cursor)
        const parent = await this.nearestExistingParent(cursor, worktree.path)
        if (!this.isWithin(worktree.path, parent)) throw this.context.error('invalid-params', `path traverses outside worktree ${worktree.id}`)
        continue
      }

      if (info.isSymbolicLink()) {
        let target: string
        try {
          target = await realpath(cursor)
        } catch (error) {
          throw this.context.error('not-found', `symlink target does not exist: ${cursor}`)
        }
        if (!this.isWithin(worktree.path, target)) {
          throw this.context.error('invalid-params', `symlink target is outside worktree ${worktree.id}: ${cursor}`)
        }
        cursor = target
        if (index < parts.length - 1) {
          const targetInfo = await stat(cursor)
          if (!targetInfo.isDirectory()) throw this.context.error('invalid-params', `path parent is not a directory: ${cursor}`)
        }
      } else if (index < parts.length - 1 && !info.isDirectory()) {
        throw this.context.error('invalid-params', `path parent is not a directory: ${cursor}`)
      }
    }

    let canonical = cursor
    try {
      canonical = await realpath(cursor)
    } catch (error) {
      if (!options.create || this.errorCode(error) !== 'ENOENT') throw this.translatePathError(error, cursor)
      canonical = cursor
    }
    if (!this.isWithin(worktree.path, canonical)) {
      throw this.context.error('invalid-params', `path resolves outside worktree ${worktree.id}`)
    }
    return { path: canonical, relativePath: relative(worktree.path, canonical) || '.', root: worktree.path }
  }
  async entryPath(worktreeId: string, requestedPath: string, options: PathOptions = {}): Promise<AuthorizedPath> {
    const worktree = await this.forId(worktreeId)
    if (requestedPath.length === 0 || requestedPath.includes('\0')) {
      throw this.context.error('invalid-params', 'path must be a non-empty path without NUL bytes')
    }
    const candidate = isAbsolute(requestedPath)
      ? resolvePath(requestedPath)
      : resolvePath(worktree.path, requestedPath)
    if (!this.isWithin(worktree.path, candidate)) {
      throw this.context.error('invalid-params', `path is outside worktree ${worktree.id}`)
    }
    const leaf = basename(candidate)
    if (leaf === '' || leaf === '.' || leaf === '..' || candidate === worktree.path) {
      throw this.context.error('invalid-params', 'mutations require a worktree child path')
    }
    const parent = await this.path(worktreeId, dirname(candidate), options)
    const path = join(parent.path, leaf)
    try {
      await lstat(path)
    } catch (error) {
      if (!options.create || this.errorCode(error) !== 'ENOENT') throw this.translatePathError(error, path)
    }
    return { path, relativePath: relative(worktree.path, path), root: worktree.path }
  }

  isWithin(root: string, candidate: string): boolean {
    const rel = relative(root, candidate)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  private async nearestExistingParent(path: string, root: string): Promise<string> {
    let cursor = path
    while (this.isWithin(root, cursor)) {
      try {
        return await realpath(cursor)
      } catch (error) {
        if (this.errorCode(error) !== 'ENOENT') throw this.translatePathError(error, cursor)
        const parent = relative(root, cursor) === '' ? root : cursor.slice(0, cursor.lastIndexOf(sep)) || root
        if (parent === cursor) break
        cursor = parent
      }
    }
    return await realpath(root)
  }

  private errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code
  }

  private translatePathError(error: unknown, path: string): Error {
    const code = this.errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return this.context.error('not-found', `file does not exist: ${path}`)
    if (code === 'EACCES' || code === 'EPERM') return this.context.error('invalid-params', `access denied: ${path}`)
    return error instanceof Error ? error : new Error(String(error))
  }
}
