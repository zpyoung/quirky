import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'

type Ui = typeof import('../src/ui')
type Mount = (element: HTMLElement, props: object) => (() => void) | void
type Call = { method: string; params: Record<string, unknown> | undefined }

const ACTIVE = 'setting:quirky.feedback/active'
const ENABLED = 'setting:quirky.feedback/enabled'
const root = join(import.meta.dir, '..')

let ui: Ui
let originalLoad: Ui['modeLoader']['load']

beforeAll(async () => {
  GlobalRegistrator.register()
  ui = await import('../src/ui')
  originalLoad = ui.modeLoader.load
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  ui.modeLoader.load = originalLoad
  ui.deactivate()
  setUrl('http://localhost/')
})

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type Harness = ReturnType<typeof harness>

function harness(initial: { active?: boolean; enabled?: boolean } = {}) {
  const settings: Record<string, unknown> = { active: initial.active ?? false, enabled: initial.enabled ?? true }
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const provided = new Map<string, unknown>()
  const calls: Call[] = []
  const toasts: { title: string; body: string }[] = []
  const keys = new Map<string, boolean | undefined>()
  const trace: string[] = []
  const handlers = {
    setWrite: null as null | ((params: Record<string, unknown>) => Promise<unknown>),
    command: null as null | ((params: Record<string, unknown> | undefined) => Promise<unknown>)
  }
  const emit = (id: string, value: boolean) => {
    settings[id.split('/')[1]!] = value
    for (const listener of [...listeners]) listener({ type: 'setting.changed', id, value } as QuirkyEvent)
  }
  const context = {
    pluginId: 'quirky.feedback',
    log: () => {},
    provide: (id: string, implementation: unknown) => { provided.set(id, implementation) },
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'setting.set') {
        trace.push(`set ${String(params?.value)}`)
        if (handlers.setWrite) return handlers.setWrite(params!)
        emit(String(params?.id), params?.value as boolean)
        return { ok: true }
      }
      if (method === 'ui.command.run') {
        trace.push('run')
        return handlers.command ? handlers.command(params) : { result: { started: true } }
      }
      throw new Error(`unexpected ${method}`)
    },
    subscribe: (listener: (event: QuirkyEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSetting: (name: string) => {
      const key = name.replace('setting:quirky.feedback/', '')
      if (!(key in settings)) throw new Error(`no setting ${name}`)
      return settings[key]
    },
    toast: (title: string, body: string) => { toasts.push({ title, body }) },
    setContext: (key: string, value: boolean | undefined) => { keys.set(key, value) }
  } as unknown as UiPluginContext
  const mounts: { context: UiPluginContext; options: { annotate(pane: string): Promise<void> }; unmounted: number }[] = []
  const loads = { count: 0, pending: null as null | Promise<void> }
  const useLoader = (gate?: Promise<void>) => {
    ui.modeLoader.load = async () => {
      loads.count++
      if (gate) await gate
      return {
        mountFeedbackMode: (ctx: UiPluginContext, options: { annotate(pane: string): Promise<void> }) => {
          const entry = { context: ctx, options, unmounted: 0 }
          mounts.push(entry)
          trace.push('mode on')
          return () => { entry.unmounted++; trace.push('mode off') }
        }
      }
    }
  }
  useLoader()
  ui.activate(context)
  const overlay = () => provided.get('overlay:quirky.feedback/mode') as Mount
  return { context, settings, emit, calls, toasts, keys, trace, mounts, loads, handlers, provided, overlay, useLoader, listeners }
}

const mountOverlay = (h: Harness) => (h.overlay()(document.createElement('div'), {}) ?? (() => {})) as () => void
const writes = (h: Harness) => h.calls.filter((call) => call.method === 'setting.set')
const live = (h: Harness) => h.mounts.filter((entry) => entry.unmounted === 0)

