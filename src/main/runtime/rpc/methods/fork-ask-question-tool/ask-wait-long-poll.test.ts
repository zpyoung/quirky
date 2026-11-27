import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { AskDb } from '../../../../fork-ask-question-tool/ask-db'
import { AskRegistry } from '../../../../fork-ask-question-tool/ask-registry'
import { createAskAttachedSurfaceRoster } from '../../../../fork-ask-question-tool/ask-attached-surface-roster'
import { createAskWaitConcurrencyGate } from '../../../../fork-ask-question-tool/ask-wait-concurrency-gate'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { QuirkyRuntimeRpcServer } from '../../../runtime-rpc'
import { readRuntimeMetadata } from '../../../runtime-metadata'
import { openFramedSession, sendRequest, sleep, waitFor } from '../../../runtime-rpc-test-harness'
import { classifyRuntimeLongPoll } from '../../../runtime-rpc/runtime-rpc-long-poll'

function isRuntimeBusy(response: Record<string, unknown>): boolean {
  const error = response.error
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'runtime_busy'
  )
}

async function waitUntilAdmitted(
  endpoint: string,
  authToken: string | null,
  askId: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const response = await sendRequest(endpoint, {
      id: 'req_ask_wait_resumed',
      authToken,
      method: 'ask.wait',
      params: { askId, chunkMs: 10 }
    })
    if (!isRuntimeBusy(response)) {
      return response
    }
    await sleep(10)
  }
  throw new Error('ask.wait admission was not released after its socket closed')
}

describe('ask.wait long-poll transport', () => {
  it('keeps an unanswered wait alive and releases its ask slot when the socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'quirky-ask-wait-long-poll-'))
    const db = new AskDb(':memory:')
    const registry = new AskRegistry(db)
    const roster = createAskAttachedSurfaceRoster({ hasLocalRendererWindow: () => true })
    const runtime = new QuirkyRuntimeService()
    const getAskServicesSpy = vi.spyOn(runtime, 'getAskServices').mockReturnValue({
      db,
      registry,
      roster,
      waitGate: createAskWaitConcurrencyGate(),
      resolvePaneClosed: (paneKey) => registry.resolvePaneClosed(paneKey)
    })
    const { askId } = await registry.register(
      { questions: [{ id: 'q1', type: 'text', question: 'Still waiting?' }] },
      { paneKey: 'tab_wait:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', worktreeId: null },
      { requestId: 'req_register_wait' }
    )
    const server = new QuirkyRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 30,
      longPollCap: 1
    })
    let waitingSocket: Socket | null = null

    try {
      await server.start()
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata) {
        throw new Error('runtime metadata was not written')
      }
      const endpoint = metadata.transports[0]?.endpoint
      if (!endpoint) {
        throw new Error('runtime transport endpoint was not written')
      }
      const session = openFramedSession(endpoint, {
        id: 'req_ask_wait',
        authToken: metadata.authToken,
        method: 'ask.wait',
        params: { askId, chunkMs: 100_000 }
      })
      waitingSocket = session.socket

      await waitFor(
        () => session.frames.filter((frame) => frame._keepalive === true).length >= 2,
        1_000
      )
      expect(session.socket.destroyed).toBe(false)

      session.socket.destroy()
      await session.done
      const resumed = await waitUntilAdmitted(endpoint, metadata.authToken, askId)
      expect(resumed).toMatchObject({
        id: 'req_ask_wait_resumed',
        ok: true,
        result: { status: 'pending', askId }
      })
      expect(db.getAsk(askId)?.status).toBe('registered')
    } finally {
      waitingSocket?.destroy()
      registry.cancel(askId, 'agent')
      await server.stop()
      db.close()
      rmSync(userDataPath, { recursive: true, force: true })
      getAskServicesSpy.mockRestore()
    }
  })

  it('meters a chunked ask wait as a plain wait, leaving the orchestration.ask reservation intact', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'req_classify',
        authToken: 'token',
        method: 'ask.wait',
        params: { askId: 'ask_1', chunkMs: 100_000 }
      })
    ).toBe('wait')
  })
})
