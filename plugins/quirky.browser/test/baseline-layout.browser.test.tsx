import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const UI_MODULES = join(ROOT, 'packages/ui/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const executable = browserExecutable()
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'browser-baseline-layout-fixture',
  setup(builder) {
    builder.onResolve({ filter: /baseline-layout-browser-fixture\.ts$/ }, () => ({
      path: 'entry',
      namespace: 'baseline-layout-fixture'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'baseline-layout-fixture' }, () => ({
      contents: browserEntry(),
      loader: 'ts',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^\// }, ({ path }) => ({
      path: Bun.resolveSync(path, ROOT),
      namespace: 'file'
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
  }
}

let browser: Browser
let browserBundle = ''
const openPages = new Set<{ page: Page; pageErrors: string[]; requests: string[] }>()

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'baseline-layout-browser-fixture.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Browser baseline-layout fixture bundle was empty.')
  browserBundle = await output.text()
  browser = await chromium.launch({ headless: true, executablePath: executable })
}, 60_000)

afterEach(async () => {
  const sessions = [...openPages]
  openPages.clear()
  await Promise.all(sessions.map(async ({ page, pageErrors, requests }) => {
    try {
      await page.evaluate(() => window.__baselineLayoutFixture?.cleanup())
      expect(pageErrors).toEqual([])
      expect(requests).toEqual([])
      expect(await page.evaluate(() => window.__baselineLayoutFixture.unexpectedCalls)).toEqual([])
      expect(await page.evaluate(() => window.__baselineLayoutFixture.nativeCalls)).toEqual([])
    } finally {
      await page.close()
    }
  }))
})

afterAll(async () => {
  await browser?.close()
}, 30_000)

declare global {
  interface Window {
    __baselineLayoutFixture: {
      events: { type: string; value?: string; key?: string }[]
      unexpectedCalls: unknown[]
      nativeCalls: string[]
      apiCalls: { method: string; params?: Record<string, unknown> }[]
      commandCalls: { id: string; args: unknown }[]
      dispatchResults: { id: string; args: unknown; result: unknown }[]
      toasts: { title: string; body: string; options?: unknown }[]
      mountTextField(options?: { hideLabel?: boolean; disabled?: boolean; defaultValue?: string }): void
      focusAddress(): void
      mountPane(options?: { mode?: 'native' | 'watch'; browserImportHintHidden?: boolean }): void
      mountSettings(mode: 'standalone' | 'embedded'): void
      setNavigationFailure(message: string | null): void
      setSaveBehavior(mode: 'success' | 'pending' | 'reject', message?: string): void
      releasePendingSave(): Promise<void>
      setCommandFailure(message: string | null): void
      setDesignArmPending(value: boolean): void
      releaseDesignArm(): void
      emitFrame(): Promise<void>
      cleanup(): void
    }
  }
}

function browserEntry(): string {
  return `
    import { createElement as h, createRef } from 'react'
    import { createRoot } from 'react-dom/client'
    import { flushSync } from 'react-dom'
    import { TextField } from '@quirky/ui'
    import { BrowserPaneWindow } from ${JSON.stringify(join(ROOT, 'plugins/quirky.browser/src/window/BrowserPaneWindow'))}
    import { registerPreferencesUi } from ${JSON.stringify(join(ROOT, 'plugins/quirky.browser/src/preferences-ui'))}
    import { DESIGN_CONTROL_COMMAND, dispatchDesignControl, dispatchPaneUiControl, PANE_UI_CONTROL_COMMAND } from ${JSON.stringify(join(ROOT, 'plugins/quirky.browser/src/ui-control'))}
    import { dispatchPreferencesControl, PREFERENCES_CONTROL_COMMAND } from ${JSON.stringify(join(ROOT, 'plugins/quirky.browser/src/preferences-window/shared'))}

    const PANE_ID = 'pane-1'
    const HOME_PAGE_ID = 'setting:quirky.browser/defaultHomePage'
    const IMPORT_HINT_ID = 'setting:quirky.browser/browserImportHintHidden'
    const SEARCH_SUGGESTIONS = [
      { url: 'https://www.google.com/search?q=http%3A%2F%2F127.0.0.1%3A8765%2F', title: 'Search for http://127.0.0.1:8765/', kind: 'search' },
      { url: 'https://example.test/other', title: 'Other', kind: 'history' }
    ]
    const preferencesState = {
      profiles: [
        { profile: { id: 'default', label: 'Default', scope: 'default' }, active: true },
        { profile: { id: 'review', label: 'Review', scope: 'isolated' }, active: false },
        { profile: { id: 'long-profile', label: 'VeryLongBrowserProfileNameThatMustWrapInsideTheNarrowSettingsContent'.repeat(2), scope: 'isolated' }, active: false }
      ],
      identity: { selected: 'clean', active: 'clean', restartRequired: false, nativeSupported: false },
      imports: { available: true, destination: 'managed-chrome', nativeSupported: false, reason: 'Cookie imports are stored in managed Chrome, not Native.' },
      localhostLabels: { available: true, enabled: false, reason: 'Loopback links get worktree labels.', labels: [] }
    }
    const settings = {
      [HOME_PAGE_ID]: '',
      'setting:quirky.browser/defaultSearchEngine': 'google',
      'setting:quirky.browser/defaultZoom': 0,
      'setting:quirky.browser/identityMode': 'clean',
      'setting:quirky.browser/openLinksInApp': false,
      'setting:quirky.browser/openLinksInAppModifierInverts': false,
      'setting:quirky.browser/localhostWorktreeLabelsEnabled': false,
      [IMPORT_HINT_ID]: true,
      'setting:quirky.browser/agentBrowserUseEnabled': false,
      'setting:quirky.terminal/link-click': 'actions',
      'setting:quirky.terminal/link-middle-click': 'open'
    }
    const fixture = {
      events: [],
      unexpectedCalls: [],
      nativeCalls: [],
      apiCalls: [],
      commandCalls: [],
      dispatchResults: [],
      toasts: [],
      listeners: new Set(),
      provided: new Map(),
      settings,
      paneState: null,
      componentRoot: null,
      settingsCleanup: null,
      navigationFailure: null,
      saveMode: 'success',
      saveFailure: 'Save refused',
      pendingSaves: [],
      commandFailure: null,
      designArmPending: false,
      pendingDesignArms: [],

      unexpected(name, detail) {
        const call = { name, detail }
        fixture.unexpectedCalls.push(call)
        throw new Error('Unexpected fixture call: ' + name)
      },
      makePane(mode = 'native') {
        return {
          id: PANE_ID,
          worktreeId: 'worktree-1',
          profileId: 'default',
          partition: 'persist:quirky-browser-default',
          mode,
          page: mode === 'watch' ? 'page-1' : null,
          url: 'https://example.test/page',
          title: 'Example',
          loading: false,
          error: null,
          canGoBack: true,
          canGoForward: true,
          zoom: 0,
          viewport: 'default',
          command: null,
          find: { text: '', current: 0, total: 0 },
          prompts: [],
          downloads: []
        }
      },
      saveSetting(id, value) {
        settings[id] = value
        for (const listener of [...fixture.listeners]) listener({ type: 'setting.changed', id, value })
        return { id, value }
      },
      async call(method, params) {
        fixture.apiCalls.push({ method, ...(params === undefined ? {} : { params }) })
        if (method === 'quirky.browser/paneState') return fixture.paneState
        if (method === 'quirky.browser/preferencesState') return preferencesState
        if (method === 'quirky.browser/identityGet') return { active: 'native' }
        if (method === 'quirky.browser/paneSuggestions') {
          const query = typeof params?.query === 'string' ? params.query : ''
          return { suggestions: query === 'http://127.0.0.1:8765/' ? SEARCH_SUGGESTIONS : [] }
        }
        if (method === 'quirky.browser/paneNavigate') {
          if (fixture.navigationFailure) throw new Error(fixture.navigationFailure)
          return { pane: params?.pane, input: params?.input }
        }
        if (method === 'quirky.browser/paneControl') return {}
        if (method === 'quirky.browser/paneWatch') return { watchId: 'watch-1' }
        if (method === 'quirky.browser/paneWatchStop' || method === 'quirky.browser/paneFrameAck') return {}
        if (method === 'quirky.browser/designArm') {
          if (!fixture.designArmPending) return { opId: 'design-1' }
          return await new Promise((resolve) => fixture.pendingDesignArms.push(resolve))
        }
        if (method === 'quirky.browser/designRead') return await new Promise(() => {})
        if (method === 'quirky.browser/designCancel' || method === 'quirky.browser/designHover') return {}
        if (method === 'setting.set') {
          if (fixture.saveMode === 'reject') throw new Error(fixture.saveFailure)
          if (fixture.saveMode === 'pending') {
            return await new Promise((resolve, reject) => fixture.pendingSaves.push(async () => {
              try {
                resolve(fixture.saveSetting(String(params?.id ?? ''), params?.value))
              } catch (error) {
                reject(error)
              }
            }))
          }
          return fixture.saveSetting(String(params?.id ?? ''), params?.value)
        }
        return fixture.unexpected('context.call', { method, params })
      },
      context: null,
      initializeContext() {
        const context = {
          nativeBrowser: {
            available: false,
            clearPartitionAvailable: false,
            previewAvailable: false,
            mount() { return fixture.unexpected('nativeBrowser.mount') },
            clearPartition() { return fixture.unexpected('nativeBrowser.clearPartition') },
            defaultUserAgent() { return fixture.unexpected('nativeBrowser.defaultUserAgent') }
          },
          pluginId: 'quirky.browser',
          nativeDropPaths() { fixture.nativeCalls.push('nativeDropPaths'); return fixture.unexpected('nativeDropPaths') },
          log() {},
          readClipboardText() { fixture.nativeCalls.push('readClipboardText'); return fixture.unexpected('readClipboardText') },
          provide(id, implementation) { fixture.provided.set(id, implementation) },
          call: (method, params) => fixture.call(method, params),
          subscribe(listener) {
            fixture.listeners.add(listener)
            return () => fixture.listeners.delete(listener)
          },
          getSetting(name) { return settings[name] },
          executeCommand: async (id, args) => {
            fixture.commandCalls.push({ id, args })
            if (fixture.commandFailure && id === PREFERENCES_CONTROL_COMMAND) throw new Error(fixture.commandFailure)
            let result
            if (id === PANE_UI_CONTROL_COMMAND) result = dispatchPaneUiControl(context, args)
            else if (id === PREFERENCES_CONTROL_COMMAND) result = dispatchPreferencesControl(context, args)
            else if (id === DESIGN_CONTROL_COMMAND) result = dispatchDesignControl(context, args)
            else return fixture.unexpected('context.executeCommand', { id, args })
            fixture.dispatchResults.push({ id, args, result })
            return result
          },
          createCommandDrag() { return fixture.unexpected('createCommandDrag') },
          consumeCommandDrag() { return null },
          cancelCommandDrag() {},
          openView() { return fixture.unexpected('context.openView') },
          closeView() {},
          togglePanel() {},
          setPalette() {},
          getLayout() { return { view: null, panel: null, sidebar: true, focus: null } },
          onLayout() { return () => {} },
          onStream() { return () => {} },
          onConnection() { return () => {} },
          confirm: async () => false,
          toast(title, body, options) { fixture.toasts.push({ title, body, options }) },
          setPanelBadge() {},
          setContext() {},
          mountView() { return () => {} }
        }
        fixture.context = context
        registerPreferencesUi(context)
      },
      mountTextField(options = {}) {
        const container = document.getElementById('fixture-root')
        if (!fixture.componentRoot) fixture.componentRoot = createRoot(container)
        const props = {
          label: 'Address and search',
          id: 'probe-address',
          help: 'Help',
          error: 'Failed',
          'aria-describedby': 'external-help',
          disabled: options.disabled ?? false,
          defaultValue: options.defaultValue ?? '',
          className: 'probe-input',
          ref: inputRef,
          onChange(event) {
            fixture.events.push({ type: 'change', value: event.currentTarget.value })
          },
          onKeyDown(event) {
            fixture.events.push({ type: 'keydown', key: event.key })
          }
        }
        if (Object.hasOwn(options, 'hideLabel')) props.hideLabel = options.hideLabel
        flushSync(() => fixture.componentRoot.render(h(TextField, props)))
      },
      focusAddress() {
        inputRef.current?.focus()
      },
      mountPane(options = {}) {
        fixture.cleanup()
        const mode = options.mode ?? 'native'
        settings[IMPORT_HINT_ID] = options.browserImportHintHidden ?? true
        fixture.paneState = { tabs: [fixture.makePane(mode)], active: PANE_ID, history: [{ url: 'https://example.test/seen', title: 'Seen', visitedAt: 1 }] }
        fixture.componentRoot = createRoot(document.getElementById('fixture-root'))
        flushSync(() => fixture.componentRoot.render(h(BrowserPaneWindow, { context: fixture.context, input: { pane: PANE_ID } })))
      },
      mountSettings(mode) {
        fixture.cleanup()
        const host = document.getElementById('fixture-root')
        host.replaceChildren()
        let mountElement = host
        let mountId = 'view:quirky.browser/browser-settings'
        if (mode === 'embedded') {
          const heading = document.createElement('h2')
          heading.id = 'host-heading'
          heading.textContent = 'Browser: Session & Cookies'
          mountElement = document.createElement('div')
          mountElement.id = 'settings-contribution'
          host.append(heading, mountElement)
          mountId = 'settings-section:quirky.browser/browser-preferences'
        }
        const mount = fixture.provided.get(mountId)
        if (typeof mount !== 'function') throw new Error('Registered Browser settings mount was not provided: ' + mountId)
        fixture.settingsCleanup = mount(mountElement, { report() {} })
      },
      setNavigationFailure(message) {
        fixture.navigationFailure = message
      },
      setSaveBehavior(mode, message) {
        fixture.saveMode = mode
        if (message) fixture.saveFailure = message
      },
      async releasePendingSave() {
        const pending = fixture.pendingSaves.splice(0)
        for (const resolve of pending) await resolve()
      },
      setCommandFailure(message) {
        fixture.commandFailure = message
      },
      setDesignArmPending(value) {
        fixture.designArmPending = value
      },
      releaseDesignArm() {
        for (const resolve of fixture.pendingDesignArms.splice(0)) resolve({ opId: 'design-1' })
      },
      async emitFrame() {
        const event = {
          type: 'quirky.browser/paneFrame',
          data: { pane: PANE_ID, watchId: 'watch-1', sequence: 1, data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/m6sAAAAASUVORK5CYII=', width: 800, height: 600 }
        }
        for (const listener of [...fixture.listeners]) await listener(event)
      },
      cleanup() {
        if (fixture.settingsCleanup) {
          fixture.settingsCleanup()
          fixture.settingsCleanup = null
        }
        if (fixture.componentRoot) {
          flushSync(() => fixture.componentRoot.unmount())
          fixture.componentRoot = null
        }
      }
    }
    const inputRef = createRef()
    fixture.initializeContext()
    window.__baselineLayoutFixture = fixture
  `
}

async function expandStyleImports(url: URL, ancestors: Set<string> = new Set()): Promise<string> {
  if (ancestors.has(url.href)) throw new Error(`Cyclic production CSS import: ${url.href}`)
  const nextAncestors = new Set(ancestors).add(url.href)
  const source = await Bun.file(url).text()
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);/g
  let result = ''
  let cursor = 0
  for (const match of source.matchAll(importPattern)) {
    const index = match.index
    result += source.slice(cursor, index)
    const importedUrl = new URL(match[2]!, url)
    const imported = importedUrl.protocol === 'file:'
      ? await expandStyleImports(importedUrl, nextAncestors)
      : match[0]
    const media = match[3]?.trim()
    result += media && importedUrl.protocol === 'file:' ? `@media ${media} {\n${imported}\n}` : imported
    cursor = index + match[0].length
  }
  return result + source.slice(cursor)
}

