import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { ASK_HANDLERS } from './handlers'
import { ASK_CLI_TRANSPORT_RETRY_ATTEMPTS } from './ask-cli-transport-retry'

const VALID_SPEC_JSON =
  '{"questions":[{"id":"confirm_deploy","type":"confirm","question":"Deploy now?"}]}'

function ctx(flags: [string, string | boolean][], overrides: { cwd?: string } = {}) {
  return {
    flags: new Map<string, string | boolean>(flags),
    client: { call: callMock },
    cwd: overrides.cwd ?? '/repo',
    json: false
  } as never
}

describe('ask flag and spec validation (client.call never invoked on bad input)', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  it('rejects a missing --spec', async () => {
    await expect(ASK_HANDLERS.ask(ctx([]))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON in --spec', async () => {
    await expect(ASK_HANDLERS.ask(ctx([['spec', '{not json']]))).rejects.toThrow(/--spec/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a spec that fails validateAskSpec, naming the offending field', async () => {
    const badSpec = '{"questions":[{"id":"","type":"confirm","question":"Deploy?"}]}'
    await expect(ASK_HANDLERS.ask(ctx([['spec', badSpec]]))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('questions[0].id')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', true],
    ['empty', ''],
    ['non-numeric', 'soon'],
    ['zero', '0'],
    ['negative', '-1']
  ])('rejects invalid --timeout-ms: %s', async (_label, value) => {
    await expect(
      ASK_HANDLERS.ask(
        ctx([
          ['spec', VALID_SPEC_JSON],
          ['timeout-ms', value]
        ])
      )
    ).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a --chunk-ms the client timeout cannot hold, before registering anything', async () => {
    await expect(
      ASK_HANDLERS.ask(
        ctx([
          ['spec', VALID_SPEC_JSON],
          ['chunk-ms', '2147480000']
        ])
      )
    ).rejects.toThrow(/--chunk-ms must be at most/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects invalid --chunk-ms', async () => {
    await expect(
      ASK_HANDLERS.ask(
        ctx([
          ['spec', VALID_SPEC_JSON],
          ['chunk-ms', 'soon']
        ])
      )
    ).rejects.toThrow(/--chunk-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a missing --id on ask wait', async () => {
    await expect(ASK_HANDLERS['ask wait'](ctx([]))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a missing --id on ask cancel', async () => {
    await expect(ASK_HANDLERS['ask cancel'](ctx([]))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('quirky ask: register -> registered line -> one wait chunk -> envelope', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    logSpy.mockRestore()
  })

  it('prints the registered line before issuing ask.wait, then prints the terminal envelope', async () => {
    callMock.mockResolvedValueOnce({ result: { askId: 'ask_1' } }).mockResolvedValueOnce({
      result: {
        status: 'answered',
        askId: 'ask_1',
        answers: {},
        skipped: [],
        summary: 'Deploy now?: yes'
      }
    })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock.mock.calls[0][0]).toBe('ask.register')
    expect(callMock.mock.calls[1][0]).toBe('ask.wait')
    expect(logSpy.mock.calls[0][0]).toBe(JSON.stringify({ status: 'registered', askId: 'ask_1' }))
    expect(logSpy.mock.calls[1][0]).toBe(
      JSON.stringify({
        status: 'answered',
        askId: 'ask_1',
        answers: {},
        skipped: [],
        summary: 'Deploy now?: yes'
      })
    )
  })

  it('prints a pending envelope carrying the wait instruction when the chunk elapses unanswered', async () => {
    callMock.mockResolvedValueOnce({ result: { askId: 'ask_2' } }).mockResolvedValueOnce({
      result: { status: 'pending', askId: 'ask_2', instruction: 'quirky ask wait --id ask_2' }
    })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(logSpy.mock.calls[1][0]).toBe(
      JSON.stringify({
        status: 'pending',
        askId: 'ask_2',
        instruction: 'quirky ask wait --id ask_2'
      })
    )
  })

  it('never issues ask.wait when ask.register reports an immediate unavailable outcome (no id)', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'unavailable', reason: 'no attached ask surface' }
    })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ status: 'unavailable', reason: 'no attached ask surface' })
    )
    // Why: an absent key is the honest encoding of "no ask was ever registered" — a
    // later regression reintroducing `id: null` must fail here, not pass silently.
    const parsed: unknown = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect('id' in (parsed as Record<string, unknown>)).toBe(false)
    expect('askId' in (parsed as Record<string, unknown>)).toBe(false)
  })

  it.each(['answered', 'partial', 'declined', 'timed_out', 'unavailable'])(
    'exits without throwing for terminal status %s',
    async (status) => {
      callMock.mockResolvedValueOnce({ result: { askId: 'ask_3' } }).mockResolvedValueOnce({
        result: {
          status,
          askId: 'ask_3',
          answers: {},
          skipped: [],
          summary: '',
          ...(status === 'unavailable' ? { reason: 'expired' } : {})
        }
      })

      await expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).resolves.toBeUndefined()
    }
  )

  it('resends the identical requestId on a transport failure during register', async () => {
    callMock
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'socket closed'))
      .mockResolvedValueOnce({ result: { askId: 'ask_4' } })
      .mockResolvedValueOnce({
        result: { status: 'declined', askId: 'ask_4', answers: {}, skipped: [], summary: '' }
      })

    vi.useFakeTimers()
    // Why: attach the assertion synchronously, before any timer advances, so the
    // rejection this retry swallows internally is never briefly unobserved.
    const assertion = expect(
      ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))
    ).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await assertion
    vi.useRealTimers()

    const firstRequestId = callMock.mock.calls[0][1].requestId
    const secondRequestId = callMock.mock.calls[1][1].requestId
    expect(typeof firstRequestId).toBe('string')
    expect(firstRequestId.length).toBeGreaterThan(0)
    expect(secondRequestId).toBe(firstRequestId)
  })

  it('keeps retrying across transport loss until the chunk budget is spent, then prints pending', async () => {
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_wait_exhausted' } })
      .mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'connection reset'))

    vi.useFakeTimers()
    try {
      const assertion = expect(
        ASK_HANDLERS.ask(
          ctx([
            ['spec', VALID_SPEC_JSON],
            ['chunk-ms', '20000']
          ])
        )
      ).resolves.toBeUndefined()
      await Promise.all([assertion, vi.runAllTimersAsync()])

      expect(callMock.mock.calls.slice(1).every(([method]) => method === 'ask.wait')).toBe(true)
      expect(callMock.mock.calls.length).toBeGreaterThan(1 + ASK_CLI_TRANSPORT_RETRY_ATTEMPTS)
      expect(logSpy.mock.calls).toEqual([
        [JSON.stringify({ status: 'registered', askId: 'ask_wait_exhausted' })],
        [
          JSON.stringify({
            status: 'pending',
            askId: 'ask_wait_exhausted',
            instruction: 'quirky ask wait --id ask_wait_exhausted'
          })
        ]
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off and retries when the host sheds the wait as runtime_busy', async () => {
    const answered = {
      status: 'answered',
      askId: 'ask_busy',
      answers: {},
      skipped: [],
      summary: ''
    }
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_busy' } })
      .mockRejectedValueOnce(
        new RuntimeRpcFailureError({
          id: 'req_wait',
          ok: false,
          error: { code: 'runtime_busy', message: 'long-poll capacity reached; retry with backoff' }
        })
      )
      .mockResolvedValueOnce({ result: answered })

    vi.useFakeTimers()
    try {
      const assertion = expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).resolves.toBe(
        undefined
      )
      await Promise.all([assertion, vi.runAllTimersAsync()])
    } finally {
      vi.useRealTimers()
    }

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(logSpy.mock.calls.at(-1)).toEqual([JSON.stringify(answered)])
  })

  it('still rejects when every ask.register transport attempt fails', async () => {
    const failure = new RuntimeClientError('runtime_unavailable', 'registration unavailable')
    callMock.mockRejectedValue(failure)

    vi.useFakeTimers()
    try {
      const assertion = expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).rejects.toBe(
        failure
      )
      await Promise.all([assertion, vi.runAllTimersAsync()])

      expect(callMock).toHaveBeenCalledTimes(ASK_CLI_TRANSPORT_RETRY_ATTEMPTS)
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not turn a server runtime_unavailable wait failure into pending', async () => {
    const failure = new RuntimeRpcFailureError({
      id: 'req_wait',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'server rejected wait' }
    })
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_server_failure' } })
      .mockRejectedValueOnce(failure)

    await expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).rejects.toBe(failure)

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ status: 'registered', askId: 'ask_server_failure' })
    )
  })

  it('resumes the same askId on a transport failure mid-wait, never issuing a second register', async () => {
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_5' } })
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'connection reset'))
      .mockResolvedValueOnce({
        result: { status: 'answered', askId: 'ask_5', answers: {}, skipped: [], summary: '' }
      })

    vi.useFakeTimers()
    const assertion = expect(
      ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))
    ).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await assertion
    vi.useRealTimers()

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(callMock.mock.calls[0][0]).toBe('ask.register')
    expect(callMock.mock.calls[1][0]).toBe('ask.wait')
    expect(callMock.mock.calls[1][1]).toMatchObject({ askId: 'ask_5' })
    expect(callMock.mock.calls[2][0]).toBe('ask.wait')
    expect(callMock.mock.calls[2][1]).toMatchObject({ askId: 'ask_5' })
  })

  it('passes pane/worktree origin env vars verbatim and drops absent ones', async () => {
    delete process.env.QUIRKY_TERMINAL_HANDLE
    delete process.env.QUIRKY_WORKSPACE_ID
    process.env.QUIRKY_PANE_KEY = 'pane_9'
    process.env.QUIRKY_WORKTREE_ID = 'wt_9'
    try {
      callMock.mockResolvedValueOnce({ result: { askId: 'ask_6' } }).mockResolvedValueOnce({
        result: { status: 'declined', askId: 'ask_6', answers: {}, skipped: [], summary: '' }
      })

      await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]], { cwd: '/repo' }))

      const params = callMock.mock.calls[0][1]
      expect(params).toMatchObject({ cwd: '/repo', paneKey: 'pane_9', worktreeId: 'wt_9' })
      expect(params.terminalHandle).toBeUndefined()
      expect(params.workspaceId).toBeUndefined()
    } finally {
      delete process.env.QUIRKY_PANE_KEY
      delete process.env.QUIRKY_WORKTREE_ID
    }
  })
})

