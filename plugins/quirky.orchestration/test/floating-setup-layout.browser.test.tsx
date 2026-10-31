import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.orchestration/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'orchestration-overlay-browser-dependencies',
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
  'packages/ui/src/design-system/components.css'
]

let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const uiModule = join(ROOT, 'plugins/quirky.orchestration/src/ui.tsx')
  return `
    import { activate } from ${JSON.stringify(uiModule)}

    const provided = new Map()
    const context = {
      pluginId: 'quirky.orchestration',
      provide(id, implementation) { provided.set(id, implementation) },
      call(method) {
        if (method === 'quirky.terminal/floating') return Promise.resolve({ enabled: true, open: true })
        if (method === 'quirky.orchestration/skillStatus') {
          return Promise.resolve({ state: 'missing', agents: [], installCommand: 'quirky orchestration skill-install', text: 'Install the orchestration skill.' })
        }
        throw new Error('Unexpected UI call: ' + method)
      },
      subscribe() { return () => {} },
      executeCommand() { return Promise.resolve() },
      openView() { return Promise.resolve() },
      toast() {},
      log() {}
    }

    activate(context)
    const mount = provided.get('overlay:quirky.orchestration/floating-setup')
    if (typeof mount !== 'function') throw new Error('The orchestration setup overlay was not provided.')
    mount(document.getElementById('overlay-root'), {})
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body { font: var(--compat-px-13)/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
        </style>
      </head>
      <body>
        <span data-floating-button aria-hidden="true" style="position:fixed;left:65vw;top:650px;width:36px;height:36px"></span>
        <div id="overlay-root"></div>
      </body>
    </html>`
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-orchestration-overlay-'))
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
    if (!output) throw new Error('The orchestration overlay browser bundle was empty.')
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

test.skipIf(!existsSync(chromium.executablePath()))('keeps floating setup actions inside the card at desktop and narrow widths in both themes', async () => {
  const context = await browser!.newContext({ viewport: { width: 1054, height: 768 } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    const card = page.getByRole('complementary', { name: 'Enable orchestration' })
    await card.waitFor()
    await page.getByRole('button', { name: 'Dismiss', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Enable', exact: true }).waitFor()

    for (const theme of ['dark', 'light']) {
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme)
      for (const width of [1054, 360]) {
        await page.setViewportSize({ width, height: 768 })
        await page.waitForFunction(() => {
          const card = document.querySelector<HTMLElement>('[aria-label="Enable orchestration"]')
          if (!card) return false
          const rect = card.getBoundingClientRect()
          return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 0.5
        })

        const buttons = await card.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect()
            return {
              label: button.textContent,
              clearance: [
                rect.left - bounds.left,
                bounds.right - rect.right,
                rect.top - bounds.top,
                bounds.bottom - rect.bottom
              ]
            }
          })
        })
        expect(buttons.map((button) => button.label)).toEqual(['Dismiss', 'Enable'])
        for (const button of buttons) {
          for (const clearance of button.clearance) expect(clearance).toBeGreaterThanOrEqual(0)
        }
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)
