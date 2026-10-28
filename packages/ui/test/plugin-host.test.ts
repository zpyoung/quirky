import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THEME, QuirkyClient, THEME_TOKENS, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempHome, startHarness, waitFor, type Harness } from '../../daemon/test/helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, writePlugin } from '../../daemon/test/plugins/fixtures'
import { WindowPluginHost, type HostState } from '../src/plugins/host'
import { settingsGroups, themePicker } from '../src/plugins/settingsGroups'

type El = Record<string, unknown>
type Imported = { url: string; mod: { ctx?: UiPluginContext } }
type Writer = (installed: string, marker: string) => void

const q = JSON.stringify
const section = (plugin: string, name = 'list') => `sidebar-section:${plugin}/${name}`
const el = (): El => ({})
const asElement = (element: El) => element as unknown as HTMLElement

type UiSource = { top?: string; activate?: string; deactivate?: string }

/** A plain-JavaScript UI module that records its import, activation and deactivation in the marker file. */
function uiSource(marker: string, id: string, source: UiSource = {}): string {
  return [
    "import { appendFileSync, existsSync } from 'node:fs'",
    `const record = (line) => appendFileSync(${q(marker)}, line + '\\n')`,
    'export let ctx',
    `record('ui-import ${id}')`,
    source.top ?? '',
    'export async function activate(context) {',
    '  ctx = context',
    `  record('ui-activate ${id}')`,
    `  ${source.activate ?? ''}`,
    '}',
    'export async function deactivate() {',
    `  record('ui-deactivate ${id}')`,
    `  ${source.deactivate ?? ''}`,
    '}',
    ''
  ].join('\n')
}

/** Statements for `activate`: provides `id` as a mount function with the given body (`element`, `props` in scope). */
const provideMount = (id: string, body: string) => `context.provide(${q(id)}, (element, props) => { ${body} })`
const provideCommand = (id: string, body: string) => `context.provide(${q(id)}, (args) => { ${body} })`

function installUi(
  installed: string,
  marker: string,
  id: string,
  contributes: Record<string, unknown[]>,
  source: UiSource = {},
  extra: Record<string, unknown> = {}
): string {
  return writePlugin(
    installed,
    { id, name: id, version: '1.0.0', ui: 'ui.js', ...(Object.keys(contributes).length ? { contributes } : {}), ...extra },
    { 'ui.js': uiSource(marker, id, source) }
  )
}

const listSection = { 'sidebar-section': [{ id: 'list', title: 'List' }] }

type BootOptions = { builtin?: Writer; activationTimeoutMs?: number }
type Booted = Awaited<ReturnType<typeof boot>>

const harnesses: Harness[] = []
const hosts: WindowPluginHost[] = []
const windowClients: QuirkyClient[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop()
  for (const client of windowClients.splice(0)) client.close()
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
})

/** A real daemon serving the fixture plugins, and a window host wired to it the way the app wires it. */
async function boot(write: Writer, options: BootOptions = {}) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  const moduleDir = makeTempDir('qd-mods-')
  write(join(home, 'plugins'), marker)
  let builtinPluginsDir: string | null = null
  if (options.builtin) {
    builtinPluginsDir = makeTempDir('qd-builtin-')
    options.builtin(builtinPluginsDir, marker)
  }
  const harness = await startHarness({ home, builtinPluginsDir })
  harnesses.push(harness)
  const client = await QuirkyClient.connect(rpcUrl(harness.runtime), { role: 'ui', subscribe: true })
  windowClients.push(client)
  const agent = await harness.connect('cli', 'agent')

  const imports: Imported[] = []
  const urls: string[] = []
  const events: QuirkyEvent[] = []
  const toasts: [string, string][] = []
  const logs: string[] = []
  let fetched = 0
  const host = new WindowPluginHost({
    call: (method, params) => client.callAny(method, params),
    onEvent: (listener) =>
      client.onEvent((event) => {
        events.push(event)
        listener(event)
      }),
    async importModule(url) {
      urls.push(url)
      const response = await fetch(`http://127.0.0.1:${harness.runtime.port}${url}`)
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      const file = join(moduleDir, `m${fetched++}.js`)
      writeFileSync(file, await response.text())
      const mod = (await import(file)) as Imported['mod']
      imports.push({ url, mod })
      return mod
    },
    onStream: (streamId, listener) => client.onTerminalOutput(streamId, listener),
    onConnection: () => () => {},
    confirm: async () => true,
    toast: (title, body) => toasts.push([title, body]),
    log: (message) => logs.push(message),
    activationTimeoutMs: options.activationTimeoutMs
  })
  hosts.push(host)

  const booted = {
    harness,
    agent,
    host,
    marker,
    imports,
    urls,
    events,
    toasts,
    logs,
    state: (): HostState => host.getState(),
    lines: () => readMarker(marker),
    /** The context the plugin's UI module last received. */
    ctx: (plugin: string): UiPluginContext => {
      const found = imports.find(({ url }) => url.startsWith(`/plugins/${plugin}/`))
      if (!found?.mod.ctx) throw new Error(`${plugin} has no context`)
      return found.mod.ctx
    },
    slot: (id: string) => host.getState().slots[id],
    mounted: (id: string) => waitFor(() => host.getState().slots[id]?.status === 'mounted'),
    errored: (id: string) =>
      waitFor(() => {
        const slot = host.getState().slots[id]
        return slot?.status === 'error' ? slot.message : undefined
      }),
    inModel: (id: string) => {
      const model = host.getState().model!
      return [...model.sidebarSections, ...model.activityItems, ...model.statusBars, ...model.panels, ...model.views, ...model.overlays, ...model.commands].some((e) => e.id === id)
    },
    waitForLine: (line: string) => waitFor(() => readMarker(marker).includes(line)),
    waitForGone: (id: string) => waitFor(() => !booted.inModel(id) && host.getState().slots[id] === undefined),
    waitForRevoked: (plugin: string) =>
      waitFor(() => {
        try {
          booted.ctx(plugin).closeView()
          return false
        } catch (error) {
          return (error as Error).message === `${plugin} is not active`
        }
      }),
    /** Shows `id` in a fresh element, as a slot in the shell would; returns the element and the dispose. */
    show: (id: string, props?: { input?: unknown }) => {
      const element = el()
      return { element, dispose: host.mount(id, asElement(element), props) }
    }
  }
  await host.refresh()
  return booted
}

