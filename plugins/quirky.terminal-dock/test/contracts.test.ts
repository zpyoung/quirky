import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import type { DockState, SendResult } from '../src/types'
import { enableDock, launchFakeClaude, paneOf, startDockE2E, waitForTuiInput, type DockHarness } from './support'
import { waitFor } from '../../quirky.terminal/test/e2e-support'

let harness: DockHarness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

type DockManifest = {
  contributes: {
    method: { id: string; result?: Schema }[]
    event: { id: string; data?: Schema }[]
  }
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'quirky-plugin.json'), 'utf8')) as DockManifest

function resultSchema(id: string): Schema {
  const result = manifest.contributes.method.find((method) => method.id === id)?.result
  if (!result) throw new Error(`missing result schema for ${id}`)
  return result
}

function eventDataSchema(id: string): Schema {
  const data = manifest.contributes.event.find((event) => event.id === id)?.data
  if (!data) throw new Error(`missing event data schema for ${id}`)
  return data
}

function expectValid(schema: Schema, value: unknown): void {
  expect(validateValue(schema, value)).toBeNull()
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test(
  'published result and event schemas accept actual populated dock state objects',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    await harness.connect()
    const initial = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expectValid(resultSchema('get'), initial)

    const file = join(harness.repo, 'contract-attachment.txt')
    writeFileSync(file, 'real attachment data\n')
    const attached = await harness.call<DockState>('quirky.terminal-dock/attach', { pane, path: file })
    expect(attached.attachments).toHaveLength(1)
    expectValid(resultSchema('attach'), attached)

    const changed = await waitFor('dock changed event with the attached file', () =>
      harness!.events.find((event) => {
        if (event.type !== 'quirky.terminal-dock/changed' || !('data' in event) || !record(event.data)) return false
        const state = event.data.state
        return event.data.pane === pane && record(state) && Array.isArray(state.attachments) && state.attachments.length === 1
      })
    )
    if (!('data' in changed)) throw new Error('dock changed event has no data')
    expectValid(eventDataSchema('changed'), changed.data)

    const updated = await harness.call<DockState>('quirky.terminal-dock/set', {
      pane,
      revision: attached.revision,
      draft: 'schema-backed draft'
    })
    expectValid(resultSchema('set'), updated)
    expectValid(resultSchema('options'), await harness.call<DockState>('quirky.terminal-dock/options', { pane }))
    expectValid(resultSchema('list'), await harness.call('quirky.terminal-dock/list'))
    expectValid(resultSchema('history'), await harness.call('quirky.terminal-dock/history', { pane }))

    const active = harness.call<SendResult>('quirky.terminal-dock/send', { pane, id: 'schema-active', text: 'active schema prompt' })
    const queued = harness.call<SendResult>('quirky.terminal-dock/send', { pane, id: 'schema-queued', text: 'queued schema prompt' })
    void active.catch(() => undefined)
    void queued.catch(() => undefined)
    await waitForTuiInput(harness, (input) => input.includes(Buffer.from('active schema prompt')))
    const queuedState = await harness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(queuedState.activeSend).toMatchObject({ id: 'schema-active' })
    expect(queuedState.queuedSends).toContainEqual(expect.objectContaining({ id: 'schema-queued' }))
    expectValid(resultSchema('get'), queuedState)
    expectValid(resultSchema('list'), await harness.call('quirky.terminal-dock/list'))
  },
  90_000
)
