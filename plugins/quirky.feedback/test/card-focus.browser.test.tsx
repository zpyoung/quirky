import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Card } from '../src/mode/Card'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('comment focus ring stays inside the card scrollport before and after a discard warning', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const tokens = await Bun.file(new URL('../../../packages/ui/src/design-system/tokens.css', import.meta.url)).text()
    const components = await Bun.file(new URL('../../../packages/ui/src/design-system/components.css', import.meta.url)).text()
    const actions = { setText() {}, setIntent() {}, submit() {}, cancel() {} }
    for (const theme of ['dark', 'light']) {
      for (const width of [800, 360]) {
        await page.setViewportSize({ width, height: 600 })
        for (const warned of [false, true]) {
          const markup = renderToStaticMarkup(<Card
            card={{ serial: 1, id: null, capture: null, label: 'Worktrees', intent: 'change', text: warned ? 'Draft comment' : '', initialText: '', initialIntent: 'change', warned, saving: false }}
            number={null}
            actions={actions}
          />)
          await page.setContent(`<style>${tokens}\n${components}\n* { box-sizing: border-box; }</style><main data-theme="${theme}">${markup}</main>`)
          const comment = page.getByRole('textbox', { name: 'Comment', exact: true })
          await comment.focus()
          const ring = await comment.evaluate((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const body = element.parentElement!.parentElement!
            const clip = body.getBoundingClientRect()
            const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
            return {
              focused: element.matches(':focus-visible'),
              style: style.outlineStyle,
              width: parseFloat(style.outlineWidth),
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
          for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)
