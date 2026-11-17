import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const UI_MODULES = join(ROOT, 'packages/ui/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const executable = browserExecutable()
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'browser-baseline-layout-fixture',
  setup(builder) {
    builder.onResolve({ filter: /baseline-layout-browser-fixture\.ts$/ }, () => ({
      path: 'entry',
      namespace: 'baseline-layout-fixture'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'baseline-layout-fixture' }, () => ({
      contents: browserEntry(),
      loader: 'ts',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
  }
}

let browser: Browser
let browserBundle = ''
const openPages = new Set<{ page: Page; pageErrors: string[]; requests: string[] }>()

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'baseline-layout-browser-fixture.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Browser baseline-layout fixture bundle was empty.')
  browserBundle = await output.text()
  browser = await chromium.launch({ headless: true, executablePath: executable })
}, 60_000)

afterEach(async () => {
  const sessions = [...openPages]
  openPages.clear()
  await Promise.all(sessions.map(async ({ page, pageErrors, requests }) => {
    try {
      expect(pageErrors).toEqual([])
      expect(requests).toEqual([])
      expect(await page.evaluate(() => window.__baselineLayoutFixture.unexpectedCalls)).toEqual([])
    } finally {
      await page.close()
    }
  }))
})

afterAll(async () => {
  await browser?.close()
}, 30_000)

declare global {
  interface Window {
    __baselineLayoutFixture: {
      events: { type: string; value?: string; key?: string }[]
      unexpectedCalls: unknown[]
      mountTextField(options?: { hideLabel?: boolean; disabled?: boolean; defaultValue?: string }): void
      focusAddress(): void
    }
  }
}

function browserEntry(): string {
  return `
    import { createElement as h, createRef } from 'react'
    import { createRoot } from 'react-dom/client'
    import { flushSync } from 'react-dom'
    import { TextField } from '@quirky/ui'

    const root = createRoot(document.getElementById('fixture-root'))
    const inputRef = createRef()
    const fixture = {
      events: [],
      unexpectedCalls: [],
      mountTextField(options = {}) {
        const props = {
          label: 'Address and search',
          id: 'probe-address',
          help: 'Help',
          error: 'Failed',
          'aria-describedby': 'external-help',
          disabled: options.disabled ?? false,
          defaultValue: options.defaultValue ?? '',
          className: 'probe-input',
          ref: inputRef,
          onChange(event) {
            fixture.events.push({ type: 'change', value: event.currentTarget.value })
          },
          onKeyDown(event) {
            fixture.events.push({ type: 'keydown', key: event.key })
          }
        }
        if (Object.hasOwn(options, 'hideLabel')) props.hideLabel = options.hideLabel
        flushSync(() => root.render(h(TextField, props)))
      },
      focusAddress() {
        inputRef.current?.focus()
      }
    }
    window.__baselineLayoutFixture = fixture
  `
}

async function expandStyleImports(url: URL, ancestors: Set<string> = new Set()): Promise<string> {
  if (ancestors.has(url.href)) throw new Error(`Cyclic production CSS import: ${url.href}`)
  const nextAncestors = new Set(ancestors).add(url.href)
  const source = await Bun.file(url).text()
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);/g
  let result = ''
  let cursor = 0
  for (const match of source.matchAll(importPattern)) {
    const index = match.index
    result += source.slice(cursor, index)
    const importedUrl = new URL(match[2]!, url)
    const imported = importedUrl.protocol === 'file:'
      ? await expandStyleImports(importedUrl, nextAncestors)
      : match[0]
    const media = match[3]?.trim()
    result += media && importedUrl.protocol === 'file:' ? `@media ${media} {\n${imported}\n}` : imported
    cursor = index + match[0].length
  }
  return result + source.slice(cursor)
}

async function productionStyles(): Promise<string> {
  const shell = await expandStyleImports(new URL('../../../packages/ui/src/shell/chrome.css', import.meta.url))
  const app = await expandStyleImports(new URL('../../../packages/ui/src/styles.css', import.meta.url))
  return `${shell}\n${app}`
}

async function styledPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  const pageErrors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  openPages.add({ page, pageErrors, requests })
  const styles = await productionStyles()
  await page.setContent(`
    <html data-theme="dark">
      <head><style>${styles}</style></head>
      <body>
        <button id="focus-origin" type="button">Focus origin</button>
        <div id="fixture-root"></div>
        <p id="external-help">External help</p>
      </body>
    </html>
  `)
  await page.addScriptTag({ content: browserBundle })
  await page.waitForFunction(() => typeof window.__baselineLayoutFixture?.mountTextField === 'function')
  return page
}

const themes = ['dark', 'light'] as const
const widths = [1000, 700, 320] as const

