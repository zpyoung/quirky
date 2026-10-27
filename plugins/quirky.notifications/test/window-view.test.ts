import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import manifest from '../quirky-plugin.json'

const VIEW_ID = 'view:quirky.notifications/settings'
const COMMAND_ID = 'command:quirky.notifications/open-settings'
const SETTING = (name: string) => `setting:quirky.notifications/${name}`

type Handler = (params: Record<string, any>) => unknown

const DEFAULTS: Record<string, boolean | number | string> = {
  enabled: true,
  agentTaskComplete: true,
  terminalBell: false,
  terminalNotifications: true,
  sound: 'system',
  customSoundPath: '',
  volume: 100,
  suppressWhenFocused: true,
  showMenuBarIcon: true
}

const SETTLE_MS = 5

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  })
}

/** A `UiPluginContext` over an in-memory settings store whose `setting.set` announces `setting.changed`, as the daemon does. */
function fakeContext(handlers: Record<string, Handler> = {}, initial: Record<string, boolean | number | string> = {}) {
  const values = { ...DEFAULTS, ...initial }
  const calls: { method: string; params: Record<string, any> }[] = []
  const provided = new Map<string, (...args: any[]) => any>()
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const nameOf = (id: string) => id.replace('setting:quirky.notifications/', '')

  const announce = (event: QuirkyEvent) => void listeners.forEach((listener) => listener(event))

  const defaults: Record<string, Handler> = {
    'setting.set': (params) => {
      values[nameOf(params.id)] = params.value
      announce({ type: 'setting.changed', id: params.id, value: params.value })
      return {}
    }
  }

  const context = {
    pluginId: 'quirky.notifications',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation as (...args: any[]) => any)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method] ?? defaults[method]
      if (!handler) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
      return handler(params)
    },
    subscribe(listener: (event: QuirkyEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSetting(name: string) {
      const key = nameOf(name)
      if (!(key in values)) throw new Error(`no setting ${name}`)
      return values[key]
    },
    async executeCommand() {},
    openView(id: string, input?: unknown) {
      opened.push({ id, input })
    },
    closeView() {},
    togglePanel() {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    async confirm() {
      return true
    },
    toast(title: string, body: string) {
      toasts.push({ title, body })
    },
    setPanelBadge() {}
  } as unknown as UiPluginContext

  return {
    context,
    values,
    calls,
    opened,
    toasts,
    provided,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    announce,
    external: (name: string, value: boolean | number | string) => {
      values[name] = value
      return act(async () => announce({ type: 'setting.changed', id: SETTING(name), value }))
    }
  }
}

type Fake = ReturnType<typeof fakeContext>

let activate: (context: UiPluginContext) => void
let element: HTMLElement | null = null
let unmount: (() => void) | void = undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ activate } = await import('../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (unmount) await act(async () => void (unmount as () => void)())
  unmount = undefined
  document.body.innerHTML = ''
  element = null
})

const reports: unknown[] = []

