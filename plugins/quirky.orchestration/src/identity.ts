import { validateValue, type PluginCaller, type PluginContext, type Schema } from '@quirky/protocol'
import type { DeclaredCallerAliases, RuntimeCallerEvidence } from './contracts'
import type { AuthorityBearingCaller, SessionIdentity } from './runtime-contracts'
import { fail } from './errors'

export interface VerifiedSessionCaller {
  evidence: RuntimeCallerEvidence
  identity: SessionIdentity
}

const identitySchema: Schema = {
  type: 'object',
  required: ['sessionId', 'live', 'runtimeEpoch', 'processIncarnation', 'source', 'kind', 'providerId', 'worktreeId'],
  properties: {
    sessionId: { type: 'string' },
    live: { type: 'boolean' },
    runtimeEpoch: { type: 'string' },
    processIncarnation: { type: 'string' },
    source: { type: 'string', enum: ['terminal_launch', 'structured_lease', 'restored_authority'] },
    kind: { type: 'string', enum: ['terminal', 'structured'] },
    providerId: {},
    worktreeId: { type: 'string' }
  },
  additionalProperties: false
}

function isSessionIdentity(value: unknown, expectedSessionId: string): value is SessionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim().length > 0 &&
    candidate.sessionId === expectedSessionId &&
    candidate.live === true &&
    typeof candidate.runtimeEpoch === 'string' && candidate.runtimeEpoch.trim().length > 0 &&
    typeof candidate.processIncarnation === 'string' && candidate.processIncarnation.trim().length > 0 &&
    (candidate.source === 'terminal_launch' || candidate.source === 'structured_lease' || candidate.source === 'restored_authority') &&
    (candidate.kind === 'terminal' || candidate.kind === 'structured') &&
    (candidate.providerId === null || typeof candidate.providerId === 'string') &&
    typeof candidate.worktreeId === 'string' && candidate.worktreeId.trim().length > 0
}
function callerAuthority(caller: PluginCaller): AuthorityBearingCaller['sessionAuthority'] {
  if (caller.role === 'plugin') return undefined
  return (caller as PluginCaller & AuthorityBearingCaller).sessionAuthority
}

/** Revalidate kernel-attested caller authority against the session plugin on every write. */
export async function verifyCaller(
  context: PluginContext,
  caller: PluginCaller,
  aliases: DeclaredCallerAliases = {}
): Promise<VerifiedSessionCaller> {
  const authority = callerAuthority(caller)
  if (!authority || authority.live !== true || typeof authority.sessionId !== 'string' || authority.sessionId.trim().length === 0) {
    fail(context, 'consumer_fenced', 'this operation requires a live runtime-attested session caller')
  }
  if (caller.role === 'plugin' || (caller.sessionId !== undefined && caller.sessionId !== authority.sessionId)) {
    fail(context, 'consumer_fenced', 'the kernel-attested session does not match the caller identity')
  }
  if (aliases.from !== undefined && aliases.from !== authority.sessionId) {
    fail(context, 'consumer_fenced', `caller is attested as ${authority.sessionId}, not ${aliases.from}`)
  }
  if (aliases.terminal !== undefined && aliases.terminal !== authority.sessionId) {
    fail(context, 'consumer_fenced', `caller is attested as ${authority.sessionId}, not ${aliases.terminal}`)
  }

  const identity = await targetIdentity(context, authority.sessionId, 'consumer_fenced')
  if (
    identity.runtimeEpoch !== authority.runtimeEpoch ||
    identity.processIncarnation !== authority.processIncarnation ||
    identity.source !== authority.source
  ) {
    fail(context, 'consumer_fenced', 'the caller session changed after the connection was authenticated', {
      sessionId: authority.sessionId
    })
  }

  return {
    identity,
    evidence: {
      callerSessionId: authority.sessionId,
      runtimeSessionId: identity.sessionId,
      runtimeOwned: true,
      live: true,
      attestation: {
        source: identity.source,
        runtimeEpoch: identity.runtimeEpoch,
        processIncarnation: identity.processIncarnation
      }
    }
  }
}

/** A public session lookup is untrusted until both protocol validation and domain guards pass. */
export async function targetIdentity(
  context: PluginContext,
  sessionId: string,
  reason: 'consumer_fenced' | 'terminal_not_found' = 'terminal_not_found'
): Promise<SessionIdentity> {
  let value: unknown
  try {
    value = await context.call('quirky.session/identity', { session: sessionId })
  } catch (error) {
    fail(context, reason, `session ${sessionId} has no current live runtime identity`, {
      sessionId,
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  const validation = validateValue(identitySchema, value, 'identity')
  if (validation !== null || !isSessionIdentity(value, sessionId)) {
    fail(context, reason, `session ${sessionId} is not a valid live runtime identity`, {
      sessionId,
      ...(validation === null ? {} : { validation })
    })
  }
  return value
}

/** A caller session ID is a name for read-only scoping only, never a write credential. */
export function callerSessionId(caller: PluginCaller): string | null {
  return caller.role === 'plugin' || typeof caller.sessionId !== 'string' ? null : caller.sessionId
}