async function productionStyles(): Promise<string> {
  const shell = await expandStyleImports(new URL('../../../packages/ui/src/shell/chrome.css', import.meta.url))
  const app = await expandStyleImports(new URL('../../../packages/ui/src/styles.css', import.meta.url))
  return `${shell}\n${app}`
}

async function styledPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  const pageErrors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.route('**/*', (route) => route.abort())
  openPages.add({ page, pageErrors, requests })
  const styles = await productionStyles()
  await page.setContent(`
    <html data-theme="dark">
      <head><style>${styles}</style></head>
      <body style="margin:0;width:100%;height:900px">
        <button id="focus-origin" type="button">Focus origin</button>
        <div id="fixture-root" style="width:100vw;height:900px;min-width:0"></div>
        <p id="external-help">External help</p>
      </body>
    </html>
  `)
  await page.addScriptTag({ content: browserBundle })
  await page.waitForFunction(() => typeof window.__baselineLayoutFixture?.mountTextField === 'function')
  return page
}

const themes = ['dark', 'light'] as const
const widths = [1000, 700, 320] as const

test('TextField visually hides its label without changing its accessible name or disabled field', async () => {
  const page = await styledPage()

  for (const theme of themes) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme }, theme)
      await page.evaluate(() => window.__baselineLayoutFixture.mountTextField({
        hideLabel: true,
        disabled: true,
        defaultValue: 'native value'
      }))

      const input = page.getByRole('textbox', { name: 'Address and search' })
      await input.waitFor({ state: 'attached' })
      expect(await input.count()).toBe(1)
      expect(await input.getAttribute('id')).toBe('probe-address')
      expect(await input.getAttribute('aria-describedby')).toBe('external-help probe-address-help probe-address-error')
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      expect(await input.isDisabled()).toBe(true)
      expect(await input.inputValue()).toBe('native value')
      expect(await input.getAttribute('hidelabel')).toBeNull()
      expect(await page.getByText('Help', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByRole('alert').getAttribute('id')).toBe('probe-address-error')
      expect(await page.getByRole('alert').isVisible()).toBe(true)

      const geometry = await page.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.ui-text-field')!
        const label = wrapper.querySelector<HTMLLabelElement>('label')!
        const input = wrapper.querySelector<HTMLInputElement>('input')!
        const labelStyle = getComputedStyle(label)
        const labelRect = label.getBoundingClientRect()
        const wrapperRect = wrapper.getBoundingClientRect()
        const inputRect = input.getBoundingClientRect()
        return {
          labelText: label.textContent,
          labelFor: label.htmlFor,
          labelClass: label.className,
          labelPosition: labelStyle.position,
          labelClip: labelStyle.clip,
          labelClipPath: labelStyle.clipPath,
          labelOverflow: labelStyle.overflow,
          labelWidth: labelRect.width,
          labelHeight: labelRect.height,
          wrapperTop: wrapperRect.top,
          inputTop: inputRect.top
        }
      })
      expect(geometry.labelText).toBe('Address and search')
      expect(geometry.labelFor).toBe('probe-address')
      expect(geometry.labelClass).toContain('ui-text-field__label--hidden')
      expect(geometry.labelPosition).toBe('absolute')
      expect(geometry.labelWidth).toBeLessThanOrEqual(1)
      expect(geometry.labelHeight).toBeLessThanOrEqual(1)
      expect(geometry.labelClip !== 'auto' || geometry.labelClipPath !== 'none' || geometry.labelOverflow === 'hidden').toBe(true)
      expect(Math.abs(geometry.inputTop - geometry.wrapperTop)).toBeLessThanOrEqual(0.5)
    }
  }
})

