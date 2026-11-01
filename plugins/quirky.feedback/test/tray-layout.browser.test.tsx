import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import type { UiPluginContext } from '@quirky/protocol'
import { Tray } from '../src/mode/Tray'
import { createSession } from '../src/mode/session'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('expanded and collapsed feedback trays leave the status bar unobscured', async () => {
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  const session = createSession({} as UiPluginContext, { suspend() {} })
  try {
    const page = await browser.newPage()
    const css = (await Promise.all([
      '../../../packages/ui/src/design-system/tokens.css',
      '../../../packages/ui/src/design-system/components.css',
      '../../../packages/ui/src/shell/chrome.css',
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))).join('\n')
    for (const viewport of [{ width: 1280, height: 900 }, { width: 800, height: 600 }]) {
      await page.setViewportSize(viewport)
      for (const collapsed of [false, true]) {
        const markup = renderToStaticMarkup(<>
          <main style={{ flex: 1 }}>Workspace</main>
          <footer className="shell-statusbar" aria-label="Status bar">
            <span>0 working</span><span>0 needs you · Usage · Claude · Codex</span>
          </footer>
          <Tray state={{ ...session.getState(), collapsed }} found={new Map()} session={session} />
        </>)
        await page.setContent(`<style>${css}\nbody { margin: 0; height: 100vh; display: flex; flex-direction: column; }</style>${markup}`)
        const geometry = await page.locator('[data-feedback-tray]').evaluate((tray) => {
          const trayRect = tray.getBoundingClientRect()
          const statusBar = document.querySelector('footer')!
          const statusRect = statusBar.getBoundingClientRect()
          return {
            clearance: statusRect.top - trayRect.bottom,
            trayTop: trayRect.top,
            footerVisible: [...statusBar.children].every((item) => {
              const rect = item.getBoundingClientRect()
              return document.elementFromPoint(rect.right - 1, rect.top + rect.height / 2) === item
            }),
          }
        })
        expect(geometry.clearance).toBeGreaterThan(0)
        expect(geometry.trayTop).toBeGreaterThanOrEqual(0)
        expect(geometry.footerVisible).toBe(true)
      }
    }
  } finally {
    session.dispose()
    await browser.close()
  }
}, 60_000)