/** What the shell does for the open panel or view: mount it, and dispose it when it changes or closes. */
function followOpen(t: Booted, select: (state: HostState) => { id: string; input?: unknown } | null) {
  const seen: { id: string; element: El }[] = []
  let current: { key: string; dispose: () => void } | null = null
  let syncing = false
  let again = false
  const sync = () => {
    if (syncing) {
      again = true
      return
    }
    syncing = true
    do {
      again = false
      reconcile()
    } while (again)
    syncing = false
  }
  const reconcile = () => {
    const wanted = select(t.host.getState())
    const key = wanted ? q([wanted.id, wanted.input ?? null]) : ''
    if ((current?.key ?? '') === key) return
    const previous = current
    current = null
    previous?.dispose()
    if (!wanted) return
    const element = el()
    seen.push({ id: wanted.id, element })
    current = { key, dispose: () => undefined }
    current.dispose = t.host.mount(wanted.id, asElement(element), { input: wanted.input })
  }
  const unsubscribe = t.host.subscribe(sync)
  sync()
  return { seen, stop: unsubscribe }
}

const press = (
  letter: string,
  modifiers: Partial<{ metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}
) => ({
  key: letter,
  code: `Key${letter.toUpperCase()}`,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers
})

const NOTES_SECTION = section('acme.notes')

