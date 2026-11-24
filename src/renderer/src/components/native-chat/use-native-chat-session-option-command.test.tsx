// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendNativeChatMessageVerified = vi.fn()
const typeNativeChatCommand = vi.fn()
const observerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn()
}))
const queueMocks = vi.hoisted(() => ({
  cancelNativeChatPtySends: vi.fn(),
  waitForNativeChatPtyIdle: vi.fn()
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessageVerified: (...args: unknown[]) => sendNativeChatMessageVerified(...args),
  typeNativeChatCommand: (...args: unknown[]) => typeNativeChatCommand(...args)
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: (...args: unknown[]) => queueMocks.cancelNativeChatPtySends(...args),
  waitForNativeChatPtyIdle: (...args: unknown[]) => queueMocks.waitForNativeChatPtyIdle(...args)
}))
vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: (...args: unknown[]) => observerMocks.create(...args)
}))

import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'

function renderDispatch(agent: 'codex' | 'claude' | 'openclaude', onSubmitted = vi.fn()) {
  return renderHook(() =>
    useNativeChatSessionOptionCommand({
      agent,
      onSubmitted,
      disabled: false,
      resolveTarget: () => ({ terminalTabId: 'tab-1', ptyId: 'pty-1' }),
      setHistory: vi.fn()
    })
  )
}

describe('useNativeChatSessionOptionCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNativeChatMessageVerified.mockResolvedValue(true)
    typeNativeChatCommand.mockResolvedValue(true)
    queueMocks.waitForNativeChatPtyIdle.mockResolvedValue(undefined)
    observerMocks.create.mockReturnValue({
      ready: Promise.withResolvers<void>().promise,
      result: Promise.withResolvers<never>().promise,
      arm: vi.fn(),
      startDetection: vi.fn(),
      dispose: observerMocks.dispose
    })
  })

  afterEach(() => {
    cleanup()
    _resetTerminalInputQuarantineForTests()
  })

  it('types Codex option commands even without caller delivery metadata', async () => {
    const onSubmitted = vi.fn()
    const hook = renderDispatch('codex', onSubmitted)
    await act(() => hook.result.current.dispatch('/model'))
    expect(onSubmitted).toHaveBeenCalledOnce()

    expect(typeNativeChatCommand).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      '/model',
      expect.any(AbortSignal)
    )
    expect(sendNativeChatMessageVerified).not.toHaveBeenCalled()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s option commands pasted', async (agent) => {
    const hook = renderDispatch(agent)
    await act(() => hook.result.current.dispatch('/model sonnet', { delivery: 'type' }))

    expect(sendNativeChatMessageVerified).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      '/model sonnet',
      expect.any(AbortSignal)
    )
    expect(typeNativeChatCommand).not.toHaveBeenCalled()
  })

  it('does not run ordinary queue cancellation after quarantine already armed', async () => {
    const hook = renderDispatch('codex')
    armTerminalInputQuarantine('tab-1')

    await act(async () => {
      await expect(hook.result.current.dispatch('/model')).rejects.toThrow()
    })

    expect(queueMocks.cancelNativeChatPtySends).not.toHaveBeenCalled()
    expect(sendNativeChatMessageVerified).not.toHaveBeenCalled()
    expect(typeNativeChatCommand).not.toHaveBeenCalled()
  })
  it('disposes a pending confirmation observer when quarantine arms', async () => {
    const hook = renderDispatch('claude')
    act(() => {
      void hook.result.current.dispatch('/model sonnet', {
        detectAgentInteraction: 'claude-model-switch-confirmation',
        expectedChoiceLabel: 'Sonnet'
      })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(observerMocks.create).toHaveBeenCalledOnce()

    act(() => armTerminalInputQuarantine('tab-1'))

    expect(observerMocks.dispose).toHaveBeenCalledOnce()
    expect(sendNativeChatMessageVerified).not.toHaveBeenCalled()
  })
})