async function open(fake: Fake) {
  reports.length = 0
  activate(fake.context)
  element = document.createElement('div')
  document.body.appendChild(element)
  await act(async () => {
    unmount = fake.provided.get(VIEW_ID)!(element, { input: undefined, report: (state: unknown) => void reports.push(state) })
  })
  await settle()
  const root = element
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null
  const row = (id: string) => q(`[data-setting="${id}"]`)!
  const switchOf = (id: string) => row(id).querySelector('[role="switch"]') as HTMLButtonElement
  const select = () => q('select') as HTMLSelectElement
  const slider = () => q('input[type="range"]') as HTMLInputElement | null
  const pathField = () => q('input[type="text"]') as HTMLInputElement | null
  const button = (name: string) =>
    ([...root.querySelectorAll('button')] as HTMLButtonElement[]).find((node) => node.textContent?.trim() === name) ?? null
  return {
    root,
    q,
    row,
    switchOf,
    select,
    slider,
    pathField,
    button,
    text: () => root.textContent ?? '',
    click: async (target: Element | null) => {
      if (!target) throw new Error('nothing to click')
      await act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await settle()
    },
    choose: async (value: string) => {
      await act(async () => {
        const control = select()
        control.value = value
        control.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await settle()
    },
    type: async (field: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    fire: (field: HTMLElement, type: string) => act(async () => void field.dispatchEvent(new Event(type, { bubbles: true }))),
    options: () => [...select().querySelectorAll('option')].map((option) => ({ value: option.value, label: option.textContent!.trim(), disabled: option.disabled }))
  }
}

const SETTING_ORDER = ['enabled', 'agentTaskComplete', 'terminalBell', 'terminalNotifications', 'sound', 'suppressWhenFocused', 'showMenuBarIcon']
const DEPENDENT = ['agentTaskComplete', 'terminalBell', 'terminalNotifications', 'sound', 'suppressWhenFocused']
const declared = (id: string) => manifest.contributes.setting.find((entry) => entry.id === id)!

describe('SC-47: Settings > Notifications at its defaults', () => {
  test('SC-47: the view shows the title, the subtitle, the rows in order, and the test button last', async () => {
    const v = await open(fakeContext())
    expect(v.q('h1')!.textContent).toBe('Notifications')
    expect(v.text()).toContain('Native desktop notifications for agent activity and terminal events.')
    expect([...v.root.querySelectorAll('[data-setting]')].map((node) => node.getAttribute('data-setting'))).toEqual(SETTING_ORDER)
    const last = [...v.root.querySelectorAll('button')].at(-1)!
    expect(last.textContent).toBe('Send Test Notification')
  })

  test('SC-47: each row shows its title and the description the manifest declares', async () => {
    const v = await open(fakeContext())
    for (const id of SETTING_ORDER) {
      expect(v.row(id).textContent).toContain(declared(id).title)
      expect(v.row(id).textContent).toContain(declared(id).description!)
    }
  })

  test('SC-47: the switches show the defaults and the sound is System Default with no volume slider', async () => {
    const v = await open(fakeContext())
    const states = ['enabled', 'agentTaskComplete', 'terminalBell', 'terminalNotifications', 'suppressWhenFocused', 'showMenuBarIcon'].map((id) =>
      v.switchOf(id).getAttribute('aria-checked')
    )
    expect(states).toEqual(['true', 'true', 'false', 'true', 'true', 'true'])
    expect(v.select().value).toBe('system')
    expect(v.select().selectedOptions[0]!.textContent).toBe('System Default')
    expect(v.slider()).toBeNull()
    expect(v.q('.notif-custom')).toBeNull()
  })

  test('SC-47: the sound options are System Default, the nine built-ins in order, then Choose Custom File', async () => {
    const v = await open(fakeContext())
    expect(v.options().filter((option) => !option.disabled).map((option) => option.label)).toEqual([
      'System Default',
      'Two Tone',
      'Bong',
      'Thump',
      'Blip',
      'Sonar',
      'Blop',
      'Ding',
      'Clack',
      'Beep',
      'Choose Custom File'
    ])
    expect(v.options().at(-2)!.disabled).toBe(true)
  })

  test('a stored custom path renames the last option to Change Custom File', async () => {
    const v = await open(fakeContext({}, { customSoundPath: '/tmp/ping.wav' }))
    expect(v.options().at(-1)!.label).toBe('Change Custom File')
  })
})

describe('SC-48: the sound controls', () => {
  test('SC-48: Bong sets the sound and previews it, and the volume slider appears at 100%', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: true }) })
    const v = await open(fake)
    await v.choose('bong')
    expect(fake.callsTo('setting.set')).toEqual([{ method: 'setting.set', params: { id: SETTING('sound'), value: 'bong' } }])
    expect(fake.callsTo('quirky.notifications/preview').map((call) => call.params)).toEqual([{ sound: 'bong' }])
    const slider = v.slider()!
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('100')
    expect(slider.step).toBe('5')
    expect(slider.getAttribute('aria-label')).toBe('Notification sound volume')
    expect(slider.value).toBe('100')
    expect(v.q('.notif-volume')!.textContent).toContain('100%')
  })

  test('SC-48: Custom shows the typed path under the select only while Custom is the sound', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: true }) })
    const v = await open(fake)
    await v.choose('bong')
    await v.choose('custom')
    expect(v.pathField()).not.toBeNull()
    await v.type(v.pathField()!, '/Users/me/ping.wav')
    await v.click(v.button('Use'))
    expect(fake.callsTo('quirky.notifications/preview').at(-1)!.params).toEqual({ path: '/Users/me/ping.wav', volume: 100 })
    expect(fake.callsTo('setting.set').map((call) => call.params)).toEqual([
      { id: SETTING('sound'), value: 'bong' },
      { id: SETTING('customSoundPath'), value: '/Users/me/ping.wav' },
      { id: SETTING('sound'), value: 'custom' }
    ])
    expect(v.pathField()).toBeNull()
    const line = v.q('.notif-custom')!
    expect(line.textContent).toBe('Custom: /Users/me/ping.wav')
    expect(line.querySelector('code')).not.toBeNull()
    await v.choose('bong')
    expect(v.q('.notif-custom')).toBeNull()
    expect(v.text()).not.toContain('Custom: ')
  })

  test('SC-48: a refused path shows the reason under the field and saves nothing', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: false, reason: 'ping.xyz is not an audio file' }) })
    const v = await open(fake)
    await v.choose('custom')
    await v.type(v.pathField()!, '/tmp/ping.xyz')
    await v.click(v.button('Use'))
    expect(v.q('[role="alert"]')!.textContent).toBe('ping.xyz is not an audio file')
    expect(fake.callsTo('setting.set')).toEqual([])
    expect(v.pathField()!.value).toBe('/tmp/ping.xyz')
    expect(reports.at(-1)).toMatchObject({ customPathOpen: true, customPathError: 'ping.xyz is not an audio file' })
  })

  test('a failed preview call is shown as the reason too', async () => {
    const fake = fakeContext({
      'quirky.notifications/preview': () => {
        throw new RpcError(RpcErrorCode.InvalidParams, 'volume must be a number from 0 to 100')
      }
    })
    const v = await open(fake)
    await v.choose('custom')
    await v.type(v.pathField()!, '/tmp/ping.wav')
    await v.click(v.button('Use'))
    expect(v.q('[role="alert"]')!.textContent).toBe('volume must be a number from 0 to 100')
    expect(fake.callsTo('setting.set')).toEqual([])
  })

  test('picking a built-in sound closes an open path field', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: true }) })
    const v = await open(fake)
    await v.choose('custom')
    expect(v.pathField()).not.toBeNull()
    await v.choose('ding')
    expect(v.pathField()).toBeNull()
    expect(fake.values.sound).toBe('ding')
  })

  test('with Custom stored, the Custom line shows and Change reopens the field with the path', async () => {
    const v = await open(fakeContext({}, { sound: 'custom', customSoundPath: '/tmp/ping.wav' }))
    expect(v.q('.notif-custom')!.textContent).toBe('Custom: /tmp/ping.wav')
    expect(v.select().selectedOptions[0]!.textContent).toBe('Change Custom File')
    await v.click(v.button('Change'))
    expect(v.pathField()!.value).toBe('/tmp/ping.wav')
  })

  test('the slider saves on change, not on input, and shows the percentage while dragging', async () => {
    const fake = fakeContext({}, { sound: 'bong' })
    const v = await open(fake)
    const slider = v.slider()!
    await v.type(slider, '40')
    expect(fake.callsTo('setting.set')).toEqual([])
    expect(v.q('.notif-volume')!.textContent).toContain('40%')
    await v.fire(slider, 'change')
    await settle()
    expect(fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: SETTING('volume'), value: 40 }])
  })

  test('the volume slider is hidden again for System Default', async () => {
    const fake = fakeContext({}, { sound: 'bong' })
    const v = await open(fake)
    expect(v.slider()).not.toBeNull()
    await v.choose('system')
    expect(v.slider()).toBeNull()
    expect(fake.callsTo('quirky.notifications/preview')).toEqual([])
  })
})

