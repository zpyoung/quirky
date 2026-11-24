/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 *
 * Every activation runs under the host's activation fence and journal
 * (`quirkyd-activation-lock.ts`), so an interrupted one is recoverable to exactly one slot.
 */
import { logQuirkydActivationOutcome } from '../managed-server/activation/quirkyd-activation-outcome-log'
import { join } from 'node:path'
import type { QuirkydHostTransport } from './quirkyd-host-transport'
import { QUIRKYD_INSTALL_MODEL } from '../managed-server/install/remote-install-model'
import {
  computeRemoteInstallDir,
  readLocalFullVersion
} from '../managed-server/install/remote-versioned-install'
import { readQuirkydActivationRecord } from '../managed-server/activation/quirkyd-activation-record-store'
import type { QuirkydActivationRecord } from '../managed-server/activation/quirkyd-activation-record'
import type { QuirkydActivationVerdict } from '../managed-server/activation/quirkyd-activation-gate'
import type { QuirkydTerminalCensus } from '../../shared/quirkyd-terminal-census'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { installQuirkydBundle } from '../managed-server/install/quirkyd-remote-install'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { QUIRKYD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/quirkyd-profile-preflight'
import { materializeQuirkydArtifact } from '../quirkyd/quirkyd-artifact-materializer'
import { readQuirkydBundleTarget } from './quirkyd-deployment-target'
import { resolveQuirkydRuntimeTarget } from '../managed-server/lifecycle/quirkyd-runtime-target'
import {
  materializeNodeRuntimeArchive,
  nodeRuntimeArchiveCachePath
} from '../node-runtime/pinned-runtime-materializer'
import {
  quirkydActivationFenceExists,
  resolveQuirkydActivationReadinessTimeout,
  withQuirkydActivationLock
} from '../managed-server/activation/quirkyd-activation-lock'
import { activateInstalledQuirkyd } from './quirkyd-installed-activation'
import { quirkydActivationFenceRefusal } from '../managed-server/activation/quirkyd-activation-fence-hold'

export type QuirkydDeployOptions = {
  conn: QuirkydHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localQuirkydDir?: string
  /** The bundle's runtime target; read from `localQuirkydDir` or probed when absent. */
  target?: NodeRuntimeTarget
  /** Where the pinned runtime archive is cached; defaults beside the quirkyd artifact cache. */
  runtimeCacheRoot?: string
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  /**
   * Live-terminal counts, supplied by the caller from the runtime it is already connected
   * to. Not probed here: counting the daemon's sessions needs its protocol, and a deploy
   * that guessed zero from silence would be the "loss of contact means death" mistake.
   */
  census: QuirkydTerminalCensus
  /**
   * The record `census` was counted against; defaults to the one read before upload. A different
   * incumbent found under the fence makes the census unverifiable rather than wrongly zero.
   */
  censusRecord?: QuirkydActivationRecord
  /**
   * Counts again under the fence just before the incumbent stops, so a terminal opened during
   * the upload still defers the update. Required, since `census` may predate a long upload.
   * Called only while the incumbent is the one counted; any failure must read as unverifiable.
   */
  recountCensus: () => Promise<QuirkydTerminalCensus>
  /**
   * Reopens the terminal admission `recountCensus` closes, when the update then leaves the
   * incumbent running. Best effort: the server reopens on its own once the fence lapses.
   */
  releaseIncumbentAdmission: () => Promise<void>
  force?: boolean
  /** The Quirky app version activating, recorded so an older client never downgrades the host. */
  appVersion?: string
  /**
   * Re-applies the caller's version policy to the record read under the host fence, since another
   * desktop can activate or stop a build while this one uploads. A reason refuses the activation.
   */
  admitRecord?: (record: QuirkydActivationRecord, candidateVersion: string) => string | null
  readinessTimeoutMs?: number
  /** WSL only; SSH hosts always re-hash the runtime (see `installQuirkydBundle`). */
  recordedNodeRuntimeProbe?: boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type QuirkydDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: QuirkydActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployQuirkyd(
  input: QuirkydDeployOptions,
  retryClearedFence = true
): Promise<QuirkydDeployResult> {
  const target =
    input.target ??
    (input.localQuirkydDir
      ? readQuirkydBundleTarget(input.localQuirkydDir)
      : await resolveQuirkydRuntimeTarget(input))
  const runtimeCacheRoot =
    input.runtimeCacheRoot ?? join(getAppEnvironment().getPath('userData'), 'quirkyd-artifacts')
  const options = {
    ...input,
    target,
    readinessTimeoutMs: resolveQuirkydActivationReadinessTimeout(
      input.readinessTimeoutMs,
      QUIRKYD_STARTUP_READINESS_TIMEOUT_MS
    ),
    nodeRuntimeArchive: () =>
      materializeNodeRuntimeArchive(target, runtimeCacheRoot, { signal: input.signal }),
    nodeRuntimeOfflineArchivePath: nodeRuntimeArchiveCachePath(target, runtimeCacheRoot),
    localQuirkydDir:
      input.localQuirkydDir ?? (await materializeQuirkydArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localQuirkydDir)
  const remoteDir = computeRemoteInstallDir(QUIRKYD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const held = async (): Promise<QuirkydDeployResult> => {
    const { cleared, ...refusal } = await quirkydActivationFenceRefusal(options, 'update')
    // Once: a second abandoned fence means something keeps leaving them, so report it.
    if (cleared && retryClearedFence) {
      return deployQuirkyd({ ...input, target, localQuirkydDir: options.localQuirkydDir }, false)
    }
    return { outcome: 'installed-not-activated', fullVersion, ...refusal }
  }
  // Fail fast before upload; the activation re-reads both under the fence.
  const preUploadRecord = await readQuirkydActivationRecord(options)
  const censusRecord = options.censusRecord ?? preUploadRecord
  // An unanswered probe only skips this shortcut: the fence acquisition itself still decides.
  if (await quirkydActivationFenceExists(options).catch(() => false)) {
    return held()
  }

  await installQuirkydBundle(options, fullVersion, remoteDir)

  return logQuirkydActivationOutcome(
    `update to ${fullVersion}`,
    () =>
      withQuirkydActivationLock(
        options,
        (lock) =>
          activateInstalledQuirkyd({ ...options, censusRecord }, fullVersion, remoteDir, lock),
        held
      ),
    ['installed-and-activated', 'already-active']
  )
}
