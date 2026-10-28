import { closeSync, fstatSync, openSync, statSync, type Stats } from 'node:fs'

export type DirectoryIdentity = {
  device: string
  inode: string
  birthtimeMs: number
}

export type DirectoryHandle = {
  identity: DirectoryIdentity | null
  close(): void
}

/** Internal seam for filesystem identity, replaceable by deterministic unit tests. */
export type DirectoryIdentitySource = {
  open(path: string): DirectoryHandle
  stat(path: string): DirectoryIdentity | null
}

function identityFromStats(stats: Stats): DirectoryIdentity | null {
  if (!stats.isDirectory() || !Number.isFinite(stats.dev) || !Number.isFinite(stats.ino) || stats.ino === 0 || !Number.isFinite(stats.birthtimeMs)) {
    return null
  }
  return { device: String(stats.dev), inode: String(stats.ino), birthtimeMs: stats.birthtimeMs }
}

/** Device, inode and birth time distinguish filesystem objects without relying on path or creation metadata. */
export function instanceIdFor(identity: DirectoryIdentity): string {
  return `fs:${identity.device}:${identity.inode}:${identity.birthtimeMs}`
}

/** Both identities must be reliable; zero birth time remains usable through device and inode. */
export function sameDirectoryIdentity(left: DirectoryIdentity | null, right: DirectoryIdentity | null): boolean {
  return left !== null && right !== null &&
    left.device === right.device && left.inode === right.inode && left.birthtimeMs === right.birthtimeMs
}

export const filesystemIdentitySource: DirectoryIdentitySource = {
  open(path) {
    const fd = openSync(path, 'r')
    try {
      const identity = identityFromStats(fstatSync(fd))
      return { identity, close: () => closeSync(fd) }
    } catch (error) {
      closeSync(fd)
      throw error
    }
  },
  stat(path) {
    try {
      return identityFromStats(statSync(path))
    } catch {
      return null
    }
  }
}

/** Revalidates a held directory against its current path; the caller must close the handle. */
export function stillNamesHeldDirectory(source: DirectoryIdentitySource, handle: DirectoryHandle, path: string): boolean {
  return sameDirectoryIdentity(handle.identity, source.stat(path))
}
