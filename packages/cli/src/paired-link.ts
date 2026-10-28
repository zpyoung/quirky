import { RpcError, RpcErrorCode, type CallOptions } from '@quirky/protocol'
import { createMobileRpc, MobileRpcError, parseMobileOffer } from '@quirky/protocol/paired-client'
import { markSavedRuntimeTargetUsed, resolveSavedRuntimeTarget } from '@quirky/protocol/node'
import { ConnectionLostError, createDaemonLink, type DaemonLink, type DaemonLinkOptions } from './link'
import type { RuntimeSelection } from './runtime-selection'

/** Uses the existing device grant and E2EE transport. It never opens a local daemon connection. */
export function createPairedDaemonLink(home: string, selection: Exclude<RuntimeSelection, {kind:'local'}>, options: DaemonLinkOptions): DaemonLink {
  let identity: { id: string | null; name: string; endpoint?: string } = { id: null, name: selection.kind === 'saved' ? selection.selector : 'one-off pairing' }
  let markedUsed = false
  const failure = (error: unknown): Error => {
    if (error instanceof RpcError) return error
    const message = error instanceof Error ? error.message : String(error)
    const data = error instanceof MobileRpcError && typeof error.data === 'object' && error.data !== null && !Array.isArray(error.data) ? error.data : {}
    return new RpcError(
      error instanceof MobileRpcError && error.kind === 'remote' && typeof error.code === 'number' ? error.code : RpcErrorCode.Conflict,
      `Paired runtime ${JSON.stringify(identity.name)}: ${message}`,
      { ...data, runtime: identity, ...(error instanceof ConnectionLostError ? { reason: 'paired-connection-lost', requestBase: error.base } : { reason: error instanceof MobileRpcError ? `paired-${error.kind}` : 'paired-runtime-unavailable' }) }
    )
  }
  const link = createDaemonLink(async () => {
    try {
      const stored = selection.kind === 'saved' ? resolveSavedRuntimeTarget(home, selection.selector) : undefined
      const offer = parseMobileOffer(stored?.pairingCode ?? (selection.kind === 'pairing' ? selection.pairingCode : ''))
      if (stored && (stored.endpoint !== offer.endpoint || stored.pairedDeviceId !== offer.pairedDeviceId)) throw new Error('Saved runtime identity does not match its pinned pairing offer')
      identity = { id: stored?.id ?? null, name: stored?.name ?? 'one-off pairing', endpoint: offer.endpoint }
      const rpc = await createMobileRpc({ endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64, token: offer.deviceToken })
      return {
        async callAny(method: string, params: Record<string, unknown> = {}, callOptions?: CallOptions): Promise<unknown> {
          if (['selector', 'worktree', 'repo'].some((key) => params[key] === 'current' || params[key] === 'active')) {
            throw new RpcError(RpcErrorCode.InvalidParams, 'current/active are local shortcuts; select an exact remote workspace or repository', { reason: 'local-selector-on-remote', runtime: identity })
          }
          try {
            const result = await rpc.call(method === 'api.describe' ? 'quirky.mobile/api' : method, params, callOptions)
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
        close: () => rpc.close()
      }
    } catch (error) { throw failure(error) }
  }, options)
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
