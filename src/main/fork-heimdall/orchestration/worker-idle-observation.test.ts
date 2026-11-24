import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { WORKER_LAST_MESSAGE_MAX_BYTES } from '../../../shared/fork-heimdall/owner/worker-last-message'
import { observeWorkerIdle } from './worker-idle-observation'
import { sendWorkerPrompt } from './worker-prompt-send'
import { WorkerPromptUndeliverableError } from './orchestration-contract'

const { inspectWorkerTerminal, projectFleetWorker, readExactWorkerOutput } = vi.hoisted(() => ({
  inspectWorkerTerminal: vi.fn(),
  projectFleetWorker: vi.fn(),
  readExactWorkerOutput: vi.fn()
}))

vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-observation', () => ({
  inspectWorkerTerminal,
  projectFleetWorker
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-output', () => ({
  readExactWorkerOutput
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the run id is read.
const run = { id: 'run-1' } as RunRow

function db(overrides: { federated?: boolean; handle?: string } = {}): OrchestrationDb {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test reads only these three lookups.
  return {
    getDispatchContextById: () => ({
      run_id: 'run-1',
      assignee_handle: overrides.handle ?? 'term_1',
      dispatched_at: '2026-09-28T00:00:00Z',
      created_at: '2026-09-28T00:00:00Z'
    }),
    getFederatedDispatch: () => (overrides.federated ? { dispatch_id: 'dispatch-1' } : undefined),
    getWorkerDispatch: () => ({
      agent_terminal_handle: overrides.handle ?? 'term_1',
      state: 'running'
    })
  } as unknown as OrchestrationDb
}

function fleet(activity: string, verdict: 'live' | 'unverifiable' = 'live', host = 'local') {
  return {
    stage: { activity },
    host: { kind: host },
    liveness:
      verdict === 'live' ? { verdict, observedAt: 5_000 } : { verdict, reason: 'stale_status' }
  }
}

const sendTerminalAgentPrompt = vi.fn(async () => ({}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the prompt send is exercised; the other runtime reads are mocked at module level.
const runtime = { sendTerminalAgentPrompt } as unknown as QuirkyRuntimeService

function transcript(text: string) {
  return {
    source: 'transcript',
    transcript: {
      messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'do it' }] },
        { role: 'assistant', blocks: [{ type: 'text', text }] },
        { role: 'tool', blocks: [{ type: 'text', text: 'tool output' }] }
      ]
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  inspectWorkerTerminal.mockResolvedValue({ exact: true, status: 'live' })
  projectFleetWorker.mockReturnValue(fleet('waiting'))
  readExactWorkerOutput.mockResolvedValue(transcript('Should I keep both configs?'))
})

