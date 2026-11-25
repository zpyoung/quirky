import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTyped = vi.fn()
const sendMessage = vi.fn()

vi.mock('../../native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendTyped(...args)
}))
vi.mock('../../native-chat/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('../terminal-input-quarantine', () => ({
  isTerminalInputQuarantined: () => false
}))

import { submitToTerminalAgent } from './terminal-dock-submit'

const TARGET = { ptyId: 'pty-1', terminalTabId: 'tab-1' }

function submitCodex(text: string): boolean | Promise<boolean> {
  return submitToTerminalAgent({ agent: 'codex', target: TARGET, text, attachments: [] })
}

describe('submitToTerminalAgent typed slash commands', () => {
  beforeEach(() => {
    sendTyped.mockReset()
    sendMessage.mockReset()
  })

  it('resolves false when a queued command is cancelled before it starts, and a later submit works', async () => {
    let cancelQueued: () => void = () => {}
    sendTyped.mockImplementationOnce(
      (_target: unknown, _text: string, options: Record<string, (...a: unknown[]) => void>) => {
        cancelQueued = () => {
          options.onDeliverySettled?.(false)
          options.onOutcome?.('may-not-have-sent')
        }
        return { cancel: cancelQueued, settleAfterMs: 0 }
      }
    )
    const first = submitCodex('/model') as Promise<boolean>
    cancelQueued()
    await expect(first).resolves.toBe(false)

    sendTyped.mockImplementationOnce(
      (_target: unknown, _text: string, options: Record<string, (...a: unknown[]) => void>) => {
        options.onDeliverySettled?.(true)
        return { cancel: () => {}, settleAfterMs: 0 }
      }
    )
    await expect(submitCodex('/status')).resolves.toBe(true)
  })

  it('resolves false when the send handle settles without reporting an outcome', async () => {
    sendTyped.mockReturnValueOnce({
      cancel: () => {},
      settleAfterMs: 0,
      settled: Promise.resolve()
    })
    await expect(submitCodex('/model')).resolves.toBe(false)
  })

  it('keeps the first reported outcome when the handle settles afterwards', async () => {
    sendTyped.mockImplementationOnce(
      (_target: unknown, _text: string, options: Record<string, (...a: unknown[]) => void>) => {
        options.onDeliverySettled?.(true)
        return { cancel: () => {}, settleAfterMs: 0, settled: Promise.resolve() }
      }
    )
    await expect(submitCodex('/model')).resolves.toBe(true)
  })
})
