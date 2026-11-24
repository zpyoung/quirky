/**
 * Whether a managed quirkyd on a macOS host outlived the SSH session that started it (#25934), and
 * the restart that re-attributes it to the current session. See quirkyd-launch-ssh-session.ts.
 */
import { randomUUID } from 'node:crypto'
import type { QuirkydManagedRestartResult } from '../../../shared/quirkyd-managed-runtime'
import {
  withQuirkydActivationLock,
  type QuirkydActivationLockControl
} from '../activation/quirkyd-activation-lock'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import {
  quirkydLaunchSshSessionProbeCommand,
  parseQuirkydLaunchSshSession,
  recordsQuirkydLaunchSshSession,
  type QuirkydLaunchSshSession
} from '../../ssh/quirkyd-launch-ssh-session'
import { withManagedQuirkydLifecycle } from '../../ssh/quirkyd-runtime-maintenance'
import {
  managedQuirkydInstallDir,
  managedQuirkydSlot,
  requireManagedQuirkydEnvironment,
  requireManagedQuirkydInfrastructure,
  resolveLinkedQuirkydContext
} from './quirkyd-managed-runtime-context'
import { resolveQuirkydRemoteContext } from '../install/quirkyd-remote-context'
import { sshQuirkydHostTransport } from '../../ssh/quirkyd-ssh-host-transport'
import { rebuildQuirkydManagedTunnel } from './quirkyd-managed-tunnel'
import { wakeStoppedManagedQuirkyd } from './quirkyd-managed-wake'
import { readRemoteQuirkydManagedStopTarget } from './quirkyd-managed-remote-stop'
import { quirkydSlotDir, type QuirkydSlotOptions } from '../../ssh/quirkyd-recovery-slot'
import { stopIncumbentBehindTerminalBarrier } from './quirkyd-rollback-terminal-barrier'
import { execQuirkydRemote } from '../install/quirkyd-remote-runtime-control'
import { collectManagedTerminalCensus } from '../../ssh/quirkyd-terminal-census-client'

export async function readManagedQuirkydLaunchSshSession(
  userDataPath: string,
  environmentId: string
): Promise<QuirkydLaunchSshSession> {
  const { deployment } = requireManagedQuirkydEnvironment(userDataPath, environmentId)
  const { connectionManager, targetStore } = requireManagedQuirkydInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  // Why the open connection only: a background check must never redial a host the user left.
  const connection =
    target && connectionManager.getState(target.id)?.status === 'connected'
      ? (connectionManager.getConnection(target.id) ?? null)
      : null
  if (!target || !connection) {
    return 'unverifiable'
  }
  const context = await resolveQuirkydRemoteContext(target, sshQuirkydHostTransport(connection))
  if (!recordsQuirkydLaunchSshSession(context.host)) {
    return 'not-applicable'
  }
  const active = context.activationRecord.active
  if (!active) {
    return 'not-recorded'
  }
  return parseQuirkydLaunchSshSession(
    await execQuirkydRemote(
      { conn: context.connection, host: context.host },
      quirkydLaunchSshSessionProbeCommand(
        context.host,
        managedQuirkydInstallDir(context, active),
        context.userDataDir
      )
    )
  )
}

/**
 * Stops the active slot, retiring its idle terminal daemon, and starts it again from this
 * client's SSH session. Only on a host with no terminals: a surviving daemon keeps the old
 * attribution for every terminal it spawns.
 */
export function restartManagedQuirkydEnvironment(
  userDataPath: string,
  selector: string
): Promise<QuirkydManagedRestartResult> {
  return withManagedQuirkydLifecycle(
    userDataPath,
    selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedQuirkydContext(environment, deployment)
      if (!context.activationRecord.active) {
        return { outcome: 'not-restarted', reason: 'This host has no activated Quirky server.' }
      }
      // Why release: a finished automation shell no client used must not hold the restart back.
      const census = await collectManagedTerminalCensus(
        userDataPath,
        environment,
        context.activationRecord,
        undefined,
        { releaseFinishedAutomationTerminals: true }
      )
      if (census.liveSessions !== 0) {
        return { outcome: 'terminals-running', liveSessions: census.liveSessions }
      }
      const slot = managedQuirkydSlot(context, deployment.remotePort)
      const stopped = await withQuirkydActivationLock(
        slot,
        (lock) => stopRetiringIdleDaemon(slot, lock),
        (): StopOutcome => ({
          state: 'kept',
          reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
        })
      )
      if (stopped.state === 'kept') {
        return { outcome: 'not-restarted', reason: stopped.reason }
      }
      // Started even when the daemon stayed: a stopped server serves nothing.
      const wake = await wakeStoppedManagedQuirkyd(slot)
      if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
        return {
          outcome: 'not-restarted',
          reason:
            wake.outcome === 'recovery-refused'
              ? wake.reason
              : `This host’s Quirky server stopped but did not start again (${wake.outcome}); reconnect to start it.`
        }
      }
      // The started server may have bound another port than the forward in use.
      await rebuildQuirkydManagedTunnel(userDataPath, environment.id)
      const dir = quirkydSlotDir(slot, stopped.version)
      if (stopped.state === 'daemon-kept') {
        // The launch carried the ended session forward, so later connects keep the warning.
        return { outcome: 'not-restarted', reason: stopped.reason }
      }
      const session = parseQuirkydLaunchSshSession(
        await execQuirkydRemote(
          slot,
          quirkydLaunchSshSessionProbeCommand(slot.host, dir, slot.userDataDir)
        )
      )
      if (session === 'exited') {
        return {
          outcome: 'not-restarted',
          reason:
            'This host’s Quirky server restarted, but its terminals still belong to an SSH session ' +
            'that has ended: its terminal daemon was still running, or this connection opens a ' +
            'new SSH session for each command. Turn on SSH connection reuse for this host if ' +
            'it is off, then restart again.'
        }
      }
      return { outcome: 'restarted', environmentId: environment.id }
    }
  )
}

type StopOutcome =
  | { state: 'retired'; version: string }
  /** quirkyd exited but its daemon, which spawns every terminal, kept the old attribution. */
  | { state: 'daemon-kept'; version: string; reason: string }
  /** quirkyd keeps serving, or may still be stopping: nothing is started. */
  | { state: 'kept'; reason: string }

/** The rollback's managed stop: quirkyd retires its daemon only when no session exists then. */
async function stopRetiringIdleDaemon(
  slot: QuirkydSlotOptions,
  lock: QuirkydActivationLockControl
): Promise<StopOutcome> {
  // Re-read under the fence: another client may have changed the active slot.
  const active = (await readQuirkydActivationRecord(slot)).active
  if (!active) {
    return { state: 'kept', reason: 'This host has no activated Quirky server.' }
  }
  const target = await readRemoteQuirkydManagedStopTarget(slot, active)
  if (target.state === 'refused') {
    return { state: 'kept', reason: target.reason }
  }
  const barrier = await stopIncumbentBehindTerminalBarrier(slot, randomUUID(), target.context)
  switch (barrier.state) {
    case 'retired':
      return { state: 'retired', version: active }
    case 'unproven':
      return {
        state: 'daemon-kept',
        version: active,
        reason:
          'This host’s Quirky server restarted, but its terminal daemon kept running because a terminal ' +
          'was open at the stop, so terminals may still lack local network access.'
      }
    case 'unsettled':
      // quirkyd may still be stopping; like the rollback, the fence stays until recovery drops it.
      lock.retain()
      return { state: 'kept', reason: barrier.reason }
    case 'withdrawn':
      return { state: 'kept', reason: barrier.reason }
  }
}
