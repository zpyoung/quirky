import { describe, expect, it, vi } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import {
  relaysToServers,
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from './execution-host-scoped-rpc-client'
import type { RpcClient } from './rpc-client'
import { directWire, directWireRegistry, directWireTracker } from './direct-rpc-wire-test-harness'
import type { RpcResponse } from './types'

const SERVER = 'runtime:env-1' as const

describe('a server workspace call on the direct wire', () => {
  it('reaches the desktop as the same top-level executionHost frame as before the envelope', async () => {
    const socket = directWire()
    const requests = directWireTracker(socket)
    const streams = directWireRegistry(socket)
    const direct: RpcClient = {
      ...fakeClient(),
      sendRequest: (method, params, options) => requests.sendRequest(method, params, options),
      subscribe: (method, params, onData, options) =>
        streams.subscribe(method, params, onData, options)
    }
    const server = scopeRpcClientToExecutionHost(direct, SERVER)
    void server.sendRequest('worktree.ps', { limit: 1 })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    server.subscribe('terminal.subscribe', { terminal: 't1' }, () => {})
    // What #26501 wrote with its own `executionHost` option; the desktop parses JSON, so key order is not read.
    expect(socket.frames()).toStrictEqual([
      JSON.parse(
        '{"id":"rpc-1","deviceToken":"device-token","method":"worktree.ps","params":{"limit":1},"executionHost":"runtime:env-1"}'
      ),
      JSON.parse(
        '{"id":"rpc-2","deviceToken":"device-token","method":"terminal.subscribe","params":{"terminal":"t1"},"executionHost":"runtime:env-1"}'
      )
    ])
  })
})

function fakeClient(carries?: boolean) {
  const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
    id: 'reply',
    ok: true,
    result: null
  }))
  const subscribe = vi.fn(() => () => {})
  const close = vi.fn()
  const client = {
    sendRequest,
    subscribe,
    close,
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    ...(carries === undefined ? {} : { carriesRpcEnvelope: () => carries })
  } satisfies RpcClient
  return client
}

describe('scopeRpcClientToExecutionHost', () => {
  it('runs every request and stream on the host, as one stable view that owns no connection', () => {
    const client = fakeClient()
    const view = scopeRpcClientToExecutionHost(client, SERVER)
    void view.sendRequest('worktree.ps', { limit: 1 }, { timeoutMs: 5, envelope: { trace: 't' } })
    view.subscribe('terminal.subscribe', { terminal: 't1' }, () => {})
    view.close()
    expect(client.sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      { timeoutMs: 5, envelope: { trace: 't', executionHost: SERVER } }
    )
    expect(client.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 't1' },
      expect.any(Function),
      { envelope: { executionHost: SERVER } }
    )
    expect(client.close).not.toHaveBeenCalled()
    expect(scopeRpcClientToExecutionHost(client, SERVER)).toBe(view)
    expect(scopeRpcClientToExecutionHost(client, 'runtime:env-2')).not.toBe(view)
  })

  it('routes a server workspace only through a relaying desktop over a transport that carries an envelope', () => {
    const relays = [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY]
    expect(workspaceRouteExecutionHost(fakeClient(), relays, SERVER)).toBe(SERVER)
    expect(workspaceRouteExecutionHost(fakeClient(true), relays, SERVER)).toBe(SERVER)
    expect(workspaceRouteExecutionHost(fakeClient(false), relays, SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(fakeClient(), [], SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(null, relays, SERVER)).toBeNull()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, 'local')).toBeUndefined()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, 'ssh:box')).toBeUndefined()
    expect(workspaceRouteExecutionHost(fakeClient(), relays, undefined)).toBeUndefined()
    // A server's view answers as its client does, so a native one still reaches servers.
    expect(relaysToServers(scopeRpcClientToExecutionHost(fakeClient(), SERVER), relays)).toBe(true)
    expect(relaysToServers(scopeRpcClientToExecutionHost(fakeClient(false), SERVER), relays)).toBe(
      false
    )
  })
})
