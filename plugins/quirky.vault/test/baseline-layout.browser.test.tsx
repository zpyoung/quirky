import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
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
const SEARCH_SETTINGS = join(ROOT, 'plugins/quirky.vault/src/window/SearchSettings.tsx')
const OWNER_LABEL = 'ui-review-owner — remote session archive used for Vault layout review and regression coverage'
const LOCAL_LABEL = 'Enable local Agent Session Search'
const REMOTE_SWITCH_LABEL = `Enable Agent Session Search on ${OWNER_LABEL}`
const DISCLOSURE = 'Search stores full, unredacted agent conversations on this computer, including up to 3,072 characters from each tool output. Authenticated clients can search this local index through the daemon.'
const executable = browserExecutable()

type Theme = 'dark' | 'light'
type MountKind = 'embedded' | 'standalone'
type ReadPlan = 'reply' | 'pending' | 'reject'
type WritePlan = 'success' | 'pending' | 'reject'
type HostSeed = { hostId: string; label: string; kind: 'ok' | 'unavailable' | 'error'; reason?: string }
type FixtureOptions = {
  mount: MountKind
  hosts?: HostSeed[]
  localRead?: ReadPlan
  localReadError?: string
  allRead?: ReadPlan
  remoteReads?: Record<string, { plan?: ReadPlan; error?: string; enabled?: boolean }>
  write?: WritePlan
  writeError?: string
}
type ApiCall = { method: string; params: Record<string, unknown> }
type BrowserFixture = {
  mount(options: FixtureOptions): void
  dispose(): void
  resolveRead(host: string): void
  resolveWrite(host: string): void
  calls: ApiCall[]
}

declare global {
  interface Window {
    __vaultSettingsFixture: BrowserFixture
  }
}

let browser: Browser | undefined
let browserBundle = ''
let productionCss = ''

const browserDependencyResolver: Bun.BunPlugin = {
  name: 'vault-settings-browser-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /vault-settings-browser-fixture\.tsx?$/ }, () => ({
      path: 'entry',
      namespace: 'vault-settings-entry'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'vault-settings-entry' }, () => ({
      contents: browserEntry(),
      loader: 'ts',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
    builder.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => ({
      path: Bun.resolveSync(path, importer ? dirname(importer) : ROOT)
    }))
  }
}

