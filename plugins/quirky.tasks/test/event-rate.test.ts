import { afterEach, expect, test } from 'bun:test'
import type { ApiDescription, PluginEvent, PluginInfo, QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { bootTasks, type TasksTest } from './helpers'
import { listFixtureSource } from './fixtures/list'

type EventWatcher = { client: QuirkyClient; events: QuirkyEvent[] }

let host: TasksTest | undefined
let watcher: EventWatcher | undefined

afterEach(async () => {
  const currentWatcher = watcher
  const currentHost = host
  watcher = undefined
  host = undefined
  try {
    currentWatcher?.client.close()
  } finally {
    await currentHost?.cleanup()
  }
})

test('bounds changed events while navigating through Tasks pages', async () => {
  const currentHost = (host = await bootTasks(listFixtureSource))
  const client = await currentHost.connect('ui')
  const events: QuirkyEvent[] = []
  watcher = { client, events }
  client.onEvent((event) => events.push(event))
  await client.call('events.subscribe', {})
  // real waits exercise the daemon's 250 ms coalescing window and event delivery.

  await Bun.sleep(600)
  const mark = events.filter((event) => event.type === 'quirky.tasks/changed').length
  const before = await client.callAny('quirky.tasks/state', {}) as { revision: number }
  const started = performance.now()

  for (let page = 1; page <= 20; page++) {
    await client.callAny('quirky.tasks/navigate', { page })
  }

  const elapsed = performance.now() - started
  await Bun.sleep(600)
  const changed = events
    .filter((event): event is PluginEvent => event.type === 'quirky.tasks/changed')
    .slice(mark)
  const limit = 3 + Math.floor(elapsed / 250)

  expect(changed.length).toBeGreaterThanOrEqual(2)
  expect(changed.length).toBeLessThanOrEqual(limit)
  expect(changed[0]?.data).toHaveProperty('revision', before.revision + 1)
  expect(changed.at(-1)?.data).toHaveProperty('revision', before.revision + 20)
  for (const event of changed) expect(event).not.toHaveProperty('worktreeId')

  const state = await client.callAny('quirky.tasks/state', {}) as { revision: number }
  expect(state.revision).toBe(before.revision + 20)
}, 30_000)

test('catalogs Tasks changed as a daemon-wide coalesced event', async () => {
  const currentHost = (host = await bootTasks(listFixtureSource))
  const description = await currentHost.client.callAny('api.describe', {}) as ApiDescription
  const taskEvents = description.events.filter((event) => event.plugin === 'quirky.tasks')
  const changed = taskEvents.find((event) => event.name === 'quirky.tasks/changed')
  const workspaceComposer = taskEvents.find((event) => event.name === 'quirky.tasks/workspaceComposer')

  expect(changed).toHaveProperty('coalesce', [])
  expect(changed).not.toHaveProperty('worktree')
  expect(workspaceComposer).not.toHaveProperty('coalesce')

  const plugins = await currentHost.client.callAny('plugin.list', {}) as PluginInfo[]
  const tasks = plugins.find((plugin) => plugin.id === 'quirky.tasks')
  expect(tasks?.apiVersion).toBe('1.12.0')
  expect(tasks?.state).not.toBe('invalid')
}, 30_000)
