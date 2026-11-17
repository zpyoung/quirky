import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'packages/ui/node_modules')
const imports: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
}
let browser: Browser
let bundle: string
let styles: string
declare global {
  interface Window {
    __repairFixture: {
      changes: boolean[]
      mount(options: { disabled?: boolean; long?: boolean; mixed?: boolean }): void
    }
  }
}

function browserEntry() {
  return `
    import { createElement as h, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Checkbox, FormRow } from '@quirky/ui'
    const root = createRoot(document.getElementById('root'))
    const fixture = { changes: [], mount(options = {}) {
      fixture.changes = []
      function Probe() {
        const [checked, setChecked] = useState(false)
        const label = options.long ? 'Keep this deliberately long boolean setting label readable when it wraps onto several lines at narrow widths' : 'Probe setting'
        return h(FormRow, { label, htmlFor: 'probe', layout: 'inline', help: 'Help', error: 'Failed' },
          h(Checkbox, { label, hideLabel: true, checked, disabled: options.disabled, indeterminate: options.mixed,
            onChange(value) { fixture.changes.push(value); setChecked(value) } }))
      }
      root.render(h(Probe, { key: Math.random() }))
    } }
    window.__repairFixture = fixture
  `
}
async function expandStyles(url: URL): Promise<string> {
  const source = await Bun.file(url).text()
  const pattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);/g
  let result = ''
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    result += source.slice(cursor, match.index)
    const imported = new URL(match[2]!, url)
    const css = imported.protocol === 'file:' ? await expandStyles(imported) : match[0]
    result += match[3]?.trim() && imported.protocol === 'file:' ? `@media ${match[3]} {\n${css}\n}` : css
    cursor = match.index + match[0].length
  }
  return result + source.slice(cursor)
}
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'plugin-baseline-repairs-fixture.ts')], target: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'plugin-repair-fixture', setup(build) {
      build.onResolve({ filter: /plugin-baseline-repairs-fixture\.ts$/ }, () => ({ path: 'entry', namespace: 'repair' }))
      build.onLoad({ filter: /.*/, namespace: 'repair' }, () => ({ contents: browserEntry(), loader: 'ts', resolveDir: ROOT }))
      build.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({ path: imports[path] ?? path }))
    } }],
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  bundle = await result.outputs[0]!.text()
  styles = `${await expandStyles(new URL('../src/shell/chrome.css', import.meta.url))}\n${await expandStyles(new URL('../src/styles.css', import.meta.url))}`
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
}, 60_000)
afterAll(async () => { await browser?.close() })

async function pageFor(theme: string, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.setContent(`<html data-theme="${theme}"><head><style>${styles}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({ content: bundle })
  return page
}
async function mountProbe(page: Page, options: { disabled?: boolean; long?: boolean; mixed?: boolean } = {}) {
  await page.evaluate((options) => window.__repairFixture.mount(options), options)
  await page.locator('input').waitFor()
}
async function booleanGeometry(page: Page, id: string) {
  return page.evaluate((id) => {
    const input = document.getElementById(id) as HTMLInputElement
    const row = input.closest('.ui-form-row')!
    const label = row.querySelector('.ui-form-row__label')!
    const range = document.createRange()
    range.selectNodeContents(label)
    const first = range.getClientRects()[0]!
    const box = input.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    return {
      width: box.width, height: box.height,
      centers: Math.abs(box.y + box.height / 2 - first.y - first.height / 2),
      gap: labelBox.x - box.right,
      descriptions: [...row.querySelectorAll('.ui-help-text, .ui-error-text')].map((node) => {
        const rect = node.getBoundingClientRect()
        return { offset: Math.abs(rect.x - labelBox.x), below: rect.y >= labelBox.bottom }
      }),
      overflow: row.scrollWidth > row.clientWidth,
    }
  }, id)
}
async function assertBooleanRow(page: Page, id: string) {
  const geometry = await booleanGeometry(page, id)
  expect(geometry.width).toBe(14)
  expect(geometry.height).toBe(14)
  expect(geometry.centers).toBeLessThanOrEqual(1)
  expect(geometry.gap).toBe(8)
  expect(geometry.overflow).toBe(false)
  for (const description of geometry.descriptions) {
    expect(description.offset).toBeLessThanOrEqual(0.5)
    expect(description.below).toBe(true)
  }
}
for (const theme of ['dark', 'light']) for (const width of [1000, 320]) {
  test(`inline boolean native contract and geometry ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountProbe(page, { long: true })
      const input = page.getByRole('checkbox', { name: 'Keep this deliberately long boolean setting label readable when it wraps onto several lines at narrow widths', exact: true })
      expect(await input.getAttribute('id')).toBe('probe')
      expect(await input.getAttribute('aria-describedby')).toBe('probe-help probe-error')
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      await assertBooleanRow(page, 'probe')
      await page.locator('label[for="probe"]').click()
      expect(await input.isChecked()).toBe(true)
      await input.focus()
      await page.keyboard.press('Space')
      expect(await input.isChecked()).toBe(false)
      expect(await page.evaluate(() => window.__repairFixture.changes)).toEqual([true, false])
    } finally { await page.close() }
  })
  test(`inline boolean disabled and mixed contract ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountProbe(page, { disabled: true, mixed: true })
      const input = page.getByRole('checkbox', { name: 'Probe setting', exact: true })
      expect(await input.isDisabled()).toBe(true)
      expect(await input.evaluate((node) => (node as HTMLInputElement).indeterminate)).toBe(true)
      expect(await input.getAttribute('aria-checked')).toBe('mixed')
      await page.locator('label[for="probe"]').click({ force: true })
      await page.keyboard.press('Tab')
      await page.keyboard.press('Space')
      expect(await page.evaluate(() => window.__repairFixture.changes)).toEqual([])
      expect(await input.isChecked()).toBe(false)
    } finally { await page.close() }
  })
}
