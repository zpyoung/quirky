import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

export type OwnershipLossReason = 'home-gone' | 'home-replaced' | 'socket-gone' | 'socket-replaced'
export type OwnershipLoss = { reason: OwnershipLossReason; path: string }

export type HomeClaim = {
  check(): OwnershipLoss | null
}

export type OwnedListener = { stop(closeActive: boolean): void; unref(): unknown }
export type BindOps = Pick<typeof fs, 'mkdtempSync' | 'chmodSync' | 'lstatSync' | 'renameSync'>

export type OwnedSocket<L extends OwnedListener> = {
  readonly listener: L
  readonly privateDir: string
  check(): OwnershipLoss | null
  close(): { listenerStopped: boolean; socketRemoved: boolean }
}

type Identity = { dev: bigint; ino: bigint }
type BigIntFileInfo = Identity & { isDirectory(): boolean; isSocket(): boolean }
type PrivatePathState = { safe: boolean; directoryPresent: boolean }

const defaultOps: BindOps = {
  mkdtempSync: fs.mkdtempSync,
  chmodSync: fs.chmodSync,
  lstatSync: fs.lstatSync,
  renameSync: fs.renameSync
}

function identityOf(stat: Identity): Identity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(stat: Identity, identity: Identity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR'
}

function pathStat(ops: BindOps, path: string): BigIntFileInfo {
  return ops.lstatSync(path, { bigint: true }) as BigIntFileInfo
}

function identityError(path: string, expected: string): Error {
  return new Error(`Expected ${path} to be an owned ${expected}`)
}

/** Claims the home's identity; call immediately after creating the home. */
export function claimHome(home: string): HomeClaim {
  const first = fs.statSync(home, { bigint: true })
  if (!first.isDirectory()) throw identityError(home, 'directory')
  const identity = identityOf(first)
  let loss: OwnershipLoss | null = null

  return {
    check() {
      if (loss) return loss
      try {
        const current = fs.statSync(home, { bigint: true })
        if (!current.isDirectory() || !sameIdentity(current, identity)) {
          loss = { reason: 'home-replaced', path: home }
        }
      } catch (error) {
        if (isMissing(error)) loss = { reason: 'home-gone', path: home }
      }
      return loss
    }
  }
}

function socketLoss(path: string, identity: Identity, ops: BindOps): OwnershipLoss | null {
  try {
    const current = pathStat(ops, path)
    if (!current.isSocket() || !sameIdentity(current, identity)) return { reason: 'socket-replaced', path }
    return null
  } catch (error) {
    if (isMissing(error)) return { reason: 'socket-gone', path }
    return null
  }
}


