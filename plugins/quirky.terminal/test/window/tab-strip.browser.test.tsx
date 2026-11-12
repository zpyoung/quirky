import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import type { StripControls, StripFixture } from './tab-strip-harness'

const executable = chromium.executablePath()
const here = new URL('.', import.meta.url).pathname

// the strip's own chrome is pinned too, so viewport width is `strip - CHROME` on any host's fonts
const MORE = 70
const CHROME = 160 + MORE
const WIDE_TABS = { a: 200, b: 250, c: 200, d: 200 }
const MID_GAP_TABS = { a: 100, b: 200, c: 200, d: 400, e: 100 }
const pinnedChrome = `
  .qt-tab-more { box-sizing: border-box; width: ${MORE}px; margin: 0; padding: 0; overflow: hidden; }
  .qt-plus, .qt-actions { width: 30px !important; min-width: 30px !important; margin: 0; }
  .qc-strip { width: 100px; margin: 0; overflow: hidden; }
`

type Tabs = Record<string, number>
type Strip = {
  more: string | null
  scrollLeft: number
  viewport: number
  gap: number
  shown: string[]
  hidden: string[]
  widths: Tabs
  before: number | null
  after: number | null
}

let browser: Browser
let bundle: { js: string; css: string }

// bun test's resolver can't find react from Bun.build, so the bundle is built in its own process
const BUILD_SCRIPT = `
  const built = await Bun.build({
    entrypoints: ['tab-strip-harness.tsx', '../../../../packages/ui/src/styles.css'],
    target: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'no-panes',
      setup(build) {
        build.onResolve({ filter: /\\/PaneLayer$/ }, () => ({ path: 'pane-layer', namespace: 'no-panes' }))
        build.onLoad({ filter: /.*/, namespace: 'no-panes' }, () => ({ loader: 'js', contents: 'export const PaneLayer = () => null; export const InlineField = () => null' }))
      },
    }],
  })
  if (!built.success) throw new Error(built.logs.join('\\n'))
  const bundle = { js: '', css: '' }
  for (const output of built.outputs) {
    if (output.path.endsWith('.js')) bundle.js = await output.text()
    if (output.path.endsWith('.css')) bundle.css = await output.text()
  }
  process.stdout.write(JSON.stringify(bundle))
`

function buildBundle(): { js: string; css: string } {
  const built = Bun.spawnSync(['bun', '--eval', BUILD_SCRIPT], { cwd: here, stderr: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  if (built.exitCode !== 0) throw new Error(built.stderr.toString())
  return JSON.parse(built.stdout.toString())
}

const pinnedTabs = (tabs: Tabs) => Object.entries(tabs)
  .map(([id, width]) => `[data-tab="${id}"] { box-sizing: border-box; width: ${width}px; min-width: ${width}px; max-width: ${width}px; padding: 0; overflow: hidden; }`)
  .join('\n')

async function mountStrip(tabs: Tabs, active: string, stripWidth: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 400 } })
  const fixture: StripFixture = { tabs: Object.keys(tabs), active }
  await page.setContent(`<!doctype html><style>${bundle.css}\n${pinnedChrome}\n${pinnedTabs(tabs)}</style><body style="margin:0"><main class="qt-workspace" data-theme="dark" style="width:${stripWidth}px;height:300px"><div id="host" style="display:flex;flex:1;min-width:0"></div></main><script>window.stripFixture=${JSON.stringify(fixture)}</script></body>`)
  await page.addScriptTag({ content: bundle.js, type: 'module' })
  await page.waitForSelector('.qt-tab', { state: 'attached' })
  await settled(page)
  return page
}

/** Waits for the strip's observers, its React commit and any scroll they caused to finish. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const frame = () => new Promise((next) => requestAnimationFrame(next))
    void (async () => {
      for (let index = 0; index < 6; index += 1) await frame()
      resolve()
    })()
  }))
}

const resizeStrip = async (page: Page, width: number) => {
  await page.evaluate((next) => {
    document.querySelector<HTMLElement>('.qt-workspace')!.style.width = `${next}px`
  }, width)
  await settled(page)
}

const measure = (page: Page): Promise<Strip> => page.evaluate(() => {
  const viewport = document.querySelector<HTMLElement>('.qt-tabs')!
  const bounds = viewport.getBoundingClientRect()
  const tabs = [...viewport.querySelectorAll<HTMLElement>('[data-tab]')].map((element) => ({
    id: element.dataset.tab!,
    right: element.getBoundingClientRect().right - bounds.left,
    width: element.getBoundingClientRect().width,
    hidden: getComputedStyle(element).visibility === 'hidden',
  }))
  const firstShown = tabs.findIndex((entry) => !entry.hidden)
  const lastShown = tabs.findLastIndex((entry) => !entry.hidden)
  return {
    more: document.querySelector('.qt-tab-more')?.textContent ?? null,
    scrollLeft: viewport.scrollLeft,
    viewport: bounds.width,
    gap: bounds.width - (tabs[lastShown]?.right ?? 0),
    shown: tabs.filter((entry) => !entry.hidden).map((entry) => entry.id),
    hidden: tabs.filter((entry) => entry.hidden).map((entry) => entry.id),
    widths: Object.fromEntries(tabs.map((entry) => [entry.id, entry.width])),
    before: tabs[firstShown - 1]?.width ?? null,
    after: tabs[lastShown + 1]?.width ?? null,
  }
})

/** The rule the report asks for: neither hidden neighbour of the visible run fits in the blank space. */
function expectNoNeighbourFits(strip: Strip) {
  if (strip.before !== null) expect(strip.gap).toBeLessThan(strip.before)
  if (strip.after !== null) expect(strip.gap).toBeLessThan(strip.after)
}

