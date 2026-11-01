import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'

const executable = chromium.executablePath()

async function buildFixture() {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./fixtures/popup-menu.tsx', import.meta.url))],
    target: 'browser',
    format: 'iife',
  })

  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const bundle = result.outputs[0]
  if (!bundle) throw new Error('Bun.build produced no PopupMenu fixture bundle')
  return bundle.text()
}

test.skipIf(!existsSync(executable))('PopupMenu keeps natural keyboard focus after positioning and supports Escape, arrows, and Enter', async () => {
  const bundle = await buildFixture()
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle })

    const trigger = page.getByRole('button', { name: 'Open menu' })
    const menu = page.getByRole('menu', { name: 'Menu' })
    const waitForMenuToClose = () =>
      page.waitForFunction(() => document.querySelector('[role="menu"]') === null)
    const openMenu = async () => {
      await trigger.click()
      await menu.waitFor({ state: 'visible' })
      return menu
    }
    const isFocused = async (element: Locator) =>
      element.evaluate((node) => document.activeElement === node)

    const firstMenu = await openMenu()
    expect(await isFocused(firstMenu)).toBe(true)
    await page.keyboard.press('Escape')
    await waitForMenuToClose()
    expect(await isFocused(trigger)).toBe(true)

    const arrowMenu = await openMenu()
    expect(await isFocused(arrowMenu)).toBe(true)
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('menuitem', { name: 'First item' }).getAttribute('data-highlighted')).toBe('')
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('menuitem', { name: 'Second item' }).getAttribute('data-highlighted')).toBe('')
    await page.keyboard.press('Escape')
    await waitForMenuToClose()
    expect(await isFocused(trigger)).toBe(true)

    await openMenu()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitForMenuToClose()
    expect(await page.locator('#selection').textContent()).toBe('Second item')
  } finally {
    await browser.close()
  }
}, 60_000)