describe('quirky ask wait', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(console.log).mockRestore()
  })

  it('issues a single chunk with no registered line', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'pending', askId: 'ask_1', instruction: 'quirky ask wait --id ask_1' }
    })

    await ASK_HANDLERS['ask wait'](ctx([['id', 'ask_1']]))

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'ask.wait',
      { askId: 'ask_1', chunkMs: undefined },
      expect.any(Object)
    )
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        status: 'pending',
        askId: 'ask_1',
        instruction: 'quirky ask wait --id ask_1'
      })
    )
  })

  it('forwards a custom --chunk-ms', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'answered', askId: 'ask_1', answers: {}, skipped: [], summary: '' }
    })

    await ASK_HANDLERS['ask wait'](
      ctx([
        ['id', 'ask_1'],
        ['chunk-ms', '2000']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'ask.wait',
      { askId: 'ask_1', chunkMs: 2000 },
      expect.any(Object)
    )
  })

  it('keeps retrying across transport loss until the chunk budget is spent, then prints pending', async () => {
    callMock.mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'connection reset'))

    vi.useFakeTimers()
    try {
      const assertion = expect(
        ASK_HANDLERS['ask wait'](
          ctx([
            ['id', 'ask_wait_exhausted'],
            ['chunk-ms', '20000']
          ])
        )
      ).resolves.toBeUndefined()
      await Promise.all([assertion, vi.runAllTimersAsync()])

      expect(callMock.mock.calls.every(([method]) => method === 'ask.wait')).toBe(true)
      expect(callMock.mock.calls.length).toBeGreaterThan(ASK_CLI_TRANSPORT_RETRY_ATTEMPTS)
      expect(console.log).toHaveBeenCalledWith(
        JSON.stringify({
          status: 'pending',
          askId: 'ask_wait_exhausted',
          instruction: 'quirky ask wait --id ask_wait_exhausted'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off and retries when the host sheds the wait as runtime_busy', async () => {
    const answered = {
      status: 'answered',
      askId: 'ask_busy',
      answers: {},
      skipped: [],
      summary: ''
    }
    callMock
      .mockRejectedValueOnce(
        new RuntimeRpcFailureError({
          id: 'req_wait',
          ok: false,
          error: { code: 'runtime_busy', message: 'long-poll capacity reached; retry with backoff' }
        })
      )
      .mockResolvedValueOnce({ result: answered })

    vi.useFakeTimers()
    try {
      const assertion = expect(
        ASK_HANDLERS['ask wait'](ctx([['id', 'ask_busy']]))
      ).resolves.toBeUndefined()
      await Promise.all([assertion, vi.runAllTimersAsync()])
    } finally {
      vi.useRealTimers()
    }

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(answered))
  })

  it.each(['runtime_unavailable', 'invalid_argument'])(
    'still rejects a server %s failure',
    async (code) => {
      const failure = new RuntimeRpcFailureError({
        id: 'req_wait',
        ok: false,
        error: { code, message: 'server rejected wait' }
      })
      callMock.mockRejectedValueOnce(failure)

      await expect(ASK_HANDLERS['ask wait'](ctx([['id', 'ask_server_failure']]))).rejects.toBe(
        failure
      )

      expect(callMock).toHaveBeenCalledTimes(1)
      expect(console.log).not.toHaveBeenCalled()
    }
  )
})

describe('quirky ask cancel', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.mocked(console.log).mockRestore()
  })

  it('calls ask.cancel with the given id and prints the returned envelope verbatim', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'declined', askId: 'ask_1', answers: {}, skipped: [], summary: '' }
    })

    await ASK_HANDLERS['ask cancel'](ctx([['id', 'ask_1']]))

    expect(callMock).toHaveBeenCalledWith('ask.cancel', { askId: 'ask_1' })
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ status: 'declined', askId: 'ask_1', answers: {}, skipped: [], summary: '' })
    )
  })
})
