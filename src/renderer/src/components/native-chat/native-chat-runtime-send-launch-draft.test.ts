// Send-path behaviour when a launch-context draft is still parked on the agent's
// TUI input line: the multi-line clear and its confirmation step.

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
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage,
  sendNativeChatMessageWithImageAttachments
} from './native-chat-runtime-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  NATIVE_CHAT_CLEAR_CHUNK_GAP_MS,
  NATIVE_CHAT_CLEAR_CHUNK_MAX_BYTES,
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
} from './pty-send/native-chat-runtime-clear'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  AGENT_TUI_CLEAR_INPUT_MAX,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-tui-input-clear'

const TAB = 'tab-launch-draft'
const PTY = 'pty-launch-draft'
const TARGET: NativeChatResolvedTarget = {
  terminalTabId: TAB,
  ptyId: PTY
}
const DRAFT = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

// Clear writes go through the fire-and-forget transport; body and Enter go
// through the acceptance-aware one — merge both mocks' calls by global
// invocation order to assert on the pty write sequence as a whole.
const writes = (): string[] => {
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

// Clear bursts reach the pty in paced chunks, so compare them by concatenation.
const clearBytesBefore = (bytes: string): string => {
  const order = writes()
  return order.slice(0, order.indexOf(bytes)).join('')
}
const MAX_CLEAR_PACING_MS =
  Math.ceil(AGENT_TUI_CLEAR_INPUT_MAX.length / NATIVE_CHAT_CLEAR_CHUNK_MAX_BYTES) *
  NATIVE_CHAT_CLEAR_CHUNK_GAP_MS

beforeEach(() => {
  vi.useFakeTimers()
  sendRuntimePtyInput.mockClear()
  sendRuntimePtyInput.mockReturnValue(true)
  sendRuntimePtyInputAcceptance.mockClear()
  sendRuntimePtyInputAcceptance.mockResolvedValue(true)
  resetNativeChatPtySendQueuesForTests()
})
afterEach(() => {
  vi.useRealTimers()
  resetNativeChatPtySendQueuesForTests()
})

describe('sendNativeChatMessage with a parked multi-line draft', () => {
  it('leads with a clear sized to every line of the draft, not one Ctrl+U', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(TARGET, 'edited text', { clearInput })
    await vi.advanceTimersByTimeAsync(MAX_CLEAR_PACING_MS)
    expect(clearBytesBefore(buildNativeChatPasteBytes('edited text'))).toBe(clearInput)
    expect(writes().at(-1)).toBe(buildNativeChatPasteBytes('edited text'))
    expect(clearInput).not.toBe(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
  })

  it('still defaults to a single Ctrl+U when no draft is parked', () => {
    sendNativeChatMessage(TARGET, 'plain')
    expect(writes()[0]).toBe(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
  })

  it('holds the body until the clear is confirmed, then submits after the gap', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(TARGET, 'edited', {
      clearInput,
      confirmCleared: () => true
    })
    // Body must NOT ride out with the clear — the confirm happens in between.
    await vi.advanceTimersByTimeAsync(MAX_CLEAR_PACING_MS)
    expect(writes().join('')).toBe(clearInput)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_CLEAR_CONFIRM_MS)
    expect(clearBytesBefore(buildNativeChatPasteBytes('edited'))).toBe(clearInput)
    expect(writes().at(-1)).toBe(buildNativeChatPasteBytes('edited'))
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(writes().slice(-2)).toEqual([buildNativeChatPasteBytes('edited'), NATIVE_CHAT_SUBMIT])
  })

  it('preserves the body-to-Enter gap when the renderer stalls past both nominal deadlines', async () => {
    vi.useRealTimers()
    const writeTimes = new Map<string, number>()
    sendRuntimePtyInput.mockImplementation((_pty, bytes: string) => {
      writeTimes.set(bytes, performance.now())
      return true
    })
    sendRuntimePtyInputAcceptance.mockImplementation(async (_pty, bytes: string) => {
      writeTimes.set(bytes, performance.now())
      return true
    })
    sendNativeChatMessage(TARGET, 'edited', {
      clearInput: buildAgentTuiClearInputForText(DRAFT),
      confirmCleared: () => true
    })
    sendNativeChatMessage(TARGET, 'queued')

    const blockedUntil =
      performance.now() + NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS + 50
    while (performance.now() < blockedUntil) {
      // Simulate a renderer long task delaying both nominal deadlines.
    }

    await vi.waitFor(() => expect(writeTimes.has(NATIVE_CHAT_SUBMIT)).toBe(true), {
      timeout: NATIVE_CHAT_SUBMIT_DELAY_MS + 1_000
    })
    await vi.waitFor(() => expect(writeTimes.has(buildNativeChatPasteBytes('queued'))).toBe(true))
    expect(
      writeTimes.get(NATIVE_CHAT_SUBMIT)! - writeTimes.get(buildNativeChatPasteBytes('edited'))!
    ).toBeGreaterThanOrEqual(NATIVE_CHAT_SUBMIT_DELAY_MS - 20)
    expect(writes().indexOf(NATIVE_CHAT_SUBMIT)).toBeLessThan(
      writes().indexOf(buildNativeChatPasteBytes('queued'))
    )
  })

  it('widens to a maximal burst when the draft is still observed on the line', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(TARGET, 'edited', {
      clearInput,
      confirmCleared: () => false
    })
    await vi.advanceTimersByTimeAsync(
      MAX_CLEAR_PACING_MS + NATIVE_CHAT_CLEAR_CONFIRM_MS + MAX_CLEAR_PACING_MS
    )
    expect(clearBytesBefore(buildNativeChatPasteBytes('edited'))).toBe(
      clearInput + AGENT_TUI_CLEAR_INPUT_MAX
    )
    expect(writes().at(-1)).toBe(buildNativeChatPasteBytes('edited'))
  })

  it('re-clears before the body, never after it', async () => {
    sendNativeChatMessage(TARGET, 'edited', {
      clearInput: buildAgentTuiClearInputForText(DRAFT),
      confirmCleared: () => false
    })
    await vi.advanceTimersByTimeAsync(
      2 * MAX_CLEAR_PACING_MS + NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )
    const order = writes()
    const bodyIndex = order.indexOf(buildNativeChatPasteBytes('edited'))
    expect(order.slice(0, bodyIndex).join('')).toContain(AGENT_TUI_CLEAR_INPUT_MAX)
    expect(order.slice(bodyIndex + 1)).toEqual([NATIVE_CHAT_SUBMIT])
  })

  it('charges the confirm gap to the handle so the send card outlives the Enter', () => {
    const withConfirm = sendNativeChatMessage(TARGET, 'a', {
      clearInput: '\x15',
      confirmCleared: () => true
    })
    expect(withConfirm.settleAfterMs).toBe(
      NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_CLEAR_CONFIRM_MS
    )
  })

  it('submits before a queued send starts after clear confirmation', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(TARGET, 'first', {
      clearInput,
      confirmCleared: () => true
    })
    sendNativeChatMessage(TARGET, 'second')

    await vi.advanceTimersByTimeAsync(
      2 * MAX_CLEAR_PACING_MS + NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    expect(clearBytesBefore(buildNativeChatPasteBytes('first'))).toBe(clearInput)
    const order = writes()
    expect(order.slice(order.indexOf(buildNativeChatPasteBytes('first')))).toEqual([
      buildNativeChatPasteBytes('first'),
      NATIVE_CHAT_SUBMIT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('second')
    ])
  })
})

