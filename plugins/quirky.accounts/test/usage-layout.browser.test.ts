import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const executable = chromium.executablePath()

test.skipIf(!existsSync(executable))('usage chips use free status-bar space and recover after overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-layout-'))
  const script = join(directory, 'fixture.js')
  const build = Bun.spawn([
    process.execPath, 'build', new URL('./fixtures/usage-layout.tsx', import.meta.url).pathname,
    '--target', 'browser', '--outfile', script
  ], { stdout: 'pipe', stderr: 'pipe' })
  if (await build.exited) throw new Error(await new Response(build.stderr).text())
  const css = await Promise.all([
    'design-system/tokens.css', 'design-system/components.css', 'styles.css',
    'shell/chrome.css', 'design-system/accounts.css'
  ].map((path) => Bun.file(new URL(`../../../packages/ui/src/${path}`, import.meta.url)).text()))
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 1054, height: 900 } })
    await page.setContent(`<style>${css.join('\n')}</style>
      <div class="app"><main style="flex:1"></main><footer class="shell-statusbar" aria-label="Status bar">
        <div class="shell-statusbar__start"><span>scratch-repo › main</span></div>
        <div class="shell-statusbar__values">
          <button class="ui-status-bar-item">0 working</button>
          <button class="ui-status-bar-item">0 needs you</button>
          <section class="plugin-slot plugin-status-bar-slot">
            <div class="plugin-slot-body accounts-mount-root accounts-mount-root--bar"></div>
          </section>
        </div>
      </footer></div>`)
    await page.addScriptTag({ content: await Bun.file(script).text() })
    await page.waitForSelector('.usage-chips [data-provider]')
    await page.evaluate(async () => {
      if (!('loadUsage' in window) || typeof window.loadUsage !== 'function') throw new Error('Usage fixture not mounted')
      await window.loadUsage()
    })
    const providers = page.locator('.usage-chips [data-provider]')
    await page.waitForFunction(() => document.querySelector('.usage-measure [data-provider]')?.textContent?.includes('%'))
    expect(await providers.evaluateAll((chips) => chips.map((chip) => chip.getAttribute('data-provider')))).toEqual(['claude', 'codex'])
    expect(await page.locator('.usage-chips').textContent()).toContain('%')
    expect(await page.locator('.usage-chips').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    await page.getByRole('button', { name: 'Open Usage', exact: true }).click()
    await page.getByRole('tab', { name: 'Detailed', exact: true }).click()
    await page.waitForSelector('.usage-chips .usage-detailed-chip')
    expect(await providers.count()).toBe(2)
    expect(await page.locator('.usage-chips .meter').count()).toBe(4)
    await page.getByRole('button', { name: 'Close Usage', exact: true }).click()
    await page.getByRole('button', { name: /^Open Codex usage details/ }).click()
    await page.waitForSelector('.usage-popover > .provider-details[aria-label="Codex usage details"]')
    await page.getByRole('button', { name: 'Close Usage', exact: true }).click()

    await page.getByRole('button', { name: /^Open Claude usage details/ }).click()
    await page.waitForSelector('.usage-popover > .provider-details[aria-label="Claude usage details"]')
    await page.getByRole('button', { name: 'Close Usage', exact: true }).click()

    await page.setViewportSize({ width: 647, height: 900 })
    await page.waitForFunction(() => document.querySelector('.usage-chips button[title^="Also: Codex"]') !== null)
    expect(await providers.evaluateAll((chips) => chips.map((chip) => chip.getAttribute('data-provider')))).toEqual(['claude'])
    expect(await page.locator('.shell-statusbar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const suffix = page.locator('.usage-chips button[title^="Also: Codex"]')
    expect(await suffix.getAttribute('aria-label')).toMatch(/\b1 more provider\b/)
    await suffix.click()
    await page.waitForSelector('.usage-popover > .provider-details[aria-label="Codex usage details"]')
    await page.getByRole('button', { name: 'Close Usage', exact: true }).click()

    await page.setViewportSize({ width: 320, height: 900 })
    await page.waitForFunction(() => document.querySelector('.usage-chips button[aria-label="2 more providers"]') !== null)
    const overflow = page.locator('.usage-chips button[aria-label="2 more providers"]')
    expect(await providers.count()).toBe(0)
    const tooltip = await overflow.getAttribute('title')
    expect(tooltip?.replace(/^Also: /, '').split(', ').map((entry) => entry.split(' ')[0])).toEqual(['Claude', 'Codex'])

    await overflow.click()
    await page.waitForSelector('.usage-popover > .provider-details[aria-label$="usage details"]')
    expect(await page.locator('.usage-popover > .provider-details').getAttribute('aria-label')).toBe('Claude usage details')
    await page.getByRole('button', { name: 'Close Usage', exact: true }).click()
    await page.setViewportSize({ width: 1054, height: 900 })
    await page.waitForFunction(() => document.querySelectorAll('.usage-chips [data-provider]').length === 2)
    expect(await overflow.count()).toBe(0)
    await page.getByRole('button', { name: 'Open Usage', exact: true }).click()
    await page.getByRole('tab', { name: 'Compact', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.usage-chips .usage-detailed-chip').length === 0)
    expect(await providers.count()).toBe(2)
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