describe('SC-49: turning notifications off dims what depends on it', () => {
  test('SC-49: every dependent control is disabled and dimmed, and Show Menu Bar Icon is not', async () => {
    const fake = fakeContext({}, { sound: 'bong' })
    const v = await open(fake)
    await v.click(v.switchOf('enabled'))
    expect(fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: SETTING('enabled'), value: false }])
    for (const id of DEPENDENT) {
      expect(v.row(id).classList.contains('notif-dim')).toBe(true)
      const control = v.row(id).querySelector('button, select') as HTMLButtonElement | HTMLSelectElement
      expect(control.disabled).toBe(true)
    }
    expect(v.slider()!.disabled).toBe(true)
    expect(v.button('Send Test Notification')!.disabled).toBe(true)
    expect(v.button('Send Test Notification')!.classList.contains('notif-dim')).toBe(true)
    expect(v.row('showMenuBarIcon').classList.contains('notif-dim')).toBe(false)
    expect(v.switchOf('showMenuBarIcon').disabled).toBe(false)
    expect(v.switchOf('enabled').disabled).toBe(false)
  })

  test('SC-49: turning it back on enables them again', async () => {
    const v = await open(fakeContext({}, { enabled: false }))
    expect(v.switchOf('terminalBell').disabled).toBe(true)
    await v.click(v.switchOf('enabled'))
    expect(v.switchOf('terminalBell').disabled).toBe(false)
    expect(v.row('terminalBell').classList.contains('notif-dim')).toBe(false)
    expect(v.button('Send Test Notification')!.disabled).toBe(false)
  })
})