test('TextField preserves its visible-label default and the opted-in field keeps ref, value, events, and focus styling', async () => {
  const page = await styledPage()

  for (const theme of themes) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme }, theme)

      const visibleVariants = [
        { disabled: false },
        { disabled: false, hideLabel: false }
      ]
      let expectedGeometry: {
        wrapperClass: string
        labelClass: string
        inputClass: string
        labelPosition: string
        gap: string
        labelTop: number
        labelBottom: number
        labelWidth: number
        labelHeight: number
        inputTop: number
        wrapperTop: number
        wrapperHeight: number
      } | undefined
      for (const options of visibleVariants) {
        await page.evaluate((fieldOptions) => window.__baselineLayoutFixture.mountTextField(fieldOptions), options)
        const metrics = await page.evaluate(() => {
          const wrapper = document.querySelector<HTMLElement>('.ui-text-field')!
          const label = wrapper.querySelector<HTMLLabelElement>('label')!
          const input = wrapper.querySelector<HTMLInputElement>('input')!
          const wrapperRect = wrapper.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const inputRect = input.getBoundingClientRect()
          return {
            wrapperClass: wrapper.className,
            labelClass: label.className,
            inputClass: input.className,
            labelPosition: getComputedStyle(label).position,
            gap: getComputedStyle(wrapper).rowGap,
            labelTop: labelRect.top,
            labelBottom: labelRect.bottom,
            labelWidth: labelRect.width,
            labelHeight: labelRect.height,
            inputTop: inputRect.top,
            wrapperTop: wrapperRect.top,
            wrapperHeight: wrapperRect.height
          }
        })
        expect(metrics.wrapperClass).toBe('ui-text-field')
        expect(metrics.labelClass).toBe('ui-text-field__label')
        expect(metrics.inputClass).toBe('ui-text-field__input probe-input')
        expect(metrics.labelPosition).not.toBe('absolute')
        expect(metrics.labelWidth).toBeGreaterThan(1)
        expect(metrics.labelHeight).toBeGreaterThan(1)
        expect(metrics.inputTop - metrics.labelBottom).toBeCloseTo(Number.parseFloat(metrics.gap), 1)
        expect(metrics.labelTop).toBeGreaterThanOrEqual(metrics.wrapperTop)
        if (expectedGeometry === undefined) expectedGeometry = metrics
        else expect(metrics).toEqual(expectedGeometry)
      }
    }
  }

  await page.evaluate(() => window.__baselineLayoutFixture.mountTextField({ hideLabel: true }))
  const input = page.getByRole('textbox', { name: 'Address and search' })
  await input.waitFor({ state: 'attached' })
  await page.evaluate(() => window.__baselineLayoutFixture.focusAddress())
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.id)).toBe('probe-address')

  await page.locator('#focus-origin').focus()
  await page.keyboard.press('Tab')
  expect(await input.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  const outline = await input.evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor }
  })
  expect(outline.style).not.toBe('none')
  expect(outline.width).toBeGreaterThan(0)
  expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')

  await input.fill('typed address')
  await input.press('Enter')
  expect(await input.inputValue()).toBe('typed address')
  expect(await page.evaluate(() => window.__baselineLayoutFixture.events)).toEqual([
    { type: 'change', value: 'typed address' },
    { type: 'keydown', key: 'Enter' }
  ])
})
async function setViewport(page: Page, theme: typeof themes[number], width: typeof widths[number]): Promise<void> {
  await page.setViewportSize({ width, height: 900 })
  await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme }, theme)
}