describe('observeWorkerIdle', () => {
  it('reports an idle worker with its last assistant message', async () => {
    await expect(observeWorkerIdle(runtime, db(), run, 'dispatch-1')).resolves.toEqual({
      status: 'idle',
      activity: 'waiting',
      idleSinceMs: 5_000,
      lastMessage: { text: 'Should I keep both configs?', truncated: false }
    })
  })

  it('is active while the agent is working', async () => {
    projectFleetWorker.mockReturnValue(fleet('working'))
    await expect(observeWorkerIdle(runtime, db(), run, 'dispatch-1')).resolves.toEqual({
      status: 'active'
    })
    expect(readExactWorkerOutput).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an unverifiable terminal',
      () => inspectWorkerTerminal.mockResolvedValue({ exact: true, status: 'unverifiable' })
    ],
    [
      'a replaced process',
      () => inspectWorkerTerminal.mockResolvedValue({ exact: false, status: 'identity_changed' })
    ],
    [
      'an unverifiable agent status',
      () => projectFleetWorker.mockReturnValue(fleet('waiting', 'unverifiable'))
    ],
    ['an SSH worker', () => projectFleetWorker.mockReturnValue(fleet('waiting', 'live', 'remote'))]
  ])('is unavailable, never idle, for %s', async (_label, arrange) => {
    arrange()
    const observation = await observeWorkerIdle(runtime, db(), run, 'dispatch-1')
    expect(observation.status).toBe('unavailable')
  })

  it.each([
    ['federated', db({ federated: true })],
    ['structured', db({ handle: 'structworker_abc' })]
  ])('is unavailable for a %s worker', async (_label, database) => {
    const observation = await observeWorkerIdle(runtime, database, run, 'dispatch-1')
    expect(observation.status).toBe('unavailable')
    expect(inspectWorkerTerminal).not.toHaveBeenCalled()
  })

  it('redacts dispatch capabilities and keeps the newest 4 KiB', async () => {
    readExactWorkerOutput.mockResolvedValue(
      transcript(`${'x'.repeat(8_000)} token dcap_${'A'.repeat(30)} — which one?`)
    )
    const observation = await observeWorkerIdle(runtime, db(), run, 'dispatch-1')
    if (observation.status !== 'idle' || !observation.lastMessage) {
      throw new Error('expected an idle observation with a message')
    }
    expect(observation.lastMessage.truncated).toBe(true)
    expect(observation.lastMessage.text).not.toContain('dcap_')
    expect(observation.lastMessage.text).toContain('[dispatch capability redacted]')
    expect(new TextEncoder().encode(observation.lastMessage.text).byteLength).toBeLessThanOrEqual(
      WORKER_LAST_MESSAGE_MAX_BYTES
    )
  })

  it('falls back to the terminal tail and tolerates an unreadable output', async () => {
    readExactWorkerOutput.mockResolvedValueOnce({
      source: 'terminal',
      terminal: { tail: ['line one', 'Proceed with the deploy?'] }
    })
    const fromTerminal = await observeWorkerIdle(runtime, db(), run, 'dispatch-1')
    expect(fromTerminal).toMatchObject({
      lastMessage: { text: 'line one\nProceed with the deploy?' }
    })
    readExactWorkerOutput.mockRejectedValueOnce(new Error('source_changed'))
    const unreadable = await observeWorkerIdle(runtime, db(), run, 'dispatch-1')
    expect(unreadable).toMatchObject({ status: 'idle', lastMessage: null })
  })

  it('is unavailable when the process changes while its output is read', async () => {
    inspectWorkerTerminal
      .mockResolvedValueOnce({ exact: true, status: 'live' })
      .mockResolvedValueOnce({ exact: false, status: 'identity_changed' })
    const observation = await observeWorkerIdle(runtime, db(), run, 'dispatch-1')
    expect(observation.status).toBe('unavailable')
  })
})

describe('sendWorkerPrompt', () => {
  it('types the prefixed reply into the exact live worker', async () => {
    await sendWorkerPrompt(runtime, db(), run, 'dispatch-1', '  Keep both.  ')
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      '[Heimdall owner reply] Keep both.',
      { inputKind: 'driving' }
    )
  })

  it.each([
    ['a replaced process', { exact: false, status: 'identity_changed' }],
    ['an unverifiable worker', { exact: true, status: 'unverifiable' }]
  ])('refuses %s', async (_label, observation) => {
    inspectWorkerTerminal.mockResolvedValue(observation)
    await expect(sendWorkerPrompt(runtime, db(), run, 'dispatch-1', 'hi')).rejects.toBeInstanceOf(
      WorkerPromptUndeliverableError
    )
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it.each([
    ['federated', db({ federated: true })],
    ['structured', db({ handle: 'structworker_abc' })]
  ])('refuses a %s worker', async (_label, database) => {
    await expect(
      sendWorkerPrompt(runtime, database, run, 'dispatch-1', 'hi')
    ).rejects.toBeInstanceOf(WorkerPromptUndeliverableError)
  })

  it('reports a failed write as undeliverable', async () => {
    sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('terminal_not_writable'))
    await expect(sendWorkerPrompt(runtime, db(), run, 'dispatch-1', 'hi')).rejects.toThrow(
      'terminal_not_writable'
    )
  })
})
