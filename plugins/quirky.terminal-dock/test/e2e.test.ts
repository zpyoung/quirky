import { afterEach, expect, test } from 'bun:test'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, launchFakeClaude, paneOf, startDockE2E, waitForTuiInput, type DockHarness } from './support'

let harness: DockHarness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

test(
  'SC-20/22: daemon crash restores queued snapshots before newer text and never replays PTY bytes',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    const active = harness.call('quirky.terminal-dock/send', { pane, id: 'crash-active', text: 'first prompt' }) as Promise<SendResult>
    const queued = harness.call('quirky.terminal-dock/send', { pane, id: 'crash-queued', text: 'second prompt' }) as Promise<SendResult>
    void active.catch(() => undefined)
    void queued.catch(() => undefined)
    await waitForTuiInput(harness, (input) => input.indexOf(Buffer.from('first prompt')) >= 0)

    const beforeDraft = (await harness.call('quirky.terminal-dock/get', { pane })) as DockState
    await harness.call('quirky.terminal-dock/set', {
      pane,
      revision: beforeDraft.revision,
      draft: 'newer draft'
    })

    await harness.stopDaemon('SIGKILL')
    await harness.startDaemon()
    const recovered = (await harness.call('quirky.terminal-dock/get', { pane })) as DockState
    expect(recovered.draft).toBe('first prompt\n\nsecond prompt\n\nnewer draft')
    expect(recovered.notice).toContain('Check the terminal before retrying')

    // Exercise the real PTY/send delay after restart; advancing a fake clock would not detect a stray write.
    await Bun.sleep(650)
    const input = inputBytes(harness)
    expect(input.indexOf(Buffer.from('first prompt'))).toBe(input.lastIndexOf(Buffer.from('first prompt')))
    expect(input.indexOf(Buffer.from('second prompt'))).toBe(-1)
    expect(input.subarray(input.indexOf(Buffer.from('first prompt')) + Buffer.byteLength('first prompt')).includes(0x0d)).toBe(false)

  },
  90_000
)
