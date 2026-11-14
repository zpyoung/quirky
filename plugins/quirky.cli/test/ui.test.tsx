import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { CliLaunchTarget, InstalledCommandStatus, PairedRuntimeSummary, ProfileLauncherStatus } from '@quirky/protocol/node'

const SETTINGS_VIEW = 'view:quirky.cli/settings'

type Call = { method: string; params: Record<string, unknown> }
type Status = InstalledCommandStatus
type Target = {
  available: boolean
  executablePath: CliLaunchTarget['executablePath'] | null
  entrypointPath: CliLaunchTarget['entrypointPath'] | null
}
type Launcher = ProfileLauncherStatus
type Runtime = PairedRuntimeSummary
type ConfirmOptions = Parameters<UiPluginContext['confirm']>[0]
type SetupOptions = {
  status?: Status
  target?: Target
  launchers?: Launcher[]
  runtimes?: Runtime[]
  handlers?: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>
  confirm?: (options: ConfirmOptions) => boolean | Promise<boolean>
}

let activate: (context: UiPluginContext) => void
let act: (callback: () => unknown) => Promise<void>
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM must load only after Happy DOM installs the browser globals.
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

function setup(options: SetupOptions = {}) {
  const status = options.status ?? {
    state: 'missing' as const,
    path: '/tmp/quirky-cli/quirky',
    target: null,
    profileHome: '/tmp/quirky-profile'
  }
  const target = options.target ?? { available: false, executablePath: null, entrypointPath: null }
  const launchers = options.launchers ?? []
  const runtimes = options.runtimes ?? []
  const responses: Record<string, unknown> = {
    'quirky.cli/commandStatus': status,
    'quirky.cli/commandTarget': target,
    'quirky.cli/profileLauncherList': { launchers },
    'quirky.cli/runtimeList': { runtimes },
    'quirky.cli/commandInstall': {},
    'quirky.cli/commandReveal': {},
    'quirky.cli/commandUninstall': {},
    'quirky.cli/profileLauncherInstall': {},
    'quirky.cli/profileLauncherRemove': {},
    'quirky.cli/runtimeAdd': {},
    'quirky.cli/runtimeRemove': {}
  }
  const calls: Call[] = []
  const confirmations: ConfirmOptions[] = []
  const provided = new Map<string, unknown>()
  const context = {
    pluginId: 'quirky.cli',
    log() {},
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = options.handlers?.[method]
      if (handler) return handler(params)
      if (method === 'desktop.folder.pick') return { cancelled: true, paths: [] }
      if (Object.hasOwn(responses, method)) return responses[method]
      throw new Error(`unexpected call ${method}`)
    },
    async confirm(prompt: ConfirmOptions) {
      confirmations.push(prompt)
      return options.confirm?.(prompt) ?? true
    }
  } as unknown as UiPluginContext

  activate(context)
  let dispose = () => {}
  return {
    calls,
    confirmations,
    async mount() {
      await act(async () => {
        const implementation = provided.get(SETTINGS_VIEW) as ((element: HTMLElement) => () => void) | undefined
        if (!implementation) throw new Error(`no UI mount for ${SETTINGS_VIEW}`)
        dispose = implementation(host)
      })
      await act(async () => await waitForNextTask())
      return async () => act(async () => dispose())
    }
  }
}