async function mountPane(page: Page, options: { mode?: 'native' | 'watch'; browserImportHintHidden?: boolean } = {}): Promise<void> {
  await page.evaluate((next) => window.__baselineLayoutFixture.mountPane(next), options)
  await page.locator('.qbp-toolbar').waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.querySelector('.qbp')?.getAttribute('data-browser-pane') === 'pane-1')
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.some(({ method }) => method === 'quirky.browser/paneState'))
}

async function mountSettings(page: Page, mode: 'standalone' | 'embedded'): Promise<void> {
  await page.evaluate((nextMode) => window.__baselineLayoutFixture.mountSettings(nextMode), mode)
  const readySelector = mode === 'standalone'
    ? '.browser-settings h1'
    : '.browser-settings [aria-label="Session & Cookies"]'
  await page.locator(readySelector).waitFor({ state: 'attached' })
  await page.waitForFunction(() => {
    const profiles = document.querySelector('[aria-label="Browser profiles"]')
    return profiles?.querySelectorAll('li').length === 3
  })
}

type PaneToolbarGeometry = {
  label: string | null
  designLabel: string | null
  menuLabel: string | null
  historyLabel: string | null
  nativeText: string
  left: number
  right: number
  clientWidth: number
  scrollWidth: number
  controls: {
    name: string
    present: boolean
    left: number
    right: number
    centerY: number
    disabled: boolean
    text: string
  }[]
  inOrder: boolean
}

