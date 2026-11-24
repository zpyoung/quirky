import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the IO seam so the test stays pure: we only assert the write order and
// the inter-write delay, not the local-vs-remote pty branching.
const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputAcceptance = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputAcceptance: (...args: unknown[]) => sendRuntimePtyInputAcceptance(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  sendNativeChatMessageVerified,
  typeNativeChatCommand,
  submitNativeChatPrompt,
  sendNativeChatAskAnswer,
  resetNativeChatPtySendQueuesForTests,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  sendNativeChatMessageWithImageAttachments,
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS
} from './native-chat-runtime-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } from './fork-agent-composer/native-chat-runtime-clear'
import {
  NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS,
  NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS
} from './fork-agent-composer/native-chat-send-outcome'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import { cancelNativeChatPtySends } from './native-chat-pty-send-queue'
import { sendNativeChatMessageWithImageAttachments as sendNativeChatMessageWithAgentImageAttachments } from './native-chat-runtime-image-send'

const TAB = 'tab-runtime-send'
const PTY = 'pty-1'
const TARGET: NativeChatResolvedTarget = {
  terminalTabId: TAB,
  ptyId: PTY
}
const targetForPty = (ptyId: string): NativeChatResolvedTarget => ({
  terminalTabId: TAB,
  ptyId
})

// Clear writes go through the fire-and-forget transport; body and Enter go
// through the acceptance-aware one — merge both mocks' calls by global
// invocation order to assert on the pty write sequence as a whole.
function mergedWriteBytes(): string[] {
  const entries: { order: number; bytes: string }[] = []
  for (const mock of [sendRuntimePtyInput, sendRuntimePtyInputAcceptance]) {
    mock.mock.calls.forEach((call, index) => {
      if (typeof call[1] === 'string') {
        entries.push({ order: mock.mock.invocationCallOrder[index], bytes: call[1] })
      }
    })
  }
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.bytes)
}

function expectWriteOrder(expected: string[]): void {
  expect(mergedWriteBytes()).toEqual(expected)
}

function expectVerifiedWriteOrder(expected: string[]): void {
  const bytes = sendRuntimePtyInputVerified.mock.calls.flatMap((call) =>
    typeof call[1] === 'string' ? [call[1]] : []
  )
  expect(bytes).toEqual(expected)
}

function totalWriteCalls(): number {
  return sendRuntimePtyInput.mock.calls.length + sendRuntimePtyInputAcceptance.mock.calls.length
}

