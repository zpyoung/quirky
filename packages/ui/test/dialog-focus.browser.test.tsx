import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Dialog, FormRow } from '../src/design-system'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('scrolling dialog keeps checkbox focus outlines inside its scrollport in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const tokens = await Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text()
    const components = await Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text()
    const markup = renderToStaticMarkup(
      <Dialog open title="Settings" scrollBody actions={<button>Save</button>}>
        <form className="ui-stack">
          <h3>Appearance</h3>
          <FormRow label="Sidebar section separators" htmlFor="separators" help="Show divider lines between projects and groups.">
            <input id="separators" type="checkbox" defaultChecked />
          </FormRow>
          <div style={{ height: 1000 }} />
        </form>
      </Dialog>,
    )
    for (const theme of ['dark', 'light']) {
      for (const width of [800, 360]) {
        await page.setViewportSize({ width, height: 600 })
        await page.setContent(`<style>${tokens}\n${components}</style><main data-theme="${theme}">${markup}</main>`)
        await page.keyboard.press('Tab')
        const checkbox = page.getByRole('checkbox', { name: 'Sidebar section separators' })
        await checkbox.focus()
        for (const checked of [true, false]) {
          expect(await checkbox.isChecked()).toBe(checked)
          const ring = await checkbox.evaluate((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const body = element.closest<HTMLElement>('.ui-dialog__body')!
            const clip = body.getBoundingClientRect()
            const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
            return {
              focused: element.matches(':focus-visible'),
              style: style.outlineStyle,
              width: parseFloat(style.outlineWidth),
              scrolls: body.scrollHeight > body.clientHeight,
              clearance: [
                rect.left - extent - clip.left - body.clientLeft,
                rect.top - extent - clip.top - body.clientTop,
                clip.left + body.clientLeft + body.clientWidth - rect.right - extent,
                clip.top + body.clientTop + body.clientHeight - rect.bottom - extent,
              ],
            }
          })
          expect(ring.focused).toBe(true)
          expect(ring.style).toBe('solid')
          expect(ring.width).toBeGreaterThan(0)
          expect(ring.scrolls).toBe(true)
          for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
          if (checked) await checkbox.press('Space')
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)
