import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { makeTempHome, startHarness, type Harness } from './helpers'
import { writeModulePlugin } from './plugins/fixtures'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('preloads plugin UI before dynamic import and resolves its import-map dependency', async () => {
  const home = makeTempHome('qd-index-preload-browser-')
  const uiDir = join(home, 'ui')
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(join(uiDir, 'index.html'), `<!doctype html>
<html><head><script type="importmap">{"imports":{"fixture-dep":"./dep.js"}}</script></head>
<body><script type="module" src="./main.js"></script></body></html>`)
  writeFileSync(join(uiDir, 'dep.js'), "export const value = 'dep-ok'\n")
  writeFileSync(join(uiDir, 'main.js'), "window.addEventListener('fixture-import', () => { import('/plugins/acme.ui/dist/ui.js').then(({ value }) => { window.__preloaded = value }) }, { once: true })\n")
  const marker = join(home, 'plugin.log')
  const pluginDir = writeModulePlugin(join(home, 'plugins'), marker, {
    id: 'acme.ui',
    ui: 'dist/ui.js',
    contributes: { view: [{ id: 'panel', title: 'Panel' }] }
  })
  mkdirSync(join(pluginDir, 'dist'), { recursive: true })
  writeFileSync(join(pluginDir, 'dist', 'ui.js'), "import { value } from 'fixture-dep'; export { value }\n")
  let harness: Harness | undefined
  let browser: Browser | undefined
  try {
    harness = await startHarness({ home, uiDir, builtinPluginsDir: null })
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
      args: process.platform === 'linux' ? ['--no-sandbox'] : []
    })
    const page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(`http://127.0.0.1:${harness.runtime.port}/`, { waitUntil: 'networkidle' })
    const preload = `http://127.0.0.1:${harness.runtime.port}/plugins/acme.ui/dist/ui.js`
    // Chromium issue 389726685 reports modulepreload initiatorType as "other", so check completed fetch reuse.
    const responses = await page.evaluate((url) =>
      performance.getEntriesByName(url, 'resource').map((entry) => (entry as PerformanceResourceTiming).responseEnd),
    preload)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as Window & { __preloaded?: string }).__preloaded)).toBeUndefined()
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-import')))
    await page.waitForFunction(() => (window as Window & { __preloaded?: string }).__preloaded === 'dep-ok', null, {
      timeout: 10_000
    })
    expect(await page.evaluate((url) => performance.getEntriesByName(url, 'resource').length, preload)).toBe(1)
    expect(consoleErrors.some((message) => /import map/i.test(message))).toBe(false)
  } finally {
    await browser?.close()
    await harness?.cleanup()
    if (!harness) rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
