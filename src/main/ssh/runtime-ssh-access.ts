import {
  RuntimeSshAccessLinkRequestSchema,
  RuntimeSshAccessUnlinkRequestSchema,
  type RuntimeSshAccessLinkRequest,
  type RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  cancelRuntimeEnvironmentSshAccessLink,
  completeRuntimeEnvironmentSshAccessUnlink,
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink,
  prepareRuntimeEnvironmentSshAccessUnlink
} from '../../shared/runtime-environment-ssh-access-store'
import { getManagedQuirkydFenceEnvironmentId } from '../../shared/managed-quirkyd-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import { requireManagedQuirkydInfrastructure } from '../managed-server/lifecycle/quirkyd-managed-runtime-context'
import {
  closeQuirkydManagedTunnel,
  ensureQuirkydManagedTunnel,
  startQuirkydManagedTunnel
} from '../managed-server/lifecycle/quirkyd-managed-tunnel'
import { verifyRuntimeEnvironmentSshTunnel } from './runtime-ssh-access-verification'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-target-fingerprint'

type TargetClaims = ReturnType<typeof requireManagedQuirkydInfrastructure>['claims']

export { fingerprintRuntimeSshTarget }

function requireTarget(claims: TargetClaims, targetId: string): SshTarget & { generation: number } {
  const target = claims.listTargets().find((entry) => entry.id === targetId)
  const generation = target?.generation
  if (!target || generation === undefined || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('SSH access requires an existing durable SSH target generation.')
  }
  if (target.quirkydProvisioning) {
    throw new Error('This SSH target has pending server provisioning.')
  }
  return { ...target, generation }
}

function requireAccessOnlyTarget(claims: TargetClaims, targetId: string, environmentId: string) {
  const target = requireTarget(claims, targetId)
  // Omitting the environment bypasses the same-owner shortcut and rechecks direct authority.
  const blockers = claims
    .preflight(targetId)
    .blockers.filter(
      (entry) =>
        !(
          entry.code === 'quirkyd_migration_target_owned' &&
          getManagedQuirkydFenceEnvironmentId(target) === environmentId
        )
    )
  if (blockers.length) {
    throw new Error(`SSH access cannot claim direct SSH authority: ${blockers[0].code}`)
  }
  return target
}

function requireFence(
  claims: TargetClaims,
  environmentId: string,
  fence: {
    sshTargetId: string
    sshTargetGeneration: number
    targetFingerprint?: string
  },
  allowUnowned = false
): SshTarget {
  const target = requireTarget(claims, fence.sshTargetId)
  const owner = getManagedQuirkydFenceEnvironmentId(target)
  if (
    target.generation !== fence.sshTargetGeneration ||
    !fence.targetFingerprint ||
    fingerprintRuntimeSshTarget(target) !== fence.targetFingerprint ||
    (owner !== environmentId && !(allowUnowned && !target.quirkydFence))
  ) {
    throw new Error('The SSH target registration, connection configuration, or owner changed.')
  }
  return target
}

