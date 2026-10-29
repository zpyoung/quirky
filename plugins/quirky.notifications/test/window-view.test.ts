import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'

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
  const switchOf = (id: string) => row(id).querySelector('[role="switch"]') as HTMLInputElement
  const byLabel = (name: string) => [...root.querySelectorAll('label')].find((label) => label.textContent?.trim() === name)?.control ?? null
  const select = () => byLabel('Notification Sound') as HTMLSelectElement
  const slider = () => q('input[type="range"]') as HTMLInputElement | null
  const pathField = () => byLabel('Custom sound file path') as HTMLInputElement | null
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
  }
}

const DEPENDENT = ['agentTaskComplete', 'terminalBell', 'terminalNotifications', 'sound', 'suppressWhenFocused']


describe('SC-48: the sound controls', () => {
  test('choosing a built-in sound saves it and previews it', async () => {
    const fake = fakeContext({ 'quirky.notifications/preview': () => ({ played: true }) })
    const v = await open(fake)
    await v.choose('bong')
    expect(fake.callsTo('setting.set')).toEqual([{ method: 'setting.set', params: { id: SETTING('sound'), value: 'bong' } }])
    expect(fake.callsTo('quirky.notifications/preview').map((call) => call.params)).toEqual([{ sound: 'bong' }])
  })

  test('choosing a custom path previews and saves it, then hides it when a built-in is selected', async () => {
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
    expect(v.text()).toContain('/Users/me/ping.wav')
    await v.choose('bong')
    expect(v.text()).not.toContain('/Users/me/ping.wav')
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

  test('changing a stored custom path reopens it with its saved value', async () => {
    const v = await open(fakeContext({}, { sound: 'custom', customSoundPath: '/tmp/ping.wav' }))
    expect(v.text()).toContain('/tmp/ping.wav')
    await v.click(v.button('Change'))
    expect(v.pathField()!.value).toBe('/tmp/ping.wav')
  })

  test('the slider saves on change, not on input, and shows the percentage while dragging', async () => {
    const fake = fakeContext({}, { sound: 'bong' })
    const v = await open(fake)
    const slider = v.slider()!
    await v.type(slider, '40')
    expect(fake.callsTo('setting.set')).toEqual([])
    expect(v.text()).toContain('40%')
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

describe('SC-49: turning notifications off disables what depends on it', () => {
  test('SC-49: every dependent control is disabled, and Show Menu Bar Icon is not', async () => {
    const fake = fakeContext({}, { sound: 'bong' })
    const v = await open(fake)
    await v.click(v.switchOf('enabled'))
    expect(fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: SETTING('enabled'), value: false }])
    for (const id of DEPENDENT) {
      const control = v.row(id).querySelector('button, select, input') as HTMLButtonElement | HTMLSelectElement | HTMLInputElement
      expect(control.disabled).toBe(true)
    }
    expect(v.slider()!.disabled).toBe(true)
    expect(v.button('Send Test Notification')!.disabled).toBe(true)
    expect(v.switchOf('showMenuBarIcon').disabled).toBe(false)
    expect(v.switchOf('enabled').disabled).toBe(false)
  })

  test('SC-49: turning it back on enables them again', async () => {
    const v = await open(fakeContext({}, { enabled: false }))
    expect(v.switchOf('terminalBell').disabled).toBe(true)
    await v.click(v.switchOf('enabled'))
    expect(v.switchOf('terminalBell').disabled).toBe(false)
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
    expect(reports.at(-1)).toMatchObject({ customPathOpen: false, customPathError: null })
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

describe('opening settings', () => {
  test('the settings command opens the settings view', async () => {
    const fake = fakeContext()
    activate(fake.context)
    await act(async () => void (await fake.provided.get(COMMAND_ID)!()))
    expect(fake.opened).toEqual([{ id: VIEW_ID, input: undefined }])
  })
})