function paneToolbarGeometry(page: Page): Promise<PaneToolbarGeometry> {
  return page.locator('.qbp-toolbar').evaluate((toolbar) => {
    const controls: [string, Element | null][] = [
      ['Back', toolbar.querySelector('button[aria-label="Back"]')],
      ['Forward', toolbar.querySelector('button[aria-label="Forward"]')],
      ['Reload', toolbar.querySelector('button[aria-label="Reload"]')],
      ['Address and search', toolbar.querySelector('input[aria-label="Address and search"]')],
      ['Find in page', toolbar.querySelector('button[aria-label="Find in page"]')],
      ['Native', toolbar.querySelector('.qbp-mode')],
      ['Grab', toolbar.querySelector('.qbp-design-toolbar button:nth-child(1)')],
      ['Annotate', toolbar.querySelector('.qbp-design-toolbar button:nth-child(2)')],
      ['Draw', toolbar.querySelector('.qbp-design-toolbar button:nth-child(3)')],
      ['Browser menu', toolbar.querySelector('summary[aria-label="Browser menu"]')],
      ['Browser history', toolbar.querySelector('summary[aria-label="Browser history"]')]
    ]
    const toolbarRect = toolbar.getBoundingClientRect()
    const items = controls.map(([name, element]) => {
      if (!(element instanceof HTMLElement)) throw new Error(`Missing Browser toolbar control: ${name}`)
      const rect = element.getBoundingClientRect()
      return {
        name,
        present: true,
        left: rect.left,
        right: rect.right,
        centerY: (rect.top + rect.bottom) / 2,
        disabled: 'disabled' in element ? Boolean(element.disabled) : false,
        text: element.textContent?.trim() ?? ''
      }
    })
    const elements = controls.map(([, element]) => element).filter((element): element is HTMLElement => element instanceof HTMLElement)
    const inOrder = elements.every((element, index) => index === 0 || Boolean(elements[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
    return {
      label: toolbar.getAttribute('aria-label'),
      designLabel: toolbar.querySelector('.qbp-design-toolbar')?.getAttribute('aria-label') ?? null,
      menuLabel: toolbar.querySelector('summary[aria-label="Browser menu"]')?.getAttribute('aria-label') ?? null,
      historyLabel: toolbar.querySelector('summary[aria-label="Browser history"]')?.getAttribute('aria-label') ?? null,
      nativeText: toolbar.querySelector('.qbp-mode')?.textContent?.trim() ?? '',
      left: toolbarRect.left,
      right: toolbarRect.right,
      clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth,
      controls: items,
      inOrder
    }
  })
}

function expectAllToolbarControlsInside(metrics: PaneToolbarGeometry): void {
  expect(metrics.inOrder).toBe(true)
  expect(metrics.controls.every((control) => control.present)).toBe(true)
  expect(metrics.controls.every((control) => control.left >= metrics.left - 0.5 && control.right <= metrics.right + 0.5)).toBe(true)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
}

const addressUrl = 'http://127.0.0.1:8765/'
const longAddress = 'https://example.test/' + 'x'.repeat(219)

test('the Native Browser toolbar retains its order and fits one row at desktop and tablet widths', async () => {
  const page = await styledPage()
  await mountPane(page)

  const address = page.getByRole('textbox', { name: 'Address and search' })
  await address.waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Address and search')
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.some(({ method }) => method === 'quirky.browser/preferencesState'))

  for (const theme of themes) {
    for (const width of [700, 1000] as const) {
      await setViewport(page, theme, width)
      const metrics = await paneToolbarGeometry(page)
      expect(metrics.label).toBe('Browser controls')
      expect(metrics.designLabel).toBe('Browser design tools')
      expect(metrics.menuLabel).toBe('Browser menu')
      expect(metrics.historyLabel).toBe('Browser history')
      expect(metrics.nativeText).toBe('Native')
      const centers = metrics.controls.map(({ centerY }) => centerY)
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
      expectAllToolbarControlsInside(metrics)
      if (width === 700) {
        expect(await address.evaluate((input) => input.getBoundingClientRect().width)).toBeGreaterThanOrEqual(156)
      }
    }
  }

  expect(await address.getAttribute('placeholder')).toBe('Search or enter address')
  expect(await address.getAttribute('aria-autocomplete')).toBe('list')
  expect(await address.getAttribute('aria-expanded')).toBe('false')
  expect((await address.getAttribute('class'))?.split(' ')).toContain('qbp-address')
  const addressLabel = address.locator('..').locator('label')
  expect(await addressLabel.getAttribute('for')).toBe(await address.getAttribute('id'))
  expect(await addressLabel.getAttribute('class')).toContain('ui-text-field__label--hidden')
  const addressLabelBox = await addressLabel.evaluate((label) => {
    const rect = label.getBoundingClientRect()
    return { position: getComputedStyle(label).position, width: rect.width, height: rect.height }
  })
  expect(addressLabelBox.position).toBe('absolute')
  expect(addressLabelBox.width).toBeLessThanOrEqual(1)
  expect(addressLabelBox.height).toBeLessThanOrEqual(1)
  const focusStyle = await address.evaluate((input) => {
    const style = getComputedStyle(input)
    return { focused: input.matches(':focus-visible'), outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
  })
  expect(focusStyle.focused).toBe(true)
  expect(focusStyle.outline).not.toBe('none')
  expect(focusStyle.width).toBeGreaterThan(0)

  const designButtons = page.locator('.qbp-design-toolbar button')
  expect(await designButtons.allTextContents()).toEqual(['Grab', 'Annotate', 'Draw'])
  expect(await designButtons.evaluateAll((buttons) => buttons.map((button) => button instanceof HTMLButtonElement && button.disabled))).toEqual([true, true, true])
  expect(await page.getByRole('button', { name: 'Find in page' }).count()).toBe(1)
})

test('narrow Browser controls wrap without horizontal overflow and a long address cannot widen the toolbar', async () => {
  const page = await styledPage()
  await mountPane(page)
  const address = page.getByRole('textbox', { name: 'Address and search' })

  for (const theme of themes) {
    await setViewport(page, theme, 320)
    let metrics = await paneToolbarGeometry(page)
    expectAllToolbarControlsInside(metrics)

    await address.fill(longAddress)
    await page.waitForFunction((query) => window.__baselineLayoutFixture.apiCalls.some(({ method, params }) =>
      method === 'quirky.browser/paneSuggestions' && params?.query === query), longAddress)
    metrics = await paneToolbarGeometry(page)
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
    expect(metrics.controls.every((control) => control.left >= metrics.left - 0.5 && control.right <= metrics.right + 0.5)).toBe(true)
    expect(await address.inputValue()).toBe(longAddress)
    await address.fill('')
  }
})

test('typed and suggested Browser navigation, Escape, Find and menu Escape keep their real routes', async () => {
  const page = await styledPage()
  await mountPane(page)
  const address = page.getByRole('textbox', { name: 'Address and search' })

  await address.fill(addressUrl)
  await page.getByRole('listbox', { name: 'Browser suggestions' }).waitFor({ state: 'attached' })
  await page.waitForFunction((query) => window.__baselineLayoutFixture.apiCalls.some(({ method, params }) =>
    method === 'quirky.browser/paneSuggestions' && params?.query === query), addressUrl)
  await address.press('Enter')
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.some(({ method }) => method === 'quirky.browser/paneNavigate'))
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'quirky.browser/paneNavigate'))).toEqual([
    { method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: addressUrl } }
  ])

  await address.fill('')
  await address.fill(addressUrl)
  await page.getByRole('listbox', { name: 'Browser suggestions' }).waitFor({ state: 'attached' })
  await address.press('ArrowDown')
  await address.press('ArrowDown')
  await address.press('Enter')
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'quirky.browser/paneNavigate').length === 2)
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'quirky.browser/paneNavigate'))).toEqual([
    { method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: addressUrl } },
    { method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: 'https://example.test/other' } }
  ])

  await address.fill(addressUrl)
  await page.getByRole('listbox', { name: 'Browser suggestions' }).waitFor({ state: 'attached' })
  await address.press('Escape')
  await page.locator('[role="listbox"][aria-label="Browser suggestions"]').waitFor({ state: 'detached' })
  expect(await address.getAttribute('aria-expanded')).toBe('false')

  await page.getByRole('button', { name: 'Find in page' }).click()
  const find = page.getByRole('textbox', { name: 'Find text in page' })
  await find.waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find text in page')
  expect(await page.evaluate(() => window.__baselineLayoutFixture.commandCalls.filter(({ id }) => id === 'command:quirky.browser/paneUiControl'))).toContainEqual({
    id: 'command:quirky.browser/paneUiControl',
    args: { action: 'open-find', pane: 'pane-1' }
  })
  await find.fill('needle')
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.some(({ method, params }) =>
    method === 'quirky.browser/paneControl' && params?.action === 'find' && params?.text === 'needle'))
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method, params }) =>
    method === 'quirky.browser/paneControl' && params?.action === 'find'))).toContainEqual({
    method: 'quirky.browser/paneControl',
    params: { pane: 'pane-1', action: 'find', text: 'needle', forward: true }
  })

  const menu = page.locator('details:has(> summary[aria-label="Browser menu"])')
  const menuSummary = page.locator('summary[aria-label="Browser menu"]')
  await menuSummary.press('Enter')
  await page.waitForFunction(() => document.querySelector('details:has(> summary[aria-label="Browser menu"])')?.hasAttribute('open'))
  await page.getByRole('menuitem', { name: 'Zoom In' }).press('Escape')
  await page.waitForFunction(() => !document.querySelector('details:has(> summary[aria-label="Browser menu"])')?.hasAttribute('open'))
  await page.waitForFunction(() => document.activeElement === document.querySelector('summary[aria-label="Browser menu"]'))
  expect(await page.evaluate(() => window.__baselineLayoutFixture.commandCalls.filter(({ id }) => id === 'command:quirky.browser/paneUiControl'))).toContainEqual({
    id: 'command:quirky.browser/paneUiControl',
    args: { action: 'close-browser-menu', pane: 'pane-1' }
  })
  expect(await menu.locator(':scope > summary').evaluate((summary) => document.activeElement === summary)).toBe(true)
})

