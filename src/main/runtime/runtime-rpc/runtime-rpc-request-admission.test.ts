import '../rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuirkyRuntimeService } from '../quirky-runtime'
import { readRuntimeMetadata } from '../runtime-metadata'
import { QuirkyRuntimeRpcServer } from '../runtime-rpc'
import { openFramedSession, sendRequest, waitFor } from '../runtime-rpc-test-harness'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { WORKSPACE_LAYOUT_METHODS } from '../rpc/methods/workspace-layout'
import { streamsOnLocalSocket } from './runtime-rpc-request-admission'

describe('streamsOnLocalSocket', () => {
  it.each(['layout.subscribe', 'events.subscribe', 'agentSession.subscribeStatus'])(
    'streams %s, a streaming method the CLI reads',
    (method) => {
      expect(streamsOnLocalSocket(method)).toBe(true)
    }
  )

  it.each(['status.get', 'terminal.subscribe', 'layout.apply', 'worktree.rm'])(
    'keeps %s to one reply',
    (method) => {
      expect(streamsOnLocalSocket(method)).toBe(false)
    }
  )
})

describe('local socket admission', () => {
  const servers: QuirkyRuntimeRpcServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    vi.restoreAllMocks()
  })

  async function startServer(
    runtime: QuirkyRuntimeService,
    options: {
      longPollCap?: number
      methods: ConstructorParameters<typeof QuirkyRuntimeRpcServer>[0]['methods']
    }
  ) {
    const userDataPath = mkdtempSync(join(tmpdir(), 'quirky-runtime-rpc-'))
    const server = new QuirkyRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 1000,
      ...options
    })
    servers.push(server)
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    return { server, endpoint: metadata!.transports[0]!.endpoint, authToken: metadata!.authToken }
  }

  it('answers layout.subscribe with its stream frames instead of refusing it as a unary call', async () => {
    const { endpoint, authToken } = await startServer(new QuirkyRuntimeService(), {
      methods: WORKSPACE_LAYOUT_METHODS
    })

    const session = openFramedSession(endpoint, {
      id: 'req_layout',
      authToken,
      method: 'layout.subscribe',
      params: {}
    })
    await session.done

    const first = session.frames.find((frame) => frame._keepalive !== true)
    expect(first).toMatchObject({ id: 'req_layout', ok: true, result: { type: 'snapshot' } })
  })

  it('counts a call parked on an approval prompt against the long-poll capacity', async () => {
    const runtime = new QuirkyRuntimeService()
    vi.spyOn(runtime.approvalGate, 'policyFor').mockReturnValue('ask')
    vi.spyOn(runtime.approvalGate, 'require').mockImplementation(
      (_category, _caller, _summary, _effects, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('client left')))
        })
    )
    const { server, endpoint, authToken } = await startServer(runtime, {
      longPollCap: 1,
      methods: TERMINAL_METHODS
    })
    const confirmedStop = (id: string) => ({
      id,
      authToken,
      method: 'terminal.stop',
      params: { worktree: 'id:wt-1' },
      publicContract: 1,
      confirm: true
    })

    const parked = openFramedSession(endpoint, confirmedStop('req_parked'))
    await waitFor(() => server['activeLongPolls'] === 1)

    const overflow = await sendRequest(endpoint, confirmedStop('req_overflow'))

    expect(overflow).toMatchObject({
      id: 'req_overflow',
      ok: false,
      error: { code: 'runtime_busy' }
    })

    parked.socket.destroy()
    await waitFor(() => server['activeLongPolls'] === 0)
  })
})
