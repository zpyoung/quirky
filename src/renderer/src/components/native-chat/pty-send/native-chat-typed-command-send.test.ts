import { beforeEach, describe, expect, it, vi } from 'vitest'

type QueuedRun = (controls: {
  isCancelled: () => boolean
  delay: (ms: number, fn: () => void) => void
  markSubmitted: () => void
}) => void
type QueueOptions = { onCancelUnsubmitted?: (delay: never) => unknown; onInvalidate?: () => void }

const queued: { run: QueuedRun; options: QueueOptions }[] = []
const typeAgentTuiCommand = vi.fn()
const quarantined = vi.fn(() => false)

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: vi.fn(async () => true)
}))
vi.mock('../../../../../shared/agent-tui-command-typing', () => ({
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS: 1,
  typeAgentTuiCommand: (...args: unknown[]) => typeAgentTuiCommand(...args)
}))
vi.mock('../../terminal-pane/terminal-input-quarantine', () => ({
  isTerminalInputQuarantined: () => quarantined(),
  subscribeTerminalInputQuarantine: () => () => {}
}))
vi.mock('../native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: vi.fn(),
  waitForNativeChatPtyIdle: vi.fn(async () => {}),
  enqueueNativeChatPtySend: (_pty: string, _ms: number, run: QueuedRun, options: QueueOptions) => {
    queued.push({ run, options })
    return { cancel: () => {}, settleAfterMs: 0 }
  }
}))
vi.mock('./native-chat-runtime-clear', () => ({
  clearUnsubmittedAgentInput: vi.fn(async () => {})
}))

import { sendNativeChatTypedCommand } from './native-chat-typed-command-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'

const TARGET: NativeChatResolvedTarget = { ptyId: 'pty-1', terminalTabId: 'tab-1' }

function callbacks() {
  return {
    onWriteRejected: vi.fn(),
    onWriteUnconfirmed: vi.fn(),
    onDeliverySettled: vi.fn(),
    onOutcome: vi.fn()
  }
}

async function runQueued(cancelled = false): Promise<void> {
  const markSubmitted = vi.fn()
  queued[0]?.run({ isCancelled: () => cancelled, delay: () => {}, markSubmitted })
  await vi.waitFor(() => expect(markSubmitted).toHaveBeenCalled())
}

describe('sendNativeChatTypedCommand delivery reporting', () => {
  beforeEach(() => {
    queued.length = 0
    typeAgentTuiCommand.mockReset()
    quarantined.mockReturnValue(false)
  })

  it('reports an accepted command as delivered', async () => {
    typeAgentTuiCommand.mockResolvedValue('accepted')
    const options = callbacks()
    sendNativeChatTypedCommand(TARGET, '/model', options)
    await runQueued()
    expect(options.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(true)
    expect(options.onOutcome).toHaveBeenCalledExactlyOnceWith('unobservable')
    expect(options.onWriteRejected).not.toHaveBeenCalled()
  })

  it('reports a refused write so the caller keeps its draft', async () => {
    typeAgentTuiCommand.mockResolvedValue('rejected')
    const options = callbacks()
    sendNativeChatTypedCommand(TARGET, '/model', options)
    await runQueued()
    expect(options.onWriteRejected).toHaveBeenCalledOnce()
    expect(options.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
    expect(options.onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports a cancelled command once, without claiming a refusal', async () => {
    typeAgentTuiCommand.mockResolvedValue('rejected')
    const options = callbacks()
    sendNativeChatTypedCommand(TARGET, '/model', options)
    queued[0]?.options.onInvalidate?.()
    await runQueued(true)
    expect(options.onWriteRejected).not.toHaveBeenCalled()
    expect(options.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
    expect(options.onOutcome).toHaveBeenCalledExactlyOnceWith('may-not-have-sent')
  })

  it('reports a quarantined target as refused without queueing', () => {
    quarantined.mockReturnValue(true)
    const options = callbacks()
    sendNativeChatTypedCommand(TARGET, '/model', options)
    expect(queued).toHaveLength(0)
    expect(options.onWriteRejected).toHaveBeenCalledOnce()
    expect(options.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('still sends with no options', async () => {
    typeAgentTuiCommand.mockResolvedValue('accepted')
    sendNativeChatTypedCommand(TARGET, '/model')
    await runQueued()
  })
})
