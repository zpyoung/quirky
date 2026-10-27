import { expect, test } from 'bun:test'
import { WindowPluginHost } from '../src/plugins/host'

type Deps = ConstructorParameters<typeof WindowPluginHost>[0]

const MODEL = { sidebarSections: [], panels: [], settingsSections: [], views: [], overlays: [], commands: [], keybindings: [], settings: [], themes: [], modules: [] }
const LAYOUT = { view: null, panel: null, sidebar: true, focus: null }

function reply(method: string): unknown {
  if (method === 'ui.contributions') return MODEL
  if (method === 'ui.state') return { windows: [], layout: LAYOUT, slots: [] }
  if (method === 'setting.list') return []
  return { ok: true }
}

function setup(options: { failActivity?: boolean } = {}) {
  const clock = { now: 1_000_000 }
  const calls: string[] = []
  const inputs = new Set<() => void>()
  const deps: Deps = {
    call: async (method) => {
      calls.push(method)
      if (method === 'ui.window.activity' && options.failActivity) throw new Error('refused')
      return reply(method)
    },
    onEvent: () => () => {},
    importModule: async () => ({}),
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast: () => {},
    log: () => {},
    now: () => clock.now,
    windowActivity: {
      subscribe: (listener) => {
        inputs.add(listener)
        return () => inputs.delete(listener)
      }
    }
  }
  const host = new WindowPluginHost(deps)
  const input = () => inputs.forEach((listener) => listener())
  const activity = () => calls.filter((method) => method === 'ui.window.activity').length
  return { host, clock, input, activity, inputs }
}

test('the first input is reported at once', () => {
  const t = setup()
  t.input()
  expect(t.activity()).toBe(1)
})

test('continuing input is reported at most once per 15 seconds', () => {
  const t = setup()
  t.input()
  for (let i = 0; i < 20; i++) {
    t.clock.now += 700
    t.input()
  }
  expect(t.activity()).toBe(1)

  t.clock.now += 1000
  t.input()
  expect(t.activity()).toBe(2)
})

test('an input after a quiet spell is sent on its leading edge', () => {
  const t = setup()
  t.input()
  t.clock.now += 14_999
  t.input()
  expect(t.activity()).toBe(1)
  t.clock.now += 1
  t.input()
  expect(t.activity()).toBe(2)
  t.clock.now += 600_000
  t.input()
  expect(t.activity()).toBe(3)
})

test('a reconnect repeats the report when input happened in the last 15 seconds', async () => {
  const t = setup()
  t.input()
  t.clock.now += 5000
  await t.host.connected()
  expect(t.activity()).toBe(2)

  t.clock.now += 10_000
  t.input()
  expect(t.activity()).toBe(2)
})

test('a reconnect reports nothing more after a quiet spell or before any input', async () => {
  const fresh = setup()
  await fresh.host.connected()
  expect(fresh.activity()).toBe(0)

  const quiet = setup()
  quiet.input()
  quiet.clock.now += 15_000
  await quiet.host.connected()
  expect(quiet.activity()).toBe(1)
})

test('a refused report is swallowed and does not stop later ones', async () => {
  const t = setup({ failActivity: true })
  t.input()
  await Promise.resolve()
  t.clock.now += 20_000
  t.input()
  expect(t.activity()).toBe(2)
})

test('stop unsubscribes from input', () => {
  const t = setup()
  expect(t.inputs.size).toBe(1)
  t.host.stop()
  expect(t.inputs.size).toBe(0)
})

test('a host without a window activity source still connects', async () => {
  const host = new WindowPluginHost({
    call: async (method) => reply(method),
    onEvent: () => () => {},
    importModule: async () => ({}),
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast: () => {},
    log: () => {}
  })
  await host.connected()
  host.stop()
})
