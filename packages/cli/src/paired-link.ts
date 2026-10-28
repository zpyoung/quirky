import { RpcError, RpcErrorCode, type ApiDescription, type CallOptions } from '@quirky/protocol'
import { createMobileRpc, MobileRpcError, parseMobileOffer, parseOwnerCliOffer, type MobileRpc } from '@quirky/protocol/paired-client'
import { markSavedRuntimeTargetUsed, resolveSavedRuntimeTarget } from '@quirky/protocol/node'
import { ConnectionLostError, createDaemonLink, type DaemonLink, type DaemonLinkOptions } from './link'
import type { RuntimeSelection } from './runtime-selection'

function parseRuntimeOffer(code: string) {
  try { return parseOwnerCliOffer(code) } catch { return parseMobileOffer(code) }
}

function redact(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === 'string') {
    let safe = value
    for (const secret of secrets) if (secret.length > 0) safe = safe.replaceAll(secret, '[redacted]')
    return safe
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, secrets)]))
  }
  return value
}

/** Uses the existing mobile-v2 or full-owner grant over the existing E2EE transport. */
export function createPairedDaemonLink(home: string, selection: Exclude<RuntimeSelection, {kind:'local'}>, options: DaemonLinkOptions): DaemonLink {
  let identity: { id: string | null; name: string; endpoint?: string; scope?: 'mobile' | 'owner-cli'; grantId?: string } = {
    id: null,
    name: selection.kind === 'saved' ? selection.selector : 'one-off pairing'
  }
  let markedUsed = false
  const secrets = new Set<string>()
  const destructiveMethods = new Set<string>()
  const failure = (error: unknown): Error => {
    if (error instanceof RpcError) return error
    const message = redact(error instanceof Error ? error.message : String(error), secrets) as string
    const data = error instanceof MobileRpcError && typeof error.data === 'object' && error.data !== null && !Array.isArray(error.data)
      ? redact(error.data, secrets) as Record<string, unknown>
      : {}
    return new RpcError(
      error instanceof MobileRpcError && error.kind === 'remote' && typeof error.code === 'number' ? error.code : RpcErrorCode.Conflict,
      `Paired runtime ${JSON.stringify(identity.name)}: ${message}`,
      {
        ...data,
        runtime: identity,
        ...(error instanceof ConnectionLostError
          ? { reason: 'paired-connection-lost', requestBase: error.base }
          : { reason: error instanceof MobileRpcError ? `paired-${error.kind}` : 'paired-runtime-unavailable' })
      }
    )
  }
  const link = createDaemonLink(async () => {
    let rpc: MobileRpc | undefined
    try {
      const stored = selection.kind === 'saved' ? resolveSavedRuntimeTarget(home, selection.selector) : undefined
      const pairingCode = stored?.pairingCode ?? (selection.kind === 'pairing' ? selection.pairingCode : '')
      if (pairingCode) secrets.add(pairingCode)
      const offer = parseRuntimeOffer(pairingCode)
      secrets.add(offer.deviceToken)
      if (stored && (
        stored.endpoint !== offer.endpoint || stored.publicKeyB64 !== offer.publicKeyB64 ||
        stored.pairedDeviceId !== offer.pairedDeviceId || stored.scope !== offer.scope ||
        (stored.scope === 'owner-cli' && stored.grantId !== offer.pairedDeviceId)
      )) throw new Error('Saved runtime identity does not match its pinned pairing offer')
      identity = {
        id: stored?.id ?? null,
        name: stored?.name ?? 'one-off pairing',
        endpoint: offer.endpoint,
        scope: offer.scope,
        ...(offer.scope === 'owner-cli' ? { grantId: offer.pairedDeviceId } : {})
      }
      rpc = await createMobileRpc({ endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64, token: offer.deviceToken })
      const description = await rpc.call<ApiDescription>(offer.scope === 'mobile' ? 'quirky.mobile/api' : 'api.describe', {})
      for (const method of description.methods) if (method.destructive) destructiveMethods.add(method.name)
      const activeRpc = rpc
      return {
        async callAny(method: string, params: Record<string, unknown> = {}, callOptions?: CallOptions): Promise<unknown> {
          if (['selector', 'worktree', 'repo'].some((key) => params[key] === 'current' || params[key] === 'active')) {
            throw new RpcError(RpcErrorCode.InvalidParams, 'current/active are local shortcuts; select an exact remote workspace or repository', { reason: 'local-selector-on-remote', runtime: identity })
          }
          try {
            const result = await activeRpc.call(method === 'api.describe' && offer.scope === 'mobile' ? 'quirky.mobile/api' : method, params, callOptions)
            if (stored && !markedUsed) { markSavedRuntimeTargetUsed(home, stored.id); markedUsed = true }
            return result
          } catch (error) {
            if (error instanceof MobileRpcError && (error.kind === 'connection' || error.kind === 'closed')) {
              const lost = new Error(`Paired runtime ${JSON.stringify(identity.name)} disconnected`)
              lost.name = 'ConnectionLost'
              throw lost
            }
            throw failure(error)
          }
        },
        close: () => activeRpc.close()
      }
    } catch (error) {
      rpc?.close()
      throw failure(error)
    }
  }, {
    ...options,
    isDestructive: (method) => destructiveMethods.has(method) || options.isDestructive?.(method) === true
  })
  const invoke = async (method: string, params: Record<string, unknown>, callOptions?: CallOptions) => {
    try { return await link.callAny(method, params, callOptions) } catch (error) { throw failure(error) }
  }
  return {
    requestBase: link.requestBase,
    call: (method, params, callOptions) => invoke(method, params as Record<string, unknown>, callOptions) as Promise<never>,
    callAny: invoke,
    reconnect: () => link.reconnect(),
    close: () => link.close()
  }
}