function removeSocketIfOwned(path: string, identity: Identity, ops: BindOps): boolean {
  let current: BigIntFileInfo
  try {
    current = pathStat(ops, path)
  } catch {
    return false
  }
  if (!current.isSocket() || !sameIdentity(current, identity)) return false
  try {
    fs.unlinkSync(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function removeDirectoryIfOwned(path: string, identity: Identity, ops: BindOps): boolean {
  let current: BigIntFileInfo
  try {
    current = pathStat(ops, path)
  } catch {
    return false
  }
  if (!current.isDirectory() || !sameIdentity(current, identity)) return false
  try {
    fs.rmdirSync(path)
    return true
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' || (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw error
  }
}

/** Binds in a private directory and atomically publishes only the listening socket. */
export function bindOwnedSocket<L extends OwnedListener>(
  socketPath: string,
  listen: (privatePath: string) => L,
  ops: BindOps = defaultOps
): OwnedSocket<L> {
  const privateDir = ops.mkdtempSync(join(dirname(socketPath), '.p'))
  const privateSocketPath = join(privateDir, 's')
  let directoryIdentity: Identity | undefined
  let socketIdentity: Identity | undefined
  let publishedIdentity: Identity | undefined
  let listener: L | undefined
  let listenerStopped = false
  let published = false

  const identifyDirectory = (stat: BigIntFileInfo) => {
    if (!stat.isDirectory()) throw identityError(privateDir, 'directory')
    directoryIdentity = identityOf(stat)
  }

  const identifySocket = (path: string) => {
    const stat = pathStat(ops, path)
    if (!stat.isSocket()) throw identityError(path, 'socket')
    return identityOf(stat)
  }

  const currentPrivateState = (): PrivatePathState => {
    if (!directoryIdentity) return { safe: false, directoryPresent: true }
    let directory: BigIntFileInfo
    try {
      directory = pathStat(ops, privateDir)
    } catch (error) {
      return isMissing(error) ? { safe: true, directoryPresent: false } : { safe: false, directoryPresent: true }
    }
    if (!directory.isDirectory() || !sameIdentity(directory, directoryIdentity)) {
      return { safe: false, directoryPresent: true }
    }
    try {
      const socket = pathStat(ops, privateSocketPath)
      if (!socket.isSocket() || !socketIdentity || !sameIdentity(socket, socketIdentity)) {
        return { safe: false, directoryPresent: true }
      }
    } catch (error) {
      if (!isMissing(error)) return { safe: false, directoryPresent: true }
    }
    return { safe: true, directoryPresent: true }
  }

  const close = (): { listenerStopped: boolean; socketRemoved: boolean } => {
    const state = currentPrivateState()
    if (state.safe) {
      if (!listenerStopped && listener) {
        listener.stop(true)
        listenerStopped = true
      }
      if (state.directoryPresent && directoryIdentity) {
        if (socketIdentity) removeSocketIfOwned(privateSocketPath, socketIdentity, ops)
        removeDirectoryIfOwned(privateDir, directoryIdentity, ops)
      }
    } else if (!listenerStopped && listener) {
      listener.unref()
    }
    const socketRemoved = publishedIdentity ? removeSocketIfOwned(socketPath, publishedIdentity, ops) : false
    return { listenerStopped, socketRemoved }
  }

  try {
    identifyDirectory(pathStat(ops, privateDir))
    listener = listen(privateSocketPath)
    // Claim the bound path before chmod or publication can fail, so cleanup can distinguish it from a replacement.
    socketIdentity = identifySocket(privateSocketPath)
    ops.chmodSync(privateSocketPath, 0o600)
    ops.renameSync(privateSocketPath, socketPath)
    published = true
    const publishedStat = pathStat(ops, socketPath)
    if (!publishedStat.isSocket() || !socketIdentity || !sameIdentity(publishedStat, socketIdentity)) {
      throw identityError(socketPath, 'published socket')
    }
    publishedIdentity = identityOf(publishedStat)
    return {
      listener,
      privateDir,
      check: () => socketLoss(socketPath, publishedIdentity!, ops),
      close
    }
  } catch (originalError) {
    const retained = new Set<string>()
    const recordRetained = (...paths: string[]) => paths.forEach((path) => retained.add(path))

    if (!directoryIdentity) {
      try {
        identifyDirectory(pathStat(ops, privateDir))
      } catch (error) {
        if (!isMissing(error)) recordRetained(privateDir)
      }
    }

    if (listener && directoryIdentity && !socketIdentity) {
      try {
        const directory = pathStat(ops, privateDir)
        if (directory.isDirectory() && sameIdentity(directory, directoryIdentity)) {
          try {
            const socket = pathStat(ops, privateSocketPath)
            if (socket.isSocket()) socketIdentity = identityOf(socket)
          } catch (error) {
            if (!isMissing(error)) recordRetained(privateDir, privateSocketPath)
          }
        }
      } catch (error) {
        if (!isMissing(error)) recordRetained(privateDir, privateSocketPath)
      }
    }

    if (listener) {
      const state = currentPrivateState()
      if (state.safe) {
        try {
          listener.stop(true)
          listenerStopped = true
          if (state.directoryPresent && directoryIdentity) {
            if (socketIdentity) removeSocketIfOwned(privateSocketPath, socketIdentity, ops)
            removeDirectoryIfOwned(privateDir, directoryIdentity, ops)
          }
        } catch {
          try {
            listener.unref()
          } catch {}
          recordRetained(privateDir, privateSocketPath)
        }
      } else {
        try {
          listener.unref()
        } catch {}
        recordRetained(privateDir, privateSocketPath)
      }
    } else if (directoryIdentity) {
      try {
        if (!removeDirectoryIfOwned(privateDir, directoryIdentity, ops)) {
          let current: BigIntFileInfo | undefined
          try {
            current = pathStat(ops, privateDir)
          } catch {}
          if (current && sameIdentity(current, directoryIdentity)) recordRetained(privateDir, privateSocketPath)
        }
      } catch {
        recordRetained(privateDir, privateSocketPath)
      }
    }

    if (published && !publishedIdentity) recordRetained(socketPath)
    if (retained.size > 0) {
      console.error('[quirky-pty] bind cleanup retained paths:', [...retained].join(', '), 'after original error:', originalError)
    }
    throw originalError
  }
}
