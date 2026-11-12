import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'

type Bundle = { js: string; css: string }
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type MenuInspection = {
  viewport: { width: number; height: number }
  menu: Box
  scroller: { clientWidth: number; scrollWidth: number; scrollLeft: number }
  panel: { clientWidth: number; scrollWidth: number }
  document: { clientWidth: number; scrollWidth: number; scrollX: number }
  items: { text: string; enabled: boolean; visible: boolean; hitTarget: boolean; bounds: Box }[]
}

type FixtureLog = {
  calls: { method: string; params: Record<string, unknown> }[]
  commands: { id: string; args: unknown }[]
}

const executable = chromium.executablePath()
const here = new URL('.', import.meta.url).pathname
const PANEL_HEIGHT = 320
const VIEWPORT_HEIGHT = 480
const FIRST_NUMBER = 101
const ROW_COUNT = 24
const LAST_NUMBER = FIRST_NUMBER + ROW_COUNT - 1
const MENU_COMMANDS = ['Start workspace', 'Review', 'Open on GitHub', 'Copy link']
const BUILD_SCRIPT = `
  const built = await Bun.build({
    entrypoints: ['compact-menu-harness.tsx', '../../../packages/ui/src/styles.css'],
    target: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  if (!built.success) throw new Error(built.logs.join('\\n'))
  const bundle = { js: '', css: '' }
  for (const output of built.outputs) {
    if (output.path.endsWith('.js')) bundle.js = await output.text()
    if (output.path.endsWith('.css')) bundle.css = await output.text()
  }
  process.stdout.write(JSON.stringify(bundle))
`

let browser: Browser | undefined
let bundle: Bundle
const pages: Page[] = []

function buildBundle(): Bundle {
  const built = Bun.spawnSync(['bun', '--eval', BUILD_SCRIPT], { cwd: here, stderr: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  if (built.exitCode !== 0) throw new Error(built.stderr.toString())
  return JSON.parse(built.stdout.toString())
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const frame = () => new Promise((next) => requestAnimationFrame(next))
    void (async () => {
      for (let index = 0; index < 6; index += 1) await frame()
      resolve()
    })()
  }))
}

async function mountCompact(width: number): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: VIEWPORT_HEIGHT } })
  pages.push(page)
  await page.setContent(`<!doctype html>
    <html data-theme="dark"><head><style>
      ${bundle.css}
      html, body { width: 100%; height: 100%; margin: 0; }
      #host { width: ${width}px; height: ${PANEL_HEIGHT}px; min-width: 0; min-height: 0; }
    </style></head><body>
      <main id="host" class="plugin-slot-body"></main>
      <script>window.compactMenuFixture = ${JSON.stringify({ firstNumber: FIRST_NUMBER, rowCount: ROW_COUNT })}</script>
    </body></html>`)
  await page.addScriptTag({ content: bundle.js, type: 'module' })
  await page.waitForFunction((count) => document.querySelectorAll('.tasks-compact__row[data-row-key]').length === count, ROW_COUNT)
  await settled(page)
  return page
}

async function inspectMenu(page: Page): Promise<MenuInspection> {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]')
    const scroller = document.querySelector<HTMLElement>('.tasks-compact__list')
    const panel = document.querySelector<HTMLElement>('.tasks-compact')
    if (!menu || !scroller || !panel) throw new Error('Compact row menu did not mount')
    const box = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      menu: box(menu.getBoundingClientRect()),
      scroller: { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth, scrollLeft: scroller.scrollLeft },
      panel: { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth },
      document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, scrollX: window.scrollX },
      items: [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => {
        const bounds = item.getBoundingClientRect()
        const pointX = bounds.left + bounds.width / 2
        const pointY = bounds.top + bounds.height / 2
        const hit = document.elementFromPoint(pointX, pointY)
        const style = getComputedStyle(item)
        return {
          text: (item.innerText ?? item.textContent ?? '').trim(),
          enabled: !(item as HTMLButtonElement).disabled && item.getAttribute('aria-disabled') !== 'true',
          visible: item.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible',
          hitTarget: hit === item || (hit !== null && item.contains(hit)),
          bounds: box(bounds)
        }
      })
    }
  })
}

