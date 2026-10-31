import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { Button, IconButton, ToolIcon } from '../src/design-system'

const executable = chromium.executablePath()
const tabs = [
  ...Array.from({ length: 7 }, (_, index) => ({ id: `terminal-${index + 1}`, label: `Terminal ${index + 1}`, agent: false })),
  { id: 'claude-background', label: 'Claude background', agent: true },
]

const strip = renderToStaticMarkup(
  <div className="qt-strip">
    <div className="qt-tab-navigation">
      <div className="qt-tabs" role="tablist">
        {tabs.map(({ id, label, agent }, index) => (
          <div key={id} className={`qt-tab${index === 0 ? ' qt-selected' : ''}`} data-tab={id} title={label}>
            <ToolIcon name={agent ? 'robot' : 'terminal-window'} hue={agent ? 'lilac' : 'cyan'} />
            <span className="qt-dot qt-dot-running" role="img" aria-label="running" />
            <span className="qt-tab-title" role="tab" aria-selected={index === 0}>{label}</span>
            <IconButton className="qt-icon qt-tab-close" label={`Close ${label}`} title="Close">×</IconButton>
          </div>
        ))}
      </div>
      <button type="button" className="qt-tab-more" aria-haspopup="menu" aria-expanded="false">
        <span aria-hidden="true">⌄</span>
        <span>7 more</span>
      </button>
    </div>
    <IconButton className="qt-icon qt-plus" label="New tab" title="New tab">+</IconButton>
    <div className="qc-strip">
      <div className="qc-split">
        <Button className="qc-run" aria-label="Run quick command: Build">
          <span className="ui-icon-button__icon" aria-hidden="true">▶</span>
          <span className="qc-run-label">Build</span>
        </Button>
        <IconButton className="qc-more" label="More quick commands" aria-haspopup="menu" aria-expanded="false">⌄</IconButton>
      </div>
    </div>
    <IconButton className="qt-icon qt-actions" label="Pane actions" title="Pane actions">…</IconButton>
  </div>,
)

test.skipIf(!existsSync(executable))('selected terminal labels and close buttons stay visible beside strip controls', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 240 } })
    const [tokens, components, terminalTools, terminalWorkspace] = await Promise.all([
      Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/terminal-tools.css', import.meta.url)).text(),
      Bun.file(new URL('../src/design-system/terminal-workspace.css', import.meta.url)).text(),
    ])

    for (const width of [320, 480, 481, 646]) {
      await page.setContent(`<style>${tokens}\n${components}\n${terminalTools}\n${terminalWorkspace}</style><main class="qt-workspace" data-theme="dark" style="width:${width}px;height:120px"><section class="qt-group">${strip}</section></main>`)

      const selectedTabFits = async () => page.locator('.qt-tab.qt-selected').evaluate((tab) => {
        const title = tab.querySelector('.qt-tab-title')!
        const close = tab.querySelector('.qt-tab-close')!
        const viewport = tab.closest<HTMLElement>('.qt-tabs')!
        const stripElement = tab.closest<HTMLElement>('.qt-strip')!
        const rect = (element: Element) => element.getBoundingClientRect()
        const containedBy = (element: Element, container: HTMLElement) => {
          const bounds = rect(container)
          const inner = rect(element)
          const left = bounds.left + container.clientLeft
          const top = bounds.top + container.clientTop
          return inner.left >= left - 0.5
            && inner.top >= top - 0.5
            && inner.right <= left + container.clientWidth + 0.5
            && inner.bottom <= top + container.clientHeight + 0.5
        }
        return {
          titleInViewport: containedBy(title, viewport),
          closeInViewport: containedBy(close, viewport),
          titleInStrip: containedBy(title, stripElement),
          closeInStrip: containedBy(close, stripElement),
        }
      })

      expect(await selectedTabFits()).toEqual({ titleInViewport: true, closeInViewport: true, titleInStrip: true, closeInStrip: true })
      if (width > 480) {
        const controlsShareNavigationRow = await page.evaluate(() => {
          const navigation = document.querySelector<HTMLElement>('.qt-tab-navigation')!.getBoundingClientRect()
          return Array.from(document.querySelectorAll<HTMLElement>('.qc-strip, .qt-plus, .qt-actions')).every((control) => {
            const rect = control.getBoundingClientRect()
            const centerY = (rect.top + rect.bottom) / 2
            return centerY >= navigation.top - 0.5 && centerY <= navigation.bottom + 0.5
          })
        })
        expect(controlsShareNavigationRow).toBe(true)
      }

      await page.locator('[data-tab="terminal-3"]').evaluate((tab) => {
        tab.closest('.qt-tabs')!.querySelector('.qt-tab.qt-selected')!.classList.remove('qt-selected')
        tab.classList.add('qt-selected')
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
      expect(await selectedTabFits()).toEqual({ titleInViewport: true, closeInViewport: true, titleInStrip: true, closeInStrip: true })
    }
  } finally {
    await browser.close()
  }
}, 60_000)
