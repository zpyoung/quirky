/**
 * The things Quirky installs into `~/.quirky-remote/`, and the rules that keep them from
 * touching each other.
 *
 * Design D10 (to be tracked in docs/reference/remote-server-install-model.md): the relay and
 * quirkyd converge into one server package; on the host that is `server-<version>/` plus the
 * shared `runtimes/node-<sha256>/` store. Legacy `relay-*` / `quirkyd-*` directories belong to a
 * migration sweep that deletes only on an `exited` verdict, handed over in two releases: this
 * one lists them as diagnostics only. Until then each is its own namespace, so the prefix has
 * to be a parameter rather than a literal.
 *
 * GC ownership is the trap that parameterization creates. Each model garbage-collects ONLY
 * its own directories — see `remoteInstallDirOwner`. Relay's regex happened to be narrow
 * enough already; making the prefix a parameter is exactly what could have widened it into
 * deleting a live quirkyd tree, so the ownership rule is asserted here rather than left to
 * whichever regex a caller passes.
 */
import {
  relayArtifactFilenames,
  RELAY_INSTALL_COMPLETE_FILENAME,
  RELAY_VERSION_FILENAME
} from '../../ssh/relay-install-artifacts'
import {
  quirkydArtifactFilenames,
  QUIRKYD_INSTALL_COMPLETE_FILENAME,
  QUIRKYD_RUNTIMES_DIRNAME,
  QUIRKYD_VERSION_FILENAME
} from '../../../shared/quirkyd-artifacts'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export type RemoteInstallModelId = 'relay' | 'quirkyd'

export type RemoteInstallModel = {
  readonly id: RemoteInstallModelId
  /** Leading segment of every version dir: `<dirPrefix>-<fullVersion>`. */
  readonly dirPrefix: string
  /** npm package name written into the remote `package.json` for native deps. */
  readonly nativeDepsPackageName: string
  readonly versionFilename: string
  readonly installCompleteFilename: string
  /** Files whose absence means a torn install, so the probe forces a re-deploy. */
  requiredArtifacts(host: RemoteHostPlatform): string[]
}

export const RELAY_INSTALL_MODEL: RemoteInstallModel = {
  id: 'relay',
  dirPrefix: 'relay',
  nativeDepsPackageName: 'quirky-relay',
  versionFilename: RELAY_VERSION_FILENAME,
  installCompleteFilename: RELAY_INSTALL_COMPLETE_FILENAME,
  requiredArtifacts: (host) => relayArtifactFilenames(isWindowsRemoteHost(host))
}

export const QUIRKYD_INSTALL_MODEL: RemoteInstallModel = {
  id: 'quirkyd',
  dirPrefix: 'quirkyd',
  nativeDepsPackageName: 'quirky-quirkyd',
  versionFilename: QUIRKYD_VERSION_FILENAME,
  installCompleteFilename: QUIRKYD_INSTALL_COMPLETE_FILENAME,
  // libc changes no file name, so `<os>-<arch>` names every slot file. The page's hashed assets
  // are named only by its manifest, required here; the sentinel follows the whole-tree upload.
  requiredArtifacts: (host) => quirkydArtifactFilenames(`${host.os}-${host.arch}`, [])
}

export const REMOTE_INSTALL_MODELS: readonly RemoteInstallModel[] = [
  RELAY_INSTALL_MODEL,
  QUIRKYD_INSTALL_MODEL
]

/**
 * The version half of a directory name, shared by both models.
 *
 * Why `[0-9]` and not `\d`: this exact source string is also embedded in an awk ERE and a
 * PowerShell `-match` on the remote host. Those three dialects agree on `[0-9]`, `\.` and
 * `\+`; only JavaScript understands `\d`.
 */
const VERSION_PATTERN = String.raw`v?[0-9]+\.[0-9]+\.[0-9]+(\+[0-9a-f]+)?`