describe.skipIf(!existsSync(executable))('compact row action menu in a browser', () => {
  beforeAll(async () => {
    bundle = buildBundle()
    browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  }, 60_000)

  afterEach(async () => {
    for (const page of pages.splice(0)) await page.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  for (const width of [160, 280, 600]) {
    test(`${width}px panel keeps every bottom-row command visible and hit-testable`, async () => {
      const page = await mountCompact(width)
      const bottomRow = page.locator('.tasks-compact__row[data-row-key]').last()
      const nearBottom = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('.tasks-compact__list')!
        list.scrollTop = list.scrollHeight
        const row = [...list.querySelectorAll<HTMLElement>('.tasks-compact__row[data-row-key]')].at(-1)!
        const listBox = list.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        return {
          atEnd: list.scrollTop + list.clientHeight >= list.scrollHeight - 1,
          rowVisible: rowBox.top >= listBox.top && rowBox.bottom <= listBox.bottom,
          bottomGap: listBox.bottom - rowBox.bottom
        }
      })
      await settled(page)
      expect(nearBottom.atEnd).toBe(true)
      expect(nearBottom.rowVisible).toBe(true)
      expect(nearBottom.bottomGap).toBeGreaterThanOrEqual(-1)
      expect(nearBottom.bottomGap).toBeLessThan(50)

      const trigger = page.getByRole('button', { name: `More actions for #${LAST_NUMBER}` })
      await bottomRow.hover()
      await settled(page)
      await trigger.hover()
      await trigger.click()
      const menu = page.locator('[role="menu"]')
      await menu.waitFor({ state: 'visible' })

      const inspection = await inspectMenu(page)
      expect(inspection.items.map((item) => item.text)).toEqual(MENU_COMMANDS)
      expect(inspection.items.every((item) => item.enabled && item.visible && item.hitTarget)).toBe(true)
      expect(inspection.menu.left).toBeGreaterThanOrEqual(0)
      expect(inspection.menu.top).toBeGreaterThanOrEqual(0)
      expect(inspection.menu.right).toBeLessThanOrEqual(inspection.viewport.width + 0.5)
      expect(inspection.menu.bottom).toBeLessThanOrEqual(inspection.viewport.height + 0.5)
      expect(inspection.scroller.scrollWidth).toBeLessThanOrEqual(inspection.scroller.clientWidth)
      expect(inspection.scroller.scrollLeft).toBe(0)
      expect(inspection.panel.scrollWidth).toBeLessThanOrEqual(inspection.panel.clientWidth)
      expect(inspection.document.scrollWidth).toBeLessThanOrEqual(inspection.document.clientWidth)
      expect(inspection.document.scrollX).toBe(0)

      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true)
      expect(await page.locator('.tasks-compact').count()).toBe(1)

      await trigger.click()
      await menu.waitFor({ state: 'visible' })
      await page.getByRole('menuitem', { name: 'Review', exact: true }).click()
      await page.waitForFunction(() => {
        const log = (window as unknown as { compactMenuMock?: FixtureLog }).compactMenuMock
        return log?.calls.some((call) => call.method === 'quirky.reviews/open') === true
      })
      const effects = await page.evaluate(() => {
        const log = (window as unknown as { compactMenuMock: FixtureLog }).compactMenuMock
        return {
          reviewCalls: log.calls.filter((call) => call.method === 'quirky.reviews/open'),
          commands: log.commands
        }
      })
      expect(effects.reviewCalls).toEqual([{
        method: 'quirky.reviews/open',
        params: {
          worktree: 'wt-main',
          number: LAST_NUMBER,
          tab: 'conversation',
          prRepo: { host: 'github.com', owner: 'acme', repo: 'quirky' }
        }
      }])
      expect(effects.commands).toEqual([])
    }, 60_000)
  }
})