async function waitForNextTask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function input(label: string): HTMLInputElement {
  const fieldLabel = [...host.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => candidate.textContent?.trim() === label)
  if (!fieldLabel) throw new Error(`no field named ${label}`)
  const field = document.getElementById(fieldLabel.htmlFor)
  if (!(field instanceof HTMLInputElement)) throw new Error(`no input for ${label}`)
  return field
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(label: string) {
  await act(async () => {
    button(label).click()
    await waitForNextTask()
  })
}

test('unavailable CLI targets remain visible and disable installation', async () => {
  const view = setup()
  const dispose = await view.mount()

  expect(host.textContent).toContain('Status: missing')
  expect(host.textContent).toContain('Path: /tmp/quirky-cli/quirky')
  expect(host.textContent).toContain('Profile: /tmp/quirky-profile')
  expect(host.textContent).toContain('No verified CLI entrypoint is available')
  expect(button('Install command').disabled).toBe(true)
  await dispose()
})

test('initial status errors stay visible and retry reloads the view', async () => {
  let failFirstRead = true
  const view = setup({
    handlers: {
      'quirky.cli/commandStatus': () => {
        if (failFirstRead) {
          failFirstRead = false
          throw new Error('daemon connection unavailable')
        }
        return { state: 'missing', path: '/tmp/quirky-cli/quirky', target: null, profileHome: '/tmp/quirky-profile' }
      }
    }
  })
  const dispose = await view.mount()

  expect(host.querySelector('[role="alert"]')?.textContent).toContain('daemon connection unavailable')
  await click('Retry status')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('pre')?.textContent).toContain('Status: missing')
  await dispose()
})


test('foreign command replacement requires confirmation before the managed state appears', async () => {
  let confirmed = false
  const status: Status = { state: 'foreign', path: '/tmp/foreign/quirky', target: null, profileHome: '/tmp/profile-a' }
  const view = setup({
    status,
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    handlers: {
      'quirky.cli/commandStatus': () => ({ ...status }),
      'quirky.cli/commandInstall': (params) => {
        if (params.replaceForeign !== true) throw new Error('foreign replacement was not explicitly authorized')
        status.state = 'managed'
        status.target = '/app/cli.mjs'
      }
    },
    confirm: () => confirmed
  })
  const dispose = await view.mount()

  await click('Install command')
  expect(view.confirmations).toHaveLength(1)
  expect(view.confirmations[0]?.title).toBe('Replace foreign command?')
  expect(view.confirmations[0]?.body).toContain('/tmp/foreign/quirky')
  expect(host.textContent).toContain('Status: foreign')
  expect(view.calls.some(({ method }) => method === 'quirky.cli/commandInstall')).toBe(false)

  confirmed = true
  await click('Install command')
  expect(host.textContent).toContain('Status: managed')
  expect(button('Uninstall command').disabled).toBe(false)
  await dispose()
})

test('profile launcher creation handles chooser cancellation and exposes only managed removal', async () => {
  let chooserCancelled = true
  const launchers: Launcher[] = [
    { name: 'managed', state: 'managed', path: '/tmp/profile-bin/managed', profileHome: '/tmp/home-managed', target: '/app/cli.mjs' },
    { name: 'foreign', state: 'foreign', path: '/tmp/profile-bin/foreign', profileHome: '/tmp/home-foreign', target: null }
  ]
  const view = setup({
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    launchers,
    handlers: {
      'quirky.cli/profileLauncherList': () => ({ launchers: [...launchers] }),
      'desktop.folder.pick': () => chooserCancelled ? { cancelled: true, paths: [] } : { cancelled: false, paths: ['/tmp/chosen-profile'] },
      'quirky.cli/profileLauncherInstall': () => {
        launchers.push({
          name: 'work',
          state: 'managed',
          path: '/tmp/profile-bin/work',
          profileHome: '/tmp/chosen-profile',
          target: '/app/cli.mjs'
        })
      },
      'quirky.cli/profileLauncherRemove': () => {
        const index = launchers.findIndex(({ name }) => name === 'managed')
        if (index !== -1) launchers.splice(index, 1)
      }
    }
  })
  const dispose = await view.mount()

  await type(input('Profile QUIRKY_HOME'), '/tmp/typed-profile')
  await click('Choose profile folder')
  expect(input('Profile QUIRKY_HOME').value).toBe('/tmp/typed-profile')
  chooserCancelled = false
  await click('Choose profile folder')
  expect(input('Profile QUIRKY_HOME').value).toBe('/tmp/chosen-profile')

  await type(input('Profile launcher name'), 'work')
  await type(input('Launcher path (optional)'), '/tmp/profile-bin/work')
  await click('Create profile launcher')
  expect(input('Profile launcher name').value).toBe('')
  expect(input('Launcher path (optional)').value).toBe('')
  expect(button('Remove work')).toBeDefined()
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].some(({ textContent }) => textContent?.trim() === 'Remove foreign')).toBe(false)

  await click('Remove managed')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].some(({ textContent }) => textContent?.trim() === 'Remove managed')).toBe(false)
  expect(button('Remove work')).toBeDefined()
  await dispose()
})

