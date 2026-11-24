import {
  QUIRKYD_BUILD_TARGET_FILENAME,
  QUIRKYD_LAUNCHER_FILENAME,
  QUIRKYD_SERVER_ENTRY_FILENAME,
  QUIRKYD_NODE_RUNTIME_DIR_PREFIX,
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_NODE_RUNTIME_POSIX_EXECUTABLE,
  QUIRKYD_RUNTIMES_DIRNAME,
  quirkydBunRuntimeFilename
} from '../../../shared/quirkyd-artifacts'
import { assertPosixQuirkydHost } from './quirkyd-remote-host-support'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** `quirkyd_slot=<dir>;`, so the selections below name the long slot path once on the wire. */
function assignQuirkydSlot(directory: string): string {
  return `quirkyd_slot=${quotePosixShell(directory.replace(/\/+$/, ''))}; `
}

/** New slots start the server directly; rollback still accepts older single-entry slots. */
export function selectQuirkydSlotEntryCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixQuirkydHost(host)
  const server = `"$quirkyd_slot"/${quotePosixShell(QUIRKYD_SERVER_ENTRY_FILENAME)}`
  const launcher = `"$quirkyd_slot"/${quotePosixShell(QUIRKYD_LAUNCHER_FILENAME)}`
  return `${assignQuirkydSlot(directory)}if [ -f ${server} ]; then quirkyd_entry=${server}; else quirkyd_entry=${launcher}; fi`
}

/**
 * Sets `$quirkyd_runtime` to the pinned Node a slot's `.runtime-node` names, or exits 78.
 * Assumes the marker exists; callers decide what its absence means.
 */
export function quirkydNodeSlotRuntimeCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixQuirkydHost(host)
  const nodeMarker = `"$quirkyd_slot"/${quotePosixShell(QUIRKYD_NODE_RUNTIME_MARKER_FILENAME)}`
  const nodeRuntimePrefix = `"\${quirkyd_slot%/*}"/${quotePosixShell(
    `${QUIRKYD_RUNTIMES_DIRNAME}/${QUIRKYD_NODE_RUNTIME_DIR_PREFIX}`
  )}`
  const nodeExecutable = quotePosixShell(`/${QUIRKYD_NODE_RUNTIME_POSIX_EXECUTABLE}`)
  return (
    `${assignQuirkydSlot(directory)}quirkyd_node_sha=$(cat ${nodeMarker}) || exit 78; ` +
    // Why validate: the digest becomes a path segment, so only a bare sha256 may reach it.
    // The leading `(` keeps the pattern parseable when stop embeds this in `$(...)`.
    'case "$quirkyd_node_sha" in ("" | *[!0-9a-f]*) exit 78;; esac; ' +
    '[ "${#quirkyd_node_sha}" -eq 64 ] || exit 78; ' +
    `quirkyd_runtime=${nodeRuntimePrefix}"$quirkyd_node_sha"${nodeExecutable}; ` +
    '[ -x "$quirkyd_runtime" ] || exit 78; '
  )
}

/**
 * The slot's own contents pick its runtime: Node marker, then Bun, then legacy host Node.
 * Only legacy slots may use host Node; an incomplete Node or Bun slot must not change runtimes.
 */
export function selectQuirkydSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixQuirkydHost(host)
  const nodeMarker = quotePosixShell(
    joinRemotePath(host, directory, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const runtime = quotePosixShell(
    joinRemotePath(host, directory, quirkydBunRuntimeFilename(host.os))
  )
  const target = quotePosixShell(joinRemotePath(host, directory, QUIRKYD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${nodeMarker} ]; then ${quirkydNodeSlotRuntimeCommand(host, directory)}` +
    `elif [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; quirkyd_runtime=${runtime}; ` +
    `else quirkyd_runtime=${quotePosixShell(legacyNodePath)}; fi`
  )
}
