import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, type ReactNode, useState } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ImportJob } from '../src/cookies/types'
import type { CookieImportPanelProps } from '../src/preferences/contract'
import { CookieImportPanel } from '../src/preferences-window/CookieImportPanel'

const REVIEW = { id: 'review', label: 'Review' }
const DEFAULT = { id: 'default', label: 'Default' }
const IMPORTS: NonNullable<CookieImportPanelProps['imports']> = {
  available: true,
  destination: 'managed-chrome',
  nativeSupported: false,
  reason: 'Imports are written to managed Chrome only.'
}

type RpcCall = { method: string; params?: Record<string, unknown> }
type ToastCall = { title: string; body: string; options?: { kind?: string } }

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let calls: RpcCall[]
let toasts: ToastCall[]
let errors: string[]
let confirmations: { title: string; body?: string; confirmLabel?: string }[]
let callHandler: (method: string, params?: Record<string, unknown>) => Promise<unknown>
let confirmHandler: (options: { title: string; body?: string; confirmLabel?: string }) => Promise<boolean>
let imported: number
let refreshFailure: Error | null
let context: UiPluginContext

function makeDeferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function makeContext(): UiPluginContext {
  return {
    pluginId: 'quirky.browser',
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      return await callHandler(method, params)
    },
    confirm: async (options: { title: string; body?: string; confirmLabel?: string }) => {
      confirmations.push(options)
      return await confirmHandler(options)
    },
    toast: (title: string, body: string, options?: { kind?: string }) => { toasts.push({ title, body, options }) }
  } as unknown as UiPluginContext
}

function Host({ destination = REVIEW }: { destination?: typeof REVIEW }) {
  const [open, setOpen] = useState(false)
  const onImported = async () => {
    imported += 1
    if (refreshFailure) throw refreshFailure
  }
  return <>
    <button onClick={() => setOpen(true)}>Open Import Cookies</button>
    {open && <CookieImportPanel
      context={context}
      imports={IMPORTS}
      destination={destination}
      onError={(message) => errors.push(message)}
      onImported={onImported}
    />}
  </>
}

beforeAll(async () => {
  GlobalRegistrator.register()
  // ReactDOM must load after the DOM shim so it detects the test environment correctly.
  ;({ createRoot } = await import('react-dom/client'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  calls = []
  toasts = []
  errors = []
  confirmations = []
  imported = 0
  refreshFailure = null
  callHandler = async () => undefined
  confirmHandler = async () => true
  context = makeContext()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function mount(element: ReactNode = <Host />): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(element)
    await settle()
  })
}

async function rerenderHost(destination: typeof REVIEW | typeof DEFAULT): Promise<void> {
  await act(async () => {
    root?.render(<Host destination={destination} />)
    await settle()
  })
}

async function clickButton(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  await act(async () => {
    button.click()
    await settle()
  })
}

async function chooseFile(file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept="application/json,.json"]')
  if (!input) throw new Error('Missing JSON file chooser')
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  })
}

async function selectFile(contents: string, name = 'cookies.json'): Promise<void> {
  await chooseFile(new File([contents], name, { type: 'application/json' }))
}

function hasAlertContaining(message: string): boolean {
  return [...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes(message))
}

function callsFor(method: string): RpcCall[] {
  return calls.filter((call) => call.method === `quirky.browser/${method}`)
}

function text(): string {
  return container.textContent ?? ''
}

async function waitForText(needle: string, timeoutMs = 1200): Promise<void> {
  const started = Date.now()
  while (!text().includes(needle) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await act(async () => { await settle() })
  }
  expect(text()).toContain(needle)
}

const successJob = (profileId: string, result: NonNullable<ImportJob['result']>, id = 'import-1') => ({
  id, profileId, status: 'succeeded' as const, createdAt: 1, finishedAt: 2, result
})

