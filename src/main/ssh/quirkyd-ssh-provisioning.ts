import { z } from 'zod'
import type {
  QuirkydSshPendingProvisioning,
  QuirkydSshProvisioningRequest,
  QuirkydSshProvisioningResult
} from '../../shared/quirkyd-ssh-provisioning'
import type { SshRepoReadoption, SshTarget, SshTargetCreateInput } from '../../shared/ssh-types'
import { EphemeralVmRecipeSshTargetSchema } from '../../shared/ephemeral-vm-recipes'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getQuirkydSshDeployment } from '../../shared/runtime-environments'
import { normalizeSshConfigAlias } from '../../shared/ssh-config-alias'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import { normalizeSshTarget } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import { requireManagedQuirkydTargetStore } from '../managed-server/lifecycle/quirkyd-managed-runtime-context'
import { createManagedQuirkydEnvironment } from '../managed-server/lifecycle/quirkyd-runtime-deployment'
import { rotateSshProviderAuthority } from './ssh-provider-authority'

// Why no port forwards: a managed server is only created on an empty host.
const provisioningTargetSchema = EphemeralVmRecipeSshTargetSchema.omit({
  portForwards: true
}).extend({
  gssapiAuthentication: z.boolean().optional(),
  systemSshConnectionReuse: z.boolean().optional(),
  source: z.enum(['manual', 'ssh-config']).optional(),
  lastRequiredPassphrase: z.boolean().optional()
})

/** Requests whose server is not registered yet; a completed one keeps its intent for idempotent retries. */
export function listPendingQuirkydSshProvisioning(
  userDataPath: string
): QuirkydSshPendingProvisioning[] {
  const deployed = new Set(
    listEnvironments(userDataPath).flatMap(
      (environment) => getQuirkydSshDeployment(environment)?.sshTargetId ?? []
    )
  )
  return requireManagedQuirkydTargetStore()
    .getQuirkydRuntimeClaims()
    .listTargets()
    .flatMap((target) =>
      target.quirkydProvisioning && !deployed.has(target.id)
        ? [{ ...target.quirkydProvisioning, sshTargetId: target.id }]
        : []
    )
}

export function createQuirkydSshHost(
  userDataPath: string,
  request: QuirkydSshProvisioningRequest
): Promise<QuirkydSshProvisioningResult> {
  const requestId = requireRequestId(request?.requestId)
  const name = requireText(request?.name, 'Server name')
  const targetInput = parseTarget(request?.target)
  return runTargetLifecycle(`quirkyd-provision:${userDataPath}:${requestId}`, async () => {
    const targetStore = requireManagedQuirkydTargetStore()
    const targets = targetStore.getQuirkydRuntimeClaims().listTargets()
    const existing = targets.find((entry) => entry.quirkydProvisioning?.requestId === requestId)
    if (existing) {
      if (existing.quirkydProvisioning?.name !== name || !matchesRequest(existing, targetInput)) {
        throw new Error('This provisioning request already belongs to another host or server name.')
      }
      return provision(userDataPath, existing, [])
    }
    if (targets.some((entry) => sameEndpoint(entry, targetInput))) {
      throw new Error('That SSH host is already registered. Use its existing server or SSH entry.')
    }
    const target = targetStore.addTarget({
      ...targetInput,
      source: 'manual',
      quirkydProvisioning: { requestId, name }
    })
    const repoReadoptions = [...targetStore.lastRepoReadoptions]
    targetStore.lastRepoReadoptions = []
    for (const targetId of new Set(
      repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
    )) {
      rotateSshProviderAuthority(targetId)
    }
    if (repoReadoptions.length > 0) {
      // Why visible: re-adopted projects make the host non-empty; hiding it would hide them too.
      targetStore.updateTarget(target.id, { quirkydProvisioning: undefined })
      return {
        requestId,
        name,
        sshTargetId: target.id,
        repoReadoptions,
        result: {
          outcome: 'pending',
          reason:
            'This host already has Quirky projects, so it was restored as a direct SSH host. ' +
            'Quirky can only be set up on an empty host.'
        }
      }
    }
    return provision(userDataPath, target, repoReadoptions)
  })
}

export function resumeQuirkydSshHost(
  userDataPath: string,
  requestIdInput: string
): Promise<QuirkydSshProvisioningResult> {
  const requestId = requireRequestId(requestIdInput)
  return runTargetLifecycle(`quirkyd-provision:${userDataPath}:${requestId}`, async () => {
    const target = requireManagedQuirkydTargetStore()
      .getQuirkydRuntimeClaims()
      .listTargets()
      .find((entry) => entry.quirkydProvisioning?.requestId === requestId)
    if (!target) {
      throw new Error('The managed SSH provisioning request was not found.')
    }
    return provision(userDataPath, target, [])
  })
}

async function provision(
  userDataPath: string,
  target: SshTarget,
  repoReadoptions: SshRepoReadoption[]
): Promise<QuirkydSshProvisioningResult> {
  const intent = target.quirkydProvisioning
  if (!intent) {
    throw new Error('The managed SSH provisioning request was not found.')
  }
  // Why first: the intent must survive a crash before the host is contacted.
  await requireManagedQuirkydTargetStore().getQuirkydRuntimeClaims().flush()
  const base = { ...intent, sshTargetId: target.id, repoReadoptions }
  try {
    return {
      ...base,
      result: await createManagedQuirkydEnvironment(userDataPath, {
        name: intent.name,
        sshTargetId: target.id
      })
    }
  } catch (error) {
    return {
      ...base,
      result: {
        outcome: 'pending',
        reason: error instanceof Error ? error.message : 'Managed SSH provisioning failed.'
      }
    }
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new Error(`${label} is required and must not exceed 1024 characters.`)
  }
  return value.trim()
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('A stable managed SSH provisioning request id is required.')
  }
  return value
}

function parseTarget(value: unknown): SshTargetCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A new unowned SSH host is required.')
  }
  const {
    id: _id,
    generation: _generation,
    quirkydProvisioning: _intent,
    owner,
    ...raw
  }: Record<string, unknown> = { ...value }
  if (owner !== undefined) {
    throw new Error('A new unowned SSH host is required.')
  }
  const target = provisioningTargetSchema.parse(raw)
  return {
    ...target,
    label: requireText(target.label, 'SSH host label'),
    host: requireText(target.host, 'SSH host'),
    username: target.username.trim(),
    configHost: target.configHost?.trim() || target.host.trim()
  }
}

function sameEndpoint(left: SshTarget, right: SshTargetCreateInput): boolean {
  const alias = normalizeSshConfigAlias(right.configHost ?? right.host)
  if (
    alias &&
    [left.configHost, left.label].some((value) => normalizeSshConfigAlias(value) === alias)
  ) {
    return true
  }
  return left.host === right.host && left.port === right.port && left.username === right.username
}

function matchesRequest(target: SshTarget, input: SshTargetCreateInput): boolean {
  const stored: Record<string, unknown> = { ...target }
  return Object.entries(normalizeSshTarget({ ...input, id: target.id })).every(
    ([key, value]) => key === 'source' || JSON.stringify(stored[key]) === JSON.stringify(value)
  )
}
