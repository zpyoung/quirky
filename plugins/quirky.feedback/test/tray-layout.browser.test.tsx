import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import type { Comment } from '../src/contract'

const executable = chromium.executablePath()
const TOGGLE = '[data-feedback-toggle]'
const TRAY = '[data-feedback-tray]'

async function pageAssets() {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./fixtures/mode-page.tsx', import.meta.url))],
    target: 'browser',
    format: 'iife',
    define: { 'process.env.QUIRKY_BUILD_CHANNEL': '"test"' },
  })
  if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'))
  const css = (await Promise.all([
    '../../../packages/ui/src/design-system/tokens.css',
    '../../../packages/ui/src/design-system/components.css',
    '../../../packages/ui/src/shell/chrome.css',
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))).join('\n')
  return { script: await built.outputs[0]!.text(), css }
}

const comments: Comment[] = Array.from({ length: 30 }, (_, index) => ({
  id: `c${index}`, createdAt: 1, intent: 'change', comment: `A long saved comment number ${index} `.repeat(4),
  capture: {
    kind: 'element', owner: 'quirky', elementPath: 'div', selector: '#missing', role: null, accessibleName: null,
    visibleText: null, nearbyText: null, attributes: null, rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {},
    component: null, source: null, sourceCaller: null, build: { version: '1', commit: 'x', channel: 'dev' },
  },
}))

async function load(page: Page, assets: Awaited<ReturnType<typeof pageAssets>>, saved: Comment[]) {
  await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${assets.css}
body { margin: 0; height: 100vh; font: 13px/1.4 system-ui, sans-serif; }
.app { height: 100%; display: flex; flex-direction: column; }
.shell-workspace { flex: 1 1 auto; min-height: 0; }</style></head><body><div class="app">
<header class="window-bar" aria-label="Window bar"><button id="bar-control">Projects</button></header>
<div class="feedback-banner-slot" data-feedback-banner-slot></div>
<div class="shell-workspace"><button id="workspace-control">Workspace control</button></div>
</div></body></html>`)
  await page.addScriptTag({ content: assets.script })
  await page.evaluate((list) => window.startFeedback(list), saved)
  await page.waitForFunction(() => window.feedbackCalls.includes('quirky.feedback/list'))
  await page.locator(TOGGLE).waitFor()
}

const boxes = (page: Page) => page.evaluate(([tray]) => {
  const box = (selector: string) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect()
    return rect === undefined ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }
  return { bar: box('.window-bar')!, banner: box('[data-feedback-banner]')!, workspace: box('.shell-workspace')!, tray: box(tray!) }
}, [TRAY])

test.skipIf(!existsSync(executable))('the open panel sits under the banner, fits the window and leaves the bar and layout alone', async () => {
  const assets = await pageAssets()
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    for (const viewport of [{ width: 1280, height: 900 }, { width: 800, height: 600 }, { width: 560, height: 600 }, { width: 360, height: 480 }, { width: 800, height: 280 }]) {
      await page.setViewportSize(viewport)
      await load(page, assets, comments)
      const closed = await boxes(page)
      expect(closed.tray).toBeNull()
      expect(await page.locator('[data-feedback-row]').count()).toBe(0)

      await page.locator(TOGGLE).click()
      await page.locator(TRAY).waitFor()
      const open = await boxes(page)
      const tray = open.tray!
      expect(await page.locator(TOGGLE).getAttribute('aria-expanded')).toBe('true')
      expect(open.banner).toEqual(closed.banner)
      expect(open.workspace).toEqual(closed.workspace)
      expect(tray.top).toBeGreaterThanOrEqual(open.banner.bottom)
      expect(tray.top).toBeGreaterThanOrEqual(open.bar.bottom)
      expect(tray.left).toBeGreaterThanOrEqual(11.5)
      expect(tray.right).toBeCloseTo(Math.min(open.banner.right, viewport.width - 12), 0)
      expect(tray.bottom).toBeLessThanOrEqual(viewport.height)
      expect(tray.bottom - tray.top).toBeLessThanOrEqual(viewport.height * 0.6 + 1)

      const fit = await page.locator(TRAY).evaluate((element) => {
        const scroller = [...element.querySelectorAll<HTMLElement>('div')].find((node) => getComputedStyle(node).overflowY === 'auto')!
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return { scrolls: scroller.scrollHeight > scroller.clientHeight, sideways: element.scrollWidth > element.clientWidth, hit: hit !== null && element.contains(hit), masked: element.hasAttribute('data-quirky-native-mask') }
      })
      expect(fit).toEqual({ scrolls: true, sideways: false, hit: true, masked: true })
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('the panel follows the banner when the window resizes', async () => {
  const assets = await pageAssets()
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await load(page, assets, comments)
    await page.locator(TOGGLE).click()
    await page.locator(TRAY).waitFor()
    await page.setViewportSize({ width: 700, height: 500 })
    await page.waitForFunction(([tray]) => {
      const panel = document.querySelector(tray!)!.getBoundingClientRect()
      const banner = document.querySelector('[data-feedback-banner]')!.getBoundingClientRect()
      return Math.abs(panel.right - banner.right) <= 1 && panel.bottom <= window.innerHeight
    }, [TRAY])
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('real clicks and Esc: the panel never starts a comment, cards stack above it, Esc closes in order', async () => {
  const assets = await pageAssets()
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await load(page, assets, comments)
    const card = page.locator('[data-feedback-card]')

    await page.locator(TOGGLE).click()
    expect(await card.count()).toBe(0)
    await page.locator('[data-feedback-tray] h2').click()
    expect(await card.count()).toBe(0)

    await page.getByRole('button', { name: 'Edit comment 1', exact: true }).click()
    expect(await card.getAttribute('aria-label')).toBe('Edit comment')
    const onTop = await page.evaluate(([tray]) => {
      const panel = document.querySelector(tray!)!.getBoundingClientRect()
      const element = document.querySelector('[data-feedback-card]')!
      const box = element.getBoundingClientRect()
      const left = Math.max(panel.left, box.left), right = Math.min(panel.right, box.right)
      const top = Math.max(panel.top, box.top), bottom = Math.min(panel.bottom, box.bottom)
      if (left >= right || top >= bottom) return 'no overlap to test'
      return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
    }, [TRAY])
    expect(onTop).toBe(true)

    await page.keyboard.press('Escape')
    expect(await card.count()).toBe(0)
    expect(await page.locator(TRAY).count()).toBe(1)

    const point = await page.locator('#workspace-control').boundingBox()
    await page.mouse.click(point!.x + 2, point!.y + 2)
    expect(await card.getAttribute('aria-label')).toBe('New comment')
    expect(await page.locator(TRAY).count()).toBe(1)
    await page.keyboard.press('Escape')
    expect(await card.count()).toBe(0)

    await page.keyboard.press('Escape')
    expect(await page.locator(TRAY).count()).toBe(0)
    expect(await page.evaluate(() => window.feedbackCalls.includes('setting.set'))).toBe(false)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.feedbackCalls.includes('setting.set'))
  } finally {
    await browser.close()
  }
}, 60_000)