test('source detection begins only when opened and empty/error states retain file import recovery', async () => {
  const firstDetection = makeDeferred<unknown>()
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return await firstDetection.promise
    return undefined
  }
  await mount()

  expect(callsFor('detectBrowsers')).toHaveLength(0)
  await clickButton('Open Import Cookies')
  expect(callsFor('detectBrowsers')).toHaveLength(1)
  firstDetection.resolve({ browsers: [] })
  await act(async () => { await settle() })
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('button')?.textContent).toBe('Open Import Cookies')
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'From File')).toBe(true)

  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') throw new Error('Browser source detection failed.')
    return undefined
  }
  await clickButton('Refresh browsers')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Browser source detection failed.')
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'From File')).toBe(true)
  expect(callsFor('detectBrowsers')).toHaveLength(2)

  await clickButton('From File')
  expect(container.querySelector('[role="dialog"][aria-label="Import Cookies"]')).not.toBeNull()
  await clickButton('Cancel')
  expect(container.querySelector('[role="dialog"][aria-label="Import Cookies"]')).toBeNull()
  expect(confirmations).toHaveLength(0)
  expect(callsFor('importStart')).toHaveLength(0)
  await clickButton('From File')
  expect(container.querySelector('[role="dialog"][aria-label="Import Cookies"]')).not.toBeNull()

  await selectFile('{malformed')
  await waitForText('valid JSON')
  expect(hasAlertContaining('valid JSON')).toBe(true)
  await selectFile('{"name":"not an array"}')
  await waitForText('JSON array')
  expect(hasAlertContaining('JSON array')).toBe(true)
  await selectFile('[]')
  await waitForText('at least one cookie')
  expect(hasAlertContaining('at least one cookie')).toBe(true)
  expect(toasts.filter(({ title, options }) => title === 'Cookie import failed' && options?.kind === 'error')).toHaveLength(3)

  const cookies = [{ name: 'sid', value: 'cookie-value', domain: '.example.test', path: '/', secure: true, httpOnly: true, hostOnly: false }]
  const result = { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: ['example.test'] }
  callHandler = async (method) => {
    if (method === 'quirky.browser/importStart') return { id: 'import-file' }
    if (method === 'quirky.browser/importGet') return { ...successJob('review', result), id: 'import-file' }
    return undefined
  }
  const fileRead = makeDeferred<string>()
  const confirming = makeDeferred<boolean>()
  let firstReadCount = 0
  let secondReadCount = 0
  confirmHandler = () => confirming.promise
  const firstFile = new File([], 'cookies.json', { type: 'application/json' })
  const repeatedFile = new File(['[]'], 'repeat.json', { type: 'application/json' })
  Object.defineProperty(firstFile, 'text', { value: () => { firstReadCount += 1; return fileRead.promise } })
  Object.defineProperty(repeatedFile, 'text', { value: () => { secondReadCount += 1; return Promise.resolve('[]') } })
  await chooseFile(firstFile)
  await chooseFile(repeatedFile)
  expect(firstReadCount).toBe(1)
  expect(secondReadCount).toBe(0)
  expect(confirmations).toHaveLength(0)
  expect(callsFor('importStart')).toHaveLength(0)

  await rerenderHost(DEFAULT)
  fileRead.resolve(JSON.stringify(cookies))
  await act(async () => { await settle() })
  expect(confirmations).toHaveLength(1)
  expect(callsFor('importStart')).toHaveLength(0)
  confirming.resolve(true)
  await waitForText('1 imported')
  const started = callsFor('importStart')[0]
  expect(started?.params).toEqual({ profile: 'review', source: { kind: 'json', cookies }, yes: true })
  if (started?.params?.source && typeof started.params.source === 'object') {
    expect('path' in started.params.source).toBe(false)
  } else {
    throw new Error('Missing JSON import source.')
  }
  expect(imported).toBe(1)
  expect(toasts.at(-1)?.options?.kind).toBe('success')
  expect(text()).not.toContain('cookie-value')
  expect(JSON.stringify({ toasts, errors })).not.toContain('cookie-value')
})