function browserEntry(): string {
  return `
    import { mountSearchSettings, mountSearchSettingsView } from ${JSON.stringify(SEARCH_SETTINGS)}

    const localHost = { hostId: 'local', label: 'Local Mac', kind: 'ok', scannedFiles: 0, scannedAt: null }
    const defaultOwner = { hostId: 'owner', label: ${JSON.stringify(OWNER_LABEL)}, kind: 'ok', scannedFiles: 0, scannedAt: null }
    const status = (overrides = {}) => ({
      enabled: false,
      phase: 'idle',
      filesIndexed: 0,
      filesDue: 0,
      filesFailed: 0,
      messagesIndexed: 0,
      degradedRoots: [],
      lastReconcileAt: null,
      lastSweepCompletedAt: null,
      generation: 1,
      supportedAgents: [],
      sessionsByAgent: {},
      ...overrides
    })
    const reply = (hosts, currentStatus = status()) => ({ status: currentStatus, hosts })
    let unmount = null
    let options = null
    const pendingReads = new Map()
    const pendingWrites = new Map()
    const calls = []
    const writeStatus = (host, enabled) => reply([host === 'local' ? localHost : (options.hosts ?? [localHost, defaultOwner]).find((entry) => entry.hostId === host) ?? defaultOwner], status({ enabled, phase: enabled ? 'current' : 'idle' }))
    const readResponse = (host) => {
      if (host === 'local') return reply([localHost])
      if (host === 'all') return reply(options.hosts ?? [localHost, defaultOwner])
      const remote = options.remoteReads?.[host]
      return reply([], status({ enabled: remote?.enabled ?? false, phase: remote?.enabled ? 'current' : 'idle' }))
    }
    const call = async (method, params = {}) => {
      calls.push({ method, params: { ...params } })
      if (method === 'quirky.vault/searchStatus') {
        const host = params.host
        const plan = host === 'local' ? (options.localRead ?? 'reply') : host === 'all' ? (options.allRead ?? 'reply') : (options.remoteReads?.[host]?.plan ?? 'reply')
        if (plan === 'pending') {
          const deferred = Promise.withResolvers()
          pendingReads.set(host, deferred)
          return await deferred.promise
        }
        if (plan === 'reject') throw new Error(host === 'local' ? (options.localReadError ?? 'local status unavailable') : (options.remoteReads?.[host]?.error ?? 'remote status unavailable'))
        return readResponse(host)
      }
      if (method === 'quirky.vault/setSearchEnabled') {
        const host = params.host
        const enabled = params.enabled === true
        const write = options.write ?? 'success'
        if (write === 'pending') {
          const deferred = Promise.withResolvers()
          pendingWrites.set(host, { ...deferred, enabled })
          return await deferred.promise
        }
        if (write === 'reject') throw new Error(options.writeError ?? 'write refused')
        return writeStatus(host, enabled)
      }
      throw new Error('Unexpected Vault settings API call: ' + method)
    }
    const fixture = {
      calls,
      mount(nextOptions) {
        options = nextOptions
        const target = document.getElementById('settings-root')
        if (!target) throw new Error('Missing SearchSettings mount element.')
        const mount = options.mount === 'embedded' ? mountSearchSettings : mountSearchSettingsView
        unmount = mount({
          call,
          subscribe: () => () => {},
          toast: () => {},
          confirm: async () => false,
          togglePanel: () => {}
        }, target, {})
      },
      resolveRead(host) {
        const pending = pendingReads.get(host)
        if (!pending) throw new Error('No pending status read for ' + host)
        pendingReads.delete(host)
        pending.resolve(readResponse(host))
      },
      resolveWrite(host) {
        const pending = pendingWrites.get(host)
        if (!pending) throw new Error('No pending enable write for ' + host)
        pendingWrites.delete(host)
        pending.resolve(writeStatus(host, pending.enabled))
      },
      dispose() {
        unmount?.()
        unmount = null
        for (const [host, pending] of pendingReads) pending.resolve(readResponse(host))
        pendingReads.clear()
        for (const [host, pending] of pendingWrites) pending.resolve(writeStatus(host, pending.enabled))
        pendingWrites.clear()
      }
    }
    window.__vaultSettingsFixture = fixture
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
  const shell = await expandStyleImports(pathToFileURL(join(ROOT, 'packages/ui/src/shell/chrome.css')))
  const app = await expandStyleImports(pathToFileURL(join(ROOT, 'packages/ui/src/styles.css')))
  return `${shell}\n${app}`
}

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'vault-settings-browser-fixture.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Vault settings browser bundle was empty.')
  browserBundle = await output.text()
  productionCss = await productionStyles()
  browser = await chromium.launch({ headless: true, executablePath: executable })
}, 60_000)

afterAll(async () => {
  const launchedBrowser = browser
  try {
    browser = undefined
  } finally {
    await launchedBrowser?.close()
  }
}, 30_000)

function localSeed(): HostSeed {
  return { hostId: 'local', label: 'Local Mac', kind: 'ok' }
}

function defaultHosts(): HostSeed[] {
  return [localSeed(), { hostId: 'owner', label: OWNER_LABEL, kind: 'ok' }]
}

async function withSettingsPage<T>(
  setup: { theme: Theme; viewportWidth: 1000 | 320; containerWidth: 600 | 320; fixture: FixtureOptions },
  run: (page: Page) => Promise<T>
): Promise<T> {
  if (!browser) throw new Error('The Vault settings browser did not launch.')
  const page = await browser.newPage({ viewport: { width: setup.viewportWidth, height: 900 } })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.setContent(`
      <html data-theme="${setup.theme}">
        <head><style>${productionCss}</style></head>
        <body>
          <div id="settings-container" style="display:flex;flex-direction:column;width:${setup.containerWidth}px;height:900px;margin-inline:auto">
            <div id="settings-root"></div>
          </div>
        </body>
      </html>
    `)
    await page.addScriptTag({ content: browserBundle })
    await page.evaluate((fixtureOptions) => window.__vaultSettingsFixture.mount(fixtureOptions), setup.fixture)
    await page.locator('[data-vault-settings]').waitFor()
    return await run(page)
  } finally {
    try {
      await page.evaluate(() => window.__vaultSettingsFixture?.dispose())
    } finally {
      await page.close()
    }
    expect(pageErrors).toEqual([])
  }
}

async function waitForDefaultRows(page: Page): Promise<void> {
  await page.getByRole('switch', { name: LOCAL_LABEL, exact: true }).waitFor()
  await page.getByRole('switch', { name: REMOTE_SWITCH_LABEL, exact: true }).waitFor()
  await page.waitForFunction((label) => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-vault-host-row]')]
    return rows.some((row) => row.dataset.vaultHostId === 'local' && row.dataset.vaultHostStatus === 'idle') &&
      rows.some((row) => row.dataset.vaultHostId === 'owner' && row.dataset.vaultHostStatus === 'idle' && row.textContent?.includes(label))
  }, OWNER_LABEL)
}

async function switchLabel(page: Page, switchName: string): Promise<{ id: string; label: Locator }> {
  const input = page.getByRole('switch', { name: switchName, exact: true })
  const id = await input.getAttribute('id')
  if (!id) throw new Error(`The ${switchName} switch has no id.`)
  return { id, label: page.locator(`label[for="${id}"]`) }
}

async function writeCalls(page: Page): Promise<ApiCall[]> {
  return page.evaluate(() => window.__vaultSettingsFixture.calls.filter((call) => call.method === 'quirky.vault/setSearchEnabled'))
}

function assertEightPixelGap(value: number): void {
  expect(Math.abs(value - 8)).toBeLessThanOrEqual(0.5)
}

const layoutCases = [
  { name: 'dark/1000px/embedded', theme: 'dark', viewportWidth: 1000, containerWidth: 600, mount: 'embedded' },
  { name: 'dark/1000px/standalone', theme: 'dark', viewportWidth: 1000, containerWidth: 600, mount: 'standalone' },
  { name: 'dark/320px/embedded', theme: 'dark', viewportWidth: 320, containerWidth: 320, mount: 'embedded' },
  { name: 'dark/320px/standalone', theme: 'dark', viewportWidth: 320, containerWidth: 320, mount: 'standalone' },
  { name: 'light/1000px/embedded', theme: 'light', viewportWidth: 1000, containerWidth: 600, mount: 'embedded' },
  { name: 'light/1000px/standalone', theme: 'light', viewportWidth: 1000, containerWidth: 600, mount: 'standalone' },
  { name: 'light/320px/embedded', theme: 'light', viewportWidth: 320, containerWidth: 320, mount: 'embedded' },
  { name: 'light/320px/standalone', theme: 'light', viewportWidth: 320, containerWidth: 320, mount: 'standalone' }
] as const

for (const scenario of layoutCases) {
  test(`Vault settings preserve host-row geometry and semantics (${scenario.name})`, async () => {
    await withSettingsPage({
      theme: scenario.theme,
      viewportWidth: scenario.viewportWidth,
      containerWidth: scenario.containerWidth,
      fixture: { mount: scenario.mount, hosts: defaultHosts() }
    }, async (page) => {
      await waitForDefaultRows(page)
      const layout = await page.locator('[data-vault-host-id="local"], [data-vault-host-id="owner"]').evaluateAll((rows) => rows.map((row) => {
        const list = row.querySelector<HTMLElement>('.ui-list-row')!
        const form = row.querySelector<HTMLElement>('.ui-form-row')!
        const label = form.querySelector<HTMLLabelElement>('.ui-form-row__label')!
        const input = form.querySelector<HTMLInputElement>('input')!
        const listRect = list.getBoundingClientRect()
        const formRect = form.getBoundingClientRect()
        const labelRect = label.getBoundingClientRect()
        const inputRect = input.getBoundingClientRect()
        const labelRange = document.createRange()
        labelRange.selectNodeContents(label)
        const title = list.querySelector<HTMLElement>('.ui-list-row__title')!
        const titleRange = document.createRange()
        titleRange.selectNodeContents(title)
        return {
          hostId: row.getAttribute('data-vault-host-id'),
          hostStatus: row.getAttribute('data-vault-host-status'),
          rowWidth: row.clientWidth,
          rowScrollWidth: row.scrollWidth,
          list: { left: listRect.left, right: listRect.right, top: listRect.top, bottom: listRect.bottom },
          form: { left: formRect.left, right: formRect.right, top: formRect.top, bottom: formRect.bottom },
          label: {
            text: label.textContent,
            rect: { left: labelRect.left, right: labelRect.right, top: labelRect.top, bottom: labelRect.bottom },
            lineRects: [...labelRange.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
            clientWidth: label.clientWidth,
            scrollWidth: label.scrollWidth,
            htmlFor: label.htmlFor
          },
          title: {
            text: title.textContent,
            clientWidth: title.clientWidth,
            scrollWidth: title.scrollWidth,
            lineRects: [...titleRange.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }))
          },
          input: {
            id: input.id,
            name: input.getAttribute('name'),
            role: input.getAttribute('role'),
            type: input.type,
            ariaLabel: input.getAttribute('aria-label'),
            checked: input.checked,
            width: inputRect.width,
            height: inputRect.height,
            left: inputRect.left,
            right: inputRect.right,
            top: inputRect.top,
            bottom: inputRect.bottom,
            labelPrecedesInput: Boolean(label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)
          },
          formOrder: form.children[0] === label && form.children[1] === input.parentElement,
          wrap: getComputedStyle(row).flexWrap,
          groupGap: formRect.left > listRect.right - 0.5 && formRect.top < listRect.bottom && formRect.bottom > listRect.top
            ? formRect.left - listRect.right
            : formRect.top - listRect.bottom,
          horizontal: formRect.left > listRect.right - 0.5 && formRect.top < listRect.bottom && formRect.bottom > listRect.top,
          labelGap: inputRect.left - labelRect.right,
          badge: list.querySelector<HTMLElement>('.ui-list-row__trailing .ui-badge')?.textContent?.trim() ?? null,
          badgeInsideList: Boolean(list.querySelector('.ui-list-row__trailing .ui-badge'))
        }
      }))
      expect(layout).toHaveLength(2)
      const expectedHostLabels = new Map([
        ['local', LOCAL_LABEL],
        ['owner', REMOTE_SWITCH_LABEL]
      ])
      for (const row of layout) {
        const expectedLabel = expectedHostLabels.get(row.hostId!)!
        expect(row.hostStatus).toBe('idle')
        expect(row.wrap).toBe('wrap')
        assertEightPixelGap(row.groupGap)
        assertEightPixelGap(row.labelGap)
        expect(row.badgeInsideList).toBe(true)
        expect(row.badge).toBe('Disabled')
        expect(row.input.type).toBe('checkbox')
        expect(row.input.role).toBe('switch')
        expect(row.input.name).toBeNull()
        expect(row.input.id).toBeTruthy()
        expect(row.input.ariaLabel).toBe(expectedLabel)
        expect(row.label.htmlFor).toBe(row.input.id)
        expect(row.label.text).toBe(expectedLabel)
        expect(row.formOrder).toBe(true)
        expect(row.input.labelPrecedesInput).toBe(true)
        expect(row.input.checked).toBe(false)
        expect(row.input.width).toBeCloseTo(16, 1)
        expect(row.input.height).toBeCloseTo(16, 1)
        expect(await page.getByRole('switch', { name: expectedLabel, exact: true }).count()).toBe(1)
      }
      expect(layout[0]!.input.id).not.toBe(layout[1]!.input.id)
      if (scenario.containerWidth === 600) {
        expect(layout.every((row) => row.horizontal)).toBe(true)
      } else {
        expect(layout.every((row) => !row.horizontal)).toBe(true)
        for (const row of layout) {
          expect(row.label.scrollWidth).toBeLessThanOrEqual(row.label.clientWidth)
          expect(row.rowScrollWidth).toBeLessThanOrEqual(row.rowWidth)
          if (row.hostId === 'owner') {
            expect(row.label.lineRects.length).toBeGreaterThan(1)
            expect(row.title.text).toBe(OWNER_LABEL)
            expect(row.title.lineRects.length).toBeGreaterThan(1)
            expect(row.title.scrollWidth).toBeLessThanOrEqual(row.title.clientWidth)
          }
          expect(row.label.lineRects.every((line) => line.right <= row.input.left + 0.5)).toBe(true)
          expect(row.label.lineRects.every((line) => line.left >= row.list.left - 0.5)).toBe(true)
          expect(row.title.lineRects.every((line) => line.left >= row.list.left - 0.5 && line.right <= row.list.right + 0.5)).toBe(true)
        }
        const pageWidth = await page.evaluate(() => ({
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          settings: document.querySelector<HTMLElement>('[data-vault-settings]')!.scrollWidth,
          settingsClient: document.querySelector<HTMLElement>('[data-vault-settings]')!.clientWidth
        }))
        expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport)
        expect(pageWidth.body).toBeLessThanOrEqual(pageWidth.viewport)
        expect(pageWidth.settings).toBeLessThanOrEqual(pageWidth.settingsClient)
      }
      expect(await page.locator('.qvh-settings-heading').count()).toBe(scenario.mount === 'standalone' ? 1 : 0)
    })
  })
}

for (const target of [
  { host: 'local', name: LOCAL_LABEL },
  { host: 'owner', name: REMOTE_SWITCH_LABEL }
] as const) {
  test(`activating the ${target.host} host label enables only that native switch`, async () => {
    await withSettingsPage({
      theme: 'dark', viewportWidth: 1000, containerWidth: 600,
      fixture: { mount: 'embedded', hosts: defaultHosts(), write: 'success' }
    }, async (page) => {
      await waitForDefaultRows(page)
      const targetSwitch = page.getByRole('switch', { name: target.name, exact: true })
      const otherSwitch = page.getByRole('switch', { name: target.host === 'local' ? REMOTE_SWITCH_LABEL : LOCAL_LABEL, exact: true })
      const { id, label } = await switchLabel(page, target.name)
      await label.click()
      await page.waitForFunction((id) => (document.getElementById(id) as HTMLInputElement | null)?.checked === true, id)
      expect(await targetSwitch.isChecked()).toBe(true)
      expect(await otherSwitch.isChecked()).toBe(false)
      expect(await writeCalls(page)).toEqual([{
        method: 'quirky.vault/setSearchEnabled',
        params: { enabled: true, host: target.host }
      }])
    })
  })
}

test('a pending write disables both switches and blocks further label and Space activation', async () => {
  await withSettingsPage({
    theme: 'dark', viewportWidth: 1000, containerWidth: 600,
    fixture: { mount: 'embedded', hosts: defaultHosts(), write: 'pending' }
  }, async (page) => {
    await waitForDefaultRows(page)
    const localSwitch = page.getByRole('switch', { name: LOCAL_LABEL, exact: true })
    const remoteSwitch = page.getByRole('switch', { name: REMOTE_SWITCH_LABEL, exact: true })
    const { label: localLabel } = await switchLabel(page, LOCAL_LABEL)
    const { label: remoteLabel } = await switchLabel(page, REMOTE_SWITCH_LABEL)
    await localLabel.click()
    await page.waitForFunction(() => {
      const local = document.querySelector<HTMLInputElement>('[data-vault-search-enabled]')
      const remote = document.querySelector<HTMLInputElement>('[data-vault-host-switch]')
      return window.__vaultSettingsFixture.calls.filter((call) => call.method === 'quirky.vault/setSearchEnabled').length === 1 && Boolean(local?.disabled && remote?.disabled)
    })
    expect(await localSwitch.isDisabled()).toBe(true)
    expect(await remoteSwitch.isDisabled()).toBe(true)
    for (const label of [localLabel, remoteLabel]) {
      const bounds = await label.boundingBox()
      if (!bounds) throw new Error('The disabled switch label is not visible.')
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.keyboard.press('Space')
    }
    expect(await writeCalls(page)).toEqual([{
      method: 'quirky.vault/setSearchEnabled',
      params: { enabled: true, host: 'local' }
    }])
    await page.evaluate(() => window.__vaultSettingsFixture.resolveWrite('local'))
    await page.waitForFunction(() => {
      const local = document.querySelector<HTMLInputElement>('[data-vault-search-enabled]')
      const remote = document.querySelector<HTMLInputElement>('[data-vault-host-switch]')
      return local?.checked === true && local.disabled === false && remote?.disabled === false
    })
    expect(await writeCalls(page)).toHaveLength(1)
  })
})

for (const target of [
  { host: 'local', name: LOCAL_LABEL },
  { host: 'owner', name: REMOTE_SWITCH_LABEL }
] as const) {
  test(`a rejected ${target.host} enable preserves its confirmed disabled switch and InlineError`, async () => {
    await withSettingsPage({
      theme: 'dark', viewportWidth: 1000, containerWidth: 600,
      fixture: { mount: 'embedded', hosts: defaultHosts(), write: 'reject', writeError: 'policy refused the request' }
    }, async (page) => {
      await waitForDefaultRows(page)
      const input = page.getByRole('switch', { name: target.name, exact: true })
      const { label } = await switchLabel(page, target.name)
      await label.click()
      const errorMessage = target.host === 'local'
        ? 'Could not enable search. Try again. policy refused the request'
        : 'Could not read host search status. policy refused the request'
      const errorScope = target.host === 'local' ? page.locator('[data-vault-settings]') : page.locator('[data-vault-host-id="owner"]')
      await errorScope.locator('.ui-inline-error[role="alert"]').waitFor()
      expect(await input.isChecked()).toBe(false)
      expect(await errorScope.locator('.ui-inline-error[role="alert"]').textContent()).toBe(errorMessage)
      expect(await input.isDisabled()).toBe(false)
      expect(await writeCalls(page)).toEqual([{
        method: 'quirky.vault/setSearchEnabled',
        params: { enabled: true, host: target.host }
      }])
    })
  })
}

test('an unavailable remote host shows its error and Retry instead of a switch', async () => {
  const unavailableHosts: HostSeed[] = [
    localSeed(),
    { hostId: 'owner', label: OWNER_LABEL, kind: 'unavailable', reason: 'This host does not provide history search.' }
  ]
  await withSettingsPage({
    theme: 'dark', viewportWidth: 1000, containerWidth: 600,
    fixture: { mount: 'embedded', hosts: unavailableHosts }
  }, async (page) => {
    await page.locator('[data-vault-host-id="owner"]').locator('[data-vault-retry-host]').waitFor()
    const row = page.locator('[data-vault-host-id="owner"]')
    expect(await row.locator('.ui-inline-error[role="alert"]').textContent()).toBe('This host does not provide history search.')
    expect(await row.getByRole('button', { name: 'Retry', exact: true }).count()).toBe(1)
    expect(await row.locator('[data-vault-host-switch]').count()).toBe(0)
    expect(await page.getByRole('switch', { name: REMOTE_SWITCH_LABEL, exact: true }).count()).toBe(0)
    expect(await row.locator('.ui-list-row .ui-badge').textContent()).toBe('Unavailable')
  })
})

test('a loading local status keeps its switch disabled until the in-memory response resolves', async () => {
  await withSettingsPage({
    theme: 'dark', viewportWidth: 1000, containerWidth: 600,
    fixture: { mount: 'embedded', hosts: defaultHosts(), localRead: 'pending' }
  }, async (page) => {
    const localSwitch = page.getByRole('switch', { name: LOCAL_LABEL, exact: true })
    await localSwitch.waitFor()
    expect(await localSwitch.isDisabled()).toBe(true)
    expect(await page.locator('[data-vault-search-loading] p.ui-notice-line').textContent()).toBe('Checking search status…')
    expect(await page.locator('[data-vault-host-id="local"] .ui-list-row .ui-badge').textContent()).toBe('Checking')
    await page.evaluate(() => window.__vaultSettingsFixture.resolveRead('local'))
    await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-vault-host-id="owner"]')?.dataset.vaultHostStatus === 'idle')
    expect(await localSwitch.isDisabled()).toBe(false)
  })
})

test('an unavailable local status retains its disabled switch and InlineError', async () => {
  await withSettingsPage({
    theme: 'dark', viewportWidth: 1000, containerWidth: 600,
    fixture: { mount: 'embedded', hosts: defaultHosts(), localRead: 'reject', localReadError: 'local worker unavailable' }
  }, async (page) => {
    const localSwitch = page.getByRole('switch', { name: LOCAL_LABEL, exact: true })
    await page.locator('[data-vault-settings] .ui-inline-error[role="alert"]').waitFor()
    expect(await localSwitch.isDisabled()).toBe(true)
    expect(await localSwitch.isChecked()).toBe(false)
    expect(await page.locator('[data-vault-settings] .ui-inline-error[role="alert"]').textContent()).toBe('Could not read local search status. local worker unavailable')
    expect(await page.locator('[data-vault-host-id="local"] .ui-list-row .ui-badge').textContent()).toBe('Unavailable')
  })
})

test('the empty remote-host result keeps the local disclosure and keyboard focus indication', async () => {
  await withSettingsPage({
    theme: 'light', viewportWidth: 1000, containerWidth: 600,
    fixture: { mount: 'standalone', hosts: [localSeed()] }
  }, async (page) => {
    await page.getByRole('switch', { name: LOCAL_LABEL, exact: true }).waitFor()
    expect(await page.locator('[data-vault-host-row]').count()).toBe(1)
    expect(await page.locator('[data-vault-host-id="local"] [data-vault-status-summary]').textContent()).toBe('Transcript search is off. Only titles are filtered until enabled.')
    expect(await page.locator('.qvh-settings-card').filter({ hasText: DISCLOSURE }).count()).toBe(1)
    expect(await page.getByText(DISCLOSURE, { exact: true }).count()).toBe(1)
    expect(await page.locator('[data-vault-enable-all]').count()).toBe(0)
    expect(await page.locator('.ui-empty-state').count()).toBe(0)

    await page.keyboard.press('Tab')
    const focus = await page.getByRole('switch', { name: LOCAL_LABEL, exact: true }).evaluate((input) => ({
      active: document.activeElement === input,
      focusVisible: input.matches(':focus-visible'),
      outlineWidth: getComputedStyle(input).outlineWidth,
      outlineStyle: getComputedStyle(input).outlineStyle,
      outlineOffset: getComputedStyle(input).outlineOffset,
      outlineColor: getComputedStyle(input).outlineColor
    }))
    expect(focus.active).toBe(true)
    expect(focus.focusVisible).toBe(true)
    expect(focus.outlineWidth).toBe('2px')
    expect(focus.outlineStyle).toBe('solid')
    expect(focus.outlineOffset).toBe('2px')
    expect(focus.outlineColor).toBe('rgb(91, 108, 255)')
  })
})