test('TextField visually hides its label without changing its accessible name or disabled field', async () => {
  const page = await styledPage()

  for (const theme of themes) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme }, theme)
      await page.evaluate(() => window.__baselineLayoutFixture.mountTextField({
        hideLabel: true,
        disabled: true,
        defaultValue: 'native value'
      }))

      const input = page.getByRole('textbox', { name: 'Address and search' })
      await input.waitFor({ state: 'attached' })
      expect(await input.count()).toBe(1)
      expect(await input.getAttribute('id')).toBe('probe-address')
      expect(await input.getAttribute('aria-describedby')).toBe('external-help probe-address-help probe-address-error')
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      expect(await input.isDisabled()).toBe(true)
      expect(await input.inputValue()).toBe('native value')
      expect(await input.getAttribute('hidelabel')).toBeNull()
      expect(await page.getByText('Help', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByRole('alert').getAttribute('id')).toBe('probe-address-error')
      expect(await page.getByRole('alert').isVisible()).toBe(true)

      const geometry = await page.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.ui-text-field')!
        const label = wrapper.querySelector<HTMLLabelElement>('label')!
        const input = wrapper.querySelector<HTMLInputElement>('input')!
        const labelStyle = getComputedStyle(label)
        const labelRect = label.getBoundingClientRect()
        const wrapperRect = wrapper.getBoundingClientRect()
        const inputRect = input.getBoundingClientRect()
        return {
          labelText: label.textContent,
          labelFor: label.htmlFor,
          labelClass: label.className,
          labelPosition: labelStyle.position,
          labelClip: labelStyle.clip,
          labelClipPath: labelStyle.clipPath,
          labelOverflow: labelStyle.overflow,
          labelWidth: labelRect.width,
          labelHeight: labelRect.height,
          wrapperTop: wrapperRect.top,
          inputTop: inputRect.top
        }
      })
      expect(geometry.labelText).toBe('Address and search')
      expect(geometry.labelFor).toBe('probe-address')
      expect(geometry.labelClass).toContain('ui-text-field__label--hidden')
      expect(geometry.labelPosition).toBe('absolute')
      expect(geometry.labelWidth).toBeLessThanOrEqual(1)
      expect(geometry.labelHeight).toBeLessThanOrEqual(1)
      expect(geometry.labelClip !== 'auto' || geometry.labelClipPath !== 'none' || geometry.labelOverflow === 'hidden').toBe(true)
      expect(Math.abs(geometry.inputTop - geometry.wrapperTop)).toBeLessThanOrEqual(0.5)
    }
  }
})

test('TextField preserves its visible-label default and the opted-in field keeps ref, value, events, and focus styling', async () => {
  const page = await styledPage()
  const defaultLabelGeometry: unknown[] = []

  for (const theme of themes) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate((nextTheme) => { document.documentElement.dataset.theme = nextTheme }, theme)

      const visibleVariants = [
        { disabled: false },
        { disabled: false, hideLabel: false }
      ]
      let expectedGeometry: unknown
      for (const options of visibleVariants) {
        await page.evaluate((fieldOptions) => window.__baselineLayoutFixture.mountTextField(fieldOptions), options)
        const metrics = await page.evaluate(() => {
          const wrapper = document.querySelector<HTMLElement>('.ui-text-field')!
          const label = wrapper.querySelector<HTMLLabelElement>('label')!
          const input = wrapper.querySelector<HTMLInputElement>('input')!
          const wrapperRect = wrapper.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const inputRect = input.getBoundingClientRect()
          return {
            wrapperClass: wrapper.className,
            labelClass: label.className,
            inputClass: input.className,
            labelPosition: getComputedStyle(label).position,
            gap: getComputedStyle(wrapper).rowGap,
            labelTop: labelRect.top,
            labelBottom: labelRect.bottom,
            labelWidth: labelRect.width,
            labelHeight: labelRect.height,
            inputTop: inputRect.top,
            wrapperTop: wrapperRect.top,
            wrapperHeight: wrapperRect.height
          }
        })
        expect(metrics.wrapperClass).toBe('ui-text-field')
        expect(metrics.labelClass).toBe('ui-text-field__label')
        expect(metrics.inputClass).toBe('ui-text-field__input probe-input')
        expect(metrics.labelPosition).not.toBe('absolute')
        expect(metrics.labelWidth).toBeGreaterThan(1)
        expect(metrics.labelHeight).toBeGreaterThan(1)
        expect(metrics.inputTop - metrics.labelBottom).toBeCloseTo(Number.parseFloat(metrics.gap), 1)
        expect(metrics.labelTop).toBeGreaterThanOrEqual(metrics.wrapperTop)
        if (expectedGeometry === undefined) expectedGeometry = metrics
        else expect(metrics).toEqual(expectedGeometry)
      }
      defaultLabelGeometry.push(expectedGeometry)
    }
  }

  await page.evaluate(() => window.__baselineLayoutFixture.mountTextField({ hideLabel: true }))
  const input = page.getByRole('textbox', { name: 'Address and search' })
  await input.waitFor({ state: 'attached' })
  await page.evaluate(() => window.__baselineLayoutFixture.focusAddress())
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.id)).toBe('probe-address')

  await page.locator('#focus-origin').focus()
  await page.keyboard.press('Tab')
  expect(await input.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  const outline = await input.evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor }
  })
  expect(outline.style).not.toBe('none')
  expect(outline.width).toBeGreaterThan(0)
  expect(outline.color).not.toBe('rgba(0, 0, 0, 0)')

  await input.fill('typed address')
  await input.press('Enter')
  expect(await input.inputValue()).toBe('typed address')
  expect(await page.evaluate(() => window.__baselineLayoutFixture.events)).toEqual([
    { type: 'change', value: 'typed address' },
    { type: 'keydown', key: 'Enter' }
  ])
  expect(defaultLabelGeometry).toHaveLength(themes.length * widths.length)
})
