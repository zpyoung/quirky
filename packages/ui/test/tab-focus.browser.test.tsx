import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Tabs } from '../src/design-system'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('tab focus outlines stay inside the scrollport in both themes, including horizontally scrolled tabs', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const tokens = await Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text()
    const components = await Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text()
    const groups = [
      { label: 'Usage footer detail', labels: ['Detailed', 'Compact'] },
      { label: 'Usage percentage display', labels: ['Used', 'Remaining'] },
    ]
    for (const theme of ['dark', 'light']) {
      for (const width of [400, 100]) {
        const markup = groups.map(({ label, labels }) => renderToStaticMarkup(<Tabs
          label={label}
          value={labels[0]}
          items={labels.map((label) => ({ id: label, label }))}
          onChange={() => {}}
        />)).join('')
        await page.setContent(`<style>${tokens}\n${components}</style><main data-theme="${theme}" style="width:${width}px;padding:20px">${markup}</main>`)
        await page.keyboard.press('Tab')
        for (const tab of await page.getByRole('tab').all()) {
          await tab.focus()
          await tab.scrollIntoViewIfNeeded()
          const ring = await tab.evaluate((element) => {
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
    }
  } finally {
    await browser.close()
  }
}, 60_000)