test('pairing offer stays password-protected after failure, clears on save, and lists only safe metadata', async () => {
  const pairingOffer = 'owner-cli://sensitive-offer'
  const runtimes: Runtime[] = []
  let attempts = 0
  const view = setup({
    handlers: {
      'quirky.cli/runtimeList': () => ({ runtimes: [...runtimes] }),
      'quirky.cli/runtimeAdd': () => {
        attempts++
        if (attempts === 1) throw new Error('offer was rejected')
        runtimes.push({
          id: 'runtime-1',
          name: 'Build runtime',
          endpoint: 'wss://runtime.example',
          pairedDeviceId: 'device-1',
          scope: 'owner-cli',
          grantId: 'device-1',
          createdAt: 1,
          lastUsedAt: null
        })
        return { id: 'runtime-1', name: 'Build runtime', pairedDeviceId: 'device-1' }
      }
    },
    runtimes
  })
  const dispose = await view.mount()

  expect(input('Pairing offer').type).toBe('password')
  expect(host.textContent).not.toContain('runtime.example')
  await type(input('Runtime name'), 'Build runtime')
  await type(input('Pairing offer'), pairingOffer)
  await click('Save paired runtime')
  expect(input('Pairing offer').value).toBe(pairingOffer)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('offer was rejected')

  await click('Save paired runtime')
  expect(input('Pairing offer').value).toBe('')
  expect(input('Runtime name').value).toBe('')
  expect(host.textContent).toContain('wss://runtime.example')
  expect(host.textContent).toContain('device-1')
  expect(host.textContent).not.toContain(pairingOffer)
  await dispose()
})

test('pending launcher completion after unmount does not trigger another refresh', async () => {
  const pendingInstall = Promise.withResolvers<void>()
  const view = setup({
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    handlers: {
      'quirky.cli/commandInstall': () => pendingInstall.promise
    }
  })
  const dispose = await view.mount()
  const statusReadsBeforeInstall = view.calls.filter(({ method }) => method === 'quirky.cli/commandStatus').length

  await act(async () => { button('Install command').click() })
  await dispose()
  pendingInstall.resolve()
  await act(async () => await waitForNextTask())

  expect(view.calls.filter(({ method }) => method === 'quirky.cli/commandStatus')).toHaveLength(statusReadsBeforeInstall)
  expect(host.childElementCount).toBe(0)
})

test('shows only the loading notice while the first status read is pending', async () => {
  const pendingStatus = Promise.withResolvers<Status>()
  const view = setup({
    handlers: {
      'quirky.cli/commandStatus': () => pendingStatus.promise
    }
  })
  const dispose = await view.mount()

  expect([...host.querySelectorAll('.ui-notice-line')].map((notice) => notice.textContent?.trim())).toEqual([
    'Loading CLI and runtime profile status…'
  ])
  expect(host.querySelector('pre')).toBeNull()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).not.toContain('No profile launchers are installed.')
  expect(host.textContent).not.toContain('No paired runtimes are saved.')
  expect(host.textContent).not.toContain('Refreshing CLI and runtime status…')

  await dispose()
})