describe('sendNativeChatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
    resetNativeChatPtySendQueuesForTests()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('clears the TUI line, then writes the framed body, before the Enter', async () => {
    const handle = sendNativeChatMessage(TARGET, 'hello world')
    await vi.advanceTimersByTimeAsync(0)
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hello world')
    ])
    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)
  })

  it('does not fire Enter before the proven 500ms gap (busy-agent safety)', async () => {
    sendNativeChatMessage(TARGET, 'hi')
    // A short gap would fire Enter while a busy Codex has not yet landed the
    // paste, submitting an empty box — so nothing must happen before 500ms.
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(mergedWriteBytes()).toHaveLength(2)
  })

  it('writes the bare carriage-return Enter as a separate delayed write', async () => {
    sendNativeChatMessage(TARGET, 'hi')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hi'),
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('cancels the delayed Enter and re-clears an unsubmitted body', async () => {
    const handle = sendNativeChatMessage(TARGET, 'hi')
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    // Pre-send clear + body + cancel clear; Enter must not fire.
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hi'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
    ])
  })

  it('clears leftover unsubmitted body on cancel so the next send cannot glue', async () => {
    const handle = sendNativeChatMessage(TARGET, 'tell me a joke')
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()

    sendNativeChatMessage(TARGET, 'continue')
    // Queue release after cancel is promise-chained; flush so the next body runs.
    await vi.advanceTimersByTimeAsync(0)

    expect(mergedWriteBytes()).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, // cancel cleanup
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, // next send pre-clear
      buildNativeChatPasteBytes('continue')
    ])
  })

  it('does not clear the TUI input when cancel runs after Enter already fired', async () => {
    const handle = sendNativeChatMessage(TARGET, 'already submitted')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    sendRuntimePtyInput.mockClear()
    handle.cancel()

    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('serializes rapid sends on the same PTY so bodies cannot glue before Enter', async () => {
    sendNativeChatMessage(TARGET, 'tell me a joke')
    sendNativeChatMessage(TARGET, 'continue')
    await vi.advanceTimersByTimeAsync(0)

    // First clear+body are immediate; second sequence waits for the first Enter.
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke')
    ])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke'),
      NATIVE_CHAT_SUBMIT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('continue')
    ])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInputAcceptance).toHaveBeenLastCalledWith(
      PTY,
      NATIVE_CHAT_SUBMIT,
      'driving'
    )
    expect(mergedWriteBytes()).toHaveLength(6)
  })

  it('does not let a canceled queued send stall the sends behind it', async () => {
    sendNativeChatMessage(TARGET, 'first')
    const canceled = sendNativeChatMessage(TARGET, 'canceled')
    sendNativeChatMessage(TARGET, 'third')
    canceled.cancel()

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('first'),
      NATIVE_CHAT_SUBMIT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('third')
    ])
  })

  it('does not serialize sends across different PTYs', async () => {
    sendNativeChatMessage(targetForPty('pty-a'), 'one')
    sendNativeChatMessage(targetForPty('pty-b'), 'two')
    await vi.advanceTimersByTimeAsync(0)

    // Independent PTYs: each gets its own clear-then-body, unordered relative
    // to the other PTY's writes. Clear and body both go through the
    // acceptance-aware transport now (r4-2).
    const byPty = (ptyId: string): string[] =>
      sendRuntimePtyInputAcceptance.mock.calls.flatMap((call) =>
        call[0] === ptyId && typeof call[1] === 'string' ? [call[1]] : []
      )
    expect(byPty('pty-a')).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('one')
    ])
    expect(byPty('pty-b')).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('two')
    ])
  })

  it('passes a live isCancelled check through to the acceptance-aware body write', async () => {
    const handle = sendNativeChatMessage(TARGET, 'hi')
    await vi.advanceTimersByTimeAsync(0)

    const bodyCall = sendRuntimePtyInputAcceptance.mock.calls.find(
      (call) => call[1] === buildNativeChatPasteBytes('hi')
    )
    const isCancelled = bodyCall?.[3] as (() => boolean) | undefined
    expect(isCancelled).toBeInstanceOf(Function)
    expect(isCancelled?.()).toBe(false)

    handle.cancel()
    expect(isCancelled?.()).toBe(true)
  })
})

