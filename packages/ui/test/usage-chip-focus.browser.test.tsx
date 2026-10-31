import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Button } from '../src/design-system'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('usage chip focus rings remain visible inside the overflow row in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const css = (await Promise.all(['tokens', 'components', 'accounts'].map((name) =>
      Bun.file(new URL(`../src/design-system/${name}.css`, import.meta.url)).text()
    ))).join('\n')
    for (const theme of ['dark', 'light']) {
      for (const collapsed of [false, true]) {
        const markup = renderToStaticMarkup(<div className="accounts-ui usage-status-bar">
          <div className="usage-chips" aria-label="Provider usage status bar">
            <Button className="usage-chip" aria-label={collapsed ? '2 more providers' : 'Open Claude usage'}>
              {collapsed ? '+2' : 'Claude 81% remaining'}
            </Button>
          </div>
        </div>)
        await page.setContent(`<style>${css}</style><main data-theme="${theme}" style="width:${collapsed ? 40 : 240}px;padding:20px">${markup}</main>`)
        await page.keyboard.press('Tab')
        const chip = page.getByRole('button')
        await chip.focus()
        const ring = await chip.evaluate((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const parent = element.parentElement!
          const clip = parent.getBoundingClientRect()
          const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
          return {
            focused: element.matches(':focus-visible'),
            style: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            clearance: [
              rect.left - extent - clip.left - parent.clientLeft,
              rect.top - extent - clip.top - parent.clientTop,
              clip.left + parent.clientLeft + parent.clientWidth - rect.right - extent,
              clip.top + parent.clientTop + parent.clientHeight - rect.bottom - extent,
            ],
          }
        })
        expect(ring.focused).toBe(true)
        expect(ring.style).toBe('solid')
        expect(ring.width).toBeGreaterThan(0)
        for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)
