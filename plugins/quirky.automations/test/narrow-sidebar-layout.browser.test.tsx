import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.automations/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'automations-narrow-sidebar-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/icons/icons.css',
  'packages/ui/src/design-system/automations.css'
]
const HOST_STYLESHEET = 'packages/ui/src/shell/tool-shell.css'
const HEADER_VIEWPORT = { width: 1054, height: 900 }
const HEADER_LAYOUTS = [
  { panelClass: 'tool-shell__panel--left-bottom', top: 666.75, height: 207.25 },
  { panelClass: 'tool-shell__panel--left-top', top: 40, height: 834 }
] as const
const VIEWPORT_WIDTH = 646
const HEIGHT = 768
const PANEL_WIDTHS = [116, 200, 320]

let browser: Browser | null = null
let headerBrowserBundle = ''
let browserBundle = ''

function browserEntry(): string {
  const uiModule = join(ROOT, 'packages/ui/src/design-system/index.ts')
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { TextField } from ${JSON.stringify(uiModule)}

    function AutomationsFixture() {
      return h('main', { className: 'auto-automations', 'aria-label': 'Automations' },
        h('div', { className: 'auto-toolbar' },
          h(TextField, {
            label: 'Search automations',
            className: 'auto-search',
            type: 'search',
            placeholder: 'Search…',
            'aria-label': 'Search automations',
            defaultValue: ''
          }),
          h('details', { className: 'auto-filter-menu' },
            h('summary', null, 'Filters'),
            h('div', { className: 'auto-filter-panel' }, h('strong', null, 'Host'))
          )
        )
      )
    }

    createRoot(document.getElementById('automations-panel')).render(h(AutomationsFixture))
  `
}

function headerBrowserEntry(): string {
  const uiModule = join(ROOT, 'packages/ui/src/design-system/index.ts')
  const pluginUiModule = join(ROOT, 'plugins/quirky.automations/src/ui.tsx')
  const stateModule = join(ROOT, 'plugins/quirky.automations/src/state.ts')
  return `
    import { createElement as h, useLayoutEffect, useRef } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ToolPanelFrame } from ${JSON.stringify(uiModule)}
    import { activate } from ${JSON.stringify(pluginUiModule)}
    import { initialUiState } from ${JSON.stringify(stateModule)}

    const provided = new Map()
    const context = {
      provide(id, implementation) { provided.set(id, implementation) },
      async call(method) {
        if (method === 'quirky.automations/uiState') return initialUiState()
        if (method === 'quirky.automations/list') return []
        if (method === 'quirky.automations/editorData') {
          return {
            hosts: [{ id: 'local', label: 'Local', available: true }],
            projects: [],
            workspaces: [],
            agents: [],
            errors: []
          }
        }
        if (method === 'quirky.automations/externalList') return { managers: [] }
        throw new Error('Unexpected Automations UI call: ' + method)
      },
      subscribe() { return () => {} },
      getSetting() { return true },
      openView() {},
      toast() {}
    }

    activate(context)

    function AutomationPanelHost() {
      const mountPoint = useRef(null)
      useLayoutEffect(() => {
        const mount = provided.get('view:quirky.automations/automations')
        if (typeof mount !== 'function') throw new Error('Automations view was not registered.')
        return mount(mountPoint.current, {})
      }, [])
      return h(ToolPanelFrame, { title: 'Automations', onMinimize() {} },
        h('section', {
          className: 'plugin-slot',
          'data-plugin-slot': 'view:quirky.automations/automations'
        }, h('div', { style: { display: 'contents' } },
          h('div', { className: 'plugin-slot-body', ref: mountPoint })
        ))
      )
    }

    createRoot(document.getElementById('header-panel')).render(h(AutomationPanelHost))
  `
}

function headerPageMarkup(panelClass: string): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body, #root { height: 100%; margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
          .shell-workspace {
            --tool-left-rail: 42;
            --tool-left-panel-width: 280;
            --tool-left-top-height: 834;
            --tool-left-bottom-top: 626.75;
            --tool-left-bottom-height: 207.25;
            height: calc(100% - 66px);
            top: 40px;
            margin: 0;
          }
        </style>
      </head>
      <body>
        <div id="root">
          <div class="shell-workspace">
            <div class="tool-shell">
              <div class="tool-shell__panels">
                <div id="header-panel" class="tool-shell__panel ${panelClass}" data-tool-panel></div>
              </div>
            </div>
          </div>
        </div>
      </body>
    </html>`
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body, #root { height: 100%; margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
          #layout { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); height: 100%; min-width: 0; }
          .panel { height: 100%; min-width: 0; }
          #center { min-width: 0; }
        </style>
      </head>
      <body>
        <div id="root">
          <div id="layout" style="--sidebar-width: 116px">
            <aside class="panel" id="automations-panel"></aside>
            <main id="center"></main>
          </div>
        </div>
      </body>
    </html>`
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-automations-narrow-sidebar-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    const headerEntrypoint = join(tempDir, 'header-browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    writeFileSync(headerEntrypoint, headerBrowserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The automations narrow-sidebar browser bundle was empty.')
    browserBundle = await output.text()
    const headerResult = await Bun.build({
      entrypoints: [headerEntrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!headerResult.success) throw new Error(headerResult.logs.map((log) => log.message).join('\n'))
    const headerOutput = headerResult.outputs[0]
    if (!headerOutput) throw new Error('The Automations header browser bundle was empty.')
    headerBrowserBundle = await headerOutput.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps automation search and filters reachable in narrow panels', async () => {
  const context = await browser!.newContext({ viewport: { width: VIEWPORT_WIDTH, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    await page.getByRole('main', { name: 'Automations' }).waitFor()

    const search = page.getByRole('searchbox', { name: 'Search automations' })
    const filterSummary = page.locator('.auto-filter-menu > summary')
    const metrics = async () => page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const panel = document.querySelector('#automations-panel')!
      const label = panel.querySelector('.ui-text-field__label')!
      const labelRange = document.createRange()
      labelRange.selectNodeContents(label)
      return {
        panel: box(panel),
        searchField: box(panel.querySelector('input[aria-label="Search automations"]')!),
        labelText: Array.from(labelRange.getClientRects(), (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
        filterSummary: box(panel.querySelector('.auto-filter-menu > summary')!)
      }
    })
    const expectContainedHorizontally = (
      inner: { left: number; right: number },
      outer: { left: number; right: number }
    ) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
    }

    for (const panelWidth of PANEL_WIDTHS) {
      await page.locator('#layout').evaluate((element, width) => {
        ;(element as HTMLElement).style.setProperty('--sidebar-width', `${width}px`)
      }, panelWidth)

      const layout = await metrics()
      expect(layout.panel.width).toBe(panelWidth)
      expect(layout.labelText.length).toBeGreaterThan(0)
      for (const textRect of layout.labelText) expectContainedHorizontally(textRect, layout.panel)
      expectContainedHorizontally(layout.searchField, layout.panel)
      expectContainedHorizontally(layout.filterSummary, layout.panel)

      await search.fill(`automation-${panelWidth}`)
      await filterSummary.click()
      await filterSummary.click()
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps the Automations header title and actions reachable in narrow tool panels', async () => {
  const context = await browser!.newContext({ viewport: HEADER_VIEWPORT })
  const page = await context.newPage()
  const actionNames = [
    'Automation settings',
    'Refresh automations',
    'Runs',
    'New Automation',
    'Minimize Automations'
  ]
  try {
    for (const layout of HEADER_LAYOUTS) {
      await page.setContent(headerPageMarkup(layout.panelClass))
      for (const stylesheet of [...STYLESHEETS, HOST_STYLESHEET]) {
        await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
      }
      await page.addScriptTag({ content: headerBrowserBundle })

      const panel = page.locator('#header-panel')
      const heading = page.getByRole('heading', { name: 'Automations', exact: true })
      await heading.waitFor({ state: 'attached' })
      await page.mouse.move(0, 0)
      const inactiveActionOpacity = await panel.locator('.ui-tool-panel-frame__actions').evaluate((element) => getComputedStyle(element).opacity)
      expect(inactiveActionOpacity).toBe('0')
      await page.locator('.auto-empty-automations').waitFor()

      const panelBounds = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      expect(panelBounds.width).toBe(280)
      expect(Math.abs(panelBounds.top - layout.top)).toBeLessThan(0.5)
      expect(Math.abs(panelBounds.height - layout.height)).toBeLessThan(0.5)

      const title = await heading.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const text = range.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        const header = element.closest('.ui-tool-panel-frame__header')!.getBoundingClientRect()
        const panel = element.closest('.tool-shell__panel')!.getBoundingClientRect()
        const hit = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2)
        return {
          text: element.textContent,
          width: bounds.width,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          textWidth: text.width,
          textInsideHeader: text.left >= header.left - 0.5 && text.right <= header.right + 0.5,
          textInsidePanel: text.left >= panel.left - 0.5 && text.right <= panel.right + 0.5,
          textNotOccluded: hit === element || element.contains(hit)
        }
      })
      expect(title.text).toBe('Automations')
      expect(title.width).toBeGreaterThan(0)
      expect(title.clientWidth).toBeGreaterThan(0)
      expect(title.textWidth).toBeGreaterThan(0)
      expect(title.textWidth).toBeLessThanOrEqual(title.clientWidth + 0.5)
      expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth)
      expect(title.textInsideHeader).toBe(true)
      expect(title.textInsidePanel).toBe(true)
      expect(title.textNotOccluded).toBe(true)

      await panel.hover()
      await page.waitForFunction(() => {
        const actions = document.querySelector('.ui-tool-panel-frame__actions')
        return actions !== null && getComputedStyle(actions).opacity === '1'
      })
      for (const name of ['Automation settings', 'Refresh automations', 'New Automation']) {
        expect(await page.getByRole('button', { name, exact: true }).getAttribute('title')).toBe(name)
      }
      for (const name of actionNames) {
        const button = page.getByRole('button', { name, exact: true })
        expect(await button.count()).toBe(1)
        const metrics = await button.evaluate((element) => {
          const button = element as HTMLButtonElement
          const rect = button.getBoundingClientRect()
          const panel = button.closest('.tool-shell__panel')!.getBoundingClientRect()
          const header = button.closest('.ui-tool-panel-frame__header')!.getBoundingClientRect()
          const actions = button.closest('.ui-tool-panel-frame__actions')!
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            width: rect.width,
            height: rect.height,
            insidePanel: rect.left >= panel.left - 0.5 && rect.right <= panel.right + 0.5
              && rect.top >= panel.top - 0.5 && rect.bottom <= panel.bottom + 0.5,
            insideHeader: rect.left >= header.left - 0.5 && rect.right <= header.right + 0.5
              && rect.top >= header.top - 0.5 && rect.bottom <= header.bottom + 0.5,
            inHeaderActions: actions.contains(button),
            painted: getComputedStyle(button).visibility === 'visible'
              && getComputedStyle(button).display !== 'none'
              && getComputedStyle(actions).opacity === '1',
            enabled: !button.disabled,
            hitTarget: hit !== null && button.contains(hit)
          }
        })
        expect(metrics.width).toBeGreaterThan(0)
        expect(metrics.height).toBeGreaterThan(0)
        expect(metrics.insidePanel).toBe(true)
        expect(metrics.insideHeader).toBe(true)
        expect(metrics.inHeaderActions).toBe(true)
        expect(metrics.painted).toBe(true)
        expect(metrics.enabled).toBe(true)
        expect(metrics.hitTarget).toBe(true)
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)
