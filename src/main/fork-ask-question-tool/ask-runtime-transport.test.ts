import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { QuirkyRuntimeRpcServer } from '../runtime/runtime-rpc'
import { classifyRuntimeLongPoll } from '../runtime/runtime-rpc/runtime-rpc-long-poll'
import { openFramedSession, waitFor } from '../runtime/runtime-rpc-test-harness'
import type { AskDb } from './ask-db'
import { ASK_WAIT_CONCURRENCY_CAP } from './ask-wait-concurrency-gate'
import type { AskRegistry } from './ask-registry'

type AskRegistryInternals = {
  live: Map<string, { waiters: Set<unknown> }>
}

function waiterCount(registry: AskRegistry, askId: string): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: AskRegistry exposes no waiter count; `live` is its own private field and this reads only the set's size.
  return (registry as unknown as AskRegistryInternals).live.get(askId)?.waiters.size ?? 0
}

describe('ask.wait runtime transport', () => {
  let userDataPath: string
  let servers: QuirkyRuntimeRpcServer[]
  let databases: AskDb[]

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'quirky-ask-runtime-transport-'))
    installFakeAppEnvironment({ getPath: () => userDataPath })
    servers = []
    databases = []
  })

  afterEach(async () => {
    for (const server of servers) {
      await server.stop()
    }
    for (const db of databases) {
      db.close()
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function startRuntime(keepaliveIntervalMs: number): Promise<{
    registry: AskRegistry
    db: AskDb
    endpoint: string
    authToken: string
  }> {
    const runtime = new QuirkyRuntimeService()
    const { registry, db } = runtime.getAskServices()
    databases.push(db)
    const server = new QuirkyRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs })
    servers.push(server)
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    if (!metadata?.transports[0] || !metadata.authToken) {
      throw new Error('runtime transport metadata was not published')
    }
    return {
      registry,
      db,
      endpoint: metadata.transports[0].endpoint,
      authToken: metadata.authToken
    }
  }

  async function registerPending(registry: AskRegistry, requestId: string): Promise<string> {
    const { askId } = await registry.register(
      { questions: [{ id: 'q1', type: 'text', question: 'What is your name?' }] },
      { paneKey: null, worktreeId: null },
      { requestId }
    )
    return askId
  }

  it('keeps ask.wait out of the orchestration.ask long-poll reservation', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'req_ask_wait',
        authToken: 'token',
        method: 'ask.wait',
        params: { askId: 'ask_1', chunkMs: 300 }
      })
    ).toBe('wait')
    expect(
      classifyRuntimeLongPoll({
        id: 'req_orchestration_ask',
        authToken: 'token',
        method: 'orchestration.ask',
        params: {}
      })
    ).toBe('ask')
  })

  it('sheds ask.wait past the gate cap and readmits once a slot frees', async () => {
    const { registry, endpoint, authToken } = await startRuntime(1_000)
    const parked: ReturnType<typeof openFramedSession>[] = []
    for (let index = 0; index < ASK_WAIT_CONCURRENCY_CAP; index += 1) {
      const askId = await registerPending(registry, `req_parked_${index}`)
      parked.push(
        openFramedSession(endpoint, {
          id: `req_ask_wait_parked_${index}`,
          authToken,
          method: 'ask.wait',
          params: { askId, chunkMs: 60_000 }
        })
      )
      await waitFor(() => waiterCount(registry, askId) === 1)
    }

    const shedAskId = await registerPending(registry, 'req_shed')
    const shed = openFramedSession(endpoint, {
      id: 'req_ask_wait_shed',
      authToken,
      method: 'ask.wait',
      params: { askId: shedAskId, chunkMs: 60_000 }
    })
    await shed.done
    expect(shed.frames.at(-1)).toMatchObject({
      id: 'req_ask_wait_shed',
      ok: false,
      error: { code: 'runtime_busy' }
    })
    // The shed wait never reached the registry, so the durable ask is still answerable.
    expect(waiterCount(registry, shedAskId)).toBe(0)

    parked[0].socket.destroy()
    await parked[0].done

    const readmitted = openFramedSession(endpoint, {
      id: 'req_ask_wait_readmitted',
      authToken,
      method: 'ask.wait',
      params: { askId: shedAskId, chunkMs: 60_000 }
    })
    await waitFor(() => waiterCount(registry, shedAskId) === 1)
    expect(registry.answer(shedAskId, { q1: { value: 'Ada', source: 'input' } }, [])).toEqual({
      committed: true
    })
    await readmitted.done
    expect(readmitted.frames.at(-1)).toMatchObject({
      id: 'req_ask_wait_readmitted',
      ok: true,
      result: { status: 'answered', askId: shedAskId }
    })

    for (const session of parked.slice(1)) {
      session.socket.destroy()
      await session.done
    }
  })

  it('keeps the Unix socket alive until ask.wait returns its pending chunk', async () => {
    const { registry, endpoint, authToken } = await startRuntime(50)
    const askId = await registerPending(registry, 'req_keepalive')
    const session = openFramedSession(endpoint, {
      id: 'req_ask_wait_keepalive',
      authToken,
      method: 'ask.wait',
      params: { askId, chunkMs: 300 }
    })

    await session.done

    const terminalIndex = session.frames.findIndex((frame) => frame.ok !== undefined)
    expect(terminalIndex).toBe(session.frames.length - 1)
    expect(session.frames.slice(0, terminalIndex).every((frame) => frame._keepalive === true)).toBe(
      true
    )
    expect(
      session.frames.filter((frame) => frame._keepalive === true).length
    ).toBeGreaterThanOrEqual(3)
    expect(session.frames[terminalIndex]).toMatchObject({
      id: 'req_ask_wait_keepalive',
      ok: true,
      result: { status: 'pending', askId }
    })
  })

  it('drains the real registry waiter on disconnect and permits a resumed wait', async () => {
    const { registry, db, endpoint, authToken } = await startRuntime(1_000)
    const askId = await registerPending(registry, 'req_disconnect')
    const disconnected = openFramedSession(endpoint, {
      id: 'req_ask_wait_disconnected',
      authToken,
      method: 'ask.wait',
      params: { askId, chunkMs: 60_000 }
    })

    await waitFor(() => waiterCount(registry, askId) === 1)
    disconnected.socket.destroy()
    await disconnected.done
    await waitFor(() => waiterCount(registry, askId) === 0)
    expect(db.getAsk(askId)?.status).toBe('registered')

    const resumed = openFramedSession(endpoint, {
      id: 'req_ask_wait_resumed',
      authToken,
      method: 'ask.wait',
      params: { askId, chunkMs: 60_000 }
    })
    await waitFor(() => waiterCount(registry, askId) === 1)
    expect(registry.answer(askId, { q1: { value: 'Ada', source: 'input' } }, [])).toEqual({
      committed: true
    })
    await resumed.done

    expect(resumed.frames.at(-1)).toMatchObject({
      id: 'req_ask_wait_resumed',
      ok: true,
      result: {
        status: 'answered',
        askId,
        answers: { q1: { value: 'Ada', source: 'input' } }
      }
    })
  })
})
