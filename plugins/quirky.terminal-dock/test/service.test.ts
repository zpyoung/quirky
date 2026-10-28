import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, launchFakeClaude, launchShell, paneOf, startDockE2E, connectUi, waitForTuiInput, type DockHarness } from './support'

let harness: DockHarness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const get = (pane: string) => harness!.call('quirky.terminal-dock/get', { pane }) as Promise<DockState>

test(
  'SC-01/02/22: auto-open is per recognized pane and revisioned empty clears cannot erase newer drafts',
  async () => {
    harness = await startDockE2E()
    const first = await launchFakeClaude(harness)
    const firstPane = await paneOf(harness, first.id)
    await enableDock(harness)

    const opened = await get(firstPane)
    expect(opened.supported).toBe(true)
    expect(opened.agent).toBe('claude')
    expect(opened.docked).toBe(true)

    const edited = (await harness.call('quirky.terminal-dock/set', {
      pane: firstPane,
      revision: opened.revision,
      draft: 'review this'
    })) as DockState
    expect(edited.draft).toBe('review this')
    expect(edited.revision).toBeGreaterThan(opened.revision)

    let conflict = ''
    try {
      await harness.call('quirky.terminal-dock/set', {
        pane: firstPane,
        revision: opened.revision,
        draft: ''
      })
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error)
    }
    expect(conflict).toContain('revision')
    expect(conflict).toContain('review this')
    expect((await get(firstPane)).draft).toBe('review this')

    await harness.call('setting.set', { id: 'setting:quirky.terminal-dock/autoOpen', value: false })
    const second = await launchFakeClaude(harness)
    const secondPane = await paneOf(harness, second.id)
    expect((await get(firstPane)).docked).toBe(true)
    expect((await get(secondPane)).docked).toBe(false)

    const shell = await launchShell(harness)
    const shellPane = await paneOf(harness, shell.id)
    const shellState = await get(shellPane)
    expect(shellState.supported).toBe(false)
    expect(shellState.docked).toBe(false)
  },
  90_000
)

