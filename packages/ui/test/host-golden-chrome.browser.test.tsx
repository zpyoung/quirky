import { beforeAll, afterAll, expect, test } from 'bun:test'
import { accessSync, constants } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { openSettings } from '../../../scripts/ui-review/capture'

const candidates = [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
const executable = candidates.find((path) => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
})
if (!executable && process.env.CI === 'true') {
  throw new Error(`host-golden-chrome needs Chromium or Chrome; none found at ${candidates.join(', ')}`)
}
let browser: Browser
beforeAll(async () => {
  if (executable) browser = await chromium.launch({ headless: true, executablePath: executable })
})
afterAll(async () => { await browser?.close() })

test.skipIf(!executable)('Settings opens from the Window bar when a plugin also has a More button', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`
      <header class="window-bar" aria-label="Window bar">
        <button aria-label="More" onclick="document.querySelector('[role=menu]').hidden=false">Host</button>
      </header>
      <section data-plugin-slot="sidebar:worktrees">
        <button aria-label="More" onclick="document.body.dataset.pluginClicked='true'">Plugin</button>
      </section>
      <div role="menu" hidden><button role="menuitem" onclick="document.querySelector('[role=dialog]').hidden=false">Settings</button></div>
      <div role="dialog" aria-label="Settings" hidden>Settings content</div>
    `)
    await openSettings({ page, options: { timeoutMs: 1_000 } } as Parameters<typeof openSettings>[0])
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('body').getAttribute('data-plugin-clicked')).toBeNull()
  } finally {
    await page.close()
  }
})
