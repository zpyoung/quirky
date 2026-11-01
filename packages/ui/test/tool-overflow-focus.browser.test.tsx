import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { ControlIcon, IconButton } from '../src/design-system'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('tool overflow focus rings stay rounded and inside the left rail in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    const css = (await Promise.all([
      '../src/design-system/compatibility-tokens.css',
      '../src/design-system/tokens.css',
      '../src/design-system/components.css',
      '../src/shell/tool-shell.css',
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))).join('\n')
    const button = renderToStaticMarkup(
      <IconButton
        className="tool-shell__overflow-button"
        label="More tools"
        title="More tools"
        aria-haspopup="menu"
        aria-expanded={false}
      >
        <ControlIcon name="dots-three" />
      </IconButton>
    )

    for (const theme of ['dark', 'light']) {
      await page.setContent(`<style>${css}\n* { box-sizing: border-box; } html, body { height: 100%; margin: 0; }</style><main class="shell-workspace" data-theme="${theme}" style="width:100vw;height:100vh"><div class="tool-shell" role="group" aria-label="Tool windows"><nav class="tool-shell__stripe tool-shell__stripe--left" aria-label="Left tools"><div class="tool-shell__overflow">${button}</div></nav></div></main>`)
      await page.locator('.tool-shell').evaluate((toolShell) => {
        const workspace = toolShell.parentElement!
        const railWidth = Number.parseFloat(getComputedStyle(workspace).getPropertyValue('--tool-shell-rail-width'))
        toolShell.style.setProperty('--tool-left-rail', String(railWidth))
      })
      await page.keyboard.press('Tab')

      const ring = await page.getByRole('button', { name: 'More tools' }).evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const rail = element.closest('.tool-shell__stripe') as HTMLElement
        const clip = rail.getBoundingClientRect()
        const extent = Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset))
        return {
          focused: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          cornerRadii: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ].map((radius) => Number.parseFloat(radius)),
          railLeft: clip.left,
          clearance: [
            rect.left - extent - clip.left - rail.clientLeft,
            rect.top - extent - clip.top - rail.clientTop,
            clip.left + rail.clientLeft + rail.clientWidth - rect.right - extent,
            clip.top + rail.clientTop + rail.clientHeight - rect.bottom - extent,
          ],
        }
      })

      expect(ring.focused).toBe(true)
      expect(ring.outlineStyle).toBe('solid')
      expect(ring.outlineWidth).toBeGreaterThan(0)
      for (const radius of ring.cornerRadii) expect(radius).toBeGreaterThan(0)
      expect(ring.railLeft).toBe(0)
      for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
    }
  } finally {
    await browser.close()
  }
}, 60_000)
test.skipIf(!existsSync(executable))('provider Source Control focus ring stays rounded and inside the right rail at 647px in both themes', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 647, height: 800 } })
    const css = (await Promise.all([
      '../src/design-system/compatibility-tokens.css',
      '../src/design-system/tokens.css',
      '../src/design-system/components.css',
      '../src/shell/tool-shell.css',
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))).join('\n')
    const button = renderToStaticMarkup(
      <IconButton
        label="Source Control"
        title="Source Control"
        data-available="true"
        data-dirty="false"
      >
        <span className="ui-cluster" />
      </IconButton>
    )

    for (const theme of ['dark', 'light']) {
      await page.setContent(`<style>${css}\n* { box-sizing: border-box; } html, body { height: 100%; margin: 0; }</style><main class="shell-workspace" data-theme="${theme}" style="width:100vw;height:100vh"><div class="tool-shell" role="group" aria-label="Tool windows" style="--tool-right-rail:42"><nav class="tool-shell__stripe tool-shell__stripe--right" aria-label="Right tools"><div class="tool-shell__group tool-shell__group--upper" data-slot="right-top"><div class="tool-shell__tool" data-selected="true"><div class="tool-shell__tool-provider"><section class="plugin-slot" data-plugin-slot="activity-item:quirky.sidebar-extras/source-control"><div class="plugin-slot-body">${button}</div></section></div></div></div></nav></div></main>`)
      await page.keyboard.press('Tab')

      const ring = await page.getByRole('button', { name: 'Source Control' }).evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const rail = element.closest('.tool-shell__stripe') as HTMLElement
        const clip = rail.getBoundingClientRect()
        const extent = Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset))
        return {
          focused: element.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          cornerRadii: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ].map((radius) => Number.parseFloat(radius)),
          railRight: clip.right,
          viewportWidth: window.innerWidth,
          clearance: [
            rect.left - extent - clip.left - rail.clientLeft,
            rect.top - extent - clip.top - rail.clientTop,
            clip.left + rail.clientLeft + rail.clientWidth - rect.right - extent,
            clip.top + rail.clientTop + rail.clientHeight - rect.bottom - extent,
          ],
        }
      })

      expect(ring.focused).toBe(true)
      expect(ring.outlineStyle).toBe('solid')
      expect(ring.outlineWidth).toBeGreaterThan(0)
      for (const radius of ring.cornerRadii) expect(radius).toBeGreaterThan(0)
      expect(ring.railRight).toBe(ring.viewportWidth)
      for (const clearance of ring.clearance) expect(clearance).toBeGreaterThanOrEqual(-0.5)
    }
  } finally {
    await browser.close()
  }
}, 60_000)
