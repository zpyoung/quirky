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
    const consumed = await waitForTuiInput(harness, (input) => {
      const firstBody = input.indexOf(Buffer.from('one'))
      const firstSubmit = input.indexOf(0x0d, firstBody + Buffer.byteLength('one'))
      const secondBody = input.indexOf(Buffer.from('two\rlines'))
      const secondSubmit = input.indexOf(0x0d, secondBody + Buffer.byteLength('two\rlines'))
      return firstBody >= 0 && firstSubmit >= 0 && secondBody >= 0 && secondSubmit >= 0
    })
    const firstBody = consumed.indexOf(Buffer.from('one'))
    const firstBodyEnd = firstBody + Buffer.byteLength('one')
    const firstSubmit = consumed.indexOf(0x0d, firstBodyEnd)
    const secondBody = consumed.indexOf(Buffer.from('two\rlines'))
    const secondBodyEnd = secondBody + Buffer.byteLength('two\rlines')
    const secondSubmit = consumed.indexOf(0x0d, secondBodyEnd)
    expect(firstBody).toBeGreaterThanOrEqual(0)
    expect(firstSubmit).toBeGreaterThanOrEqual(firstBodyEnd)
    expect(secondBody).toBeGreaterThan(firstSubmit)
    expect(secondSubmit).toBeGreaterThanOrEqual(secondBodyEnd)
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
  'SC-21: cancelling queued and current sends suppresses delayed Enter and recovers accepted text ahead of newer drafts',
  async () => {
    harness = await startDockE2E({ holdBeforeEnter: true })
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const initial = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    const staged = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: initial.revision,
      draft: 'first-body'
    })
    const beforeEnterWait = waitForDockBeforeEnter(harness)
    beforeEnter = beforeEnterWait

    const first = harness.call('quirky.terminal-dock/send', {
      pane,
      id: 'current',
      revision: staged.revision
    }) as Promise<SendResult>
    const queued = harness.call('quirky.terminal-dock/send', { pane, id: 'queued', text: 'never-write' }) as Promise<SendResult>
    await waitForTuiInput(harness, (input) => input.indexOf(Buffer.from('first-body')) >= 0)
    await beforeEnterWait.reached
    const sending = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    await harness.call('quirky.terminal-dock/set', {
      pane,
      revision: sending.revision,
      draft: 'newer draft'
    })

    await harness.call('quirky.terminal-dock/cancel', { pane, send: 'queued' })
    await harness.call('quirky.terminal-dock/cancel', { pane, send: 'current' })
    const [currentResult, queuedResult] = await Promise.all([first, queued])
    expect(currentResult.outcome).toBe('cancelled')
    expect(currentResult.accepted).toBe(true)
    expect(queuedResult.outcome).toBe('cancelled')
    expect(queuedResult.accepted).toBe(false)

    const recovered = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(recovered.draft).toBe('first-body\n\nnever-write\n\nnewer draft')
    expect(recovered.notice).toContain('Check the terminal before retrying')
    const consumed = await Bun.file(`${harness.home}/dock-pty-input.bin`).bytes()
    const bodyEnd = Buffer.from(consumed).indexOf(Buffer.from('first-body')) + Buffer.byteLength('first-body')
    expect(Buffer.from(consumed).indexOf(Buffer.from('never-write'))).toBe(-1)
    expect(Buffer.from(consumed).subarray(bodyEnd).includes(0x0d)).toBe(false)
  },
  90_000
)

test(
  'SC-08: disabling during delayed Enter preserves manual-close and auto-open preferences',
  async () => {
    harness = await startDockE2E()
    await harness.call('setting.set', { id: 'setting:quirky.terminal-dock/autoOpen', value: false })
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const initiallyClosed = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(initiallyClosed).toMatchObject({ supported: true, docked: false, userUndocked: false })
    const manuallyOpened = await harness.call<DockState>('quirky.terminal-dock/set', { pane, docked: true })
    await harness.call('quirky.terminal-dock/set', { pane, docked: false })
    expect(manuallyOpened.userUndocked).toBe(false)

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
    const restored = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(restored).toMatchObject({
      draft: 'survive the kill switch',
      docked: false,
      userUndocked: true
    })
    expect(inputBytes(harness)).toEqual(stoppedInput)

    const next = await launchFakeClaude(harness)
    const nextPane = await paneOf(harness, next.id)
    expect(await harness.call<DockState>('quirky.terminal-dock/get', { pane: nextPane }))
      .toMatchObject({ supported: true, docked: false, userUndocked: false })
  },
  90_000
)

test(
  'SC-09/18: literal Escape becomes visible text while an idle interrupt writes one raw Escape byte',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const submitted = harness.call('quirky.terminal-dock/send', {
      pane,
      id: 'visible-escape',
      text: 'literal \u001b[31m text'
    }) as Promise<SendResult>
    const safeBody = Buffer.from('literal ␛[31m text')
    const consumed = await waitForTuiInput(harness, (input) => input.includes(safeBody))
    await submitted
    expect(consumed.includes(Buffer.from([0x1b]))).toBe(false)
    expect(consumed.indexOf(safeBody)).toBe(consumed.lastIndexOf(safeBody))

    const beforeInterrupt = inputBytes(harness)
    await harness.call('quirky.terminal-dock/cancel', { pane, interrupt: true })
    expect(inputBytes(harness).subarray(beforeInterrupt.length)).toEqual(Buffer.from([0x1b]))
  },
  90_000
)