describe('image sends with a parked multi-line draft', () => {
  it('clears every draft line before pasting, so no line rides along with the image', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(TARGET, 'caption', ['/tmp/a.png'], {
      clearInput
    })
    await vi.advanceTimersByTimeAsync(MAX_CLEAR_PACING_MS)
    expect(clearBytesBefore(buildNativeChatImagePasteBytes('/tmp/a.png'))).toBe(clearInput)
  })

  it('clears exactly once — a second Ctrl+U would wipe the just-pasted image', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(TARGET, 'caption', ['/tmp/a.png'], {
      clearInput
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const ctrlUCount = (bytes: string): number =>
      bytes.split(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT).length - 1
    expect(ctrlUCount(writes().join(''))).toBe(ctrlUCount(clearInput))
  })

  it('submits the image send before a queued message starts', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(TARGET, 'caption', ['/tmp/a.png'], {
      clearInput,
      confirmCleared: () => true
    })
    sendNativeChatMessage(TARGET, 'second')

    await vi.advanceTimersByTimeAsync(
      2 * MAX_CLEAR_PACING_MS +
        NATIVE_CHAT_CLEAR_CONFIRM_MS +
        NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS +
        NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    expect(writes().indexOf(NATIVE_CHAT_SUBMIT)).toBeLessThan(
      writes().indexOf(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
    )
  })
})