/** Suffix GC leaves behind mid-delete; the listing must surface these so they can be swept. */
const TOMBSTONE_PATTERN = String.raw`\.gc-tombstone\.[0-9]+\.[0-9]+`

/**
 * Why validated and not merely typed: the prefix is interpolated into a remote `find -name`
 * glob, an awk regex and a single-quoted PowerShell literal. A quote or a metacharacter
 * here would be a remote-shell injection on the client's own connection.
 */
function assertSafeDirPrefix(dirPrefix: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(dirPrefix)) {
    throw new Error(`Unsafe remote install dir prefix: ${JSON.stringify(dirPrefix)}`)
  }
}

export function remoteInstallDirName(model: RemoteInstallModel, fullVersion: string): string {
  assertSafeDirPrefix(model.dirPrefix)
  return `${model.dirPrefix}-${fullVersion}`
}

/** Matches a live version dir for exactly one model — never a tombstone, never a sibling model. */
export function remoteInstallVersionDirRegex(model: RemoteInstallModel): RegExp {
  assertSafeDirPrefix(model.dirPrefix)
  return new RegExp(`^${model.dirPrefix}-(${VERSION_PATTERN})$`)
}

/** A strictly named leftover of one model's interrupted GC rename; safe to delete on sight. */
export function remoteInstallGcTombstoneRegex(model: RemoteInstallModel): RegExp {
  assertSafeDirPrefix(model.dirPrefix)
  return new RegExp(`^${model.dirPrefix}-(${VERSION_PATTERN})${TOMBSTONE_PATTERN}$`)
}

/** What the remote listing is allowed to return: live dirs plus their tombstones. */
export function remoteInstallListingRegexSource(model: RemoteInstallModel): string {
  assertSafeDirPrefix(model.dirPrefix)
  return `^${model.dirPrefix}-(${VERSION_PATTERN})(${TOMBSTONE_PATTERN})?$`
}

/**
 * Which owner a directory found in `~/.quirky-remote/` belongs to, or null for anything no
 * owner created.
 *
 * Design D10: **the model that created a directory owns it, and nothing else may delete it**
 * (amended only in the release after the two-step hand-over). A relay GC pass that saw
 * `quirkyd-0.1.0+abc` would be looking at the live install of a peer whose lifecycle it has no
 * view into — the SSH-execution-boundary collapse in directory form.
 */
export function remoteInstallDirOwner(dirName: string): RemoteInstallDirOwner | null {
  if (dirName === QUIRKYD_RUNTIMES_DIRNAME) {
    return 'runtimes'
  }
  for (const model of REMOTE_INSTALL_MODELS) {
    if (new RegExp(remoteInstallListingRegexSource(model)).test(dirName)) {
      return model.id
    }
  }
  return null
}

/** True when `model` is allowed to garbage-collect `dirName`. */
export function remoteInstallGcPermits(model: RemoteInstallModel, dirName: string): boolean {
  return remoteInstallDirOwner(dirName) === model.id
}

/**
 * `runtimes` is the shared Node store (design D5). No version-dir model owns it, so neither
 * model's GC can list or delete it; only `remote-node-runtime-store-gc.ts` collects inside it.
 */
export type RemoteInstallDirOwner = RemoteInstallModelId | 'runtimes'

export type RemoteInstallInventory = Record<RemoteInstallDirOwner | 'unknown', string[]>

/** Group a raw `~/.quirky-remote/` listing by owning model, for diagnostics and the client's choice. */
export function inventoryRemoteInstallDirs(dirNames: readonly string[]): RemoteInstallInventory {
  const inventory: RemoteInstallInventory = { relay: [], quirkyd: [], runtimes: [], unknown: [] }
  for (const name of dirNames) {
    const owner = remoteInstallDirOwner(name)
    if (owner) {
      inventory[owner].push(name)
    } else {
      inventory.unknown.push(name)
    }
  }
  return inventory
}
