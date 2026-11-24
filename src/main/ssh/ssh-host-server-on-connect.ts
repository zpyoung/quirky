/**
 * Which server an SSH host runs, decided once per connect before any relay is started.
 *
 * Every host runs managed quirkyd: an empty host deploys it, a host with Quirky state converts through
 * the journaled migration, and a converted host connects through its tunnel, updating first when
 * it runs an older build and its terminals allow. A host whose relay terminals are live, or can't
 * be proven exited, keeps the relay this session and converts on a later connect. A host quirkyd
 * can't run on keeps the pinned-relay ladder, with the reason recorded so the deploy isn't retried
 * on every connect. A host whose sshd refuses port forwarding reaches its server through the
 * stdio bridge (quirkyd-managed-tunnel-transport.ts) instead.
 */
import type {
  QuirkydManagedConversionResult,
  QuirkydManagedDeployResult
} from '../../shared/quirkyd-managed-runtime'
import type {
  SshManagedServerRelayReason,
  SshManagedServerLinkedProject,
  SshManagedServerNodeDownloadBlocked,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import type { QuirkydManagedServing } from '../managed-server/lifecycle/quirkyd-managed-serving'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from './managed-server-update-check'
import { managedResultAfterUpdate, unservedManagedResult } from './managed-server-serving-gate'
import { quirkydMigrationConflictGuidance } from './quirkyd-migration-conflict-guidance'
import { keptForBridgedTerminals, relayTerminalReason } from './ssh-host-server-bridged-unserved'
import { boundedDetail, setupFailure, type SetupFailure } from './ssh-host-server-setup-failure'
import {
  classifyQuirkydHostUnavailable,
  QUIRKYD_TUNNEL_UNAVAILABLE_REASON
} from '../quirkyd/quirkyd-host-unavailable'

export type HostServerPhase = 'deploying' | 'converting' | 'connecting' | 'updating' | 'starting'

export type HostServerOnConnectResult =
  | {
      route: 'managed'
      environmentId: string
      update?: SshManagedServerUpdateNote
      serving?: SshManagedServerServingNote
      linked?: SshManagedServerLinkedProject[]
      /** Another desktop's update held the host; recheck until it clears. Never published. */
      fenceHeld?: true
    }
  | {
      route: 'unserved'
      reason: SshManagedServerRelayReason
      /** A blocker the user must act on, or why quirkyd can't run on this host. */
      detail?: string
      terminals?: number
      terminalsElsewhere?: boolean
      canLeaveBehind?: true
      /** A move that stopped short kept the host locked; the next connect resumes it. */
      held?: true
      /** Setup lost contact with the host, so it is not known to have failed there. */
      contactLost?: true
      nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked
      /** COMPAT(legacy-relay-bridge): the connect stays up so the bridge serves the terminals. */
      bridged?: true
    }

export type HostServerTerminalVerdict = {
  verdict: 'exited' | 'live' | 'unverifiable'
  /** Relay terminals known to be running or unproven. */
  count: number
  /** Counted only by the host-wide census: another desktop or session runs them. */
  elsewhere?: boolean
  /** COMPAT(legacy-relay-bridge): the host converts anyway and the bridge serves them. */
  bridged?: true
}

export type HostServerOnConnectDeps = {
  managedEnvironmentId: (target: SshTarget) => string | null
  ensureTunnel: (environmentId: string) => Promise<void>
  /** Behind the tunnel: answers, or is started from its activated slot if proven stopped. */
  ensureServing: (environmentId: string) => Promise<QuirkydManagedServing>
  /** Marks a commit whose reply outlived the move as finished; its source rows are kept. */
  retainCommittedSource: (target: SshTarget) => Promise<void>
  /** False when this build carries no quirkyd template, so nothing is tried on the host. */
  hasTemplate: () => boolean
  /** A recorded "quirkyd can't run here" whose key still matches this build. */
  recordedUnavailable: (target: SshTarget) => string | null
  recordUnavailable: (target: SshTarget, reason: string) => void
  /** True when the host holds no Quirky state, so it deploys without a migration. */
  isEmptyHost: (target: SshTarget) => boolean
  relayTerminals: (target: SshTarget) => Promise<HostServerTerminalVerdict>
  deploy: (target: SshTarget) => Promise<QuirkydManagedDeployResult>
  /** `hostProof`: the connect's own terminal verdict, for a conversion asked before any session. */
  convert: (
    target: SshTarget,
    hostProof: HostServerTerminalVerdict | null
  ) => Promise<QuirkydManagedConversionResult>
  /** A registered server whose conversion has not committed and been kept yet. */
  hasUnfinishedConversion: (target: SshTarget) => boolean
  /** Releases a conversion fence once its server provably holds nothing, so the relay serves. */
  abandonConversion: (target: SshTarget) => Promise<void>
  /** Releases an empty-host deploy claim whose server was never registered. */
  abandonDeploy: (target: SshTarget) => Promise<void>
  progress: (target: SshTarget, phase: HostServerPhase) => void
  /** A conversion fenced the host and registered its server, but staged nothing there yet. */
  isFencedBeforeStaging: (target: SshTarget) => boolean
  /** Unregisters that unreachable server and releases its fence, so the relay serves again. */
  releaseUnreachableSetup: (target: SshTarget) => Promise<void>
} & ManagedServerUpdateDeps

export async function resolveHostServerOnConnect(
  target: SshTarget,
  deps: HostServerOnConnectDeps
): Promise<HostServerOnConnectResult> {
  if (target.quirkydFence?.sourceChangedAt) {
    return { route: 'unserved', reason: 'source_changed' }
  }
  const existing = deps.managedEnvironmentId(target)
  if (existing) {
    deps.progress(target, 'connecting')
    try {
      await deps.ensureTunnel(existing)
    } catch (error) {
      // Why only before staging: once the server holds staged state, only it can say what moved.
      if (
        classifyQuirkydHostUnavailable(error) === QUIRKYD_TUNNEL_UNAVAILABLE_REASON &&
        deps.isFencedBeforeStaging(target)
      ) {
        await deps.releaseUnreachableSetup(target)
        deps.recordUnavailable(target, QUIRKYD_TUNNEL_UNAVAILABLE_REASON)
        return {
          route: 'unserved',
          reason: 'quirkyd_unavailable',
          detail: QUIRKYD_TUNNEL_UNAVAILABLE_REASON
        }
      }
      throw error
    }
    if (deps.hasUnfinishedConversion(target)) {
      // Why before routing: until the commit lands the server is empty, so finish it or back out.
      return await convertHost(target, deps, { checkTerminals: false })
    }
    const serving = await deps.ensureServing(existing)
    const unserved = unservedManagedResult(existing, serving)
    if (unserved) {
      return unserved
    }
    try {
      await deps.retainCommittedSource(target)
    } catch (error) {
      console.warn('[ssh] Could not mark a finished migration retained:', error)
    }
    const update = await checkManagedServerUpdate(target, existing, deps, () =>
      deps.progress(target, 'updating')
    )
    return managedResultAfterUpdate(existing, serving, update)
  }
  const recorded = deps.recordedUnavailable(target)
  if (recorded) {
    return { route: 'unserved', reason: 'quirkyd_unavailable', detail: recorded }
  }
  if (!deps.hasTemplate()) {
    return { route: 'unserved', reason: 'quirkyd_unavailable', detail: 'artifacts_unavailable' }
  }
  if (deps.isEmptyHost(target)) {
    try {
      deps.progress(target, 'deploying')
      const deployed = await deps.deploy(target)
      return await afterDeploy(target, deps, deployed)
    } catch (error) {
      return setupFailed(target, deps, error, true)
    }
  }
  return convertHost(target, deps, { checkTerminals: true })
}

async function convertHost(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  options: { checkTerminals: boolean }
): Promise<HostServerOnConnectResult> {
  let terminals: HostServerTerminalVerdict | null = null
  try {
    terminals = options.checkTerminals ? await deps.relayTerminals(target) : null
    if (terminals && terminals.verdict !== 'exited' && !terminals.bridged) {
      // Why unverifiable too: loss of contact is never evidence that a relay terminal exited.
      return {
        route: 'unserved',
        reason: relayTerminalReason(terminals.verdict),
        terminals: terminals.count,
        ...(terminals.elsewhere ? { terminalsElsewhere: true } : {})
      }
    }
    deps.progress(target, 'converting')
    const converted = await deps.convert(target, terminals)
    return await afterConversion(target, deps, converted)
  } catch (error) {
    // COMPAT(legacy-relay-bridge): the terminals run on in their old tabs until they exit.
    const failed = await setupFailed(target, deps, error, false)
    return keptForBridgedTerminals(failed, terminals, error)
  }
}

function setupFailed(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  error: unknown,
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn('[ssh] Managed Quirky server setup failed; using the relay this session:', error)
  const unavailable = classifyQuirkydHostUnavailable(error)
  const conflict = empty ? null : quirkydMigrationConflictGuidance(error)
  if (conflict) {
    return unfinished(target, deps, unavailable, empty, 'refused', { detail: conflict })
  }
  return unfinished(target, deps, unavailable, empty, 'failed', setupFailure(error))
}

async function afterDeploy(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: QuirkydManagedDeployResult
): Promise<HostServerOnConnectResult> {
  if (result.outcome === 'deferred') {
    return deferred(target, deps, result, true)
  }
  const environmentId = result.environment.id
  if (result.outcome !== 'already-current') {
    return { route: 'managed', environmentId }
  }
  // Another Quirky version may serve it; only the now-paired server can say whether it may update.
  const update = await checkManagedServerUpdate(target, environmentId, deps, () =>
    deps.progress(target, 'updating')
  )
  return managedResultAfterUpdate(environmentId, { state: 'serving' }, update)
}

async function afterConversion(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: QuirkydManagedConversionResult
): Promise<HostServerOnConnectResult> {
  switch (result.outcome) {
    case 'converted':
      return {
        route: 'managed',
        environmentId: result.environment.id,
        ...(result.linkedProjects ? { linked: result.linkedProjects } : {})
      }
    case 'deferred':
      return deferred(target, deps, result, false)
    case 'refused':
      if (result.code === 'quirkyd_migration_terminals') {
        return { route: 'unserved', reason: relayTerminalReason(result.verdict) }
      }
      return {
        route: 'unserved',
        reason: 'refused',
        detail: result.reason,
        ...(result.canLeaveBehind ? { canLeaveBehind: true } : {})
      }
  }
}

function deferred(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: { code: string; reason: string },
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn(`[ssh] Managed Quirky server setup deferred (${result.code}):`, result.reason)
  const unavailable = classifyQuirkydHostUnavailable({ code: result.code })
  return unfinished(target, deps, unavailable, empty, 'deferred', { detail: result.reason })
}

/**
 * A setup that stopped short: its claim or fence goes first, since a fenced host refuses the relay
 * and nothing remote serves it yet. A host quirkyd can't run on also records why.
 */
async function unfinished(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  unavailable: string | null,
  empty: boolean,
  reason: 'deferred' | 'failed' | 'refused',
  failure: SetupFailure
): Promise<HostServerOnConnectResult> {
  try {
    await (empty ? deps.abandonDeploy(target) : deps.abandonConversion(target))
  } catch (error) {
    // A staged or registered destination keeps its fence; the connect reports it below.
    console.warn('[ssh] The managed Quirky server setup keeps its fence:', error)
  }
  // Why re-read: only the journal says whether the abort released the host or left it locked.
  const held = !empty && !unavailable && deps.hasUnfinishedConversion(target)
  if (!unavailable) {
    // Shown under the SSH host, with the host's quirkyd.log tail when the failure carries one.
    return {
      route: 'unserved',
      reason,
      detail: boundedDetail(failure.detail),
      ...(failure.contactLost ? { contactLost: true as const } : {}),
      ...(failure.nodeDownloadBlocked ? { nodeDownloadBlocked: failure.nodeDownloadBlocked } : {}),
      ...(held ? { held: true as const } : {})
    }
  }
  deps.recordUnavailable(target, unavailable)
  return { route: 'unserved', reason: 'quirkyd_unavailable', detail: unavailable }
}
