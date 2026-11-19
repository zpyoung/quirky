import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const UI_MODULES = join(ROOT, 'packages/ui/node_modules')
const MOBILE_SETTINGS = join(ROOT, 'plugins/quirky.mobile/src/window/MobileSettings.tsx')
const MOBILE_PAGE = join(ROOT, 'plugins/quirky.mobile/src/window/MobilePage.tsx')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
}
const SIDEBAR_LABEL = 'Show Mobile in the sidebar'
const SIDEBAR_ID = 'mobile-sidebar-visibility'

type MobileCall = { method: string; params: Record<string, unknown> }

declare global {
  interface Window {
    __mobileFixture: {
      calls: MobileCall[]
      unexpected: string[]
      rejectConfigure: boolean
      mountSettings(options?: { rejectConfigure?: boolean }): void
      mountPage(): void
      unmount(): void
    }
  }
}

let browser: Browser | undefined
let bundle = ''
let styles = ''
const pageErrors = new WeakMap<Page, string[]>()
const unexpectedRequests = new WeakMap<Page, string[]>()

function browserEntry(): string {
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { MobileSettings } from ${JSON.stringify(MOBILE_SETTINGS)}
    import { MobilePage } from ${JSON.stringify(MOBILE_PAGE)}

    const mount = document.getElementById('root')
    if (!mount) throw new Error('Missing Mobile browser fixture mount.')
    const root = createRoot(mount)
    const initialState = () => ({
      machineName: 'Test desktop',
      showMobileButton: true,
      onboardingSeen: true,
      autoRestoreFitMs: null,
      customAddresses: [],
      interfaces: [{ name: 'en0', address: '192.168.1.20', family: 'IPv4', kind: 'lan' }],
      devices: [],
      listener: { available: true, host: '192.168.1.20', port: 6768 },
      relay: 'unavailable'
    })
    let state = initialState()
    const fixture = {
      calls: [],
      unexpected: [],
      rejectConfigure: false,
      mountSettings(options = {}) {
        fixture.calls = []
        fixture.unexpected = []
        fixture.rejectConfigure = options.rejectConfigure === true
        state = initialState()
        root.render(h(MobileSettings, { context }))
      },
      mountPage() {
        fixture.calls = []
        fixture.unexpected = []
        fixture.rejectConfigure = false
        state = initialState()
        root.render(h(MobilePage, { context, input: { stage: 'intro' } }))
      },
      unmount() { root.unmount() }
    }
    function unexpected(name) {
      fixture.unexpected.push(name)
      throw new Error('Unexpected Mobile fixture call: ' + name)
    }
    const context = {
      pluginId: 'quirky.mobile',
      async call(method, params = {}) {
        fixture.calls.push({ method, params: structuredClone(params) })
        if (method === 'quirky.mobile/state') return structuredClone(state)
        if (method === 'quirky.mobile/devices') return structuredClone(state.devices)
        if (method === 'quirky.mobile/interfaces') return structuredClone(state.interfaces)
        if (method === 'quirky.mobile/configure') {
          if (fixture.rejectConfigure) throw new Error('Configure refused')
          state = { ...state, ...params }
          return structuredClone(state)
        }
        return unexpected(method)
      },
      subscribe() { return () => {} },
      openView() { return unexpected('context.openView') },
      provide() { return unexpected('context.provide') },
      executeCommand() { return unexpected('context.executeCommand') },
      onLayout() { return unexpected('context.onLayout') },
      getLayout() { return unexpected('context.getLayout') },
      getSetting() { return unexpected('context.getSetting') },
      toast() { return unexpected('context.toast') },
      nativeBrowser: new Proxy({}, {
        get(_target, property) { return unexpected('nativeBrowser.' + String(property)) }
      })
    }
    window.__mobileFixture = fixture
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

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'mobile-baseline-layout-fixture.ts')],
    target: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'mobile-baseline-layout-fixture',
      setup(build) {
        build.onResolve({ filter: /mobile-baseline-layout-fixture\.ts$/ }, () => ({
          path: 'entry',
          namespace: 'mobile-layout-fixture',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mobile-layout-fixture' }, () => ({
          contents: browserEntry(),
          loader: 'ts',
          resolveDir: ROOT,
        }))
        build.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
          path: BROWSER_IMPORTS[path] ?? path,
        }))
        build.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => ({
          path: Bun.resolveSync(path, importer ? dirname(importer) : ROOT),
        }))
      },
    }],
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Mobile browser fixture bundle was empty.')
  bundle = await output.text()
  styles = await productionStyles()
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
}, 60_000)

afterAll(async () => { await browser?.close() }, 30_000)

