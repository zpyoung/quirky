import { lstat, readFile } from 'node:fs/promises'
import { removeHostTree } from './host-tree-removal'
import type { ReadPath, StatPath } from './worktree-orphan-gitdir-proof'

export { toHostFilesystemPath, toHostRemovalPath } from './host-tree-removal'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

type LocalWorktreePathAccess = {
  statPath: StatPath
  readPath: ReadPath
}

export function toLocalWorktreeRuntimePath(
  targetPath: string,
  _options: LocalWorktreeFilesystemOptions = {}
): string {
  return targetPath
}

export function getLocalWorktreePathAccess(
  _options: LocalWorktreeFilesystemOptions = {}
): LocalWorktreePathAccess {
  return {
    statPath: lstat,
    readPath: (path) => readFile(path, 'utf8')
  }
}

export async function removeLocalWorktreePath(
  targetPath: string,
  _options: LocalWorktreeFilesystemOptions = {}
): Promise<void> {
  await removeHostTree(targetPath)
}
