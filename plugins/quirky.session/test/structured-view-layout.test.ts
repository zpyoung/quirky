import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

declare global {
  interface Window {
    sentCalls: unknown[]
    toggleCalls: unknown[]
  }
}

const ROOT = resolve(import.meta.dir, '../../..')
const SESSION_MODULES = join(ROOT, 'plugins/quirky.session/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(SESSION_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(SESSION_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(SESSION_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(SESSION_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(SESSION_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'structured-view-layout-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: new RegExp('^(?:react|react/jsx-runtime|react/jsx-dev-runtime|react-dom|react-dom/client|@quirky/ui|@quirky/protocol)$') },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const VIEWPORT = { width: 1568, height: 1339 }
const RIGHT_GROUP = 327
const CENTER_RIGHT = VIEWPORT.width - RIGHT_GROUP
const CENTER_WIDTH = 541
const BOTTOM_PANEL = 26
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/terminal-workspace.css',
  'packages/ui/src/shell/tool-shell.css'
]

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

const executable = chromiumExecutable()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const structuredView = join(ROOT, 'plugins/quirky.session/src/window/StructuredView.tsx')
  const geometry = join(ROOT, 'plugins/quirky.terminal/src/window/floating/geometry.ts')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { IconButton } from '@quirky/ui'
    import { StructuredView } from ${JSON.stringify(structuredView)}
    import { defaultButton } from ${JSON.stringify(geometry)}

    window.sentCalls = []
    window.toggleCalls = []

    const context = {
      call(method: string, params?: Record<string, unknown>) {
        if (method === 'quirky.structured/messages') return Promise.resolve([])
        if (method === 'quirky.structured/send') {
          window.sentCalls.push(params)
          return Promise.resolve(null)
        }
        return Promise.resolve(null)
      },
      subscribe() { return () => {} },
      onConnection() { return () => {} },
      toast() {}
    }
    const session = { id: 'structured-1', kind: 'structured', agent: 'claude', title: 'Claude', status: 'running' }

    createRoot(document.getElementById('structured-view')!).render(
      createElement(StructuredView, { context, session })
    )

    const anchor = document.querySelector<HTMLElement>('[data-overlay-button-anchor]')!
    const button = defaultButton(
      { width: window.innerWidth, height: window.innerHeight },
      anchor.getBoundingClientRect()
    )
    createRoot(document.getElementById('floating-overlay')!).render(
      createElement(IconButton, {
        className: 'qf-button',
        'data-floating-button': '',
        label: 'Show floating workspace',
        'aria-pressed': false,
        title: 'Show floating workspace',
        style: { left: button.x, top: button.y },
        onClick: () => window.toggleCalls.push(true)
      })
    )
  `
}

function pageMarkup(): string {
  const leftGroup = CENTER_RIGHT - CENTER_WIDTH
  const leftPanel = leftGroup - 42 - 5
  const rightPanel = RIGHT_GROUP - 42 - 5
  return `<!doctype html>
    <html data-theme="dark">
      <head><meta charset="utf-8"><style>html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }</style></head>
      <body>
        <div class="shell-workspace" style="position: fixed; inset: 0; --tool-left-rail: 42; --tool-left-panel-width: ${leftPanel}; --tool-left-edge: 5; --tool-right-rail: 42; --tool-right-panel-width: ${rightPanel}; --tool-right-edge: 5; --tool-bottom-panel-height: ${BOTTOM_PANEL}; --tool-bottom-edge: 0">
          <section class="shell-main-region">
            <main class="main" style="display: flex; flex-direction: column; min-width: 0; min-height: 0">
              <div id="structured-view" style="display: flex; flex: 1; flex-direction: column; min-height: 0"></div>
            </main>
          </section>
          <div class="tool-shell"><div class="tool-shell__overlay-button-anchor" data-overlay-button-anchor aria-hidden="true"></div></div>
        </div>
        <div id="floating-overlay"></div>
      </body>
    </html>`
}

async function openComposer() {
  const context = await browser!.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.setContent(pageMarkup())
  for (const stylesheet of STYLESHEETS) {
    await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
  }
  await page.addScriptTag({ content: browserBundle })
  await page.locator('textarea[placeholder^="Message"]').waitFor()
  await page.getByRole('button', { name: 'Show floating workspace' }).waitFor()
  return { context, page }
}

async function assertComposerClearance() {
  const { context, page } = await openComposer()
  try {
    await page.getByRole('textbox', { name: 'Message' }).fill('layout regression')
    const send = page.getByRole('button', { name: 'Send', exact: true })
    const toggle = page.getByRole('button', { name: 'Show floating workspace' })
    const sendBox = await send.boundingBox()
    const toggleBox = await toggle.boundingBox()
    if (!sendBox || !toggleBox) throw new Error('The composer Send button or floating workspace toggle is not visible')

    const mainBox = await page.locator('.shell-main-region').boundingBox()
    expect(mainBox?.width).toBe(CENTER_WIDTH)

    const overlaps = sendBox.x < toggleBox.x + toggleBox.width &&
      sendBox.x + sendBox.width > toggleBox.x &&
      sendBox.y < toggleBox.y + toggleBox.height &&
      sendBox.y + sendBox.height > toggleBox.y
    expect(overlaps).toBe(false)

    const sendCenter = { x: sendBox.x + sendBox.width / 2, y: sendBox.y + sendBox.height / 2 }
    const hitTarget = await page.evaluate(({ x, y }) => {
      return document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? null
    }, sendCenter)
    expect(hitTarget).toBe('Send')

    await page.mouse.click(sendCenter.x, sendCenter.y)
    await page.waitForFunction(() => window.sentCalls.length === 1, undefined, { timeout: 2_000 })
    expect(await page.evaluate(() => window.sentCalls)).toEqual([
      { session: 'structured-1', text: 'layout regression' }
    ])
    expect(await page.evaluate(() => window.toggleCalls)).toEqual([])
  } finally {
    await context.close()
  }
}

beforeAll(async () => {
  if (!executable) return
  const tempDir = mkdtempSync(join(ROOT, 'plugins/quirky.session/.structured-view-layout-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '\"production\"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\n'))
    browserBundle = await result.outputs[0]!.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

describe('the structured composer beside the floating workspace toggle', () => {
  test.skipIf(!executable)('keeps Send clear and clickable in a narrow center workspace at the default window size', async () => {
    await assertComposerClearance()
  }, 60_000)

})

describe('the structured transcript header', () => {
  test.skipIf(!executable)('keeps the event filter inline, inset, and clear of the transcript', async () => {
    const { context, page } = await openComposer()
    try {
      const checkbox = page.getByRole('checkbox', { name: 'Show all events' })
      const label = page.getByText('Show all events', { exact: true })
      const title = page.getByRole('heading', { name: 'Transcript', exact: true })
      const checkboxBox = await checkbox.boundingBox()
      const labelBox = await label.boundingBox()
      const titleBox = await title.boundingBox()
      const headerBox = await page.locator('#structured-view header').boundingBox()
      const logBox = await page.getByRole('log').boundingBox()
      if (!checkboxBox || !labelBox || !titleBox || !headerBox || !logBox) {
        throw new Error('The transcript header, filter, or log is not visible')
      }

      const checkboxCenter = checkboxBox.y + checkboxBox.height / 2
      expect(Math.abs(checkboxCenter - (labelBox.y + labelBox.height / 2))).toBeLessThanOrEqual(1)
      expect(Math.abs(checkboxCenter - (titleBox.y + titleBox.height / 2))).toBeLessThanOrEqual(1)
      const inset = await page.getByRole('log').evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineEnd))
      expect(Math.min(checkboxBox.x, labelBox.x) - headerBox.x).toBeGreaterThanOrEqual(inset)
      expect(headerBox.x + headerBox.width - Math.max(checkboxBox.x + checkboxBox.width, labelBox.x + labelBox.width)).toBeGreaterThanOrEqual(inset)
      expect(titleBox.x - headerBox.x).toBeGreaterThanOrEqual(inset)
      expect(checkboxBox.y + checkboxBox.height).toBeLessThanOrEqual(logBox.y)
      expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(logBox.y)

      await label.click()
      expect(await checkbox.isChecked()).toBe(true)
      await checkbox.focus()
      await checkbox.press('Space')
      expect(await checkbox.isChecked()).toBe(false)
    } finally {
      await context.close()
    }
  }, 60_000)
})
