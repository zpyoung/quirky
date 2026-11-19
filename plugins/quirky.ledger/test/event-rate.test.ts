import { afterEach, expect, test } from 'bun:test'
import type { ApiDescription, PluginEvent, PluginInfo, QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { startLedgerHarness, workspaceTarget, type LedgerHarness } from './harness'

type EventWatcher = { client: QuirkyClient; events: QuirkyEvent[] }

let harness: LedgerHarness | undefined
let watcher: EventWatcher | undefined

afterEach(async () => {
  const currentWatcher = watcher
  const currentHarness = harness
  watcher = undefined
  harness = undefined
  try {
    currentWatcher?.client.close()
  } finally {
    await currentHarness?.cleanup()
  }
})

test('bounds changed events while filing a burst of ledger entries', async () => {
  const currentHarness = (harness = await startLedgerHarness())
  watcher = await currentHarness.plugins.h.connectWithEvents('ui')
  const { events } = watcher

  await Bun.sleep(600)
  const mark = events.filter((event) => event.type === 'quirky.ledger/changed').length
  const started = performance.now()
  let ledgerId: string | undefined

  for (let index = 0; index < 36; index++) {
    const response = await currentHarness.request({
      operation: 'file',
      target: workspaceTarget(currentHarness.project),
      type: 'deferred',
      content: { title: `rate ${index}`, why_deferred: 'Blocked on a dependency.', priority: 'medium' }
    })
    ledgerId = response.ledger?.ledgerId
  }

  await Bun.sleep(600)
  const elapsed = performance.now() - started
  const changed = events.filter((event): event is PluginEvent => event.type === 'quirky.ledger/changed').slice(mark)
  const limit = 3 + Math.floor(elapsed / 250)
  console.info('quirky.ledger/changed burst', { events: changed.length, elapsedMs: elapsed, limit })

  expect(changed.length).toBeGreaterThanOrEqual(2)
  expect(changed.length).toBeLessThanOrEqual(limit)
  if (ledgerId === undefined) throw new Error('final file response did not include a ledgerId')
  expect(changed.at(-1)?.data).toEqual({ ledgerId })

  const listed = await currentHarness.operation('list', { target: workspaceTarget(currentHarness.project) })
  expect(listed.entries).toHaveLength(36)
}, 30_000)

test('catalogs changed as the sole per-ledger coalesced event', async () => {
  const currentHarness = (harness = await startLedgerHarness())
  const description = (await currentHarness.client.callAny('api.describe', {})) as ApiDescription
  const ledgerEvents = description.events.filter((event) => event.plugin === 'quirky.ledger')

  expect(ledgerEvents).toHaveLength(1)
  expect(ledgerEvents[0]?.name).toBe('quirky.ledger/changed')
  expect(ledgerEvents[0]?.coalesce).toEqual(['ledgerId'])
  expect(ledgerEvents[0]).not.toHaveProperty('worktree')

  const plugins = (await currentHarness.client.callAny('plugin.list', {})) as PluginInfo[]
  expect(plugins.find((plugin) => plugin.id === 'quirky.ledger')?.apiVersion).toBe('1.3.0')
})
