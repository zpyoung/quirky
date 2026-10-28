import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent, type UiLayout } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

const harnesses: Harness[] = []

const PLUGIN = 'acme.geometry'
const OUTLINE = `panel:${PLUGIN}/outline`
const HISTORY = `panel:${PLUGIN}/history`
const PAGE = `view:${PLUGIN}/page`

const panelWidths = (layout: UiLayout): Record<string, number> => layout.panelWidths ?? {}

function writeGeometryPlugin(root: string): void {
  writePlugin(
    root,
    {
      id: PLUGIN,
      name: 'Geometry',
      version: '1.0.0',
      ui: 'ui.js',
      contributes: {
        panel: [
          { id: 'outline', title: 'Outline' },
          { id: 'history', title: 'History' }
        ],
        view: [{ id: 'page', title: 'Page' }]
      }
    },
    { 'ui.js': 'export function activate() {}\n' }
  )
}

/** A fresh real daemon with two effective panels, a view for wrong-kind checks, and restart support. */
function makeEnv() {
  const home = makeTempHome()
  const builtins = makeTempDir('qd-empty-builtins-')
  writeGeometryPlugin(join(home, 'plugins'))
  const env = {
    home,
    harness: null as Harness | null,
    async start(): Promise<Harness> {
      const harness = await startHarness({ home, builtinPluginsDir: builtins })
      harnesses.push(harness)
      env.harness = harness
      return harness
    },
    async restart(): Promise<Harness> {
      const old = env.harness!
      const index = harnesses.indexOf(old)
      if (index >= 0) harnesses.splice(index, 1)
      for (const client of old.clients) client.close()
      await old.daemon.stop()
      old.pty.stop()
      return env.start()
    }
  }
  return env
}

async function start() {
  const env = makeEnv()
  const harness = await env.start()
  const caller = await harness.connect('cli')
  return { env, harness, caller }
}

/** Same-process daemon errors are caught directly instead of being handled by a remote-client matcher. */
async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

async function layoutOf(client: QuirkyClient): Promise<UiLayout> {
  return (await client.call('ui.state', {})).layout
}

async function expectRejectedWithoutLayoutChange(
  caller: QuirkyClient,
  watcherEvents: QuirkyEvent[],
  params: Record<string, unknown>,
  code: number
): Promise<void> {
  const before = await layoutOf(caller)
  const eventCount = watcherEvents.filter((event) => event.type === 'ui.state.changed').length
  const error = await failure(caller.call('ui.panel.configure', params as never))
  expect(error.code).toBe(code)
  expect(await layoutOf(caller)).toEqual(before)
  expect(watcherEvents.filter((event) => event.type === 'ui.state.changed')).toHaveLength(eventCount)
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

describe('ui.panel.configure', () => {
  test('stores independent desired widths per panel and preserves their numeric bounds', async () => {
    const { caller } = await start()

    const first = await caller.call('ui.panel.configure', { id: OUTLINE, width: 380 })
    expect(panelWidths(first)).toEqual({ [OUTLINE]: 380 })

    const second = await caller.call('ui.panel.configure', { id: HISTORY, width: 460 })
    expect(panelWidths(second)).toEqual({ [OUTLINE]: 380, [HISTORY]: 460 })

    const partial = await caller.call('ui.panel.configure', { id: HISTORY, width: 540 })
    expect(panelWidths(partial)).toEqual({ [OUTLINE]: 380, [HISTORY]: 540 })
    expect(await layoutOf(caller)).toEqual(partial)

    const minimum = await caller.call('ui.panel.configure', { id: OUTLINE, width: 220 })
    expect(panelWidths(minimum)[OUTLINE]).toBe(220)
    const maximum = await caller.call('ui.panel.configure', { id: HISTORY, width: 4096 })
    expect(panelWidths(maximum)[HISTORY]).toBe(4096)
    expect(await layoutOf(caller)).toEqual(maximum)
  })

  test('rejects invalid, absent, wrong-kind and disabled targets without mutation or layout broadcasts', async () => {
    const { harness, caller } = await start()
    await caller.call('ui.panel.configure', { id: OUTLINE, width: 350 })
    const watcher = await harness.connectWithEvents('ui')

    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: OUTLINE }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: '', width: 350 }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: OUTLINE, width: 219 }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: OUTLINE, width: 4097 }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: OUTLINE, width: 350.5 }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(
      caller,
      watcher.events,
      { id: OUTLINE, width: Number.NaN },
      RpcErrorCode.InvalidParams
    )
    await expectRejectedWithoutLayoutChange(
      caller,
      watcher.events,
      { id: OUTLINE, width: 390, unexpected: true },
      RpcErrorCode.InvalidParams
    )
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: PAGE, width: 390 }, RpcErrorCode.InvalidParams)
    await expectRejectedWithoutLayoutChange(
      caller,
      watcher.events,
      { id: `panel:${PLUGIN}/missing`, width: 390 },
      RpcErrorCode.NotFound
    )

    await caller.call('plugin.disable', { id: PLUGIN })
    watcher.events.length = 0
    await expectRejectedWithoutLayoutChange(caller, watcher.events, { id: OUTLINE, width: 390 }, RpcErrorCode.NotFound)
  })

  test('persists panel width preferences across restart and drops malformed stored widths on read', async () => {
    const env = makeEnv()
    const first = await env.start()
    const caller = await first.connect('cli')

    const saved = await caller.call('ui.panel.configure', { id: OUTLINE, width: 375 })
    await caller.call('ui.panel.configure', { id: HISTORY, width: 495 })
    expect(saved.panelWidths).toEqual({ [OUTLINE]: 375 })

    const restarted = await env.restart()
    const restartedClient = await restarted.connect('cli')
    expect(await layoutOf(restartedClient)).toMatchObject({
      panelWidths: { [OUTLINE]: 375, [HISTORY]: 495 }
    })

    const index = harnesses.indexOf(restarted)
    if (index >= 0) harnesses.splice(index, 1)
    restartedClient.close()
    await restarted.daemon.stop()
    restarted.pty.stop()
    const db = new Database(join(env.home, 'quirky.db'))
    db.query('INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'layout',
      JSON.stringify({
        view: null,
        panel: null,
        sidebar: true,
        focus: null,
        panelWidths: {
          [OUTLINE]: 410,
          [HISTORY]: 219,
          [PAGE]: 420,
          'panel:acme.geometry/not-a-number': 'wide',
          '': 350
        }
      })
    )
    db.close()

    const normalizedDaemon = await env.start()
    const normalizedClient = await normalizedDaemon.connect('cli')
    const normalized = await layoutOf(normalizedClient)
    expect(normalized.panelWidths).toEqual({ [OUTLINE]: 410 })
  })
})

