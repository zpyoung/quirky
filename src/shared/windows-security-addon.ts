import { createRequire } from 'node:module'
import { join, toNamespacedPath } from 'node:path'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from './orcad-artifacts'

export type GrantAccessOptions = {
  inheritable: boolean
  replace: boolean
}

/** `type` and `flags` are the raw ACE_HEADER bytes; `sid` is null for every ACE type but allow and deny. */
export type WindowsAce = { type: number; flags: number; mask: number; sid: string | null }

/** `protected` is SE_DACL_PROTECTED. */
export type WindowsDacl = { protected: boolean; aces: WindowsAce[] }

/** Every call throws an Error whose message names the Win32 call and its error code. */
export type WindowsSecurityAddon = {
  currentUserSid(): string
  getDaclAces(path: string): WindowsDacl | null
  setDaclSddl(path: string, sddl: string): void
  setDaclSddlAsync(path: string, sddl: string): Promise<void>
  createFileWithDacl(path: string, sddl: string, data: Uint8Array): void
  grantAccess(path: string, sid: string, accessMask: number, options: GrantAccessOptions): void
  grantAccessAsync(
    path: string,
    sid: string,
    accessMask: number,
    options: GrantAccessOptions
  ): Promise<void>
}

/** The addon (every path namespaced, async writes ordered per path) and the token's user SID. */
export type WindowsSecurity = {
  addon: Omit<WindowsSecurityAddon, 'currentUserSid'>
  userSid: string
}

/** FILE_ALL_ACCESS, what SDDL prints as `FA`. */
export const WINDOWS_FILE_ALL_ACCESS = 0x1f01ff
/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, what icacls calls `(RX)`. */
export const WINDOWS_FILE_READ_EXECUTE = 0x1200a9

const requireFromHere = createRequire(__filename)

let loaded: WindowsSecurity | { error: string } | null = null

/**
 * The addon, or why it cannot load on this host. orcad ships the bare binary at its slot root,
 * beside its server bundles and two levels above its CLI bundle (`out/cli/index.js`).
 */
export function loadWindowsSecurity(): WindowsSecurity | { error: string } {
  loaded ??= loadOnce()
  return loaded
}

function loadOnce(): WindowsSecurity | { error: string } {
  if (process.platform !== 'win32') {
    return { error: `unsupported on ${process.platform}` }
  }
  const failures: string[] = []
  const candidates = [
    () => join(__dirname, ORCAD_WINDOWS_SECURITY_FILENAME),
    () => join(__dirname, '..', '..', ORCAD_WINDOWS_SECURITY_FILENAME)
  ]
  for (const candidate of candidates) {
    try {
      // Reading the SID is also what makes the addon load its deferred .node binary.
      return prepare(requireFromHere(candidate()))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { error: failures.join('; ') }
}

/**
 * Every path is namespaced (`\\?\`) once, here: the Win32 security APIs are MAX_PATH-limited.
 *
 * Async DACL writes to one path run in order. A grant reads the DACL and writes back a merge, so
 * one racing a re-lock on another pool thread could land last and restore the broader DACL. A
 * synchronous grantDirAcl is not ordered against them, but it runs to completion on the main
 * thread, so restrictAsync's post-apply verify (a later main-thread continuation) sees its result:
 * a resurrected broad DACL fails that verify, which evicts the directory to retry under the budget.
 */
function prepare(raw: WindowsSecurityAddon): WindowsSecurity {
  const writes = new Map<string, Promise<unknown>>()
  const inPathOrder = (path: string, write: (namespaced: string) => Promise<void>) => {
    const namespaced = toNamespacedPath(path)
    const key = namespaced.toLowerCase()
    const run = () => write(namespaced)
    const next = (writes.get(key) ?? Promise.resolve()).then(run, run)
    const settled = next.catch(() => undefined)
    writes.set(key, settled)
    void settled.then(() => {
      if (writes.get(key) === settled) {
        writes.delete(key)
      }
    })
    return next
  }
  return {
    userSid: raw.currentUserSid(),
    addon: {
      getDaclAces: (path) => raw.getDaclAces(toNamespacedPath(path)),
      setDaclSddl: (path, sddl) => raw.setDaclSddl(toNamespacedPath(path), sddl),
      setDaclSddlAsync: (path, sddl) =>
        inPathOrder(path, (namespaced) => raw.setDaclSddlAsync(namespaced, sddl)),
      createFileWithDacl: (path, sddl, data) =>
        raw.createFileWithDacl(toNamespacedPath(path), sddl, data),
      grantAccess: (path, sid, mask, options) =>
        raw.grantAccess(toNamespacedPath(path), sid, mask, options),
      grantAccessAsync: (path, sid, mask, options) =>
        inPathOrder(path, (namespaced) => raw.grantAccessAsync(namespaced, sid, mask, options))
    }
  }
}

/** Installs `addon` (a fake, or null for "cannot load") behind the same wrapping as the real one. */
export function setWindowsSecurityForTests(addon: WindowsSecurityAddon | null): void {
  loaded = addon ? prepare(addon) : { error: 'disabled for tests' }
}

/** Forgets the loaded addon and its SID. */
export function resetWindowsSecurityLoadForTests(): void {
  loaded = null
}