test('shows a retryable inline error for a failed first read', async () => {
  let attempts = 0
  const view = setup({
    handlers: {
      'quirky.cli/commandStatus': () => {
        attempts++
        if (attempts === 1) throw new Error('daemon connection unavailable')
        return { state: 'missing', path: '/tmp/quirky-cli/quirky', target: null, profileHome: '/tmp/quirky-profile' }
      }
    }
  })
  const dispose = await view.mount()

  const alert = host.querySelector('[role="alert"]')
  expect(alert?.className).toBe('ui-inline-error')
  expect(alert?.textContent).toContain('Could not load CLI status: daemon connection unavailable')
  expect([...alert!.querySelectorAll('button')].map((candidate) => candidate.textContent?.trim())).toEqual(['Retry status'])
  expect(host.querySelector('pre')).toBeNull()
  expect(host.querySelector('.ui-notice-line')).toBeNull()
  expect(host.textContent).not.toContain('No profile launchers are installed.')
  expect(host.textContent).not.toContain('No paired runtimes are saved.')

  await click('Retry status')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('pre')?.textContent).toContain('Status: missing')
  expect(host.textContent).toContain('No profile launchers are installed.')
  expect(view.calls.filter(({ method }) => method === 'quirky.cli/commandStatus')).toHaveLength(2)
  await dispose()
})

test('keeps the loaded status visible when a refresh fails', async () => {
  const status: Status = { state: 'managed', path: '/tmp/q', target: '/app/cli.mjs', profileHome: '/tmp/p' }
  let reads = 0
  const view = setup({
    status,
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    handlers: {
      'quirky.cli/commandStatus': () => {
        reads++
        if (reads > 1) throw new Error('boom')
        return status
      }
    }
  })
  const dispose = await view.mount()

  await click('Reveal command')

  const alert = host.querySelector('[role="alert"]')
  expect(host.querySelector('pre')?.textContent).toContain('Status: managed')
  expect(host.textContent).toContain('No profile launchers are installed.')
  expect(alert?.className).toBe('ui-inline-error')
  expect(alert?.textContent).toContain('Could not load CLI status: boom')
  expect([...alert!.querySelectorAll('button')].map((candidate) => candidate.textContent?.trim())).toEqual(['Retry status'])
  await dispose()
})

test('shows action errors inline without buttons and clears them on the next action', async () => {
  let attempts = 0
  const view = setup({
    handlers: {
      'quirky.cli/runtimeAdd': () => {
        attempts++
        if (attempts === 1) throw new Error('offer was rejected')
        return {}
      }
    }
  })
  const dispose = await view.mount()

  await type(input('Runtime name'), 'Build')
  await type(input('Pairing offer'), 'owner-cli://x')
  await click('Save paired runtime')

  const alert = host.querySelector('[role="alert"]')
  expect(alert?.className).toBe('ui-inline-error')
  expect(alert?.textContent).toBe('offer was rejected')
  expect(alert?.querySelectorAll('button')).toHaveLength(0)

  await click('Save paired runtime')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await dispose()
})

test('shows a live refreshing notice while a post-load status read is pending', async () => {
  const status: Status = { state: 'managed', path: '/tmp/q', target: '/app/cli.mjs', profileHome: '/tmp/p' }
  const pendingRefresh = Promise.withResolvers<Status>()
  let reads = 0
  const view = setup({
    status,
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    handlers: {
      'quirky.cli/commandStatus': () => {
        reads++
        return reads === 1 ? status : pendingRefresh.promise
      }
    }
  })
  const dispose = await view.mount()

  await click('Reveal command')

  expect(host.querySelector('[aria-live="polite"] .ui-notice-line')?.textContent?.trim()).toBe(
    'Refreshing CLI and runtime status…'
  )
  expect(host.querySelector('pre')?.textContent).toContain('Status: managed')
  expect(button('Reveal command').disabled).toBe(true)

  await act(async () => {
    pendingRefresh.resolve(status)
    await pendingRefresh.promise
    await waitForNextTask()
  })
  expect(host.querySelectorAll('.ui-notice-line')).toHaveLength(0)
  await dispose()
})