describe('stub source', () => {
  test('imports nothing heavy statically', () => {
    const source = readFileSync(join(root, 'src/ui.tsx'), 'utf8')
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]!)
    const banned = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@quirky/ui', './mode', './capture', './format', './issue', './contract']
    for (const specifier of specifiers) {
      expect(banned.some((name) => specifier === name || specifier.startsWith(`${name}/`) && !specifier.startsWith('@quirky/ui/desktop-bridge'))).toBe(false)
    }
    expect(source).toContain("import('./mode')")
    expect(/import\s+['"]/.test(source)).toBe(false)
  })
})

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'quirky-plugin.json'), 'utf8'))
  test('declares the ui module and one lazy overlay', () => {
    expect(manifest.ui).toBe('dist/ui.js')
    expect(manifest.apiVersion).toBe('1.2.0')
    expect(manifest.activation).toBe('lazy')
    expect(manifest.contributes.overlay).toEqual([{ id: 'mode', title: 'Feedback mode' }])
    expect(manifest.contributes.method.map((entry: { id: string }) => entry.id)).toEqual(['list', 'add', 'update', 'remove', 'clear'])
  })
  test('declares the settings', () => {
    const [enabled, active] = manifest.contributes.setting
    expect(enabled).toMatchObject({ id: 'enabled', title: 'Enable Feedback Mode', type: 'boolean', default: true })
    expect(enabled.description).toBeString()
    expect(enabled.menu).toBeUndefined()
    expect(active).toMatchObject({ id: 'active', title: 'Feedback Mode', type: 'boolean', default: false, menu: 'view', whenSetting: 'enabled', description: 'Turns selection on in the main window.' })
  })
  test('declares the command and keybinding', () => {
    expect(manifest.contributes.command).toEqual([{ id: 'toggle', title: 'Toggle Feedback Mode', palette: true, whenSetting: 'enabled' }])
    expect(manifest.contributes.keybinding).toHaveLength(1)
    expect(manifest.contributes.keybinding[0]).toMatchObject({ key: 'mod+alt+k', command: 'toggle', whenSetting: 'enabled', when: 'terminalFocus || !terminalFocus' })
  })
})

describe('registration', () => {
  test('provides the overlay and the toggle command', () => {
    const h = harness()
    expect(h.provided.has('overlay:quirky.feedback/mode')).toBe(true)
    expect(h.provided.has('command:quirky.feedback/toggle')).toBe(true)
  })

  test('toggle flips active', async () => {
    const h = harness()
    const toggle = h.provided.get('command:quirky.feedback/toggle') as () => Promise<unknown>
    await toggle()
    expect(writes(h).at(-1)?.params).toEqual({ id: ACTIVE, value: true })
    await toggle()
    expect(writes(h).at(-1)?.params).toEqual({ id: ACTIVE, value: false })
  })

  test('toggle does nothing while the feature is disabled', async () => {
    const h = harness({ enabled: false })
    await (h.provided.get('command:quirky.feedback/toggle') as () => Promise<unknown>)()
    expect(writes(h)).toHaveLength(0)
  })
})

