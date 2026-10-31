import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { IconButton, ListRow, ToolPanelFrame } from '../src/design-system'

const executable = chromium.executablePath()
const panel = renderToStaticMarkup(
  <div className="tool-shell__panel">
    <ToolPanelFrame title="Terminal sessions">
      <div className="plugin-slot">
        <div className="tt-tool-panel-fill tt-sessions-panel">
          <ToolPanelFrame title="Sessions">
            <ul className="tt-sessions-list">
              {Array.from({ length: 20 }, (_, index) => (
                <li key={index} data-session={`session-${index}`}>
                  <ListRow
                    title={`Terminal ${index + 1}`}
                    description="main running"
                    status="working"
                    trailing={<IconButton label={`Kill session ${index}`} variant="destructive">×</IconButton>}
                  />
                </li>
              ))}
            </ul>
          </ToolPanelFrame>
        </div>
      </div>
    </ToolPanelFrame>
  </div>,
)

test.skipIf(!existsSync(executable))('terminal session rows stay inset on both sides of a docked, scrolling list', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    const styles = await Promise.all([
      '../src/design-system/tokens.css',
      '../src/design-system/components.css',
      '../src/design-system/terminal-tools.css',
      '../src/shell/tool-shell.css',
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))

    for (const width of [320, 1200]) {
      await page.setContent(`<style>${styles.join('\n')}</style><main data-theme="dark">${panel}</main>`)
      await page.locator('.tool-shell__panel').evaluate((element, width) => {
        Object.assign((element as HTMLElement).style, { width: `${width}px`, height: '240px' })
      }, width)
      const geometry = await page.locator('.tt-sessions-list').evaluate((list) => {
        const bounds = list.getBoundingClientRect()
        const row = list.querySelector('li')!.getBoundingClientRect()
        return {
          leftInset: row.left - bounds.left,
          rightInset: bounds.right - row.right,
          scrolls: list.scrollHeight > list.clientHeight,
        }
      })
      expect(geometry.leftInset).toBeGreaterThanOrEqual(8)
      expect(geometry.rightInset).toBeGreaterThanOrEqual(8)
      expect(geometry.scrolls).toBe(true)
    }
  } finally {
    await browser.close()
  }
}, 60_000)
