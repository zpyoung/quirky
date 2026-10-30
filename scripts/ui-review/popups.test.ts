import { describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { chromium } from 'playwright'
import { CLONE_ATTRIBUTE, appendInertClone, cloneOpenPopupExpression, removeClonesExpression, separateClonesExpression } from './popups'

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}
const executable = chromiumExecutable()

class FakeElement {
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  constructor(readonly name: string) {}
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.name)
    copy.attributes = new Map(this.attributes)
    return copy
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  appendChild(child: FakeElement) { this.children.push(child) }
}

describe('popup clones for the popups composite', () => {
  test('a clone is a separate element that is inert, hidden from assistive tech and marked for removal', () => {
    const popup = new FakeElement('div')
    popup.setAttribute('class', 'ui-popup')
    const host = new FakeElement('body')

    const clone = appendInertClone(popup, host, CLONE_ATTRIBUTE)

    expect(clone).not.toBe(popup)
    expect(host.children).toEqual([clone])
    expect(clone.attributes.get('inert')).toBe('')
    expect(clone.attributes.get('aria-hidden')).toBe('true')
    expect(clone.attributes.has(CLONE_ATTRIBUTE)).toBe(true)
    expect(clone.attributes.get('class')).toBe('ui-popup')
  })

  test('the opened popup is left untouched', () => {
    const popup = new FakeElement('div')
    appendInertClone(popup, new FakeElement('body'), CLONE_ATTRIBUTE)

    expect(popup.attributes.has('inert')).toBe(false)
    expect(popup.attributes.has('aria-hidden')).toBe(false)
  })
})

const POPUPS_HTML = `<style>.ui-popup{position:fixed;top:40px;width:200px;height:100px}</style>
<button id="outside">outside</button>
<div class="ui-popup" style="left:10px" role="menu"><button id="inside">row</button></div>`

describe('popup clones in a real page', () => {
  test.skipIf(!executable)('a copy keeps the popup\'s look, takes no focus or clicks, and goes away on removal', async () => {
    const browser = await chromium.launch({ executablePath: executable!, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
    try {
      const page = await browser.newPage()
      await page.setContent(POPUPS_HTML)

      const copied: unknown = await page.evaluate(cloneOpenPopupExpression())
      expect(copied).toBe(true)
      expect(await page.locator('.ui-popup').count()).toBe(2)
      const copy = page.locator(`[${CLONE_ATTRIBUTE}]`)
      expect(await copy.getAttribute('inert')).toBe('')
      expect(await copy.getAttribute('aria-hidden')).toBe('true')
      expect(await page.getByRole('menu').count()).toBe(1)
      const hit = await page.evaluate(() => document.elementFromPoint(20, 60)?.closest('.ui-popup')?.hasAttribute('data-capture-popup-clone') ?? null)
      expect(hit).toBe(false)

      await page.evaluate(removeClonesExpression())
      expect(await page.locator('.ui-popup').count()).toBe(1)
    } finally {
      await browser.close()
    }
  }, 60_000)

  test.skipIf(!executable)('a second copy slides right of the first instead of covering it', async () => {
    const browser = await chromium.launch({ executablePath: executable!, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
    try {
      const page = await browser.newPage()
      await page.setContent(POPUPS_HTML)
      await page.evaluate(cloneOpenPopupExpression())
      await page.evaluate(cloneOpenPopupExpression())
      await page.evaluate(separateClonesExpression())

      const boxes = await page.locator(`[${CLONE_ATTRIBUTE}]`).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()))
      expect(boxes[1].left).toBeGreaterThanOrEqual(boxes[0].right)
    } finally {
      await browser.close()
    }
  }, 60_000)
})
