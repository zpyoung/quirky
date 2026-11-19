import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

declare global {
  interface Window {
    sentCalls: unknown[]
    toggleCalls: unknown[]
    initialMessages?: unknown[]
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
  const chatView = join(ROOT, 'plugins/quirky.session/src/window/chat/ChatView.tsx')
  const windowModel = join(ROOT, 'plugins/quirky.session/src/window/model.ts')
  const geometry = join(ROOT, 'plugins/quirky.terminal/src/window/floating/geometry.ts')
  // under `bun test`, Bun.build cannot resolve ../model from window/chat unless window/ was read first
  return `
    import ${JSON.stringify(windowModel)}
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { IconButton } from '@quirky/ui'
    import { ChatView } from ${JSON.stringify(chatView)}
    import { defaultButton } from ${JSON.stringify(geometry)}

    window.sentCalls = []
    window.toggleCalls = []

    const context = {
      call(method: string, params?: Record<string, unknown>) {
        if (method === 'quirky.structured/messages') return Promise.resolve(window.initialMessages ?? [])
        if (method === 'quirky.structured/queue' || method === 'quirky.view/list') return Promise.resolve([])
        if (method === 'quirky.structured/send') {
          window.sentCalls.push(params)
          return Promise.resolve(null)
        }
        return Promise.resolve(null)
      },
      executeCommand() { return Promise.resolve(null) },
      subscribe() { return () => {} },
      onConnection() { return () => {} },
      toast() {},
      log() {},
      mountView() { return () => {} }
    }
    const session = { id: 'structured-1', worktreeId: 'wt-main', kind: 'structured', agent: 'claude', title: 'Claude', status: 'running' }

    createRoot(document.getElementById('structured-view')!).render(
      createElement(ChatView, { context, session })
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

/** Opens the chat with `messages` journaled and a center workspace `centerWidth` wide. */
async function openComposer({ centerWidth = CENTER_WIDTH, messages = [] }: { centerWidth?: number; messages?: unknown[] } = {}) {
  const context = await browser!.newContext({ viewport: { width: VIEWPORT.width + centerWidth - CENTER_WIDTH, height: VIEWPORT.height } })
  const page = await context.newPage()
  await page.setContent(pageMarkup())
  await page.evaluate((initial) => void (window.initialMessages = initial), messages)
  for (const stylesheet of STYLESHEETS) {
    await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
  }
  await page.addScriptTag({ content: browserBundle })
  await page.getByRole('textbox', { name: 'Message' }).waitFor()
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
      return document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null
    }, sendCenter)
    expect(hitTarget).toBe('Send')

    await page.mouse.click(sendCenter.x, sendCenter.y)
    await page.waitForFunction(() => window.sentCalls.length === 1, undefined, { timeout: 2_000 })
    expect(await page.evaluate(() => window.sentCalls)).toEqual([
      { session: 'structured-1', text: 'layout regression', when: 'now' }
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

describe('the chat composer beside the floating workspace toggle', () => {
  test.skipIf(!executable)('keeps Send clear and clickable in a narrow center workspace at the default window size', async () => {
    await assertComposerClearance()
  }, 60_000)

})

const PLAN_MESSAGES = [
  { sessionId: 'structured-1', seq: 1, role: 'user', text: 'plan it', at: 1_700_000_000_000, item: { kind: 'user', text: 'plan it' } },
  {
    sessionId: 'structured-1',
    seq: 2,
    role: 'assistant',
    text: '',
    at: 1_700_000_001_000,
    item: { kind: 'plan', version: 1, status: 'waiting', askId: 'ask-1', text: '# Handle ExitPlanMode\n\n1. Read the plan file' }
  }
]

describe('the plan panel layout', () => {
  test.skipIf(!executable)('a narrow chat shows the plan in a sheet over the chat, not beside it', async () => {
    const { context, page } = await openComposer({ messages: PLAN_MESSAGES })
    try {
      const sheet = page.getByRole('dialog', { name: 'Plan' })
      await sheet.waitFor()
      await sheet.getByText('Handle ExitPlanMode').waitFor()
      expect(await page.locator('aside[aria-label="Plan"]').count()).toBe(0)
      const box = (await sheet.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width)
      expect(box.height).toBeGreaterThan(0)
      await sheet.getByRole('button', { name: 'Approve, auto mode' }).waitFor()
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Plan · v1 waiting' }).click()
      await sheet.waitFor()
    } finally {
      await context.close()
    }
  }, 60_000)

  test.skipIf(!executable)('a wide chat shows the plan in an aside beside the transcript', async () => {
    const { context, page } = await openComposer({ centerWidth: 1300, messages: PLAN_MESSAGES })
    try {
      const aside = page.locator('aside[aria-label="Plan"]')
      await aside.waitFor()
      await aside.getByText('Handle ExitPlanMode').waitFor()
      expect(await page.getByRole('dialog').count()).toBe(0)
      const asideBox = (await aside.boundingBox())!
      const logBox = (await page.getByRole('log').boundingBox())!
      expect(logBox.x + logBox.width).toBeLessThanOrEqual(asideBox.x + 1)
      expect(asideBox.width).toBeGreaterThan(300)
      expect(asideBox.width).toBeLessThanOrEqual(440)
      await aside.getByRole('button', { name: 'Close plan' }).click()
      await aside.waitFor({ state: 'detached' })
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('the chat transcript header', () => {
  test.skipIf(!executable)('keeps the event filter in the overflow menu, inset, and clear of the transcript', async () => {
    const { context, page } = await openComposer()
    try {
      const trigger = page.getByRole('button', { name: 'More actions' })
      const title = page.getByRole('heading', { name: 'Rename chat: Claude', exact: true })
      const triggerBox = await trigger.boundingBox()
      const titleBox = await title.boundingBox()
      const headerBox = await page.locator('#structured-view header').boundingBox()
      const logBox = await page.getByRole('log').boundingBox()
      if (!triggerBox || !titleBox || !headerBox || !logBox) {
        throw new Error('The transcript header, menu trigger, or log is not visible')
      }

      const triggerCenter = triggerBox.y + triggerBox.height / 2
      expect(Math.abs(triggerCenter - (titleBox.y + titleBox.height / 2))).toBeLessThanOrEqual(1)
      const inset = await page.getByRole('log').evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineEnd))
      expect(headerBox.x + headerBox.width - (triggerBox.x + triggerBox.width)).toBeGreaterThanOrEqual(inset)
      expect(titleBox.x - headerBox.x).toBeGreaterThanOrEqual(inset)
      expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(logBox.y)

      await trigger.click()
      const item = page.getByRole('menuitemcheckbox', { name: 'Show all events' })
      expect(await item.getAttribute('aria-checked')).toBe('false')
      await item.click()
      await trigger.click()
      expect(await page.getByRole('menuitemcheckbox', { name: 'Show all events' }).getAttribute('aria-checked')).toBe('true')
    } finally {
      await context.close()
    }
  }, 60_000)
})
