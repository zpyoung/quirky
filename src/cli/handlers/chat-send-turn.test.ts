import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { CHAT_HANDLERS } from './chat'

const SESSION = 'claude_0b1c2d3e_4f5a_4b6c_8d7e_9f0a1b2c3d4e'
const MESSAGE_KEY = agentJournalSubmissionKey('op-1')
const SESSION_ROW = { sessionId: SESSION, workspaceId: 'wt-1', agent: 'claude', status: 'idle' }

type Frame = { type: string; [key: string]: unknown }

function historyPage(items: unknown[]) {
  return { ok: true, page: { epoch: 'e1', fence: 7, items, hasOlder: false, window: {} } }
}

function turnRow(turnId: string, userItemId: string) {
  return { itemId: `item-${turnId}`, body: { kind: 'turn', turnId, state: 'running', userItemId } }
}

function finished(turnId: string, seq: number): Frame {
  return {
    seq,
    at: 1000 + seq,
    topic: 'chat',
    type: 'turn.finished',
    data: { sessionId: SESSION, turnId }
  } as Frame
}

/** A host whose journal holds `before` until the send is accepted and `after` from then on. */
function host(journal: { before: unknown[]; after: unknown[] }, events: Frame[] = []) {
  let accepted = false
  const call = vi.fn(async (method: string) => {
    if (method === 'agentSession.send') {
      accepted = true
    }
    const result =
      method === 'agentSession.send'
        ? {
            ok: true,
            replayed: false,
            fence: 7,
            cursor: { epoch: 'e1', sequence: 1 },
            value: { clientMessageId: 'op-1' }
          }
        : historyPage(accepted ? journal.after : journal.before)
    return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'rt' } }
  })
  const stream = vi.fn(
    async (
      method: string,
      _params: unknown,
      onFrame: (frame: unknown) => void,
      options?: { signal?: AbortSignal }
    ) => {
      if (method === 'events.subscribe') {
        onFrame({ type: 'ready', subscriptionId: 's', cursor: 1 })
        await new Promise((resolve) => setTimeout(resolve, 20))
        events.forEach(onFrame)
      } else {
        onFrame({ type: 'snapshot', sessions: [SESSION_ROW] })
      }
      await new Promise<void>((resolve) => {
        const { signal } = options ?? {}
        if (!signal || signal.aborted) {
          resolve()
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true })
        }
      })
    }
  )
  return { isRemote: false, call, stream }
}

function sendContext(client: ReturnType<typeof host>, flags: Record<string, string | boolean>) {
  // SAFETY: the handler reads only flags, cwd, json and the client calls this fake implements
  return {
    flags: new Map(Object.entries({ session: SESSION, text: 'go', ...flags })),
    client,
    cwd: '/',
    json: true
  } as unknown as HandlerContext
}

let output: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

function printedResult(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output.mock.calls.map((call) => String(call[0])).join('\n'))
  const result =
    typeof parsed === 'object' && parsed !== null && 'result' in parsed ? parsed.result : null
  return typeof result === 'object' && result !== null ? { ...result } : {}
}

describe('chat send turn id', () => {
  it('returns the id of the turn the host opened for the message', async () => {
    const client = host({
      before: [],
      after: [turnRow('t-old', 'earlier'), turnRow('t-41', MESSAGE_KEY)]
    })
    await CHAT_HANDLERS['chat send'](sendContext(client, {}))

    expect(printedResult()).toMatchObject({ clientMessageId: 'op-1', turnId: 't-41' })
    expect(client.stream).not.toHaveBeenCalled()
  })

  it('--wait settles on the turn it started, not on an earlier one finishing first', async () => {
    const client = host(
      {
        before: [turnRow('t-earlier', 'earlier')],
        after: [turnRow('t-earlier', 'earlier'), turnRow('t-mine', MESSAGE_KEY)]
      },
      [finished('t-earlier', 3), finished('t-stray', 4), finished('t-mine', 5)]
    )
    await CHAT_HANDLERS['chat send'](sendContext(client, { wait: true, timeout: '5000' }))

    expect(printedResult()).toMatchObject({ turnId: 't-mine', status: 'finished' })
  })

  it('--wait does not settle on a turn the journal already held before the send', async () => {
    const earlier = [turnRow('t-earlier', 'earlier')]
    const client = host({ before: earlier, after: earlier }, [finished('t-earlier', 3)])

    await expect(
      CHAT_HANDLERS['chat send'](sendContext(client, { wait: true, timeout: '100' }))
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})