test('a refused Browser navigation uses its existing InlineError without changing the route', async () => {
  const page = await styledPage()
  await page.evaluate(() => window.__baselineLayoutFixture.setNavigationFailure('Navigation refused'))
  await mountPane(page)
  const address = page.getByRole('textbox', { name: 'Address and search' })
  await address.fill(addressUrl)
  await address.press('Enter')
  const error = page.locator('.qbp-message .ui-inline-error')
  await error.waitFor({ state: 'visible' })
  expect(await error.textContent()).toBe('Navigation refused')
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'quirky.browser/paneNavigate'))).toEqual([
    { method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: addressUrl } }
  ])
  expect(await page.locator('[role="status"]').filter({ hasText: 'Navigation refused' }).count()).toBe(0)
})

test('an enabled import hint and a pending Watch design operation keep every narrow Browser control', async () => {
  const page = await styledPage()
  await mountPane(page, { mode: 'native', browserImportHintHidden: false })
  await page.getByRole('complementary', { name: 'Import browser data hint' }).waitFor({ state: 'visible' })

  for (const theme of themes) {
    await setViewport(page, theme, 320)
    expectAllToolbarControlsInside(await paneToolbarGeometry(page))
    expect(await page.getByRole('complementary', { name: 'Import browser data hint' }).isVisible()).toBe(true)
  }

  await page.evaluate(() => window.__baselineLayoutFixture.mountPane({ mode: 'watch' }))
  await page.waitForFunction(() => window.__baselineLayoutFixture.apiCalls.some(({ method }) => method === 'quirky.browser/paneWatch'))
  await page.evaluate(() => window.__baselineLayoutFixture.emitFrame())
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img.qbp-watch-image')
    return Boolean(image?.complete && image.naturalWidth > 0)
  })
  await page.evaluate(() => window.__baselineLayoutFixture.setDesignArmPending(true))
  const grab = page.getByRole('button', { name: 'Grab' })
  await grab.click()
  await page.waitForFunction(() => {
    const button = document.querySelector('.qbp-design-toolbar button')
    return button?.textContent?.trim() === 'Arming…' && button.getAttribute('aria-busy') === 'true'
  })
  await setViewport(page, 'dark', 320)
  expectAllToolbarControlsInside(await paneToolbarGeometry(page))
  await page.evaluate(() => window.__baselineLayoutFixture.releaseDesignArm())
  const designHint = page.locator('.qbp-design-toolbar [role="status"]')
  await designHint.waitFor({ state: 'visible' })
  expect(await designHint.textContent()).toBe('Click an element, or hover and press C to copy / S to screenshot. Esc cancels.')
  expectAllToolbarControlsInside(await paneToolbarGeometry(page))
})