describe('sendNativeChatMessage post-send observation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
    resetNativeChatPtySendQueuesForTests()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
    // sendNativeChatMessageVerified's tests (next file section) share this mock
    // and only reset sendRuntimePtyInputVerified, not this one.
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
  })

  const settleSend = () => vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
  const fullObservationWindow = () =>
    vi.advanceTimersByTimeAsync(
      NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS * NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS
    )

  it('reports unobservable when confirmSubmitted is absent, with no extra reads', async () => {
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { onOutcome })
    await settleSend()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('unobservable')
    // clear + body + Enter only — the observation step added no pty writes.
    expect(totalWriteCalls()).toBe(3)
  })

  it('reports observed-cleared on the first read and does not poll again', async () => {
    const confirmSubmitted = vi.fn().mockReturnValue(true)
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })
    await settleSend()

    expect(confirmSubmitted).toHaveBeenCalledOnce()
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('observed-cleared')

    await fullObservationWindow()
    expect(confirmSubmitted).toHaveBeenCalledOnce()
    expect(onOutcome).toHaveBeenCalledOnce()
  })

  it('reports observed-cleared once a flapping read turns true', async () => {
    const confirmSubmitted = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })
    await settleSend()
    expect(onOutcome).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_OBSERVATION_POLL_MS)

    expect(confirmSubmitted).toHaveBeenCalledTimes(2)
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('observed-cleared')
  })

  it('reports may-not-have-sent when every read is false, and never re-writes after the CR', async () => {
    const confirmSubmitted = vi.fn().mockReturnValue(false)
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })
    await settleSend()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()

    await fullObservationWindow()

    expect(confirmSubmitted).toHaveBeenCalledTimes(NATIVE_CHAT_SUBMIT_OBSERVATION_MAX_READS)
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    // The no-auto-resend invariant: a negative observation must never trigger another pty write.
    expect(totalWriteCalls()).toBe(0)
  })

  it('aborts before the body when the transport rejects the initial clear', async () => {
    sendRuntimePtyInputAcceptance.mockResolvedValueOnce(false)
    const confirmSubmitted = vi.fn().mockReturnValue(true)
    const onOutcome = vi.fn()

    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalledTimes(1)
    expect(confirmSubmitted).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports may-not-have-sent exactly once on a remote clear rejection, and never writes body or CR (r4-2)', async () => {
    sendRuntimePtyInputAcceptance.mockResolvedValueOnce(false) // clear rejected
    const onOutcome = vi.fn()

    sendNativeChatMessage(TARGET, 'hi', { onOutcome })
    await fullObservationWindow()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some(
        (call) => call[1] === buildNativeChatPasteBytes('hi') || call[1] === NATIVE_CHAT_SUBMIT
      )
    ).toBe(false)
  })

  it('proceeds with an unchanged clear-then-body-then-Enter flow when the clear is accepted (r4-2)', async () => {
    const confirmSubmitted = vi.fn().mockReturnValue(true)
    const onOutcome = vi.fn()

    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })
    await settleSend()

    expect(sendRuntimePtyInputAcceptance.mock.calls.map((call) => call[1])).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hi'),
      NATIVE_CHAT_SUBMIT
    ])
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('observed-cleared')
  })

  it('aborts before the body when the transport rejects maximal-clear escalation', async () => {
    sendRuntimePtyInputAcceptance.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const confirmCleared = vi.fn().mockReturnValue(false)
    const onOutcome = vi.fn()

    sendNativeChatMessage(TARGET, 'hi', { confirmCleared, onOutcome })
    await vi.runAllTimersAsync()

    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalledTimes(2)
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports may-not-have-sent when the transport rejects the CR write', async () => {
    sendRuntimePtyInputAcceptance
      .mockResolvedValueOnce(true) // clear
      .mockResolvedValueOnce(true) // body
      .mockResolvedValueOnce(false) // CR
    const confirmSubmitted = vi.fn().mockReturnValue(true)
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })

    await settleSend()

    expect(confirmSubmitted).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports may-not-have-sent exactly once when the transport throws on the CR write', async () => {
    // mockImplementationOnce (not a standing mockImplementation) so this
    // failure does not leak into later describe blocks that share this mock.
    sendRuntimePtyInputAcceptance
      .mockResolvedValueOnce(true) // clear
      .mockResolvedValueOnce(true) // body
      .mockImplementationOnce(() => {
        throw new Error('transport dead')
      }) // CR
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { onOutcome })

    await settleSend()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports may-not-have-sent exactly once when cancelled before the submit delay', () => {
    const onOutcome = vi.fn()
    const handle = sendNativeChatMessage(TARGET, 'hi', { onOutcome })
    handle.cancel()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports may-not-have-sent exactly once when the transport throws on the body write, and never issues the CR (draft stays restorable)', async () => {
    // Regression for a remote handle rejecting the body RPC (e.g. terminal_handle_stale):
    // the CR must not follow a body write that never reached the PTY.
    sendRuntimePtyInputAcceptance
      .mockResolvedValueOnce(true) // clear
      .mockImplementationOnce(() => Promise.reject(new Error('terminal_handle_stale'))) // body
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'hi', { onOutcome })

    await vi.advanceTimersByTimeAsync(0)
    await fullObservationWindow()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some((call) => call[1] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })

  it('does not write the CR and reports may-not-have-sent when the body write is rejected, even though confirmSubmitted would read true', async () => {
    const confirmSubmitted = vi.fn().mockReturnValue(true)
    const onOutcome = vi.fn()
    sendRuntimePtyInputAcceptance
      .mockResolvedValueOnce(true) // clear
      .mockResolvedValueOnce(false) // oversized body, rejected
    sendNativeChatMessage(TARGET, 'hi', { confirmSubmitted, onOutcome })

    await vi.advanceTimersByTimeAsync(0)

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    expect(confirmSubmitted).not.toHaveBeenCalled()

    await fullObservationWindow()

    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some((call) => call[1] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
    expect(onOutcome).toHaveBeenCalledOnce()
  })

  it('reports may-not-have-sent exactly once when a send queued behind another is cancelled before its body starts', async () => {
    const firstOutcome = vi.fn()
    const queuedOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'first', { onOutcome: firstOutcome })
    await vi.advanceTimersByTimeAsync(0)
    const queued = sendNativeChatMessage(TARGET, 'queued', { onOutcome: queuedOutcome })

    // The queued send never reached `start`, so its body was never written.
    queued.cancel()
    expect(queuedOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')

    await settleSend()
    expect(firstOutcome).toHaveBeenCalledExactlyOnceWith('unobservable')

    // Cancelling again, and letting the queue reach the dropped entry, must not double-fire.
    queued.cancel()
    await fullObservationWindow()
    expect(queuedOutcome).toHaveBeenCalledOnce()
  })

  it('reports may-not-have-sent exactly once when the cleanup clear throws on cancel (r5-2)', () => {
    const onOutcome = vi.fn()
    sendRuntimePtyInput.mockImplementationOnce(() => {
      throw new Error('preload write dead')
    })
    const handle = sendNativeChatMessage(TARGET, 'hi', { onOutcome })

    handle.cancel()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('cancels a later queued send even when the first handle cleanup clear throws (r5-2)', async () => {
    const firstOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'first', { onOutcome: firstOutcome })
    sendNativeChatMessage(TARGET, 'second')
    sendRuntimePtyInput.mockImplementationOnce(() => {
      throw new Error('preload write dead')
    })

    expect(() => cancelNativeChatPtySends(PTY)).not.toThrow()
    expect(firstOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')

    await vi.runAllTimersAsync()

    // A first-handle throw must not stop the fenced cancel loop from reaching
    // the second (still-queued) handle — otherwise it starts on the pty this
    // just tried to clean up.
    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some(
        (call) => call[1] === buildNativeChatPasteBytes('second')
      )
    ).toBe(false)
  })
})

