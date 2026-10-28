import { afterEach, expect, test } from 'bun:test'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, launchFakeClaude, paneOf, startDockE2E, waitForDockBeforeEnter, waitForTuiInput, type DockHarness, type DockSubmitWait } from './support'

let harness: DockHarness | undefined
let beforeEnter: DockSubmitWait | undefined
afterEach(async () => {
  beforeEnter?.dispose()
  beforeEnter = undefined
  await harness?.cleanup()
  harness = undefined
})

test(
  'SC-18: same-terminal sends serialize complete clear/body/submit protocols through the real PTY',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    const one = harness.call('quirky.terminal-dock/send', { pane, id: 'dock-one', text: 'one' }) as Promise<SendResult>
    const two = harness.call('quirky.terminal-dock/send', { pane, id: 'dock-two', text: 'two\nlines' }) as Promise<SendResult>
    const consumed = await waitForTuiInput(harness, (input) => input.indexOf(Buffer.from('one')) >= 0 && input.indexOf(Buffer.from('two')) >= 0)
    const firstBody = consumed.indexOf(Buffer.from('one'))
    const secondBody = consumed.indexOf(Buffer.from('two'))
    expect(firstBody).toBeGreaterThanOrEqual(0)
    expect(secondBody).toBeGreaterThan(firstBody)
    expect(consumed.includes(Buffer.from('two\rlines'))).toBe(true)

    const [first, second] = await Promise.all([one, two])
    expect(first.id).toBe('dock-one')
    expect(second.id).toBe('dock-two')
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(true)

    const state = (await harness.call('quirky.terminal-dock/get', { pane })) as DockState
    const history = (await harness.call('quirky.terminal-dock/history', { pane })) as { entries: string[]; state: DockState }
    expect(history.entries).toContain('one')
    expect(history.entries).toContain('two\nlines')
    expect(state.queuedSends).toEqual([])
  },
  90_000
)

test(
  'SC-21: cancelling one queued send never writes it, and cancelling the current send suppresses delayed Enter',
  async () => {
    harness = await startDockE2E({ holdBeforeEnter: true })
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const beforeEnterWait = waitForDockBeforeEnter(harness)
    beforeEnter = beforeEnterWait

    const first = harness.call('quirky.terminal-dock/send', { pane, id: 'current', text: 'first-body' }) as Promise<SendResult>
    const queued = harness.call('quirky.terminal-dock/send', { pane, id: 'queued', text: 'never-write' }) as Promise<SendResult>
    await waitForTuiInput(harness, (input) => input.indexOf(Buffer.from('first-body')) >= 0)
    await beforeEnterWait.reached

    await harness.call('quirky.terminal-dock/cancel', { pane, send: 'queued' })
    await harness.call('quirky.terminal-dock/cancel', { pane, send: 'current' })
    const [currentResult, queuedResult] = await Promise.all([first, queued])
    expect(currentResult.outcome).toBe('cancelled')
    expect(currentResult.accepted).toBe(true)
    expect(queuedResult.outcome).toBe('cancelled')
    expect(queuedResult.accepted).toBe(false)

    const consumed = await Bun.file(`${harness.home}/dock-pty-input.bin`).bytes()
    const bodyEnd = Buffer.from(consumed).indexOf(Buffer.from('first-body')) + Buffer.byteLength('first-body')
    expect(Buffer.from(consumed).indexOf(Buffer.from('never-write'))).toBe(-1)
    expect(Buffer.from(consumed).subarray(bodyEnd).includes(0x0d)).toBe(false)
  },
  90_000
)
test(
  'SC-08: disabling the feature suppresses a pending Enter and preserves the recoverable prompt',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    const pending = harness.call('quirky.terminal-dock/send', {
      pane,
      id: 'disabled-before-enter',
      text: 'survive the kill switch'
    }) as Promise<SendResult>
    await waitForTuiInput(harness, (input) => input.indexOf(Buffer.from('survive the kill switch')) >= 0)
    await harness.call('setting.set', { id: 'setting:quirky.terminal-dock/enabled', value: false })
    const result = await pending
    expect(result).toMatchObject({ outcome: 'cancelled', accepted: true })
    const stoppedInput = inputBytes(harness)
    const bodyEnd = stoppedInput.indexOf(Buffer.from('survive the kill switch')) + Buffer.byteLength('survive the kill switch')
    expect(stoppedInput.subarray(bodyEnd).includes(0x0d)).toBe(false)

    await harness.call('setting.set', { id: 'setting:quirky.terminal-dock/enabled', value: true })
    const restored = (await harness.call('quirky.terminal-dock/get', { pane })) as DockState
    expect(restored.draft).toBe('survive the kill switch')
    expect(inputBytes(harness)).toEqual(stoppedInput)
  },
  90_000
)