test('standalone Browser settings keeps its inset, grid and preservation geometry at every theme and width', async () => {
  const page = await styledPage()
  await mountSettings(page, 'standalone')

  for (const theme of themes) {
    for (const width of widths) {
      await setViewport(page, theme, width)
      const metrics = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.browser-settings')!
        const rootRect = root.getBoundingClientRect()
        const title = root.querySelector('h1')!
        const titleRect = title.getBoundingClientRect()
        const homePage = root.querySelector<HTMLInputElement>('input[aria-label="Default home page"]')!
        const save = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Save')!
        const saveRect = save.getBoundingClientRect()
        const homeRect = homePage.getBoundingClientRect()
        const session = root.querySelector<HTMLElement>('section[aria-label="Session & Cookies"]')!
        const profile = root.querySelector<HTMLElement>('[aria-label="Browser profiles"] li')!
        const name = profile.querySelector('strong')!
        const active = [...profile.querySelectorAll<HTMLElement>('.ui-badge')].find((badge) => badge.textContent?.trim() === 'Active')!
        const nameRect = name.getBoundingClientRect()
        const activeRect = active.getBoundingClientRect()
        const longName = [...root.querySelectorAll<HTMLElement>('[aria-label="Browser profiles"] strong')].find((strong) => strong.textContent?.startsWith('VeryLongBrowserProfileName'))!
        const longNameRange = document.createRange()
        longNameRange.selectNodeContents(longName)
        return {
          className: root.className,
          paddingTop: getComputedStyle(root).paddingTop,
          paddingLeft: getComputedStyle(root).paddingLeft,
          display: getComputedStyle(root).display,
          gap: getComputedStyle(root).rowGap,
          titleCount: root.querySelectorAll('h1').length,
          titleTop: titleRect.top - rootRect.top,
          titleLeft: titleRect.left - rootRect.left,
          rootClientWidth: root.clientWidth,
          rootScrollWidth: root.scrollWidth,
          saveGap: saveRect.top - homeRect.bottom,
          sessionPadding: getComputedStyle(session).padding,
          activeGap: activeRect.left - nameRect.right,
          sameProfileLine: Math.abs((activeRect.top + activeRect.bottom) / 2 - (nameRect.top + nameRect.bottom) / 2) <= 0.5,
          longNameLineCount: longNameRange.getClientRects().length,
          sections: [...root.querySelectorAll('section[aria-label]')].map((section) => section.getAttribute('aria-label'))
        }
      })
      expect(metrics.className.split(' ')).toContain('ui-panel-content')
      expect(metrics.paddingTop).toBe('8px')
      expect(metrics.paddingLeft).toBe('8px')
      expect(metrics.display).toBe('grid')
      expect(metrics.gap).toBe('16px')
      expect(metrics.titleCount).toBe(1)
      expect(metrics.titleTop).toBeCloseTo(8, 1)
      expect(metrics.titleLeft).toBeCloseTo(8, 1)
      expect(metrics.saveGap).toBeCloseTo(12, 1)
      expect(metrics.sessionPadding).toBe('12px')
      expect(metrics.sameProfileLine).toBe(true)
      expect(metrics.activeGap).toBeCloseTo(6, 1)
      expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth)
      if (width === 320) expect(metrics.longNameLineCount).toBeGreaterThan(1)
      expect(metrics.sections).toEqual(['Browser Defaults', 'Agent Browser Use', 'Chrome identity', 'Link Routing', 'Import browser data', 'Session & Cookies'])
      expect(await page.getByRole('textbox', { name: 'Default home page' }).count()).toBe(1)
      expect(await page.getByRole('combobox', { name: 'Default search engine' }).count()).toBe(1)
      expect(await page.getByRole('combobox', { name: 'Default zoom' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Add Profile' }).count()).toBe(1)
    }
  }
})

test('Browser settings Save preserves its exact draft route while pending and reports a rejected save', async () => {
  const page = await styledPage()
  await mountSettings(page, 'standalone')
  const homePage = page.getByRole('textbox', { name: 'Default home page' })
  const save = page.getByRole('button', { name: 'Save' })
  const draft = 'https://draft.example.test/saved-path'

  await page.evaluate(() => window.__baselineLayoutFixture.setSaveBehavior('pending'))
  await homePage.fill(draft)
  await save.click()
  await page.waitForFunction(() => {
    const save = [...document.querySelectorAll<HTMLButtonElement>('.browser-settings button')]
      .find((button) => button.textContent?.trim() === 'Save')
    return save?.disabled === true
  })
  expect(await save.isDisabled()).toBe(true)
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'setting.set'))).toEqual([
    { method: 'setting.set', params: { id: 'setting:quirky.browser/defaultHomePage', value: draft } }
  ])
  await page.evaluate(() => window.__baselineLayoutFixture.releasePendingSave())
  await page.getByRole('status').filter({ hasText: 'Default home page saved.' }).waitFor({ state: 'visible' })
  expect(await save.isDisabled()).toBe(false)

  await page.evaluate(() => window.__baselineLayoutFixture.setSaveBehavior('reject', 'Save refused'))
  await homePage.fill('https://draft.example.test/rejected')
  await save.click()
  const error = page.locator('.browser-settings .ui-inline-error[role="alert"]')
  await error.waitFor({ state: 'visible' })
  expect(await error.textContent()).toBe('Save refused')
  expect(await homePage.inputValue()).toBe('https://draft.example.test/rejected')
  expect(await page.getByRole('status').filter({ hasText: 'Default home page saved.' }).count()).toBe(0)
  expect(await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) => method === 'setting.set'))).toEqual([
    { method: 'setting.set', params: { id: 'setting:quirky.browser/defaultHomePage', value: draft } },
    { method: 'setting.set', params: { id: 'setting:quirky.browser/defaultHomePage', value: 'https://draft.example.test/rejected' } }
  ])
  expect(await page.evaluate(() => window.__baselineLayoutFixture.toasts)).toEqual([
    { title: 'Browser settings', body: 'Save refused', options: { kind: 'error' } }
  ])
  const sideEffectCalls = await page.evaluate(() => window.__baselineLayoutFixture.apiCalls.filter(({ method }) =>
    ['quirky.browser/profileClear', 'quirky.browser/profileDelete', 'quirky.browser/importStart'].includes(method)))
  expect(sideEffectCalls).toEqual([])
})