async function pageFor(theme: 'dark' | 'light', width: number, height = 900, productionHost = false): Promise<Page> {
  if (!browser) throw new Error('The Mobile browser fixture did not launch.')
  const page = await browser.newPage({ viewport: { width, height } })
  pageErrors.set(page, [])
  unexpectedRequests.set(page, [])
  page.on('pageerror', (error) => pageErrors.get(page)!.push(error.stack ?? error.message))
  await page.route('**/*', async (route) => {
    unexpectedRequests.get(page)!.push(route.request().url())
    await route.abort()
  })
  const host = productionHost
    ? '<div class="main-body" style="width:320px;height:180px"><div class="plugin-slot"><div id="root" class="plugin-slot-body"></div></div></div>'
    : '<div id="root"></div>'
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${styles}</style></head><body style="margin:0">${host}</body></html>`)
  await page.addScriptTag({ content: bundle })
  return page
}

async function closePage(page: Page): Promise<void> {
  try {
    await page.evaluate(() => window.__mobileFixture?.unmount())
    expect(await page.evaluate(() => window.__mobileFixture?.unexpected ?? [])).toEqual([])
    expect(unexpectedRequests.get(page)).toEqual([])
    expect(pageErrors.get(page)).toEqual([])
  } finally {
    await page.close()
  }
}

async function mountSettings(page: Page, rejectConfigure = false): Promise<void> {
  await page.evaluate((reject) => window.__mobileFixture.mountSettings({ rejectConfigure: reject }), rejectConfigure)
  await page.getByRole('checkbox', { name: SIDEBAR_LABEL, exact: true }).waitFor()
}

async function mountPage(page: Page): Promise<void> {
  await page.evaluate(() => window.__mobileFixture.mountPage())
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor()
}

async function configureCalls(page: Page): Promise<Record<string, unknown>[]> {
  return await page.evaluate(() => window.__mobileFixture.calls
    .filter((call) => call.method === 'quirky.mobile/configure')
    .map((call) => call.params))
}

async function assertSidebarCheckbox(page: Page): Promise<void> {
  const input = page.getByRole('checkbox', { name: SIDEBAR_LABEL, exact: true })
  const visibleLabel = page.locator(`.ui-form-row__label[for="${SIDEBAR_ID}"]`)
  await visibleLabel.waitFor()

  const geometry = await page.evaluate((id) => {
    const input = document.getElementById(id) as HTMLInputElement | null
    const row = input?.closest<HTMLElement>('.ui-form-row')
    const label = row?.querySelector<HTMLElement>('.ui-form-row__label')
    if (!input || !row || !label) throw new Error('The Mobile sidebar checkbox row was incomplete.')
    const text = document.createRange()
    text.selectNodeContents(label)
    const firstLine = text.getClientRects()[0]
    if (!firstLine) throw new Error('The Mobile sidebar label had no rendered first line.')
    const inputBox = input.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    const firstLineCenter = firstLine.top + firstLine.height / 2
    return {
      width: inputBox.width,
      height: inputBox.height,
      gap: labelBox.left - inputBox.right,
      centerDifference: Math.abs(inputBox.top + inputBox.height / 2 - firstLineCenter),
      overflow: row.scrollWidth > row.clientWidth || inputBox.left < row.getBoundingClientRect().left || inputBox.right > row.getBoundingClientRect().right,
    }
  }, SIDEBAR_ID)
  expect(geometry.centerDifference).toBeLessThanOrEqual(1)
  expect(geometry.width).toBe(14)
  expect(geometry.height).toBe(14)
  expect(geometry.gap).toBe(8)
  expect(geometry.overflow).toBe(false)
  expect(await input.getAttribute('id')).toBe(SIDEBAR_ID)
  expect(await input.getAttribute('aria-label')).toBe(SIDEBAR_LABEL)
  expect(await visibleLabel.innerText()).toBe(SIDEBAR_LABEL)
  expect(await visibleLabel.isVisible()).toBe(true)
  expect(await input.isChecked()).toBe(true)
  expect(await input.evaluate((element) => element.classList.contains('ui-checkbox__input'))).toBe(true)
  expect(await input.evaluate((element) => element.closest('.ui-form-row')?.classList.contains('ui-form-row--inline'))).toBe(true)
}

async function frameMetrics(page: Page, title: string) {
  return await page.evaluate((title) => {
    const frame = [...document.querySelectorAll<HTMLElement>('.ui-tool-panel-frame')]
      .find((candidate) => candidate.querySelector('.ui-tool-panel-frame__title')?.textContent === title)
    const header = frame?.querySelector<HTMLElement>('.ui-tool-panel-frame__header')
    const body = frame?.querySelector<HTMLElement>('.ui-tool-panel-frame__body')
    if (!frame || !header || !body) throw new Error(`Missing ToolPanelFrame: ${title}`)
    const button = [...frame.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Get started')
    const headerStyle = getComputedStyle(header)
    const bodyStyle = getComputedStyle(body)
    const frameStyle = getComputedStyle(frame)
    return {
      headerPadding: [headerStyle.paddingTop, headerStyle.paddingRight, headerStyle.paddingBottom, headerStyle.paddingLeft],
      bodyPadding: [bodyStyle.paddingTop, bodyStyle.paddingRight, bodyStyle.paddingBottom, bodyStyle.paddingLeft],
      borderBottom: parseFloat(frameStyle.borderBottomWidth),
      buttonBottomGap: button ? frame.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom : null,
    }
  }, title)
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1000, 700, 320] as const) {
    test(`Mobile settings and intro frame preserve layout in ${theme} at ${width}px`, async () => {
      const page = await pageFor(theme, width)
      try {
        await mountSettings(page)
        await assertSidebarCheckbox(page)

        const identity = await frameMetrics(page, 'Desktop identity')
        expect(identity.headerPadding).toEqual(['4px', '8px', '4px', '8px'])
        expect(identity.bodyPadding).toEqual(['8px', '8px', '8px', '8px'])

        await mountPage(page)
        const intro = await frameMetrics(page, 'Your workspaces, in your pocket.')
        expect(intro.headerPadding).toEqual(['4px', '8px', '4px', '8px'])
        expect(intro.bodyPadding).toEqual(['8px', '8px', '8px', '8px'])
        expect(intro.buttonBottomGap).not.toBeNull()
        expect(intro.buttonBottomGap!).toBeGreaterThanOrEqual(8 + intro.borderBottom - 0.5)
      } finally {
        await closePage(page)
      }
    })
  }
}

test('the visible Mobile sidebar label and Space save returned state once; a rejected save preserves it', async () => {
  const page = await pageFor('dark', 320)
  try {
    await mountSettings(page)
    await assertSidebarCheckbox(page)
    const input = page.getByRole('checkbox', { name: SIDEBAR_LABEL, exact: true })
    const visibleLabel = page.locator(`.ui-form-row__label[for="${SIDEBAR_ID}"]`)

    await visibleLabel.click()
    await page.waitForFunction(() => {
      const input = document.getElementById('mobile-sidebar-visibility') as HTMLInputElement | null
      return input?.checked === false && window.__mobileFixture.calls.filter((call) => call.method === 'quirky.mobile/configure').length === 1
    })
    expect(await input.isChecked()).toBe(false)
    expect(await configureCalls(page)).toEqual([{ showMobileButton: false }])

    await input.focus()
    expect(await input.evaluate((element) => document.activeElement === element)).toBe(true)
    await input.press('Space')
    await page.waitForFunction(() => {
      const input = document.getElementById('mobile-sidebar-visibility') as HTMLInputElement | null
      return input?.checked === true && window.__mobileFixture.calls.filter((call) => call.method === 'quirky.mobile/configure').length === 2
    })
    expect(await input.isChecked()).toBe(true)
    expect(await configureCalls(page)).toEqual([{ showMobileButton: false }, { showMobileButton: true }])

    await page.evaluate(() => { window.__mobileFixture.rejectConfigure = true })
    await visibleLabel.click()
    await page.getByRole('alert').waitFor()
    expect(await input.isChecked()).toBe(true)
    expect(await page.getByRole('alert').innerText()).toBe('Configure refused')
    expect(await configureCalls(page)).toEqual([
      { showMobileButton: false },
      { showMobileButton: true },
      { showMobileButton: false },
    ])
  } finally {
    await closePage(page)
  }
})

for (const theme of ['dark', 'light'] as const) {
  test(`Mobile intro scrolls and activates inside the production 320×180 host in ${theme}`, async () => {
    const page = await pageFor(theme, 320, 180, true)
    try {
      await mountPage(page)
      const intro = await frameMetrics(page, 'Your workspaces, in your pocket.')
      expect(intro.headerPadding).toEqual(['4px', '8px', '4px', '8px'])
      expect(intro.bodyPadding).toEqual(['8px', '8px', '8px', '8px'])
      expect(intro.buttonBottomGap).not.toBeNull()
      expect(intro.buttonBottomGap!).toBeGreaterThanOrEqual(8 + intro.borderBottom - 0.5)

      const slot = page.locator('.main-body > .plugin-slot')
      const hostMetrics = await slot.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }))
      expect(hostMetrics.clientHeight).toBe(180)
      expect(hostMetrics.scrollHeight).toBeGreaterThan(hostMetrics.clientHeight)
      expect(hostMetrics.overflowY).toBe('auto')

      const button = page.getByRole('button', { name: 'Get started', exact: true })
      await button.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
      await page.waitForFunction(() => {
        const slot = document.querySelector('.main-body > .plugin-slot') as HTMLElement | null
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => candidate.textContent?.trim() === 'Get started')
        if (!slot || !button || slot.scrollTop <= 0) return false
        const slotBox = slot.getBoundingClientRect()
        const buttonBox = button.getBoundingClientRect()
        return buttonBox.top >= slotBox.top && buttonBox.bottom <= slotBox.bottom
      })
      const hit = await page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((candidate) => candidate.textContent?.trim() === 'Get started')!
        const box = button.getBoundingClientRect()
        const x = box.left + box.width / 2
        const y = box.top + box.height / 2
        const target = document.elementFromPoint(x, y)
        return { x, y, hitsButton: target === button || button.contains(target) }
      })
      expect(hit.hitsButton).toBe(true)
      await page.mouse.click(hit.x, hit.y)
      await page.getByText('Step 1 of 2', { exact: true }).waitFor()
      expect(await configureCalls(page)).toEqual([{ onboardingSeen: true }])
    } finally {
      await closePage(page)
    }
  })
}
