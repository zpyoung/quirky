// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))

// Isolates this hook's wiring from buildComposerSendOptions' own behavior
// (covered by composer-send-options' own tests); captures what the hook asks
// it to build instead.
const buildComposerSendOptions = vi.fn(
  (args: {
    text: string
    tier: string
    readTerminalScreen?: () => string | null
    onOutcome: (outcome: string) => void
  }) => ({ clearInput: `clear:${args.text}`, onOutcome: args.onOutcome })
)
vi.mock('./fork-agent-composer/composer-send-options', () => ({
  buildComposerSendOptions: (args: Parameters<typeof buildComposerSendOptions>[0]) =>
    buildComposerSendOptions(args)
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:clear',
  name: 'clear',
  token: '/clear',
  description: 'Clear history',
  skillCollision: false
}

function setup(overrides: Partial<Parameters<typeof useNativeChatPickerCommandDispatch>[0]> = {}) {
  const callbacks = {
    onSendOutcome: vi.fn(),
    onSubmitted: vi.fn(),
    restoreImageAttachments: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setNotice: vi.fn(),
    setHistory: vi.fn(),
    setActiveSuggestion: vi.fn(),
    clearImageAttachments: vi.fn(),
    clearSkillOrigin: vi.fn(),
    trackPendingSend: vi.fn(),
    onSlashCommand: vi.fn()
  }
  const attachments: AgentComposerImageAttachment[] = [{ id: 'img-1', path: '/tmp/a.png' }]
  const hook = renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent: 'claude',
      disabled: false,
      isDispatchingSessionOption: false,
      paneKey: 'pane-dock-picker',
      sendTier: 'verified',
      readTerminalScreen: () => null,
      resolveTarget: () => ({ terminalTabId: 'tab-1', ptyId: 'pty-1' }),
      sessionOptionsSurface: null,
      imageAttachments: attachments,
      ...callbacks,
      ...overrides
    })
  )
  return { hook, callbacks, attachments }
}

describe('useNativeChatPickerCommandDispatch', () => {
  beforeEach(() => {
    const handle = { cancel: vi.fn(), settleAfterMs: 0 }
    sendNativeChatMessage.mockReturnValue(handle)
    sendNativeChatTypedCommand.mockReturnValue(handle)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('types Codex autocomplete commands', () => {
    const { hook, callbacks } = setup({ agent: 'codex' })
    const { onSubmitted } = callbacks

    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      '/clear'
    )
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(onSubmitted).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'openclaude'] as const)('keeps %s autocomplete commands pasted', (agent) => {
    const { hook } = setup({ agent })

    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatMessage).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      '/clear',
      expect.anything()
    )
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('builds send options through the same tiered pipeline as a normal send', () => {
    const { hook } = setup()

    act(() => hook.result.current(COMMAND))

    expect(buildComposerSendOptions).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/clear', tier: 'verified' })
    )
    expect(sendNativeChatMessage).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      '/clear',
      expect.objectContaining({ onOutcome: expect.any(Function) })
    )
  })

  it('reports through the host outcome pipeline and restores draft+attachments on may-not-have-sent', () => {
    const { hook, callbacks, attachments } = setup()

    act(() => hook.result.current(COMMAND))
    const options = buildComposerSendOptions.mock.calls.at(-1)?.[0] as {
      onOutcome: (outcome: string) => void
    }
    act(() => options.onOutcome('may-not-have-sent'))

    expect(callbacks.onSendOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
    expect(callbacks.restoreImageAttachments).toHaveBeenCalledExactlyOnceWith(attachments)
    expect(callbacks.setDraft).toHaveBeenLastCalledWith('/clear\n\n')
    expect(callbacks.setNotice).toHaveBeenLastCalledWith(
      'Send may not have completed. Check the terminal before retrying.'
    )
  })

  it('leaves the normal picker success path unchanged when no outcome fires', () => {
    const { hook, callbacks } = setup()

    act(() => hook.result.current(COMMAND))

    expect(callbacks.setHistory).toHaveBeenCalledTimes(1)
    expect(callbacks.setDraft).toHaveBeenCalledExactlyOnceWith('')
    expect(callbacks.setCaret).toHaveBeenCalledExactlyOnceWith(0)
    expect(callbacks.setActiveSuggestion).toHaveBeenCalledExactlyOnceWith(0)
    expect(callbacks.clearSkillOrigin).toHaveBeenCalledTimes(1)
    expect(callbacks.clearImageAttachments).toHaveBeenCalledTimes(1)
    expect(callbacks.setNotice).toHaveBeenCalledExactlyOnceWith(null)
    expect(callbacks.trackPendingSend).toHaveBeenCalledTimes(1)
    expect(callbacks.onSendOutcome).not.toHaveBeenCalled()
    expect(callbacks.restoreImageAttachments).not.toHaveBeenCalled()
  })

  it('does not dispatch while disabled or another session option is in flight', () => {
    const { hook, callbacks } = setup({ disabled: true })

    act(() => hook.result.current(COMMAND))

    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(callbacks.trackPendingSend).not.toHaveBeenCalled()
  })
})
