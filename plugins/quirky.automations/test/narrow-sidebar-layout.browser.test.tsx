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
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'automations-narrow-sidebar-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui)$/ },
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
const VIEWPORT_WIDTH = 646
const HEIGHT = 768
const PANEL_WIDTHS = [116, 200, 320]

let browser: Browser | null = null
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
    writeFileSync(entrypoint, browserEntry())
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