test(
  'SC-02: a remembered manual close survives daemon restart and reconciliation',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const opened = await get(pane)
    const closed = (await harness.call('quirky.terminal-dock/set', {
      pane,
      docked: false
    })) as DockState
    expect(closed.docked).toBe(false)
    expect(closed.userUndocked).toBe(true)

    await harness.stopDaemon('SIGTERM')
    await harness.startDaemon()
    const restored = await get(pane)
    expect(restored.docked).toBe(false)
    expect(restored.userUndocked).toBe(true)
    expect(restored.draft).toBe(opened.draft)
  },
  90_000
)
test(
  'SC-12/17/23: public picker, readable attachment, send path, report, driver, option and interaction APIs use canonical pane state',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)
    const file = join(harness.repo, 'dock-visible.txt')
    const sourceBytes = Buffer.from('a real workspace attachment\n')
    writeFileSync(file, sourceBytes)
    const secondFile = join(harness.repo, 'dock-visible-second.txt')
    const secondSourceBytes = Buffer.from('a second real workspace attachment\n')
    writeFileSync(secondFile, secondSourceBytes)
    const initial = await get(pane)
    const drafted = (await harness.call('quirky.terminal-dock/set', {
      pane,
      revision: initial.revision,
      draft: 'explain this'
    })) as DockState

    const attached = (await harness.call('quirky.terminal-dock/attach', { pane, path: file })) as DockState
    const chip = attached.attachments[0]
    if (!chip) throw new Error('the real file was not attached')
    expect(readFileSync(chip.path)).toEqual(sourceBytes)
    expect(attached.draft).toBe(drafted.draft)
    const attachedSecond = (await harness.call('quirky.terminal-dock/attach', { pane, path: secondFile })) as DockState
    const secondChip = attachedSecond.attachments.find((item) => item.id !== chip.id)
    if (!secondChip) throw new Error('the second real file was not attached')

    await expect(harness.call('quirky.terminal-dock/attach', {
      pane,
      path: 'C:\\fakepath\\missing.png'
    })).rejects.toThrow('readable regular file')
    const afterRefusal = await get(pane)
    expect(afterRefusal.draft).toBe(drafted.draft)
    expect(afterRefusal.attachments.map((attachment) => attachment.id)).toEqual([chip.id, secondChip.id])

    const removed = (await harness.call('quirky.terminal-dock/removeAttachment', {
      pane,
      attachment: chip.id
    })) as DockState
    expect(removed.attachments.map((attachment) => attachment.id)).toEqual([secondChip.id])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(secondFile)).toBe(true)
    expect(readFileSync(file)).toEqual(sourceBytes)
    expect(readFileSync(secondFile)).toEqual(secondSourceBytes)

    const removedSecond = (await harness.call('quirky.terminal-dock/removeAttachment', {
      pane,
      attachment: secondChip.id
    })) as DockState
    expect(removedSecond.attachments).toHaveLength(0)
    expect(existsSync(secondFile)).toBe(true)
    const sendAttachments = (await harness.call('quirky.terminal-dock/attach', { pane, path: file })) as DockState
    const sendChip = sendAttachments.attachments[0]
    if (!sendChip) throw new Error('the send attachment was not attached')
    expect(readFileSync(sendChip.path)).toEqual(sourceBytes)
    expect(sendAttachments.draft).toBe(drafted.draft)
    const send = harness.call('quirky.terminal-dock/send', { pane, revision: sendAttachments.revision }) as Promise<SendResult>
    const consumed = await waitForTuiInput(harness, (input) =>
      input.includes(Buffer.from(`@${JSON.stringify(sendChip.path)}`))
    )
    expect(consumed.toString()).toContain(`@${JSON.stringify(sendChip.path)}`)
    expect(consumed.toString()).toContain('explain this')
    expect((await send).accepted).toBe(true)
    const picker = (await harness.call('quirky.terminal-dock/pick', {
      pane,
      kind: 'file',
      query: 'dock-visible'
    })) as { items: { label: string }[]; truncated: boolean }
    expect(picker.items.some((item) => item.label.includes('dock-visible.txt'))).toBe(true)

    const ui = await connectUi(harness)
    try {
      const mounted = (await ui.callAny('quirky.terminal-dock/report', {
        pane,
        mounted: true,
        focused: true,
        transport: 'connected'
      })) as DockState
      expect(mounted.mounted).toBe(true)

      const beforeForeignSend = inputBytes(harness).length
      const held = (await harness.call('quirky.terminal-dock/driver', {
        pane,
        owner: 'mobile-client',
        ttlMs: 30_000
      })) as DockState
      expect(held.disabledReason).toBe('Mobile device is composing')
      const refused = (await harness.call('quirky.terminal-dock/send', {
        pane,
        id: 'foreign-driver-refusal',
        text: 'must remain on the draft'
      })) as { outcome: string; accepted: boolean; reason?: string }
      expect(refused).toMatchObject({ outcome: 'refused', accepted: false, reason: 'Mobile device is composing' })
      expect(inputBytes(harness).length).toBe(beforeForeignSend)

      const released = (await harness.call('quirky.terminal-dock/driver', { pane })) as DockState
      expect(released.disabledReason).not.toBe('Mobile device is composing')
      const options = (await harness.call('quirky.terminal-dock/options', { pane })) as DockState
      expect(Array.isArray(options.options.choices.model)).toBe(true)

      let stale = ''
      try {
        await harness.call('quirky.terminal-dock/interaction', {
          pane,
          request: 'no-longer-pending',
          action: 'answer',
          answers: []
        })
      } catch (error) {
        stale = error instanceof Error ? error.message : String(error)
      }
      expect(stale).toContain('stale')

      const unmounted = (await ui.callAny('quirky.terminal-dock/report', {
        pane,
        mounted: false,
        focused: true,
        transport: 'connected'
      })) as DockState
      expect(unmounted.mounted).toBe(false)
    } finally {
      ui.close()
    }
  },
  90_000
)