describe('SC-50: Send Test Notification always answers', () => {
  const run = async (result: unknown) => {
    const fake = fakeContext({
      'quirky.notifications/test': () => {
        if (result instanceof Error) throw result
        return result
      }
    })
    const v = await open(fake)
    await v.click(v.button('Send Test Notification'))
    return fake
  }

  test('SC-50: delivered toasts the macOS permission hint', async () => {
    const fake = await run({ delivered: true, reason: 'delivered' })
    expect(fake.toasts).toEqual([
      { title: 'Test notification requested', body: 'If no macOS banner appeared, turn on Allow notifications for Quirky in System Settings.' }
    ])
  })

  test('SC-50: disabled toasts "Notifications are disabled"', async () => {
    const fake = await run({ delivered: false, reason: 'disabled' })
    expect(fake.toasts).toEqual([{ title: 'Notifications are disabled', body: '' }])
  })

  test.each(['source-disabled', 'suppressed-focus', 'cooldown', 'dropped'])('SC-50: %s toasts "Test notification was not delivered"', async (reason) => {
    const fake = await run({ delivered: false, reason })
    expect(fake.toasts).toEqual([{ title: 'Test notification was not delivered', body: '' }])
  })

  test('SC-50: a failed call still toasts once', async () => {
    const fake = await run(new RpcError(RpcErrorCode.Internal, 'daemon went away'))
    expect(fake.toasts).toEqual([{ title: 'Test notification was not delivered', body: 'daemon went away' }])
  })
})

describe('saving and following settings', () => {
  test('a switch saves through setting.set with the full setting ID', async () => {
    const fake = fakeContext()
    const v = await open(fake)
    await v.click(v.switchOf('terminalBell'))
    expect(fake.callsTo('setting.set')).toEqual([{ method: 'setting.set', params: { id: SETTING('terminalBell'), value: true } }])
    expect(v.switchOf('terminalBell').getAttribute('aria-checked')).toBe('true')
  })

  test('a refused save is toasted and the switch keeps its value', async () => {
    const fake = fakeContext({
      'setting.set': () => {
        throw new RpcError(RpcErrorCode.InvalidParams, 'nope')
      }
    })
    const v = await open(fake)
    await v.click(v.switchOf('terminalBell'))
    expect(fake.toasts).toEqual([{ title: 'Could not change the setting', body: 'nope' }])
    expect(v.switchOf('terminalBell').getAttribute('aria-checked')).toBe('false')
  })

  test('a change from elsewhere shows without reopening', async () => {
    const fake = fakeContext()
    const v = await open(fake)
    await fake.external('terminalBell', true)
    await fake.external('sound', 'sonar')
    await fake.external('enabled', false)
    expect(v.switchOf('terminalBell').getAttribute('aria-checked')).toBe('true')
    expect(v.select().value).toBe('sonar')
    expect(v.slider()).not.toBeNull()
    expect(v.switchOf('suppressWhenFocused').disabled).toBe(true)
  })

  test('a change to another plugin\'s setting is ignored', async () => {
    const fake = fakeContext()
    await open(fake)
    const before = reports.length
    await act(async () => fake.announce({ type: 'setting.changed', id: 'setting:quirky.agents/workspace-trust', value: false }))
    expect(reports.length).toBe(before)
  })

  test('the view reports the settings and the custom path field state', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: false, reason: 'missing' }) })
    const v = await open(fake)
    expect(reports.at(-1)).toEqual({
      settings: { ...DEFAULTS },
      customPathOpen: false,
      customPathError: null
    })
    await v.choose('custom')
    expect(reports.at(-1)).toMatchObject({ customPathOpen: true, customPathError: null })
    await v.type(v.pathField()!, '/x.wav')
    await v.click(v.button('Use'))
    expect(reports.at(-1)).toMatchObject({ customPathOpen: true, customPathError: 'missing' })
    await fake.external('terminalBell', true)
    expect((reports.at(-1) as { settings: Record<string, unknown> }).settings.terminalBell).toBe(true)
  })

  test('unmounting stops following events', async () => {
    const fake = fakeContext()
    const v = await open(fake)
    await act(async () => void (unmount as () => void)())
    unmount = undefined
    const before = reports.length
    await fake.external('terminalBell', true)
    expect(reports.length).toBe(before)
    expect(v.root.textContent).toBe('')
  })
})

describe('the declarations and the command', () => {
  test('the manifest points at the built module and declares the Notifications view', () => {
    expect(manifest.ui).toBe('dist/ui.js')
    expect(manifest.contributes.view).toEqual([{ id: 'settings', title: 'Notifications' }])
    expect(manifest.contributes.command).toEqual([{ id: 'open-settings', title: 'Open notification settings' }])
  })

  test('SC-47: "Open notification settings" opens the view', async () => {
    const fake = fakeContext()
    activate(fake.context)
    expect(fake.provided.has(VIEW_ID)).toBe(true)
    await act(async () => void (await fake.provided.get(COMMAND_ID)!()))
    expect(fake.opened).toEqual([{ id: VIEW_ID, input: undefined }])
  })
})

describe('the module build', () => {
  test('bundles for the browser with React left to the window and no node built-ins', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '..', 'src', 'ui.tsx')],
      target: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    expect(result.logs.filter((log) => log.level === 'error')).toEqual([])
    expect(result.success).toBe(true)
    const code = await result.outputs[0]!.text()
    expect(code).toMatch(/export\s*\{[^}]*activate/)
    expect(code).not.toContain('node:fs')
  })
})