describe.skipIf(!existsSync(executable))('tab strip overflow in a browser', () => {
  beforeAll(async () => {
    bundle = buildBundle()
    browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  test('widening a strip scrolled to its end brings back the tab that now fits', async () => {
    const page = await mountStrip(WIDE_TABS, 'd', 430 + CHROME)
    expect((await measure(page)).shown).toEqual(['c', 'd'])

    await resizeStrip(page, 660 + CHROME)

    const strip = await measure(page)
    expect(strip.viewport).toBe(660)
    expect(strip.shown).toEqual(['b', 'c', 'd'])
    expect(strip.more).toBe('1 more')
    expectNoNeighbourFits(strip)
    await page.close()
  }, 60_000)

  test('widening a strip stopped mid-way brings back the tab that now fits, with more tabs still past the gap', async () => {
    const page = await mountStrip(MID_GAP_TABS, 'c', 400 + CHROME)
    expect((await measure(page)).shown).toEqual(['b', 'c'])

    await resizeStrip(page, 520 + CHROME)

    const strip = await measure(page)
    expect(strip.shown).toEqual(['a', 'b', 'c'])
    expectNoNeighbourFits(strip)
    await page.close()
  }, 60_000)

  test('wheeling stays where it stops, so tabs past a short gap can still be reached', async () => {
    const page = await mountStrip(MID_GAP_TABS, 'a', 520 + CHROME)
    const wheelTo = async (scrollLeft: number) => {
      await page.evaluate((next) => {
        document.querySelector('.qt-tabs')!.scrollLeft = next
      }, scrollLeft)
      await settled(page)
      return measure(page)
    }

    const midway = await wheelTo(100)
    expect(midway.shown).toEqual(['b', 'c'])
    expect(midway.scrollLeft).toBe(100)

    expect((await wheelTo(500)).shown).toEqual(['d', 'e'])
    await page.close()
  }, 60_000)

  test('wheeling to the end of the strip stops where no earlier tab fits in the blank space', async () => {
    const page = await mountStrip(WIDE_TABS, 'a', 660 + CHROME)

    await page.evaluate(() => {
      document.querySelector('.qt-tabs')!.scrollLeft = 1_000_000
      return new Promise((resolve) => requestAnimationFrame(resolve))
    })
    await settled(page)

    const strip = await measure(page)
    expect(strip.shown).toEqual(['b', 'c', 'd'])
    expect(strip.more).toBe('1 more')
    expectNoNeighbourFits(strip)
    await page.close()
  }, 60_000)

  test('closing the last tab pulls the preceding tab into the space it left', async () => {
    const page = await mountStrip({ a: 100, b: 100, c: 100, d: 100, e: 100 }, 'e', 300 + CHROME)
    expect((await measure(page)).shown).toEqual(['c', 'd', 'e'])

    await page.evaluate(() => (window as unknown as { stripControls: StripControls }).stripControls.close('e'))
    await settled(page)

    const strip = await measure(page)
    expect(strip.shown).toEqual(['b', 'c', 'd'])
    expect(strip.more).toBe('1 more')
    expectNoNeighbourFits(strip)
    await page.close()
  }, 60_000)

  test('the more button goes away once every tab fits, from any scroll position', async () => {
    const page = await mountStrip(WIDE_TABS, 'd', 430 + CHROME)

    await resizeStrip(page, 850 + CHROME - MORE)

    const strip = await measure(page)
    expect(strip.more).toBeNull()
    expect(strip.hidden).toEqual([])
    expect(strip.scrollLeft).toBe(0)
    await page.close()
  }, 60_000)

  test('a next tab wider than the gap stays hidden at its own width, even when a later one would fit', async () => {
    const widths = { a: 141, b: 204, c: 143, d: 123 }
    const page = await mountStrip(widths, 'b', 474 + CHROME)

    const strip = await measure(page)
    expect(strip.more).toBe('2 more')
    expect(strip.shown).toEqual(['a', 'b'])
    expect(strip.gap).toBe(129)
    expect(strip.widths).toEqual(widths)
    await page.close()
  }, 60_000)

  test('the strip settles without toggling the more button at every width near its tipping points', async () => {
    const page = await mountStrip(WIDE_TABS, 'c', 660 + CHROME)
    await page.evaluate(() => {
      const navigation = document.querySelector('.qt-tab-navigation')!
      const log = { toggles: 0 }
      Object.assign(window, { stripLog: log })
      new MutationObserver((records) => {
        for (const record of records) log.toggles += record.addedNodes.length + record.removedNodes.length
      }).observe(navigation, { childList: true })
    })
    const readToggles = () => page.evaluate(() => (window as unknown as { stripLog: { toggles: number } }).stripLog.toggles)

    const tippingPoints = [400, 450, 650, 850 - MORE]
    for (const point of tippingPoints) {
      for (const offset of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]) {
        const before = await readToggles()
        await resizeStrip(page, point + CHROME + offset)
        const first = await measure(page)
        await settled(page)
        await settled(page)
        expect(await measure(page)).toEqual(first)
        expect((await readToggles()) - before).toBeLessThanOrEqual(1)
        expectNoNeighbourFits(first)
      }
    }
    await page.close()
  }, 120_000)
})
