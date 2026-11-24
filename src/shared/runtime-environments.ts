import { z } from 'zod'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from './paired-runtime-connection'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import {
  QuirkydWslDeploymentLinkSchema,
  type QuirkydWslDeploymentLink
} from './wsl-host-deployment-link'

export const RuntimeAccessEndpointSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('websocket'),
  label: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1)
})

export const PublicRuntimeAccessEndpointSchema = RuntimeAccessEndpointSchema.omit({
  deviceToken: true,
  publicKeyB64: true
})

export type PublicRuntimeAccessEndpoint = z.infer<typeof PublicRuntimeAccessEndpointSchema>

export const RuntimeEnvironmentSourceSchema = z.enum(['manual', 'ephemeral-vm'])
export type RuntimeEnvironmentSource = z.infer<typeof RuntimeEnvironmentSourceSchema>

export const RuntimeSshTunnelLinkSchema = z.object({
  sshTargetId: z.string().min(1),
  sshTargetGeneration: z.number().int().positive(),
  localPort: z.number().int().min(1).max(65_535),
  remotePort: z.number().int().min(1).max(65_535)
})

export type RuntimeSshTunnelLink = z.infer<typeof RuntimeSshTunnelLinkSchema>

/** A server Quirky deployed and owns over SSH; unlike sshAccess, it grants lifecycle ownership. */
export const QuirkydSshDeploymentLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  // Absent on disk: the sidecar persists SSH links without it, so older builds read them unchanged.
  kind: z.literal('ssh').optional()
})
export type QuirkydSshDeploymentLink = z.infer<typeof QuirkydSshDeploymentLinkSchema>

/** A server Quirky deployed and owns; the WSL kind is persisted only in wsl-host-deployment-store. */
export const QuirkydDeploymentLinkSchema = z.union([
  QuirkydSshDeploymentLinkSchema,
  QuirkydWslDeploymentLinkSchema
])
export type QuirkydDeploymentLink = z.infer<typeof QuirkydDeploymentLinkSchema>

/** The managed deployment Quirky owns over SSH; undefined for none or a WSL one. */
export function getQuirkydSshDeployment(environment: {
  quirkydDeployment?: QuirkydDeploymentLink | null
}): QuirkydSshDeploymentLink | undefined {
  const deployment = environment.quirkydDeployment
  return deployment && deployment.kind !== 'wsl' ? deployment : undefined
}

export const RuntimeSshAccessLinkSchema = RuntimeSshTunnelLinkSchema.extend({
  requestId: z.string().min(1).optional(),
  targetFingerprint: z.string().min(1).optional(),
  endpointId: z.string().min(1),
  previousPreferredEndpointId: z.string().min(1)
})

export type RuntimeSshAccessLink = z.infer<typeof RuntimeSshAccessLinkSchema>

export const RuntimeSshAccessOperationSchema = RuntimeSshTunnelLinkSchema.omit({ localPort: true })
  .extend({
    requestId: z.string().min(1),
    operation: z.enum(['link', 'unlink']),
    targetFingerprint: z.string().min(1).optional()
  })
  .refine((intent) => intent.operation !== 'link' || !!intent.targetFingerprint, {
    message: 'Link intent requires a target fingerprint.'
  })

export type RuntimeSshAccessOperation = z.infer<typeof RuntimeSshAccessOperationSchema>

/** The fields shipped builds read and rewrite in quirky-environments.json. */
export const PersistedRuntimeEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  pairingRevision: z.number().finite().optional(),
  pairedDeviceId: z.string().min(1).optional(),
  lastUsedAt: z.number().finite().nullable(),
  runtimeId: z.string().min(1).nullable(),
  source: RuntimeEnvironmentSourceSchema.optional(),
  connectionDependency: z.literal('ssh-tunnel').optional(),
  endpoints: z.array(RuntimeAccessEndpointSchema).min(1),
  preferredEndpointId: z.string().min(1)
})

export type PersistedRuntimeEnvironment = z.infer<typeof PersistedRuntimeEnvironmentSchema>

/**
 * A persisted environment with its sidecar state overlaid (runtime-environment-sidecar). These
 * fields never enter quirky-environments.json: shipped builds strip unknown keys when they rewrite it.
 */
export const KnownRuntimeEnvironmentSchema = PersistedRuntimeEnvironmentSchema.extend({
  sshAccess: RuntimeSshAccessLinkSchema.optional(),
  pendingSshAccessOperation: RuntimeSshAccessOperationSchema.optional(),
  quirkydDeployment: QuirkydDeploymentLinkSchema.optional(),
  /** When a migration into this managed server began committing; older snapshots predate it. */
  quirkydMigratedAt: z.string().datetime().optional(),
  reconciliation: RuntimeEnvironmentReconciliationRecordSchema.optional()
})
  .refine(
    ({ pendingSshAccessOperation, sshAccess, quirkydDeployment, connectionDependency }) =>
      !pendingSshAccessOperation || (!sshAccess && !quirkydDeployment && !connectionDependency),
    {
      message: 'Pending SSH access operations cannot coexist with active SSH access.',
      path: ['pendingSshAccessOperation']
    }
  )
  .refine(
    (environment) => {
      const access = environment.sshAccess
      return (
        !access ||
        (environment.connectionDependency === 'ssh-tunnel' &&
          environment.preferredEndpointId === access.endpointId &&
          access.previousPreferredEndpointId !== access.endpointId &&
          environment.endpoints.some(
            (endpoint) => endpoint.id === access.previousPreferredEndpointId
          ) &&
          getPreferredLoopbackRuntimePort(environment) === access.localPort)
      )
    },
    {
      message:
        'Runtime SSH access must preserve its previous endpoint and prefer its loopback endpoint.',
      path: ['sshAccess']
    }
  )
  .refine(
    (environment) => {
      const deployment = environment.quirkydDeployment
      // Why no WSL dependency value: older builds reject any other value in quirky-environments.json;
      // a WSL link's kind, kept in its own file, is the bridge dependency.
      const dependency = deployment?.kind === 'wsl' ? undefined : 'ssh-tunnel'
      return (
        !deployment ||
        (!environment.sshAccess &&
          environment.connectionDependency === dependency &&
          getPreferredLoopbackRuntimePort(environment) === deployment.localPort)
      )
    },
    {
      message:
        'A managed deployment must prefer its own tunnel and exclude independent SSH access.',
      path: ['quirkydDeployment']
    }
  )

