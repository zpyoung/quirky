import { describe, expect, it } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { READY_STREAM_RELEASE_METHODS } from './rpc-client-server-subscription'
import type { RpcSuccess } from './types'

type SentFrame = { id: string; method: string; params?: unknown }

/** The registry sends through an `unknown` port, so name the shape the assertions read. */
function readSentFrame(request: unknown): SentFrame {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('id' in request) ||
    typeof request.id !== 'string' ||
    !('method' in request) ||
    typeof request.method !== 'string'
  ) {
    throw new Error('The stream registry sent a frame without a string id and method')
  }
  return {
    id: request.id,
    method: request.method,
    params: 'params' in request ? request.params : undefined
  }
}

function readyReply(id: string, subscriptionId: string): RpcSuccess {
  return {
    id,
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId, snapshot: { accounts: [] } },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function directTransport() {
  const sent: SentFrame[] = []
  let id = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++id}`,
    getState: () => 'connected',
    sendFrame: (request) => {
      sent.push(readSentFrame(request))
      return true
    }
  })
  return {
    sent,
    subscribe: (method: string) => registry.subscribe(method, null, () => {}),
    reply: (response: RpcSuccess) => registry.handleResponse(response)
  }
}

function releases(sent: SentFrame[], method: string): unknown[] {
  return sent.filter((frame) => frame.method === method).map((frame) => frame.params)
}

describe('direct transport releases the accounts stream', () => {
  const transport = directTransport

  it('sends accounts.unsubscribe with the ready id on dispose', async () => {
    const wire = transport()
    const dispose = wire.subscribe('accounts.subscribe')
    await Promise.resolve()
    wire.reply(readyReply(wire.sent[0]!.id, 'accounts-conn-1'))

    dispose()

    expect(releases(wire.sent, 'accounts.unsubscribe')).toEqual([
      { subscriptionId: 'accounts-conn-1' }
    ])
  })

  it('holds a dispose that beat the ready and releases once the ready lands', async () => {
    const wire = transport()
    const dispose = wire.subscribe('accounts.subscribe')
    await Promise.resolve()

    dispose()
    expect(releases(wire.sent, 'accounts.unsubscribe')).toEqual([])
    wire.reply(readyReply(wire.sent[0]!.id, 'accounts-conn-1'))

    expect(releases(wire.sent, 'accounts.unsubscribe')).toEqual([
      { subscriptionId: 'accounts-conn-1' }
    ])
  })
})

// Iterates the mapping itself, so a method added to it is held to the same release.
describe.each([...READY_STREAM_RELEASE_METHODS])(
  'direct transport releases %s through the ready id',
  (method, release) => {
    const transport = directTransport
    it('releases once after ready, and once when the dispose beat the ready', async () => {
      const afterReady = transport()
      const disposeAfterReady = afterReady.subscribe(method)
      await Promise.resolve()
      afterReady.reply(readyReply(afterReady.sent[0]!.id, 'host-id-1'))
      disposeAfterReady()

      const beforeReady = transport()
      const disposeBeforeReady = beforeReady.subscribe(method)
      await Promise.resolve()
      disposeBeforeReady()
      beforeReady.reply(readyReply(beforeReady.sent[0]!.id, 'host-id-2'))

      expect(afterReady.sent.slice(1)).toEqual([
        expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-1' } })
      ])
      expect(beforeReady.sent.slice(1)).toEqual([
        expect.objectContaining({ method: release, params: { subscriptionId: 'host-id-2' } })
      ])
    })
  }
)