describe('overlay lifecycle', () => {
  test('turns active off once at startup', async () => {
    const h = harness({ active: true })
    mountOverlay(h)
    await flush()
    expect(writes(h)).toEqual([{ method: 'setting.set', params: { id: ACTIVE, value: false } }])
    expect(h.loads.count).toBe(0)
    mountOverlay(h)
    await flush()
    expect(writes(h)).toHaveLength(1)
  })

  test('does nothing in an auxiliary window', async () => {
    setUrl('http://localhost/?quirkyWindowId=w1&quirkyOwnerShellConnId=3&quirkyView=view%3Ax')
    const h = harness({ active: true })
    mountOverlay(h)
    h.emit(ACTIVE, true)
    await flush()
    expect(h.calls).toHaveLength(0)
    expect(h.listeners.size).toBe(0)
    expect(h.loads.count).toBe(0)
  })

  test('mounts and unmounts the mode as active changes', async () => {
    const h = harness()
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    expect(live(h)).toHaveLength(1)
    expect(h.mounts[0]!.context).toBe(h.context)
    expect(h.keys.get('feedbackMode')).toBe(true)
    h.emit(ACTIVE, false)
    await flush()
    expect(live(h)).toHaveLength(0)
    expect(h.keys.get('feedbackMode')).toBeUndefined()
  })

  test('does not mount twice for repeated true events', async () => {
    const h = harness()
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    h.emit(ACTIVE, true)
    await flush()
    expect(h.mounts).toHaveLength(1)
  })

  test('unmounting the overlay tears the mode down and unsubscribes', async () => {
    const h = harness()
    const unmount = mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    unmount()
    expect(live(h)).toHaveLength(0)
    expect(h.listeners.size).toBe(0)
  })

  test('a remount while active is true mounts the mode without a second turn-off', async () => {
    const h = harness()
    const unmount = mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    unmount()
    mountOverlay(h)
    await flush()
    expect(live(h)).toHaveLength(1)
    expect(writes(h).filter((call) => call.params?.value === false)).toHaveLength(1)
  })

  test('the mode waits for the startup turn-off to settle', async () => {
    const h = harness()
    let release!: () => void
    h.handlers.setWrite = () => new Promise((resolve) => { release = () => resolve({ ok: true }) })
    mountOverlay(h)
    h.emit(ACTIVE, true)
    await flush()
    expect(h.loads.count).toBe(0)
    release()
    await flush()
    expect(live(h)).toHaveLength(1)
  })

  test('a failed startup turn-off does not block the mode', async () => {
    const h = harness()
    h.handlers.setWrite = () => Promise.reject(new Error('offline'))
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    expect(live(h)).toHaveLength(1)
  })

  test('active turning false while the import is pending skips the mount', async () => {
    const h = harness()
    let open!: () => void
    h.useLoader(new Promise<void>((resolve) => { open = resolve }))
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    expect(h.loads.count).toBe(1)
    h.emit(ACTIVE, false)
    open()
    await flush()
    expect(h.mounts).toHaveLength(0)
  })

  test('a failed import toasts, turns active off and retries on the next activation', async () => {
    const h = harness()
    let attempts = 0
    const good = ui.modeLoader.load
    ui.modeLoader.load = async () => {
      attempts++
      if (attempts === 1) throw new Error('chunk missing')
      return good()
    }
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]!.body).toContain('chunk missing')
    expect(writes(h).at(-1)?.params).toEqual({ id: ACTIVE, value: false })
    expect(h.settings.active).toBe(false)
    h.emit(ACTIVE, true)
    await flush()
    expect(attempts).toBe(2)
    expect(live(h)).toHaveLength(1)
  })

  test('disabling the feature while active also writes active false', async () => {
    const h = harness()
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    h.emit(ENABLED, false)
    await flush()
    expect(live(h)).toHaveLength(0)
    expect(writes(h).at(-1)?.params).toEqual({ id: ACTIVE, value: false })
    h.emit(ENABLED, true)
    await flush()
    expect(live(h)).toHaveLength(0)
  })
})

describe('annotate this page', () => {
  async function started(h: Harness) {
    mountOverlay(h)
    await flush()
    h.emit(ACTIVE, true)
    await flush()
    h.trace.length = 0
    return h.mounts[0]!.options
  }

  test('turns the mode off before it starts Browser Annotate', async () => {
    const h = harness()
    const options = await started(h)
    await options.annotate('pane-1')
    expect(h.trace).toEqual(['set false', 'mode off', 'run'])
    const run = h.calls.find((call) => call.method === 'ui.command.run')!
    expect(run.params).toEqual({ id: 'command:quirky.browser/design', args: { action: 'annotate', pane: 'pane-1' } })
    expect(h.toasts).toHaveLength(0)
  })

  test('shows the reason when annotate does not start', async () => {
    const h = harness()
    const options = await started(h)
    h.handlers.command = async () => ({ result: { started: false, reason: 'Pane is not ready.' } })
    await options.annotate('pane-1')
    expect(h.toasts.map((toast) => toast.body)).toEqual(['Pane is not ready.'])
  })

  test('shows the error when the command rejects', async () => {
    const h = harness()
    const options = await started(h)
    h.handlers.command = async () => { throw new Error('no command') }
    await options.annotate('pane-1')
    expect(h.toasts[0]!.body).toContain('no command')
  })

  test('leaves the mode running when the setting write fails', async () => {
    const h = harness()
    const options = await started(h)
    h.handlers.setWrite = () => Promise.reject(new Error('denied'))
    await options.annotate('pane-1')
    expect(h.trace).toEqual(['set false'])
    expect(live(h)).toHaveLength(1)
    expect(h.toasts[0]!.body).toContain('denied')
  })
})
