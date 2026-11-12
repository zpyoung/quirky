import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Button, ToolIcon } from '../src/design-system'

const executable = chromium.executablePath()

const strip = renderToStaticMarkup(
  <div className="qt-strip">
    <div className="qt-tabs" role="tablist">
      <div className="qt-tab qt-selected" data-tab="tab-1">
        <ToolIcon name="terminal-window" hue="cyan" />
        <span className="qt-dot qt-dot-running" role="img" aria-label="running" />
        <span className="qt-tab-title" role="tab" aria-selected>Claude review of the parser</span>
        <Button variant="secondary" className="qt-badge qt-badge-command" aria-label="Handed off · branches from" title="Go to the session this handoff started">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 6h8" stroke="currentColor" /></svg>
          <span className="qt-badge-label">Handed off · branches from</span>
        </Button>
      </div>
    </div>
  </div>,
)

test.skipIf(!existsSync(executable))('a command badge is an icon, and expanded it shows its label in the title\'s place without moving its right edge', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 240 } })
    const [tokens, components, terminalTools, terminalWorkspace] = await Promise.all([
      Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/terminal-tools.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/terminal-workspace.css', import.meta.url)).text(),
    ])
    await page.setContent(`<style>${tokens}\n${components}\n${terminalTools}\n${terminalWorkspace}</style><main class="qt-workspace" data-theme="dark" style="width:646px;height:120px"><section class="qt-group">${strip}</section></main>`)
    const geometry = () => page.evaluate(() => {
      const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
      return { title: box('.qt-tab-title'), badge: box('.qt-badge-command'), label: box('.qt-badge-label') }
    })

    const collapsed = await geometry()
    expect(collapsed.title.width).toBeGreaterThan(0)
    expect(collapsed.label.width).toBe(0)
    expect(collapsed.badge.width).toBeLessThan(40)

    // the same expansion GroupView applies on pointer enter or focus
    await page.evaluate(() => {
      const badge = document.querySelector<HTMLElement>('.qt-badge-command')!
      const title = document.querySelector<HTMLElement>('.qt-tab-title')!
      const gap = Number.parseFloat(getComputedStyle(badge.parentElement!).columnGap) || 0
      const width = badge.getBoundingClientRect().right - title.getBoundingClientRect().left - gap
      badge.classList.add('qt-badge-expanded')
      badge.style.width = `${width}px`
      title.classList.add('qt-tab-title-yielded')
    })

    const expanded = await geometry()
    expect(expanded.title.width).toBe(0)
    expect(expanded.label.width).toBeGreaterThan(0)
    expect(Math.abs(expanded.badge.right - collapsed.badge.right)).toBeLessThan(0.5)
    // the yielded title keeps its flex gap, so the badge starts one gap after where the title began
    const gap = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.qt-tab')!).columnGap))
    expect(Math.abs(expanded.badge.left - (collapsed.title.left + gap))).toBeLessThan(0.5)
    expect(expanded.label.right).toBeLessThanOrEqual(expanded.badge.right + 0.5)
  } finally {
    await browser.close()
  }
})
