import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { makeTempHome, startHarness, waitForAsync, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

type ActivityItemEntry = {
  id: string
  kind: string
  plugin: string
  title: string
  order: number
  module: string | null
}

type ActivitySlotState = {
  id: string
  kind: string
  plugin: string
  title: string
  shown: boolean
  report?: unknown
}

type UiActivityState = {
  layout: { panel: string | null }
  slots: ActivitySlotState[]
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

function makeEnv() {
  const home = makeTempHome()
  const builtin = makeTempDir('qd-builtin-')
  const installed = join(home, 'plugins')
  const env = {
    home,
    builtin,
    installed,
    harness: null as Harness | null,
    async start(): Promise<Harness> {
      const harness = await startHarness({ home, builtinPluginsDir: builtin })
      harnesses.push(harness)
      env.harness = harness
      return harness
    },
    async restart(): Promise<Harness> {
      const old = env.harness!
      harnesses.splice(harnesses.indexOf(old), 1)
      for (const client of old.clients) client.close()
      await old.daemon.stop()
      old.pty.stop()
      return env.start()
    }
  }
  return env
}

function writeUiPlugin(root: string, id: string, contributes: Record<string, unknown[]>, extra: Record<string, unknown> = {}): void {
  writePlugin(
    root,
    { id, name: id, version: '1.0.0', ui: 'ui.js', contributes, ...extra },
    { 'ui.js': 'export function activate() {}\n' }
  )
}

async function activityCatalog(client: QuirkyClient): Promise<ActivityItemEntry[]> {
  const model = (await client.call('ui.contributions', {})) as unknown as { activityItems: ActivityItemEntry[] }
  return model.activityItems
}

function activitySlot(state: UiActivityState, id: string): ActivitySlotState | undefined {
  return state.slots.find((slot) => slot.id === id)
}

test('activity items are catalogued, open as tools, and report state while panels remain closed', async () => {
  const env = makeEnv()
  const id = 'activity-item:acme.activity/source-control'
  writeUiPlugin(env.installed, 'acme.activity', {
    'activity-item': [{ id: 'source-control', title: 'Source Control', order: 12 }]
  })
  const harness = await env.start()
  const client = await harness.connect()
  const window = await harness.connect('ui', 'activity strip')

  expect(await activityCatalog(client)).toEqual([
    {
      id,
      kind: 'activity-item',
      plugin: 'acme.activity',
      title: 'Source Control',
      order: 12,
      module: '/plugins/acme.activity/ui.js'
    }
  ])

  const initial = (await client.call('ui.state', {})) as unknown as UiActivityState
  expect(initial.layout.panel).toBeNull()
  expect(activitySlot(initial, id)).toMatchObject({
    id,
    kind: 'activity-item',
    plugin: 'acme.activity',
    title: 'Source Control'
  })

  await window.call('ui.tool.open', { id })
  const mounted = (await client.call('ui.state', {})) as unknown as UiActivityState
  expect(mounted.layout.panel).toBeNull()
  expect(activitySlot(mounted, id)).toMatchObject({
    id,
    kind: 'activity-item',
    plugin: 'acme.activity',
    title: 'Source Control',
    shown: true
  })

  await window.call('ui.report', { slot: id, state: { activeWorktree: 'fix', count: 2, available: true } })
  const reported = (await client.call('ui.state', {})) as unknown as UiActivityState
  expect(activitySlot(reported, id)?.report).toEqual({ activeWorktree: 'fix', count: 2, available: true })
  expect(reported.layout.panel).toBeNull()
})

test('disabling an override restores the prior activity-item owner in the catalog and state', async () => {
  const env = makeEnv()
  const id = 'activity-item:quirky.activity-base/source-control'
  writeUiPlugin(env.builtin, 'quirky.activity-base', {
    'activity-item': [{ id: 'source-control', title: 'Source Control', order: 10 }]
  })
  writeUiPlugin(
    env.installed,
    'acme.activity-override',
    {},
    { overrides: [{ id, title: 'Team Source Control', order: 5 }] }
  )
  const harness = await env.start()
  const client = await harness.connect()

  expect(await activityCatalog(client)).toMatchObject([
    { id, kind: 'activity-item', plugin: 'acme.activity-override', title: 'Team Source Control', order: 5 }
  ])
  expect(activitySlot((await client.call('ui.state', {})) as unknown as UiActivityState, id)).toMatchObject({
    id,
    plugin: 'acme.activity-override',
    title: 'Team Source Control'
  })

  await client.call('plugin.disable', { id: 'acme.activity-override' })
  await waitForAsync(async () => {
    const restored = await activityCatalog(client)
    return restored.find((item) => item.id === id)?.plugin === 'quirky.activity-base' ? restored : undefined
  })

  expect(await activityCatalog(client)).toMatchObject([
    { id, kind: 'activity-item', plugin: 'quirky.activity-base', title: 'Source Control', order: 10 }
  ])
  expect(activitySlot((await client.call('ui.state', {})) as unknown as UiActivityState, id)).toMatchObject({
    id,
    plugin: 'quirky.activity-base',
    title: 'Source Control'
  })
})

test('categorized setting metadata is available through the API and its value survives restart', async () => {
  const env = makeEnv()
  const id = 'setting:acme.preferences/sidebarSectionSeparators'
  writeUiPlugin(env.installed, 'acme.preferences', {
    setting: [
      {
        id: 'sidebarSectionSeparators',
        type: 'boolean',
        title: 'Show divider lines between top-level projects and groups',
        default: true,
        category: 'Appearance',
        section: 'Window & Sidebar'
      }
    ]
  })
  const harness = await env.start()
  const client = await harness.connect()
  const model = (await client.call('ui.contributions', {})) as unknown as {
    settings: { id: string; plugin: string; category?: string; section?: string }[]
  }

  expect(model.settings.find((setting) => setting.id === id)).toMatchObject({
    id,
    plugin: 'acme.preferences',
    category: 'Appearance',
    section: 'Window & Sidebar'
  })
  const listed = (await client.call('setting.list', {})) as unknown as {
    id: string
    category?: string
    section?: string
    value: boolean
  }[]
  expect(listed.find((setting) => setting.id === id)).toMatchObject({
    id,
    category: 'Appearance',
    section: 'Window & Sidebar',
    value: true
  })

  await client.call('setting.set', { id, value: false })
  const restarted = await env.restart()
  const afterRestart = await restarted.connect()
  expect(await afterRestart.call('setting.get', { id })).toMatchObject({
    value: false,
    stored: { value: false, valid: true }
  })
})