describe('sendNativeChatMessageVerified', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInputVerified.mockReset().mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('awaits body acceptance before the delayed Enter write (no pre-clear)', async () => {
    // Why: model-switch confirmation watches the PTY while this send runs;
    // verified option commands must not inject Ctrl+U noise.
    const result = sendNativeChatMessageVerified(TARGET, '/model sonnet')
    await vi.waitFor(() => {
      expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    })
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      PTY,
      buildNativeChatPasteBytes('/model sonnet'),
      'driving',
      { isCancelled: expect.any(Function) }
    )

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(await result).toBe(true)
    expect(sendRuntimePtyInputVerified).toHaveBeenLastCalledWith(
      PTY,
      NATIVE_CHAT_SUBMIT,
      'driving',
      { isCancelled: expect.any(Function) }
    )
    expect(
      sendRuntimePtyInputVerified.mock.calls.some(
        (call) => call[1] === NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
      )
    ).toBe(false)
  })

  it('does not send Enter when the body is rejected', async () => {
    sendRuntimePtyInputVerified.mockResolvedValueOnce(false)

    await expect(sendNativeChatMessageVerified(TARGET, '/model sonnet')).resolves.toBe(false)
    await vi.runAllTimersAsync()

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(
      sendRuntimePtyInputVerified.mock.calls.some((call) => call[1] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })

  it('cancels an in-flight chat Enter before delivering a verified option command', async () => {
    sendNativeChatMessage(TARGET, 'hello')
    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalled()

    const result = sendNativeChatMessageVerified(TARGET, '/model haiku')
    // Chat cancel may Ctrl+U the unsubmitted body; Enter from chat must not fire.
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(await result).toBe(true)
    const submits = sendRuntimePtyInputAcceptance.mock.calls.filter(
      (call) => call[1] === NATIVE_CHAT_SUBMIT
    )
    // Only the verified path's Enter — chat's delayed Enter was cancelled.
    expect(submits).toHaveLength(0)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(PTY, NATIVE_CHAT_SUBMIT, 'driving', {
      isCancelled: expect.any(Function)
    })
  })

  it('returns false when the delayed Enter wait is aborted', async () => {
    const controller = new AbortController()
    const result = sendNativeChatMessageVerified(TARGET, '/model sonnet', controller.signal)
    await vi.waitFor(() => {
      expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    })
    controller.abort()

    expect(await result).toBe(false)
    expect(
      sendRuntimePtyInputVerified.mock.calls.some((call) => call[1] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })

  it('serializes a card selector write behind an in-flight option command (r5-3)', async () => {
    let resolveBody!: (accepted: boolean) => void
    sendRuntimePtyInputVerified.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBody = resolve
        })
    )

    const optionResult = sendNativeChatMessageVerified(TARGET, '/model sonnet')
    await vi.waitFor(() => expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1))

    // The card issues its selector write while the option command's body is
    // still awaiting acceptance — it must queue behind the option, not
    // interleave with its body/Enter.
    sendNativeChatAskAnswer(TARGET, [{ raw: '2' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(sendRuntimePtyInput).not.toHaveBeenCalledWith(PTY, '2')

    resolveBody(true)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(await optionResult).toBe(true)
    expect(sendRuntimePtyInputVerified).toHaveBeenLastCalledWith(
      PTY,
      NATIVE_CHAT_SUBMIT,
      'driving',
      { isCancelled: expect.any(Function) }
    )

    // Only once the option command's CR has landed does the card's queued
    // selector write fire.
    await vi.runAllTimersAsync()
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(PTY, '2', 'driving')
  })
})

describe('typeNativeChatCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockReset().mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockReset().mockResolvedValue(true)
    sendRuntimePtyInputVerified.mockReset().mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('writes the Codex picker command as keys instead of one pasted text write', async () => {
    const result = typeNativeChatCommand(TARGET, '/model')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe(true)
    expectVerifiedWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      '/',
      'm',
      'o',
      'd',
      'e',
      'l',
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('queues composer commands as the same paced key sequence', async () => {
    const handle = sendNativeChatTypedCommand(TARGET, '/status')
    await vi.runAllTimersAsync()
    await handle.settled

    expectVerifiedWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      '/',
      's',
      't',
      'a',
      't',
      'u',
      's',
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('does not clear into the next queued send after cancellation', async () => {
    const command = sendNativeChatTypedCommand(TARGET, '/status')
    command.cancel()
    const next = sendNativeChatMessage(TARGET, 'next')
    await vi.runAllTimersAsync()
    await Promise.all([command.settled, next.settled])

    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('next'),
      NATIVE_CHAT_SUBMIT
    ])
  })
})

describe('sendNativeChatMessageWithImageAttachments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('clears the line, then bracket-pastes image paths before prompt text', async () => {
    const handle = sendNativeChatMessageWithImageAttachments(TARGET, 'what do you see?', [
      '/tmp/quirky-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(
      NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    const framedImage = buildNativeChatImagePasteBytes('/tmp/quirky-paste-image.png')
    await vi.advanceTimersByTimeAsync(0)
    expectWriteOrder([NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, framedImage])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
    expect(sendRuntimePtyInputAcceptance).toHaveBeenLastCalledWith(
      PTY,
      buildNativeChatPasteBytes('what do you see?'),
      'driving',
      expect.any(Function)
    )

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInputAcceptance).toHaveBeenLastCalledWith(
      PTY,
      NATIVE_CHAT_SUBMIT,
      'driving'
    )
    expect(totalWriteCalls()).toBe(4)
  })

  it('waits the normal submit gap for an attachment-only send', async () => {
    const handle = sendNativeChatMessageWithImageAttachments(TARGET, '', [
      '/tmp/quirky-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)

    await vi.advanceTimersByTimeAsync(0)
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      '\x1b[200~/tmp/quirky-paste-image.png\x1b[201~'
    ])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(totalWriteCalls()).toBe(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(totalWriteCalls()).toBe(3)
    expect(sendRuntimePtyInputAcceptance).toHaveBeenLastCalledWith(
      PTY,
      NATIVE_CHAT_SUBMIT,
      'driving'
    )
  })

  it('cancels deferred prompt and Enter writes after the attachment path', async () => {
    const handle = sendNativeChatMessageWithImageAttachments(TARGET, 'describe', [
      '/tmp/quirky-paste-image.png'
    ])
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()
    await vi.runAllTimersAsync()

    // Pre-clear + image body + cancel clear; no Enter.
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatImagePasteBytes('/tmp/quirky-paste-image.png'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
    ])
    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some((call) => call[1] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })

  it('reports may-not-have-sent once and releases the queue when the delayed caption write throws', async () => {
    sendRuntimePtyInputAcceptance
      .mockResolvedValueOnce(true) // clear
      .mockResolvedValueOnce(true) // image
      .mockImplementationOnce(() => Promise.reject(new Error('transport dead'))) // caption
    const onOutcome = vi.fn()
    sendNativeChatMessageWithImageAttachments(
      TARGET,
      'describe this',
      ['/tmp/quirky-paste-image.png'],
      { onOutcome }
    )

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')

    // The failed entry must release the per-PTY queue so a later send still starts.
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockClear()
    sendRuntimePtyInputAcceptance.mockResolvedValue(true)
    sendNativeChatMessage(TARGET, 'second send')
    await vi.advanceTimersByTimeAsync(0)

    expect(sendRuntimePtyInputAcceptance).toHaveBeenCalledWith(
      PTY,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      'driving'
    )
    expect(
      sendRuntimePtyInputAcceptance.mock.calls.some(
        (call) => call[1] === buildNativeChatPasteBytes('second send')
      )
    ).toBe(true)
  })

  it('reports may-not-have-sent exactly once when the cleanup clear throws on cancel (r5-2)', () => {
    const onOutcome = vi.fn()
    sendRuntimePtyInput.mockImplementationOnce(() => {
      throw new Error('preload write dead')
    })
    const handle = sendNativeChatMessageWithImageAttachments(
      TARGET,
      'describe',
      ['/tmp/quirky-paste-image.png'],
      { onOutcome }
    )

    handle.cancel()

    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })
})

describe('agent-aware image attachments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('escapes a pasted image path with spaces, so an attachment agent sees one path', async () => {
    sendNativeChatMessageWithAgentImageAttachments('codex', TARGET, '', [
      '/Users/me/Library/Application Support/quirky/native-chat-pastes/quirky-paste-1-ab.png'
    ])
    await vi.advanceTimersByTimeAsync(0)
    expectWriteOrder([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      '\x1b[200~/Users/me/Library/Application\\ Support/quirky/native-chat-pastes/quirky-paste-1-ab.png\x1b[201~'
    ])
  })
})