test('browser imports keep the submitted destination through confirmation and polling and show real warning counts', async () => {
  const confirming = makeDeferred<boolean>()
  const firstPoll = makeDeferred<unknown>()
  let pollCount = 0
  confirmHandler = () => confirming.promise
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return { browsers: [
      { family: 'chrome', label: 'Google Chrome', profiles: [{ name: 'Default', label: 'Default' }, { name: 'Work', label: 'Work' }] },
      { family: 'firefox', label: 'Firefox', profiles: [{ name: 'default-release', label: 'Default release' }] }
    ] }
    if (method === 'quirky.browser/importStart') return { id: 'import-1' }
    if (method === 'quirky.browser/importGet') {
      pollCount += 1
      if (pollCount === 1) return await firstPoll.promise
      return successJob('review', {
        totalCookies: 5, importedCookies: 2, skippedCookies: 3,
        googleCookiesSkipped: 1, partitionSkippedCookies: 2,
        domains: ['example.test'], warning: { code: 'source-warning', reasons: ['Some cookies could not be read.'] }
      })
    }
    return undefined
  }
  await mount()
  refreshFailure = new Error('Preferences refresh failed.')
  expect(callsFor('detectBrowsers')).toHaveLength(0)
  await clickButton('Open Import Cookies')
  await waitForText('Google Chrome')
  const chromeGroup = [...container.querySelectorAll('fieldset')].find((fieldset) => fieldset.querySelector('legend')?.textContent === 'Google Chrome')
  if (!chromeGroup) throw new Error('Chrome profile choices are not nested under their browser.')
  expect([...chromeGroup.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual([
    'Google Chrome — Default',
    'Google Chrome — Work'
  ])
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Google Chrome — Work')).toBe(true)
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Google Chrome — Default')).toBe(true)
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'From Firefox')).toBe(true)

  await clickButton('Google Chrome — Work')
  expect(confirmations).toHaveLength(1)
  expect(confirmations[0]?.body).toContain('Review')
  expect(callsFor('detectBrowsers')).toHaveLength(1)
  await rerenderHost(DEFAULT)
  expect(callsFor('detectBrowsers')).toHaveLength(1)
  expect([...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Google Chrome — Work')?.disabled).toBe(true)
  await clickButton('Google Chrome — Work')
  expect(confirmations).toHaveLength(1)
  expect(callsFor('importStart')).toHaveLength(0)

  confirming.resolve(true)
  await act(async () => { await settle() })
  expect(callsFor('importStart')).toHaveLength(1)
  expect(callsFor('importStart')[0]?.params).toEqual({
    profile: 'review', source: { kind: 'browser', family: 'chrome', profile: 'Work' }, yes: true
  })
  expect(text()).toContain('Queued for Review')
  expect(callsFor('importGet')).toHaveLength(1)
  firstPoll.resolve({ id: 'import-1', profileId: 'review', status: 'running', createdAt: 1 })
  await act(async () => { await settle() })
  expect(text()).toContain('Importing to Review')
  expect(text()).not.toContain('Importing to Default')
  expect([...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Google Chrome — Work')?.disabled).toBe(true)
  await clickButton('Google Chrome — Work')
  expect(confirmations).toHaveLength(1)
  expect(callsFor('importStart')).toHaveLength(1)

  await waitForText('2 imported')
  expect(text()).toContain('5 total')
  expect(text()).toContain('3 skipped')
  expect(text()).toContain('1 Google')
  expect(text()).toContain('2 partitioned')
  expect(text()).toContain('Some cookies could not be read.')
  expect(text()).toContain('managed Chrome')
  expect(text()).toContain('Native')
  expect(imported).toBe(1)
  expect(errors).toEqual([])
  expect(toasts.at(-1)?.options?.kind).toBe('success')
  expect(toasts.at(-1)?.body).toContain('Google Chrome (Work)')
  expect(toasts.at(-1)?.body).toContain('source-warning')
  expect(toasts.at(-1)?.body).toContain('Some cookies could not be read.')
})

test('zero imported cookies are reported accurately without claiming Native login support', async () => {
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return { browsers: [{ family: 'firefox', label: 'Firefox', profiles: [{ name: 'default-release', label: 'Default release' }] }] }
    if (method === 'quirky.browser/importStart') return { id: 'empty-import' }
    if (method === 'quirky.browser/importGet') return successJob('review', {
      totalCookies: 2, importedCookies: 0, skippedCookies: 2, domains: []
    }, 'empty-import')
    return undefined
  }
  await mount()
  await clickButton('Open Import Cookies')
  await waitForText('From Firefox')
  await clickButton('From Firefox')
  await waitForText('0 imported')
  expect(text()).toContain('2 total')
  expect(text()).toContain('2 skipped')
  expect(text()).toContain('Native')
  expect(text()).not.toContain('restored your logins')
  expect(imported).toBe(1)
})

test('Safari imports use detected browser identity without sending a profile selector', async () => {
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return { browsers: [{ family: 'safari', label: 'Safari', profiles: [{ name: 'default', label: 'Safari' }] }] }
    if (method === 'quirky.browser/importStart') return { id: 'safari-import' }
    if (method === 'quirky.browser/importGet') return successJob('review', {
      totalCookies: 0, importedCookies: 0, skippedCookies: 0, domains: []
    }, 'safari-import')
    return undefined
  }
  await mount()
  await clickButton('Open Import Cookies')
  await waitForText('From Safari')
  await clickButton('From Safari')
  await waitForText('0 imported')
  expect(callsFor('importStart')[0]?.params).toEqual({
    profile: 'review', source: { kind: 'browser', family: 'safari' }, yes: true
  })
})
test('failed jobs report errors, and unmounting a running job stops polling without cancelling it', async () => {
  let failJob = true
  let pollCount = 0
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return { browsers: [{ family: 'firefox', label: 'Firefox', profiles: [{ name: 'default-release', label: 'Default release' }] }] }
    if (method === 'quirky.browser/importStart') return { id: failJob ? 'failed-import' : 'running-import' }
    if (method === 'quirky.browser/importGet') {
      pollCount += 1
      return failJob
        ? { id: 'failed-import', profileId: 'review', status: 'failed', createdAt: 1, error: { code: 'source_denied', message: 'Source access was denied.' } }
        : { id: 'running-import', profileId: 'review', status: 'running', createdAt: 1 }
    }
    return undefined
  }
  await mount()
  await clickButton('Open Import Cookies')
  await waitForText('From Firefox')
  await clickButton('From Firefox')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Source access was denied.')
  expect(toasts.at(-1)?.options?.kind).toBe('error')
  expect(toasts.some(({ options }) => options?.kind === 'success')).toBe(false)
  expect(imported).toBe(0)

  await act(async () => {
    root?.unmount()
    root = null
    await settle()
  })
  pollCount = 0
  failJob = false
  await mount()
  await clickButton('Open Import Cookies')
  await waitForText('From Firefox')
  await clickButton('From Firefox')
  await waitForText('Importing to Review')
  expect(pollCount).toBe(1)
  await act(async () => {
    root?.unmount()
    root = null
    await settle()
  })
  await new Promise((resolve) => setTimeout(resolve, 700))
  expect(pollCount).toBe(1)
  expect(calls.some(({ method }) => method === 'quirky.browser/importCancel')).toBe(false)
  expect(imported).toBe(0)
})

test('late browser detection from an unmounted panel cannot replace a reopened panel', async () => {
  const staleDetection = makeDeferred<unknown>()
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return await staleDetection.promise
    return undefined
  }
  await mount()
  await clickButton('Open Import Cookies')
  expect(callsFor('detectBrowsers')).toHaveLength(1)
  await act(async () => {
    root?.unmount()
    root = null
    await settle()
  })

  context = makeContext()
  callHandler = async (method) => {
    if (method === 'quirky.browser/detectBrowsers') return { browsers: [{ family: 'firefox', label: 'Firefox', profiles: [{ name: 'default-release', label: 'Default release' }] }] }
    return undefined
  }
  await mount()
  await clickButton('Open Import Cookies')
  await waitForText('From Firefox')
  staleDetection.resolve({ browsers: [{ family: 'chrome', label: 'Google Chrome', profiles: [{ name: 'Default', label: 'Default' }] }] })
  await act(async () => { await settle() })
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'From Firefox')).toBe(true)
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'From Google Chrome')).toBe(false)
})