export type KnownRuntimeEnvironment = z.infer<typeof KnownRuntimeEnvironmentSchema>

export type PublicKnownRuntimeEnvironment = Omit<KnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: PublicRuntimeAccessEndpoint[]
  /** Digest of the host's persisted E2EE public key, which its pairing handshake proves. */
  hostKeyFingerprint?: string
}

export function redactRuntimeEnvironment(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _deviceToken, publicKeyB64: _key, ...rest }) => rest
    )
  }
}

// Why version 1 and the persisted schema: shipped builds accept only this shape, so every
// T5 field lives in the sidecar and a downgrade rewrite cannot lose or reject it.
export const RuntimeEnvironmentStoreSchema = z.object({
  version: z.literal(1),
  environments: z.array(PersistedRuntimeEnvironmentSchema)
})

export type RuntimeEnvironmentStore = z.infer<typeof RuntimeEnvironmentStoreSchema>

export function createEnvironmentFromPairingOffer(args: {
  id: string
  name: string
  now: number
  offer: PairingOffer
  runtimeId?: string | null
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
}): KnownRuntimeEnvironment {
  const endpointId = `ws-${args.id}`
  return KnownRuntimeEnvironmentSchema.parse({
    id: args.id,
    name: args.name,
    createdAt: args.now,
    updatedAt: args.now,
    pairingRevision: args.now,
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    lastUsedAt: null,
    runtimeId: args.runtimeId ?? null,
    ...(args.source ? { source: args.source } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    endpoints: [
      {
        id: endpointId,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ],
    preferredEndpointId: endpointId
  })
}

export function isEphemeralVmRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return environment.source === 'ephemeral-vm'
}

export function isUserManagedRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return !isEphemeralVmRuntimeEnvironment(environment)
}

/** Only the user re-pairs these, with an access link; Quirky pairs managed and cloud servers itself. */
export function isRepairableWithAccessLink(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'quirkydDeployment'>
): boolean {
  return !environment.quirkydDeployment && isUserManagedRuntimeEnvironment(environment)
}

/** Who pairs a server that refused this desktop: the user with a link, Quirky over SSH, or Quirky on Connect. */
export type RuntimePairingRepairRoute = 'access-link' | 'ssh' | 'connect'

export function runtimePairingRepairRoute(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'quirkydDeployment'>
): RuntimePairingRepairRoute {
  if (getQuirkydSshDeployment(environment)) {
    return 'ssh'
  }
  return isRepairableWithAccessLink(environment) ? 'access-link' : 'connect'
}

/** A WSL distro added as a host; keyed by its deployment record's kind, never by its name. */
export function isWslHostRuntimeEnvironment<
  T extends { quirkydDeployment?: QuirkydDeploymentLink | null }
>(environment: T): environment is T & { quirkydDeployment: QuirkydWslDeploymentLink } {
  return environment.quirkydDeployment?.kind === 'wsl'
}

/**
 * A server the generic remote-server surfaces list (Settings, status bar, server updates):
 * neither a recipe VM nor a WSL host, which each have their own place.
 */
export function isListedRemoteServer(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source' | 'quirkydDeployment'>
): boolean {
  return isUserManagedRuntimeEnvironment(environment) && !isWslHostRuntimeEnvironment(environment)
}

type PreferredEndpointSource = Pick<
  KnownRuntimeEnvironment,
  'name' | 'endpoints' | 'preferredEndpointId' | 'pairedDeviceId'
>

function preferredEndpoint(environment: PreferredEndpointSource) {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error(`Environment ${environment.name} has no access endpoints`)
  }
  return endpoint
}

export function getPreferredPairedRuntimeConnection(
  environment: PreferredEndpointSource
): PairedRuntimeConnection {
  const endpoint = preferredEndpoint(environment)
  return pairedRuntimeConnectionFromOffer({
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    pairedDeviceId: environment.pairedDeviceId
  })
}

export function getPreferredPairingOffer(environment: PreferredEndpointSource): PairingOffer {
  const endpoint = preferredEndpoint(environment)
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
}

/** The SSH tunnel a server is reached through; only quirkydDeployment also grants lifecycle ownership. */
export function getRuntimeSshAccess(
  environment: Pick<KnownRuntimeEnvironment, 'quirkydDeployment' | 'sshAccess'>
): RuntimeSshTunnelLink | undefined {
  return getQuirkydSshDeployment(environment) ?? environment.sshAccess
}

export function getPreferredLoopbackRuntimePort(environment: {
  endpoints: { id: string; endpoint: string }[]
  preferredEndpointId: string
}): number | null {
  const endpoint = environment.endpoints.find(
    (entry) => entry.id === environment.preferredEndpointId
  )
  if (!endpoint) {
    return null
  }
  try {
    const url = new URL(endpoint.endpoint)
    const port = Number(url.port)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      classifyRemotePairingHostname(url.hostname) === 'loopback' &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
      ? port
      : null
  } catch {
    return null
  }
}