describe('window plugin host against a real daemon', () => {
  test('SC-4: disabling a UI contribution removes it live', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.notes', listSection, {
        activate: provideMount(NOTES_SECTION, "element.text = '3 notes'; return () => record('cleanup list')")
      })
    )
    const { element } = t.show(NOTES_SECTION)
    await t.mounted(NOTES_SECTION)
    expect(element.text).toBe('3 notes')

    await t.agent.call('plugin.disable', { id: NOTES_SECTION })
    await t.waitForGone(NOTES_SECTION)
    await t.waitForLine('ui-deactivate acme.notes')
    expect(t.lines()).toContain('cleanup list')
    expect(t.state().plugins['acme.notes']).toEqual({ state: 'idle' })
    await t.waitForRevoked('acme.notes')

    await t.agent.call('plugin.enable', { id: NOTES_SECTION })
    await waitFor(() => t.inModel(NOTES_SECTION))
    const again = t.show(NOTES_SECTION)
    await t.mounted(NOTES_SECTION)
    expect(again.element.text).toBe('3 notes')
    expect(t.lines().filter((line) => line === 'ui-import acme.notes')).toHaveLength(1)
    expect(t.urls).toEqual(['/plugins/acme.notes/ui.js'])
  })

  test('SC-4: disabling a UI contribution removes it live (disable while the module is loading)', async () => {
    const gate = join(makeTempDir(), 'gate')
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.notes', listSection, {
        top: "import { existsSync as gateOpen } from 'node:fs'",
        activate: `${provideMount(NOTES_SECTION, "record('mount list'); element.text = 'x'")}
          while (!gateOpen(${q(gate)})) await new Promise((resolve) => setTimeout(resolve, 5))`
      })
    )
    const history: string[] = []
    t.host.subscribe(() => history.push(t.slot(NOTES_SECTION)?.status ?? 'none'))
    t.show(NOTES_SECTION)
    await t.waitForLine('ui-activate acme.notes')

    await t.agent.call('plugin.disable', { id: NOTES_SECTION })
    await t.waitForGone(NOTES_SECTION)
    writeFileSync(gate, '')
    await t.waitForLine('ui-deactivate acme.notes')
    await t.waitForRevoked('acme.notes')

    expect(t.lines()).not.toContain('mount list')
    expect(history).not.toContain('mounted')
    expect(t.slot(NOTES_SECTION)).toBeUndefined()
    expect(t.state().plugins['acme.notes']).toEqual({ state: 'idle' })
  })

  test('SC-6: code-backed contributions without a UI module carry a warning', async () => {
    const t = await boot((installed) =>
      writePlugin(installed, {
        id: 'acme.bare',
        name: 'acme.bare',
        version: '1.0.0',
        contributes: {
          command: [{ id: 'go', title: 'Go' }],
          setting: [{ id: 'size', type: 'number', title: 'Size', default: 5 }]
        }
      })
    )
    const plugins = await t.agent.call('plugin.list', {})
    expect(plugins.find((plugin) => plugin.id === 'acme.bare')).toMatchObject({
      diagnostics: [expect.objectContaining({ level: 'warning' })]
    })
    expect(t.state().settings.find((setting) => setting.id === 'setting:acme.bare/size')?.value).toBe(5)

    await t.host.runCommand('command:acme.bare/go')

    const message = 'acme.bare has no ui module'
    expect(t.toasts).toEqual([[`command:acme.bare/go failed: ${message}`, message]])
    expect(t.state().plugins['acme.bare']).toEqual({ state: 'failed', error: message })
    expect(t.urls).toEqual([])
  })

  test('SC-7: a sidebar section\'s module loads when the section is shown', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.notes', listSection, {
        activate: `context.provide(${q(NOTES_SECTION)}, (...args) => {
          record('mount args=' + args.length + ' props=' + JSON.stringify(args[1]))
          args[0].text = '3 notes'
          return () => record('cleanup list')
        })`
      })
    )
    expect(t.lines()).toEqual([])
    const statuses: string[] = []
    t.host.subscribe(() => {
      const status = t.slot(NOTES_SECTION)?.status
      if (status && statuses.at(-1) !== status) statuses.push(status)
    })

    const { element, dispose } = t.show(NOTES_SECTION)
    await t.mounted(NOTES_SECTION)

    expect(statuses).toEqual(['loading', 'mounted'])
    expect(element.text).toBe('3 notes')
    expect(t.lines()).toEqual([
      'ui-import acme.notes',
      'ui-activate acme.notes',
      'mount args=2 props={}'
    ])
    expect(t.urls).toEqual(['/plugins/acme.notes/ui.js'])
    dispose()
    expect(t.lines()).toContain('cleanup list')
  })

  test('S1: an enabled plugin loads and activates without any of its contributions being shown', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.outline', {
        panel: [{ id: 'outline', title: 'Outline' }],
        view: [{ id: 'page', title: 'Page' }]
      })
    )
    await Bun.sleep(50)

    expect(t.state().model!.panels).toMatchObject([{ id: 'panel:acme.outline/outline', title: 'Outline' }])
    expect(t.state().openPanel).toBeNull()
    expect(t.state().openView).toBeNull()
    await t.waitForLine('ui-activate acme.outline')
    expect(t.lines()).toEqual(['ui-import acme.outline', 'ui-activate acme.outline'])
    expect(t.urls).toEqual(['/plugins/acme.outline/ui.js'])
    expect(t.state().plugins['acme.outline']).toEqual({ state: 'active' })
    expect(t.state().slots).toEqual({})
  })

  test('SC-9: a panel toggles open and closed, one at a time', async () => {
    const outline = 'panel:acme.outline/outline'
    const side = 'panel:acme.notes/side'
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.outline', { panel: [{ id: 'outline', title: 'Outline' }] }, {
        activate: provideMount(outline, "record('mount outline'); return () => record('cleanup outline')")
      })
      installUi(installed, marker, 'acme.notes', { panel: [{ id: 'side', title: 'Side' }] }, {
        activate: provideMount(side, "record('mount side'); return () => record('cleanup side')")
      })
    })
    const shell = followOpen(t, (state) => (state.openPanel ? { id: state.openPanel } : null))
    const panelLines = () => t.lines().filter((line) => /^(mount|cleanup) /.test(line))

    t.host.togglePanel(outline)
    await t.mounted(outline)
    expect(t.state().openPanel).toBe(outline)
    expect(panelLines()).toEqual(['mount outline'])

    t.host.togglePanel(side)
    await t.mounted(side)
    expect(t.state().openPanel).toBe(side)
    expect(panelLines()).toEqual(['mount outline', 'cleanup outline', 'mount side'])
    expect(t.slot(outline)).toBeUndefined()

    t.host.togglePanel(side)
    await waitFor(() => t.state().openPanel === null)
    expect(panelLines()).toEqual(['mount outline', 'cleanup outline', 'mount side', 'cleanup side'])
    expect(t.state().slots).toEqual({})
    shell.stop()
  })

  test('SC-10: a command opens a view with an input', async () => {
    const page = 'view:acme.notes/page'
    const other = 'view:acme.notes/other'
    const open = 'command:acme.notes/open'
    const openOther = 'command:acme.notes/open-other'
    const close = 'command:acme.notes/close'
    const t = await boot((installed, marker) =>
      installUi(
        installed,
        marker,
        'acme.notes',
        {
          view: [
            { id: 'page', title: 'Page' },
            { id: 'other', title: 'Other' }
          ],
          command: [
            { id: 'open', title: 'Open' },
            { id: 'open-other', title: 'Open other' },
            { id: 'close', title: 'Close' }
          ]
        },
        {
          activate: [
            provideCommand(open, `context.openView(${q(page)}, { noteId: 'n1' })`),
            provideCommand(openOther, `context.openView(${q(other)})`),
            provideCommand(close, 'context.closeView()'),
            provideMount(page, "element.text = JSON.stringify(props); return () => record('cleanup page')"),
            provideMount(other, "element.text = JSON.stringify(props); return () => record('cleanup other')")
          ].join('\n')
        }
      )
    )
    const shell = followOpen(t, (state) => state.openView)

    await t.host.runCommand(open)
    await t.mounted(page)
    expect(t.state().openView).toEqual({ id: page, input: { noteId: 'n1' } })
    expect(shell.seen[0]!.element.text).toBe('{"input":{"noteId":"n1"}}')

    await t.host.runCommand(openOther)
    await t.mounted(other)
    expect(t.lines()).toContain('cleanup page')
    expect(t.slot(page)).toBeUndefined()
    expect(shell.seen[1]!.element.text).toBe('{}')

    await t.host.runCommand(close)
    await waitFor(() => t.state().openView === null)
    expect(t.lines()).toContain('cleanup other')
    expect(t.state().slots).toEqual({})
    shell.stop()
  })

  test('SC-11: a UI module talks to the daemon through its context', async () => {
    const mountPlugin: Writer = (installed, marker) => {
      const dir = writeModulePlugin(
        installed,
        marker,
        {
          id: 'acme.notes',
          ui: 'ui.js',
          contributes: { ...listSection, method: [{ id: 'count' }, { id: 'bump' }], event: [{ id: 'changed' }] }
        },
        {
          activate: `context.provide('method:acme.notes/count', () => 3)
            context.provide('method:acme.notes/bump', () => context.emit('changed', null))`
        }
      )
      writeFileSync(
        join(dir, 'ui.js'),
        uiSource(marker, 'acme.notes', {
          activate: `context.subscribe((event) => record('event ' + event.type))
            ${provideMount(
              NOTES_SECTION,
              `Promise.all([context.call('plugin.list', {}), context.call('acme.notes/count', {})])
                 .then(([plugins, count]) => { element.plugins = plugins.map((plugin) => plugin.id); element.count = count })`
            )}`
        })
      )
    }
    const t = await boot(mountPlugin)

    const { element } = t.show(NOTES_SECTION)
    await t.mounted(NOTES_SECTION)
    await waitFor(() => element.count !== undefined)
    expect(element.plugins).toContain('acme.notes')
    expect(element.count).toBe(3)

    await t.agent.callAny('acme.notes/bump', {})
    await t.waitForLine('event acme.notes/changed')

    await t.agent.call('plugin.disable', { id: NOTES_SECTION })
    await t.waitForGone(NOTES_SECTION)
    await t.waitForRevoked('acme.notes')
    const before = t.events.filter((event) => event.type === 'acme.notes/changed').length
    const heard = t.lines().length
    await t.agent.callAny('acme.notes/bump', {})
    await waitFor(() => t.events.filter((event) => event.type === 'acme.notes/changed').length > before)
    await Bun.sleep(50)

    expect(t.lines().filter((line) => line.startsWith('event ')).length).toBe(
      t.lines().slice(0, heard).filter((line) => line.startsWith('event ')).length
    )
    expect(() => t.ctx('acme.notes').call('plugin.list', {})).toThrow('acme.notes is not active')
    expect(() => t.ctx('acme.notes').subscribe(() => undefined)).toThrow('acme.notes is not active')
  })

  test('SC-12: a UI module can only provide what its plugin declared', async () => {
    const lazy = section('acme.lazy')
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.notes', listSection, {
        activate: provideCommand('command:acme.notes/undeclared', '')
      })
      installUi(installed, marker, 'acme.lazy', listSection)
    })

    t.show(NOTES_SECTION)
    t.show(lazy)

    const undeclared = 'acme.notes does not declare command:acme.notes/undeclared'
    expect(await t.errored(NOTES_SECTION)).toBe(undeclared)
    expect(t.state().plugins['acme.notes']).toEqual({ state: 'failed', error: undeclared })
    expect(await t.errored(lazy)).toBe(`acme.lazy did not provide ${lazy}`)
  })

  test('SC-12: a UI module can only provide what its plugin declared (an override\'s implementation)', async () => {
    const overridden = section('acme.orig')
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.orig', listSection, {
        activate: provideMount(overridden, "element.text = 'orig'")
      })
      installUi(installed, marker, 'acme.over', {}, {
        activate: provideMount(overridden, "element.text = 'over'")
      }, { overrides: [{ id: overridden, title: 'Over' }] })
    })
    expect(t.state().model!.sidebarSections).toMatchObject([{ id: overridden, plugin: 'acme.over' }])

    const { element } = t.show(overridden)
    await t.mounted(overridden)

    expect(element.text).toBe('over')
    expect(t.state().plugins['acme.over']).toEqual({ state: 'active' })
    expect(t.state().plugins['acme.orig']).toBeUndefined()
  })

  describe('SC-13: plugin UI failures stay in their slot', () => {
    test('SC-13: plugin UI failures stay in their slot', async () => {
      const broken = section('acme.broken')
      const throws = section('acme.throws')
      const failing = section('acme.x')
      const go = 'command:acme.cmd/go'
      const t = await boot((installed, marker) => {
        installUi(installed, marker, 'acme.broken', listSection, { top: "throw new Error('import boom')" })
        installUi(installed, marker, 'acme.throws', listSection, {
          activate: provideMount(throws, "throw new Error('boom')")
        })
        installUi(installed, marker, 'acme.x', listSection, { activate: "throw new Error('bad')" })
        installUi(installed, marker, 'acme.cmd', { command: [{ id: 'go', title: 'Go' }] }, {
          activate: provideCommand(go, "throw new Error('nope')")
        })
        installUi(installed, marker, 'acme.notes', listSection, {
          activate: provideMount(NOTES_SECTION, "element.text = 'fine'")
        })
      })

      const ids = [broken, throws, failing, NOTES_SECTION]
      const shown = ids.map((id) => t.show(id))
      await t.host.runCommand(go)
      await waitFor(() => ids.every((id) => t.slot(id)?.status !== 'loading'))

      expect(t.slot(broken)).toEqual({ status: 'error', message: expect.stringMatching(/^acme\.broken failed to load: .*import boom/) })
      expect(t.slot(throws)).toEqual({ status: 'error', message: 'acme.throws: boom' })
      expect(t.slot(failing)).toEqual({ status: 'error', message: 'acme.x failed to activate: bad' })
      expect(t.toasts).toEqual([['command:acme.cmd/go failed: nope', 'nope']])
      expect(t.slot(NOTES_SECTION)).toEqual({ status: 'mounted' })
      expect(shown[3]!.element.text).toBe('fine')
    })

    test('SC-13: plugin UI failures stay in their slot (a cleanup and a deactivate that throw)', async () => {
      const cleanup = section('acme.cleanup')
      const deact = section('acme.deact')
      const t = await boot((installed, marker) => {
        installUi(installed, marker, 'acme.cleanup', listSection, {
          activate: provideMount(cleanup, "return () => { throw new Error('cleanup boom') }")
        })
        installUi(installed, marker, 'acme.deact', listSection, {
          activate: provideMount(deact, 'return () => undefined'),
          deactivate: "throw new Error('deact boom')"
        })
      })
      t.show(cleanup)
      t.show(deact)
      await t.mounted(cleanup)
      await t.mounted(deact)

      await t.agent.call('plugin.disable', { id: cleanup })
      await t.agent.call('plugin.disable', { id: deact })
      await t.waitForGone(cleanup)
      await t.waitForGone(deact)
      await t.waitForRevoked('acme.cleanup')
      await t.waitForRevoked('acme.deact')

      expect(t.logs).toContain('acme.cleanup: cleanup failed: cleanup boom')
      expect(t.logs).toContain('acme.deact: deactivate failed: deact boom')
      expect(t.slot(cleanup)).toBeUndefined()
      expect(t.slot(deact)).toBeUndefined()
    })

    test('SC-13: plugin UI failures stay in their slot (retries)', async () => {
      const broken = section('acme.broken')
      const throws = section('acme.throws')
      const failing = section('acme.x')
      let brokenDir = ''
      const t = await boot((installed, marker) => {
        brokenDir = installUi(installed, marker, 'acme.broken', listSection, { top: "throw new Error('import boom')" })
        installUi(installed, marker, 'acme.throws', listSection, {
          top: 'let mounts = 0',
          activate: provideMount(throws, "if (++mounts === 1) throw new Error('boom'); element.text = 'second try'")
        })
        installUi(installed, marker, 'acme.x', listSection, {
          top: 'let attempts = 0',
          activate: `if (++attempts === 1) throw new Error('bad')
            ${provideMount(failing, "element.text = 'activated again'")}`
        })
      })

      const first = t.show(throws)
      expect(await t.errored(throws)).toBe('acme.throws: boom')
      first.dispose()
      const retried = t.show(throws)
      await t.mounted(throws)
      expect(retried.element.text).toBe('second try')

      await waitFor(() => t.state().plugins['acme.broken']?.state === 'failed')
      t.show(broken)
      expect(await t.errored(broken)).toMatch(/^acme\.broken failed to load: /)
      writeFileSync(
        join(brokenDir, 'ui.js'),
        uiSource(t.marker, 'acme.broken', { activate: provideMount(broken, "element.text = 'loaded'") })
      )
      const later = t.show(broken)
      await t.mounted(broken)
      expect(later.element.text).toBe('loaded')
      expect(t.urls.filter((url) => url.includes('acme.broken'))).toEqual([
        '/plugins/acme.broken/ui.js',
        '/plugins/acme.broken/ui.js?attempt=1',
        '/plugins/acme.broken/ui.js?attempt=2'
      ])

      await waitFor(() => t.state().plugins['acme.x']?.state === 'failed')
      expect(t.state().plugins['acme.x']).toEqual({ state: 'failed', error: 'acme.x failed to activate: bad' })
      const reactivated = t.show(failing)
      await t.mounted(failing)
      expect(reactivated.element.text).toBe('activated again')
      expect(t.lines().filter((line) => line === 'ui-import acme.x')).toHaveLength(1)
      expect(t.lines().filter((line) => line === 'ui-activate acme.x')).toHaveLength(2)
      expect(t.lines()).not.toContain('ui-deactivate acme.x')
    })
  })

  test('SC-14: the command palette lists commands in effect', async () => {
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.notes', {
        command: [
          { id: 'new', title: 'New note' },
          { id: 'archive', title: 'Archive note' }
        ]
      }, {
        activate: provideCommand('command:acme.notes/new', "record('ran new')")
      })
      installUi(installed, marker, 'acme.files', { command: [{ id: 'open', title: 'Open file' }] })
    })
    await t.agent.call('plugin.disable', { id: 'command:acme.files/open' })
    await waitFor(() => !t.inModel('command:acme.files/open'))

    const offered = t.host.paletteCommands('note')
    expect(offered.map((command) => command.title)).toEqual(['Archive note', 'New note'])
    expect(t.host.paletteCommands('NEW').map((command) => command.title)).toEqual(['New note'])
    expect(t.host.paletteCommands('').map((command) => command.title)).toEqual(['Archive note', 'New note'])

    await t.host.runCommand(t.host.paletteCommands('NEW')[0]!.id)
    expect(t.lines()).toContain('ran new')
    expect(t.toasts).toEqual([])
  })

  test('SC-15: a keybinding runs its command, also from inside a terminal', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.notes', {
        command: [{ id: 'new', title: 'New note' }],
        keybinding: [{ id: 'new-key', key: 'mod+shift+n', command: 'new' }]
      }, {
        activate: provideCommand('command:acme.notes/new', "record('ran new')")
      })
    )
    expect(t.state().model!.keybindings).toMatchObject([{ id: 'keybinding:acme.notes/new-key', key: 'mod+shift+n', status: 'active' }])

    expect(t.host.handleKey(press('N', { shiftKey: true }))).toBe(true)
    await waitFor(() => t.lines().filter((line) => line === 'ran new').length === 1)
    expect(t.host.handleKey(press('N', { shiftKey: true }))).toBe(true)
    await waitFor(() => t.lines().filter((line) => line === 'ran new').length === 2)

    expect(t.host.handleKey(press('n'))).toBe(false)
    await Bun.sleep(50)
    expect(t.lines().filter((line) => line === 'ran new')).toHaveLength(2)
  })

  test('SC-68: mod+j runs the command whose when holds, with the terminal focused or not', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.keys', {
        command: [{ id: 'in-terminal', title: 'In terminal' }, { id: 'elsewhere', title: 'Elsewhere' }],
        keybinding: [
          { id: 'jt', key: 'mod+j', command: 'in-terminal', when: 'terminalFocus' },
          { id: 'je', key: 'mod+j', command: 'elsewhere', when: '!terminalFocus' }
        ]
      }, {
        activate: [
          provideCommand('command:acme.keys/in-terminal', "record('ran in-terminal')"),
          provideCommand('command:acme.keys/elsewhere', "record('ran elsewhere')")
        ].join('\n')
      })
    )
    expect(t.state().model!.keybindings.map((item) => [item.id, item.status, item.when])).toEqual([
      ['keybinding:acme.keys/je', 'active', '!terminalFocus'],
      ['keybinding:acme.keys/jt', 'active', 'terminalFocus']
    ])
    await waitFor(() => t.lines().includes('ui-activate acme.keys'))

    expect(t.host.handleKey(press('J'))).toBe(true)
    await t.waitForLine('ran elsewhere')
    t.ctx('acme.keys').setContext('terminalFocus', true)
    expect(t.host.handleKey(press('J'))).toBe(true)
    await t.waitForLine('ran in-terminal')
    expect(t.lines().filter((line) => line.startsWith('ran '))).toEqual(['ran elsewhere', 'ran in-terminal'])
  })

  test('SC-68: with terminal keys first, a chord that does not mention terminalFocus goes to the terminal', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.keys', {
        command: [{ id: 'rename', title: 'Rename' }],
        keybinding: [{ id: 'r', key: 'mod+r', command: 'rename' }]
      }, {
        activate: provideCommand('command:acme.keys/rename', "record('ran rename')")
      })
    )
    await waitFor(() => t.lines().includes('ui-activate acme.keys'))
    const ctx = t.ctx('acme.keys')
    ctx.setContext('terminalKeysFirst', true)
    ctx.setContext('terminalFocus', true)
    let prevented = 0
    expect(t.host.handleKey({ ...press('R'), preventDefault: () => prevented++ })).toBe(false)
    expect(prevented).toBe(1)

    ctx.setContext('terminalFocus', false)
    expect(t.host.handleKey(press('R'))).toBe(true)
    await t.waitForLine('ran rename')
  })

  test('SC-69: a plugin embeds another plugin\'s view and unmounts it', async () => {
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.shelf', { view: [{ id: 'page', title: 'Page' }] }, {
        activate: provideMount('view:acme.shelf/page', "element.text = 'shelf ' + JSON.stringify(props); return () => record('cleanup shelf')")
      })
      installUi(installed, marker, 'acme.host', listSection)
    })
    await waitFor(() => t.lines().includes('ui-activate acme.host'))
    const element = el()
    const unmount = t.ctx('acme.host').mountView('view:acme.shelf/page', asElement(element), { session: 's-1' })

    await waitFor(() => element.text !== undefined)
    expect(element.text).toBe('shelf {"input":{"session":"s-1"}}')
    expect(t.slot('view:acme.shelf/page')).toBeUndefined()
    unmount()
    await t.waitForLine('cleanup shelf')
    expect(() => t.ctx('acme.host').mountView('view:acme.shelf/gone', asElement(el()))).toThrow('no contribution view:acme.shelf/gone')
  })

  test('SC-67: an overlay mounts with a report function and the daemon lists it in ui state', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.hud', { overlay: [{ id: 'hud', title: 'Hud' }] }, {
        activate: provideMount('overlay:acme.hud/hud', "element.text = 'hud'; props.report({ label: 'hud' })")
      })
    )
    const { element, dispose } = t.show('overlay:acme.hud/hud')
    await t.mounted('overlay:acme.hud/hud')
    expect(element.text).toBe('hud')

    const overlaySlot = async () =>
      ((await t.agent.callAny('ui.state', {})) as { slots: { id: string; kind: string; shown: boolean; report?: unknown }[] }).slots.find(
        (slot) => slot.kind === 'overlay'
      )
    await waitFor(async () => (await overlaySlot())?.report !== undefined)
    expect(await overlaySlot()).toMatchObject({ id: 'overlay:acme.hud/hud', shown: true, report: { label: 'hud' } })

    dispose()
    await waitFor(async () => (await overlaySlot())?.shown === false)
  })

  const sampleWriter =
    (key: string, commandId: string): Writer =>
    (builtin, marker) =>
      installUi(builtin, marker, 'quirky.sample', {
        command: [{ id: 'sample', title: 'Sample' }],
        keybinding: [{ id: 'k', key, command: 'sample' }]
      }, {
        activate: provideCommand(commandId, "record('ran sample')")
      })

  test('SC-16: two keybindings on one chord: one wins, and the other is reported', async () => {
    const t = await boot(
      (installed, marker) =>
        installUi(installed, marker, 'acme.keys', {
          command: [{ id: 'run', title: 'Run' }],
          keybinding: [{ id: 'k', key: 'mod+k', command: 'run' }]
        }, {
          activate: provideCommand('command:acme.keys/run', "record('ran keys')")
        }),
      { builtin: sampleWriter('mod+k', 'command:quirky.sample/sample') }
    )
    const statuses = () =>
      Object.fromEntries(t.state().model!.keybindings.map((binding) => [binding.id, [binding.status, binding.shadowedBy]]))
    expect(statuses()).toEqual({
      'keybinding:acme.keys/k': ['active', undefined],
      'keybinding:quirky.sample/k': ['shadowed', 'keybinding:acme.keys/k']
    })

    expect(t.host.handleKey(press('K'))).toBe(true)
    await t.waitForLine('ran keys')
    expect(t.lines()).not.toContain('ran sample')

    await t.agent.call('plugin.disable', { id: 'keybinding:acme.keys/k' })
    await waitFor(() => statuses()['keybinding:quirky.sample/k']?.[0] === 'active')
    expect(t.host.handleKey(press('K'))).toBe(true)
    await t.waitForLine('ran sample')
    expect(t.lines().filter((line) => line === 'ran keys')).toHaveLength(1)
  })

  test('SC-18: a keybinding whose command isn\'t in effect is unbound', async () => {
    const t = await boot((installed, marker) =>
      installUi(installed, marker, 'acme.notes', {
        command: [{ id: 'new', title: 'New note' }],
        keybinding: [{ id: 'new-key', key: 'mod+shift+n', command: 'new' }]
      }, {
        activate: provideCommand('command:acme.notes/new', "record('ran new')")
      })
    )
    await t.agent.call('plugin.disable', { id: 'command:acme.notes/new' })
    await waitFor(() => !t.inModel('command:acme.notes/new'))

    expect(t.state().model!.keybindings).toMatchObject([{ id: 'keybinding:acme.notes/new-key', status: 'unbound' }])
    expect(t.host.handleKey(press('N', { shiftKey: true }))).toBe(false)
    await Bun.sleep(50)
    expect(t.lines()).not.toContain('ran new')
    expect(t.toasts).toEqual([])
  })

  test('SC-18: a keybinding whose command isn\'t in effect is unbound (it never takes part in a clash)', async () => {
    const t = await boot(
      (installed, marker) =>
        installUi(installed, marker, 'acme.notes', {
          command: [{ id: 'new', title: 'New note' }],
          keybinding: [{ id: 'new-key', key: 'mod+shift+n', command: 'new' }]
        }, {
          activate: provideCommand('command:acme.notes/new', "record('ran new')")
        }),
      { builtin: sampleWriter('mod+shift+n', 'command:quirky.sample/sample') }
    )
    await t.agent.call('plugin.disable', { id: 'command:acme.notes/new' })
    await waitFor(() => !t.inModel('command:acme.notes/new'))

    const bindings = Object.fromEntries(t.state().model!.keybindings.map((binding) => [binding.id, binding.status]))
    expect(bindings).toEqual({ 'keybinding:acme.notes/new-key': 'unbound', 'keybinding:quirky.sample/k': 'active' })
    expect(t.host.handleKey(press('N', { shiftKey: true }))).toBe(true)
    await t.waitForLine('ran sample')
    expect(t.lines()).not.toContain('ran new')
  })

  const notesSettings = {
    setting: [
      { id: 'fontSize', type: 'number', title: 'Font size', default: 13, minimum: 8, maximum: 32 },
      { id: 'mode', type: 'enum', title: 'Mode', default: 'list', values: ['list', 'grid'] }
    ]
  }
  const FONT_SIZE = 'setting:acme.notes/fontSize'

  test('SC-23: plugin code reads settings on both sides', async () => {
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.notes', { ...listSection, ...notesSettings }, {
        activate: `${provideMount(
          NOTES_SECTION,
          `const render = () => { element.text = String(context.getSetting('fontSize')) }
           render()
           context.subscribe((event) => { if (event.type === 'setting.changed') render() })`
        )}`
      })
      installUi(installed, marker, 'acme.files', {
        setting: [{ id: 'hidden', type: 'boolean', title: 'Hidden', default: true }]
      })
    })

    const { element } = t.show(NOTES_SECTION)
    await t.mounted(NOTES_SECTION)
    expect(element.text).toBe('13')

    await t.agent.call('setting.set', { id: FONT_SIZE, value: 20 })
    await waitFor(() => element.text === '20')

    const ctx = t.ctx('acme.notes')
    expect(ctx.getSetting('fontSize')).toBe(20)
    expect(ctx.getSetting('setting:acme.files/hidden')).toBe(true)
    expect(() => ctx.getSetting('ghost')).toThrow('no setting setting:acme.notes/ghost')
  })

  test('SC-24: the Settings dialog lists every setting in effect, grouped by plugin', async () => {
    const t = await boot((installed, marker) => {
      installUi(installed, marker, 'acme.notes', notesSettings)
      installUi(installed, marker, 'acme.files', {
        setting: [{ id: 'hidden', type: 'boolean', title: 'Hidden', default: false }]
      })
      installUi(installed, marker, 'acme.solar', {
        theme: [{ id: 'solar', title: 'Solar', appearance: 'light', colors: { bg: '#fdf6e3' } }]
      })
    })
    const { settings, model } = t.state()

    expect(settingsGroups(settings).map((group) => [group.plugin, group.fields.map((field) => [field.id, field.control, field.value])])).toEqual([
      ['acme.files', [['setting:acme.files/hidden', { kind: 'checkbox' }, false]]],
      [
        'acme.notes',
        [
          [FONT_SIZE, { kind: 'number', min: 8, max: 32 }, 13],
          ['setting:acme.notes/mode', { kind: 'select', options: ['list', 'grid'] }, 'list']
        ]
      ]
    ])
    expect(themePicker(model!.themes, model!.theme.chosen)).toEqual({
      options: [
        { id: 'default', title: DEFAULT_THEME.title, appearance: 'dark' },
        { id: 'theme:acme.solar/solar', title: 'Solar', appearance: 'light' }
      ],
      selected: 'default'
    })

    const { errors } = await t.host.saveSettings({
      settings: { 'setting:acme.notes/mode': 'tiles', [FONT_SIZE]: 18 },
      theme: 'theme:acme.solar/solar'
    })

    expect(errors).toEqual({ 'setting:acme.notes/mode': 'setting:acme.notes/mode must be one of list, grid' })
    expect(await t.agent.call('setting.get', { id: FONT_SIZE })).toMatchObject({ value: 18 })
    expect(await t.agent.call('setting.get', { id: 'setting:acme.notes/mode' })).toMatchObject({ value: 'list' })
    expect(await t.agent.call('theme.list', {})).toMatchObject({ chosen: 'theme:acme.solar/solar', active: 'theme:acme.solar/solar' })
    await waitFor(() => t.state().settings.find((setting) => setting.id === FONT_SIZE)?.value === 18)

    const refused = await t.host.saveSettings({ settings: { [FONT_SIZE]: 99 }, theme: 'theme:acme.ghost/x' })
    expect(refused.errors).toEqual({ [FONT_SIZE]: `${FONT_SIZE} must be at most 32`, theme: 'no theme theme:acme.ghost/x' })
    expect(await t.agent.call('setting.get', { id: FONT_SIZE })).toMatchObject({ value: 18 })
  })

  const solar = (installed: string) =>
    writePlugin(installed, {
      id: 'acme.solar',
      name: 'acme.solar',
      version: '1.0.0',
      contributes: {
        theme: [{ id: 'solar', title: 'Solar', appearance: 'light', colors: { bg: '#fdf6e3', text: '#657b83' } }]
      }
    })
  const SOLAR = 'theme:acme.solar/solar'
  const defaults = Object.fromEntries(THEME_TOKENS.map((token) => [`--${token}`, DEFAULT_THEME.colors[token]]))
  const solarVariables = { ...defaults, '--bg': '#fdf6e3', '--text': '#657b83' }

  test('SC-25: a theme is listed, chosen and applied live, with missing colors filled in', async () => {
    const t = await boot(solar)
    expect(t.state().themeVariables).toEqual(defaults)

    await t.agent.call('theme.set', { id: SOLAR })
    await waitFor(() => t.state().themeVariables['--bg'] === '#fdf6e3')
    expect(t.state().themeVariables).toEqual(solarVariables)
    expect(t.state().model!.theme).toEqual({ chosen: SOLAR, active: SOLAR })

    await t.agent.call('theme.set', { id: 'default' })
    await waitFor(() => t.state().themeVariables['--bg'] === DEFAULT_THEME.colors.bg)
    expect(t.state().themeVariables).toEqual(defaults)
  })

  test('SC-26: a chosen theme that goes away falls back, and comes back', async () => {
    const t = await boot(solar)
    await t.agent.call('theme.set', { id: SOLAR })
    await waitFor(() => t.state().themeVariables['--bg'] === '#fdf6e3')

    await t.agent.call('plugin.disable', { id: 'acme.solar' })
    await waitFor(() => t.state().themeVariables['--bg'] === DEFAULT_THEME.colors.bg)
    expect(t.state().themeVariables).toEqual(defaults)
    expect(t.state().model!.theme).toEqual({ chosen: SOLAR, active: 'default' })

    await t.agent.call('plugin.enable', { id: 'acme.solar' })
    await waitFor(() => t.state().themeVariables['--bg'] === '#fdf6e3')
    expect(t.state().themeVariables).toEqual(solarVariables)
  })
})
