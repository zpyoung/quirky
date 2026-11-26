import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputAcceptance = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputAcceptance: (...args: unknown[]) => sendRuntimePtyInputAcceptance(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import {
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  sendNativeChatMessageVerified,
  submitNativeChatPrompt,
  typeNativeChatCommand
} from '../native-chat-runtime-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from '../native-chat-send'
import { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } from '../pty-send/native-chat-runtime-clear'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine
} from '../../terminal-pane/terminal-input-quarantine'

const TAB = 'tab-quarantine'
const PTY = 'pty-quarantine'
const TARGET: NativeChatResolvedTarget = {
  terminalTabId: TAB,
  ptyId: PTY
}

function acceptedWriteBytes(): string[] {
  return sendRuntimePtyInputAcceptance.mock.calls.flatMap((call) =>
    typeof call[1] === 'string' ? [call[1]] : []
  )
}

function verifiedWriteBytes(): string[] {
  return sendRuntimePtyInputVerified.mock.calls.flatMap((call) =>
    typeof call[1] === 'string' ? [call[1]] : []
  )
}

describe('native-chat runtime quarantine boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputAcceptance.mockResolvedValue(true)
    sendRuntimePtyInputVerified.mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
    _resetTerminalInputQuarantineForTests()
  })

  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    _resetTerminalInputQuarantineForTests()
    vi.useRealTimers()
  })

  it('rejects a message sent to a quarantined PTY boundary', async () => {
    const onOutcome = vi.fn()
    armTerminalInputQuarantine(TAB)

    sendNativeChatMessage(TARGET, 'blocked', { onOutcome })
    await vi.runAllTimersAsync()

    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
    expect(sendRuntimePtyInputAcceptance).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('invalidates a body already written when reattachment arms during the delayed Enter', async () => {
    const onOutcome = vi.fn()
    sendNativeChatMessage(TARGET, 'do not submit on the replacement shell', { onOutcome })
    await vi.advanceTimersByTimeAsync(0)
    expect(acceptedWriteBytes()).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('do not submit on the replacement shell')
    ])

    armTerminalInputQuarantine(TAB)
    await vi.advanceTimersByTimeAsync(5_000 + NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(acceptedWriteBytes()).not.toContain(NATIVE_CHAT_SUBMIT)
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('blocks a bare submit control while quarantine is armed', () => {
    armTerminalInputQuarantine(TAB)

    submitNativeChatPrompt(TARGET)

    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('does not run drain cleanup for an already-quarantined verified or typed command', async () => {
    armTerminalInputQuarantine(TAB)

    await expect(sendNativeChatMessageVerified(TARGET, '/model sonnet')).resolves.toBe(false)
    await expect(typeNativeChatCommand(TARGET, '/model')).resolves.toBe(false)

    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
    expect(sendRuntimePtyInputAcceptance).not.toHaveBeenCalled()
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
  it('drops sends queued behind an invalidated body instead of replaying them after expiry', async () => {
    sendNativeChatMessage(TARGET, 'first')
    sendNativeChatMessage(TARGET, 'queued stale send')
    await vi.advanceTimersByTimeAsync(0)

    armTerminalInputQuarantine(TAB)
    await vi.advanceTimersByTimeAsync(5_000 + NATIVE_CHAT_SUBMIT_DELAY_MS * 2)
    expect(acceptedWriteBytes()).not.toContain(NATIVE_CHAT_SUBMIT)
    expect(acceptedWriteBytes()).not.toContain(buildNativeChatPasteBytes('queued stale send'))
  })

  it('cancels paced selector writes exactly once when quarantine arms', async () => {
    const onSettled = vi.fn()
    sendNativeChatAskAnswer(TARGET, [{ raw: '1' }, { raw: '2' }], onSettled)
    await vi.advanceTimersByTimeAsync(0)
    expect(verifiedWriteBytes()).toEqual(['1'])
    const isCancelled = sendRuntimePtyInputVerified.mock.calls[0]?.[3]?.isCancelled
    expect(typeof isCancelled).toBe('function')

    armTerminalInputQuarantine(TAB)
    if (typeof isCancelled !== 'function') {
      throw new Error('verified ask write did not receive its cancellation predicate')
    }
    expect(isCancelled()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(verifiedWriteBytes()).toEqual(['1'])
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('flips the in-flight verified transport predicate when quarantine arms', async () => {
    const body = Promise.withResolvers<boolean>()
    sendRuntimePtyInputVerified.mockReturnValueOnce(body.promise)
    const pending = sendNativeChatMessageVerified(TARGET, '/model sonnet')
    await vi.advanceTimersByTimeAsync(0)
    const isCancelled = sendRuntimePtyInputVerified.mock.calls[0]?.[3]?.isCancelled
    expect(typeof isCancelled).toBe('function')

    armTerminalInputQuarantine(TAB)

    if (typeof isCancelled !== 'function') {
      throw new Error('verified body write did not receive its cancellation predicate')
    }
    expect(isCancelled()).toBe(true)
    await expect(pending).resolves.toBe(false)
    body.resolve(false)
    await vi.runAllTimersAsync()
  })
  it('does not resume an async verified send after arm and release during its queue drain', async () => {
    sendNativeChatMessage(TARGET, 'occupy queue')
    const pending = sendNativeChatMessageVerified(TARGET, '/model sonnet')

    armTerminalInputQuarantine(TAB)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toBe(false)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('allows a new send after expiry without reviving the invalidated send', async () => {
    sendNativeChatMessage(TARGET, 'stale operation')
    await vi.advanceTimersByTimeAsync(0)
    armTerminalInputQuarantine(TAB)
    await vi.advanceTimersByTimeAsync(5_000 + NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(acceptedWriteBytes()).not.toContain(NATIVE_CHAT_SUBMIT)

    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInputAcceptance.mockClear()
    sendNativeChatMessage(TARGET, 'fresh operation')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(acceptedWriteBytes()).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('fresh operation'),
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('preserves the ordinary clear-body-delayed-Enter sequence on a live PTY', async () => {
    sendNativeChatMessage(TARGET, 'ordinary send')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(acceptedWriteBytes()).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('ordinary send'),
      NATIVE_CHAT_SUBMIT
    ])
  })
})