describe('empty prompt submit', () => {
  beforeEach(() => {
    sendRuntimePtyInput.mockClear()
  })

  it('submits an empty prompt with a bare Enter', () => {
    submitNativeChatPrompt(TARGET)
    expect(sendRuntimePtyInput).toHaveBeenCalledOnce()
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(PTY, NATIVE_CHAT_SUBMIT, 'driving')
  })
})

describe('sendNativeChatAskAnswer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputVerified.mockReset().mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('returns a no-op handle for an empty key group list', () => {
    const handle = sendNativeChatAskAnswer(TARGET, [])
    expect(handle.settleAfterMs).toBe(0)
    handle.cancel()
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('paces key groups so selector steps render before the next write', () => {
    const handle = sendNativeChatAskAnswer(TARGET, [
      { raw: '1' },
      { raw: '2' },
      { text: 'custom answer' }
    ])
    expect(handle.settleAfterMs).toBe(
      2 * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(PTY, '1', 'driving')

    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(PTY, '2', 'driving')

    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      PTY,
      buildNativeChatPasteBytes('custom answer'),
      'driving'
    )
  })

  it('cancels remaining key group timers', () => {
    const handle = sendNativeChatAskAnswer(TARGET, [{ raw: '1' }, { raw: '2' }])
    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    handle.cancel()
    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS * 2)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })

  it('reports verified delivery only after settling and suppresses it after cancellation', async () => {
    const onSettled = vi.fn()
    sendRuntimePtyInputVerified.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const handle = sendNativeChatAskAnswer(TARGET, [{ raw: '1' }, { raw: '\r' }], onSettled)

    await vi.advanceTimersByTimeAsync(handle.settleAfterMs)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()

    const canceledSettled = vi.fn()
    const canceled = sendNativeChatAskAnswer(TARGET, [{ raw: '1' }], canceledSettled)
    canceled.cancel()
    await vi.runAllTimersAsync()
    expect(canceledSettled).not.toHaveBeenCalled()
  })

  it('stops writing later key groups once a group is not acknowledged', async () => {
    const onSettled = vi.fn()
    sendRuntimePtyInputVerified.mockResolvedValueOnce(false)
    const handle = sendNativeChatAskAnswer(TARGET, [{ raw: '1' }, { raw: '\r' }], onSettled)

    await vi.advanceTimersByTimeAsync(handle.settleAfterMs)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('waits for remote acceptance before reporting delivery', async () => {
    const onSettled = vi.fn()
    let resolveAccepted!: (accepted: boolean) => void
    sendRuntimePtyInputVerified.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveAccepted = resolve
      })
    )

    const handle = sendNativeChatAskAnswer(TARGET, [{ raw: '2' }], onSettled)
    await vi.advanceTimersByTimeAsync(handle.settleAfterMs)

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(PTY, '2', 'driving', {
      isCancelled: expect.any(Function),
      requireWriteSettlement: true
    })
    expect(onSettled).not.toHaveBeenCalled()

    resolveAccepted(true)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(true))
  })
})

describe('constants', () => {
  it('exports the ask-answer advance buffer used by interactive cards', () => {
    expect(NATIVE_CHAT_ADVANCE_BUFFER_MS).toBeGreaterThan(0)
  })
})