export function linkRuntimeSshAccess(
  userDataPath: string,
  input: RuntimeSshAccessLinkRequest,
  options: {
    signal?: AbortSignal
    invalidateTransport?: (environmentId: string) => void | Promise<void>
  } = {}
) {
  const args = RuntimeSshAccessLinkRequestSchema.parse(input)
  const environmentId = resolveEnvironment(userDataPath, args.selector).id
  return runTargetLifecycle(`runtime-ssh-access:${userDataPath}:${environmentId}`, () =>
    runTargetLifecycle(args.sshTargetId, async () => {
      const { claims, connectionManager } = requireManagedQuirkydInfrastructure()
      const environment = resolveEnvironment(userDataPath, environmentId)
      assertRuntimeEnvironmentNotReconciling(environment)
      if (environment.quirkydDeployment) {
        throw new Error('Managed deployments cannot use independent SSH access.')
      }
      const target = requireAccessOnlyTarget(claims, args.sshTargetId, environmentId)
      const fence = {
        sshTargetId: target.id,
        sshTargetGeneration: target.generation,
        targetFingerprint: fingerprintRuntimeSshTarget(target)
      }
      if (environment.sshAccess) {
        const access = environment.sshAccess
        if (
          environment.pendingSshAccessOperation ||
          access.requestId !== args.requestId ||
          access.sshTargetId !== args.sshTargetId ||
          access.remotePort !== args.remotePort
        ) {
          throw new Error('This server already has a different SSH access request.')
        }
        requireFence(claims, environmentId, access)
        await ensureQuirkydManagedTunnel(userDataPath, environmentId)
        requireFence(claims, environmentId, access)
        await options.invalidateTransport?.(environmentId)
        return redactRuntimeEnvironment(resolveEnvironment(userDataPath, environmentId))
      }
      const prepared = prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: environment,
        requestId: args.requestId,
        remotePort: args.remotePort,
        ...fence
      })
      await claims.flush()
      requireAccessOnlyTarget(claims, target.id, environmentId)
      requireFence(claims, environmentId, fence, true)
      // Why recorded: the durable link intent above names this target and environment.
      claims.claim(target.id, environmentId, { ownerRecorded: true })
      await claims.flush()
      let tunnelStarted = false
      let linkCommitted = false
      try {
        options.signal?.throwIfAborted()
        const claimed = requireFence(claims, environmentId, fence)
        // A cancel drops the pending connect, which frees both lifecycle queues behind it.
        const cancelConnect = (): void =>
          void connectionManager.disconnect(claimed.id).catch(() => {})
        options.signal?.addEventListener('abort', cancelConnect, { once: true })
        const connection = await connectionManager
          .connect(claimed)
          .finally(() => options.signal?.removeEventListener('abort', cancelConnect))
        options.signal?.throwIfAborted()
        requireFence(claims, environmentId, fence)
        tunnelStarted = true
        const localPort = await startQuirkydManagedTunnel(
          environmentId,
          claimed,
          connection,
          args.remotePort
        )
        const proof = await verifyRuntimeEnvironmentSshTunnel(prepared, localPort, options.signal)
        options.signal?.throwIfAborted()
        requireAccessOnlyTarget(claims, target.id, environmentId)
        requireFence(claims, environmentId, fence)
        const linked = redactRuntimeEnvironment(
          linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
            expectedEnvironment: prepared,
            requestId: args.requestId,
            ...proof,
            tunnel: {
              sshTargetId: target.id,
              sshTargetGeneration: fence.sshTargetGeneration,
              localPort,
              remotePort: args.remotePort
            }
          })
        )
        linkCommitted = true
        await options.invalidateTransport?.(environmentId)
        return linked
      } catch (error) {
        if (tunnelStarted && !linkCommitted) {
          await closeQuirkydManagedTunnel(environmentId)
        }
        throw error
      }
    })
  )
}

export function unlinkRuntimeSshAccess(
  userDataPath: string,
  input: RuntimeSshAccessUnlinkRequest,
  options: { invalidateTransport: (environmentId: string) => void | Promise<void> }
) {
  const args = RuntimeSshAccessUnlinkRequestSchema.parse(input)
  const environmentId = resolveEnvironment(userDataPath, args.selector).id
  return runTargetLifecycle(`runtime-ssh-access:${userDataPath}:${environmentId}`, async () => {
    const environment = resolveEnvironment(userDataPath, environmentId)
    assertRuntimeEnvironmentNotReconciling(environment)
    if (environment.quirkydDeployment) {
      throw new Error('Managed deployments cannot unlink independent SSH access.')
    }
    const access = environment.pendingSshAccessOperation ?? environment.sshAccess
    if (!access) {
      return redactRuntimeEnvironment(environment)
    }
    return runTargetLifecycle(access.sshTargetId, async () => {
      const { claims } = requireManagedQuirkydInfrastructure()
      requireFence(claims, environmentId, access, !!environment.pendingSshAccessOperation)
      const prepared =
        environment.pendingSshAccessOperation?.operation === 'link'
          ? cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
              expectedEnvironment: environment,
              requestId: args.requestId
            })
          : prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
              expectedEnvironment: environment,
              requestId: args.requestId
            })
      await options.invalidateTransport(environmentId)
      await closeQuirkydManagedTunnel(environmentId)
      const target = requireFence(claims, environmentId, access, true)
      if (target.quirkydFence && !claims.release(target.id, environmentId)) {
        throw new Error('The SSH target owner changed before access could be released.')
      }
      await claims.flush()
      requireFence(claims, environmentId, access, true)
      return redactRuntimeEnvironment(
        completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
          expectedEnvironment: prepared,
          requestId: args.requestId
        })
      )
    })
  })
}