test('submits both settings forms with the expected fields and button types', async () => {
  const view = setup({
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' }
  })
  const dispose = await view.mount()

  expect(button('Create profile launcher').type).toBe('submit')
  expect(button('Save paired runtime').type).toBe('submit')
  expect(button('Choose profile folder').type).toBe('button')

  await type(input('Profile launcher name'), 'work')
  const profileForm = input('Profile launcher name').closest('form')
  if (!profileForm) throw new Error('profile launcher form is missing')
  await act(async () => {
    profileForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitForNextTask()
  })
  expect(view.calls.filter(({ method }) => method === 'quirky.cli/profileLauncherInstall').map(({ params }) => params)).toEqual([
    {
      name: 'work',
      profileHome: '/tmp/quirky-profile',
      executablePath: '/app/quirky',
      entrypointPath: '/app/cli.mjs'
    }
  ])
  expect(input('Profile launcher name').value).toBe('')

  await type(input('Runtime name'), 'Build')
  await type(input('Pairing offer'), 'owner-cli://x')
  const runtimeForm = input('Runtime name').closest('form')
  if (!runtimeForm) throw new Error('runtime form is missing')
  await act(async () => {
    runtimeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitForNextTask()
  })
  expect(view.calls.filter(({ method }) => method === 'quirky.cli/runtimeAdd').map(({ params }) => params)).toEqual([
    { name: 'Build', pairingCode: 'owner-cli://x' }
  ])
  await dispose()
})

test('choosing a profile folder uses the draft and does not reload status', async () => {
  const view = setup({
    handlers: {
      'desktop.folder.pick': () => ({ cancelled: false, paths: ['/tmp/chosen'] })
    }
  })
  const dispose = await view.mount()
  const readsBeforePick = view.calls.filter(({ method }) => method === 'quirky.cli/commandStatus').length

  await click('Choose profile folder')

  expect(view.calls.filter(({ method }) => method === 'desktop.folder.pick').map(({ params }) => params)).toEqual([
    { title: 'Choose profile QUIRKY_HOME', startingFolder: '/tmp/quirky-profile', multiple: false }
  ])
  expect(input('Profile QUIRKY_HOME').value).toBe('/tmp/chosen')
  expect(view.calls.filter(({ method }) => method === 'quirky.cli/commandStatus')).toHaveLength(readsBeforePick)
  await dispose()
})

test.each(['profile launcher', 'paired runtime'] as const)('preserves a newer %s draft while the save refresh is pending', async (form) => {
  const status: Status = { state: 'missing', path: '/tmp/quirky-cli/quirky', target: null, profileHome: '/tmp/quirky-profile' }
  const pendingRefresh = Promise.withResolvers<Status>()
  let reads = 0
  const view = setup({
    target: { available: true, executablePath: '/app/quirky', entrypointPath: '/app/cli.mjs' },
    handlers: {
      'quirky.cli/commandStatus': () => ++reads === 1 ? status : pendingRefresh.promise
    }
  })
  const dispose = await view.mount()
  const fields = form === 'profile launcher'
    ? ['Profile launcher name', 'Launcher path (optional)']
    : ['Runtime name', 'Pairing offer']
  await type(input(fields[0]!), 'first')
  await type(input(fields[1]!), form === 'profile launcher' ? '/tmp/first' : 'owner-cli://first')
  await click(form === 'profile launcher' ? 'Create profile launcher' : 'Save paired runtime')
  expect(reads).toBe(2)
  await type(input(fields[0]!), 'next')
  await type(input(fields[1]!), form === 'profile launcher' ? '/tmp/next' : 'owner-cli://next')

  await act(async () => {
    pendingRefresh.resolve(status)
    await pendingRefresh.promise
    await waitForNextTask()
  })
  expect(input(fields[0]!).value).toBe('next')
  expect(input(fields[1]!).value).toBe(form === 'profile launcher' ? '/tmp/next' : 'owner-cli://next')
  await dispose()
})