test('registered embedded Browser preferences preserves the host heading and profile actions without standalone inset', async () => {
  const page = await styledPage()
  await mountSettings(page, 'embedded')

  for (const theme of themes) {
    for (const width of widths) {
      await setViewport(page, theme, width)
      const metrics = await page.evaluate(() => {
        const hostHeading = document.querySelector<HTMLElement>('#host-heading')!
        const root = document.querySelector<HTMLElement>('.browser-settings')!
        const rootRect = root.getBoundingClientRect()
        const session = root.querySelector<HTMLElement>('section[aria-label="Session & Cookies"]')!
        const profile = root.querySelector<HTMLElement>('[aria-label="Browser profiles"] li')!
        const name = profile.querySelector('strong')!
        const active = [...profile.querySelectorAll<HTMLElement>('.ui-badge')].find((badge) => badge.textContent?.trim() === 'Active')!
        const nameRect = name.getBoundingClientRect()
        const activeRect = active.getBoundingClientRect()
        const longName = [...root.querySelectorAll<HTMLElement>('[aria-label="Browser profiles"] strong')].find((strong) => strong.textContent?.startsWith('VeryLongBrowserProfileName'))!
        const range = document.createRange()
        range.selectNodeContents(longName)
        return {
          hostText: hostHeading.textContent,
          hostHeadingCount: document.querySelectorAll('#host-heading').length,
          browserHeadingCount: [...root.querySelectorAll('h1')].filter((heading) => heading.textContent?.trim() === 'Browser').length,
          className: root.className,
          paddingTop: getComputedStyle(root).paddingTop,
          paddingLeft: getComputedStyle(root).paddingLeft,
          rootClientWidth: root.clientWidth,
          rootScrollWidth: root.scrollWidth,
          rootLeft: rootRect.left,
          rootRight: rootRect.right,
          sessionPadding: getComputedStyle(session).padding,
          activeGap: activeRect.left - nameRect.right,
          sameProfileLine: Math.abs((activeRect.top + activeRect.bottom) / 2 - (nameRect.top + nameRect.bottom) / 2) <= 0.5,
          longNameLineCount: range.getClientRects().length,
          sectionNames: [...root.querySelectorAll('section[aria-label]')].map((section) => section.getAttribute('aria-label'))
        }
      })
      expect(metrics.hostText).toBe('Browser: Session & Cookies')
      expect(metrics.hostHeadingCount).toBe(1)
      expect(metrics.browserHeadingCount).toBe(0)
      expect(metrics.className.split(' ')).not.toContain('ui-panel-content')
      expect(metrics.paddingTop).toBe('0px')
      expect(metrics.paddingLeft).toBe('0px')
      expect(metrics.sessionPadding).toBe('12px')
      expect(metrics.sameProfileLine).toBe(true)
      expect(metrics.activeGap).toBeCloseTo(6, 1)
      expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth)
      if (width === 320) expect(metrics.longNameLineCount).toBeGreaterThan(1)
      expect(metrics.sectionNames).toEqual(['Session & Cookies'])
      expect(await page.getByText('Cleaned identity is active.', { exact: true }).count()).toBe(1)
      expect(await page.getByText('System webview identity cannot be changed on this platform: its native webview has no user-agent override.', { exact: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Add Profile' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Clear cookies & site data' }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Import Cookies' }).count()).toBe(3)
      expect(await page.getByRole('button', { name: 'Remove', exact: true }).count()).toBe(2)
      expect(await page.getByText('Active', { exact: true }).count()).toBe(1)
      expect(metrics.rootLeft).toBeGreaterThanOrEqual(0)
      expect(metrics.rootRight).toBeLessThanOrEqual(width)
    }
  }
})

test('embedded Add Profile and close use the registered preferences dispatcher and show refused commands exactly', async () => {
  const page = await styledPage()
  await mountSettings(page, 'embedded')

  await page.getByRole('button', { name: 'Add Profile' }).click()
  await page.getByRole('dialog', { name: 'New Browser Profile' }).waitFor({ state: 'visible' })
  const openCommand = await page.evaluate(() => window.__baselineLayoutFixture.commandCalls.filter(({ id }) => id === 'command:quirky.browser/preferencesControl'))
  expect(openCommand).toHaveLength(1)
  expect(openCommand[0]?.id).toBe('command:quirky.browser/preferencesControl')
  expect(openCommand[0]?.args).toEqual({ action: 'open-create-profile', instance: expect.any(String) })
  const openArgs = openCommand[0]?.args
  if (typeof openArgs !== 'object' || openArgs === null || !('instance' in openArgs) || typeof openArgs.instance !== 'string') {
    throw new Error('Add Profile did not provide a preferences-control instance.')
  }
  const openInstance = openArgs.instance
  expect(openInstance.length).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__baselineLayoutFixture.dispatchResults.filter(({ id }) => id === 'command:quirky.browser/preferencesControl'))).toEqual([
    {
      id: 'command:quirky.browser/preferencesControl',
      args: { action: 'open-create-profile', instance: openInstance },
      result: { instance: openInstance, action: 'open-create-profile', delivered: 1 }
    }
  ])

  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('dialog', { name: 'New Browser Profile' }).waitFor({ state: 'detached' })
  expect(await page.evaluate(() => window.__baselineLayoutFixture.commandCalls.filter(({ id }) => id === 'command:quirky.browser/preferencesControl'))).toEqual([
    { id: 'command:quirky.browser/preferencesControl', args: { action: 'open-create-profile', instance: openInstance } },
    { id: 'command:quirky.browser/preferencesControl', args: { action: 'close-create-profile', instance: openInstance } }
  ])
  expect(await page.evaluate(() => window.__baselineLayoutFixture.dispatchResults.filter(({ id }) => id === 'command:quirky.browser/preferencesControl').map(({ result }) => result))).toEqual([
    { instance: openInstance, action: 'open-create-profile', delivered: 1 },
    { instance: openInstance, action: 'close-create-profile', delivered: 1 }
  ])

  await page.evaluate(() => window.__baselineLayoutFixture.setCommandFailure('Control refused'))
  await page.getByRole('button', { name: 'Add Profile' }).click()
  const error = page.locator('.browser-settings .ui-inline-error[role="alert"]')
  await error.waitFor({ state: 'visible' })
  expect(await error.textContent()).toBe('Control refused')
  expect(await page.getByRole('dialog', { name: 'New Browser Profile' }).count()).toBe(0)
  expect(await page.evaluate(() => window.__baselineLayoutFixture.commandCalls.filter(({ id }) => id === 'command:quirky.browser/preferencesControl'))).toEqual([
    { id: 'command:quirky.browser/preferencesControl', args: { action: 'open-create-profile', instance: openInstance } },
    { id: 'command:quirky.browser/preferencesControl', args: { action: 'close-create-profile', instance: openInstance } },
    { id: 'command:quirky.browser/preferencesControl', args: { action: 'open-create-profile', instance: openInstance } }
  ])
  expect(await page.evaluate(() => window.__baselineLayoutFixture.toasts)).toEqual([
    { title: 'Browser settings', body: 'Control refused', options: { kind: 'error' } }
  ])
})
 
