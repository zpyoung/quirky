import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const UI_MODULES = join(ROOT, 'packages/ui/node_modules')
const COMPOSER_SOURCE = join(ROOT, 'plugins/quirky.terminal-dock/src/window/Composer.tsx')
const SETTINGS_SOURCE = join(ROOT, 'plugins/quirky.terminal-dock/src/window/Settings.tsx')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}

type Theme = 'dark' | 'light'
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type ComposerLayout = {
  composer: Rect
  notice: { text: string; padding: number[] } | null
  editorPadding: number[]
  overlayPadding: number[]
  footer: { rect: Rect; padding: number[] }
  options: { rect: Rect; scrollWidth: number; clientWidth: number; scrollLeft: number }
  buttons: Rect
  attach: Rect
  action: Rect
  attachDisabled: boolean
  actionDisabled: boolean
  selects: { id: string; labels: string[]; disabled: boolean }[]
}

type SettingsLayout = {
  rows: {
    label: string
    htmlFor: string
    inputId: string
    inputLabel: string
    disabled: boolean
    checked: boolean
    labelRect: Rect
    labelLineHeight: number
    controlRect: Rect
    badge: string
  }[]
}

type DockCall = { method: string; params: Record<string, unknown> }
type DockSettingsState = { enabled: boolean; autoOpen: boolean }
type DockBrowserFixture = {
  calls: DockCall[]
  mountComposer(host: HTMLElement, options: { enabled: boolean; draft: string }): void
  mountSettings(host: HTMLElement): void
  setAgentStatus(status: string): void
  getSettings(): DockSettingsState
  unmount(): void
}

declare global {
  interface Window {
    __dockFixture: DockBrowserFixture
  }
}

let browser: Browser | undefined
let browserBundle = ''
let styles = ''
let originalQuirkyHome: string | undefined
let temporaryQuirkyHome: string | undefined
let capturedQuirkyHome = false

async function cleanup(): Promise<void> {
  const launchedBrowser = browser
  browser = undefined
  try {
    await launchedBrowser?.close()
  } finally {
    if (temporaryQuirkyHome !== undefined) {
      rmSync(temporaryQuirkyHome, { recursive: true, force: true })
      temporaryQuirkyHome = undefined
    }
    if (capturedQuirkyHome) {
      if (originalQuirkyHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = originalQuirkyHome
      capturedQuirkyHome = false
    }
  }
}

beforeAll(async () => {
  originalQuirkyHome = process.env.QUIRKY_HOME
  capturedQuirkyHome = true
  temporaryQuirkyHome = mkdtempSync(join(tmpdir(), 'quirky-dock-baseline-'))
  process.env.QUIRKY_HOME = temporaryQuirkyHome
  try {
    const result = await Bun.build({
      entrypoints: ['dock-baseline-browser-fixture.tsx'],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The terminal dock browser bundle was empty.')
    browserBundle = await output.text()
    styles = await productionStyles()
    browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
  } catch (error) {
    await cleanup()
    throw error
  }
}, 60_000)

afterAll(async () => {
  await cleanup()
})

const browserDependencyResolver: Bun.BunPlugin = {
  name: 'terminal-dock-baseline-browser-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /dock-baseline-browser-fixture\.tsx$/ }, () => ({
      path: 'entry',
      namespace: 'dock-baseline-entry'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'dock-baseline-entry' }, () => ({
      contents: browserEntry(),
      loader: 'tsx',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
  }
}

function browserEntry(): string {
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Composer } from ${JSON.stringify(COMPOSER_SOURCE)}
    import { DockSettings } from ${JSON.stringify(SETTINGS_SOURCE)}

    let activeRoot = null
    let publishAgentStatus = () => {}
    let readSettings = () => ({ enabled: true, autoOpen: true })

    function dockState(enabled, draft) {
      return {
        pane: 'pane-a', session: 'session-a', tab: 'tab-a', revision: 1,
        enabled, supported: true, agent: 'claude', docked: true, userUndocked: false,
        gutterRows: 5, mounted: true, passthrough: false, draft, attachments: [],
        disabledReason: null, activeSend: null, queuedSends: [], question: null,
        options: {
          model: 'sonnet', effort: 'medium', permission: 'default',
          choices: {
            model: ['sonnet', 'opus'],
            effort: ['low', 'medium', 'high'],
            permission: ['default', 'acceptEdits']
          },
          context: { used: 25, limit: 100 }, notice: null
        },
        notice: null
      }
    }

    const fixture = {
      calls: [],
      mountComposer(host, options) {
        const calls = []
        const listeners = new Set()
        const state = dockState(options.enabled, options.draft)
        const context = {
          pluginId: 'quirky.terminal-dock',
          log() {},
          async call(method, params = {}) {
            calls.push({ method, params })
            if (method === 'quirky.terminal-dock/get') return state
            if (method === 'quirky.agent-status/get') return null
            return {}
          },
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          onConnection() { return () => {} },
          getSetting(name) { return readSettings()[name] },
          async executeCommand() {},
          readClipboardText: async () => '',
          nativeDropPaths: async () => null
        }
        publishAgentStatus = (status) => {
          for (const listener of listeners) {
            listener({ type: 'quirky.agent-status/changed', data: { sessionId: state.session, state: status } })
          }
        }
        readSettings = () => ({ enabled: true, autoOpen: true })
        fixture.calls = calls
        activeRoot = createRoot(host)
        activeRoot.render(h(Composer, {
          context, pane: state.pane, session: state.session, registerActions() {}
        }))
      },
      mountSettings(host) {
        const calls = []
        const listeners = new Set()
        const reported = { enabled: true, autoOpen: true }
        const context = {
          pluginId: 'quirky.terminal-dock',
          log() {},
          getSetting(name) { return reported[name] },
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          async call(method, params = {}) {
            calls.push({ method, params })
            if (method !== 'setting.set') return {}
            if (params.id === 'setting:quirky.terminal-dock/enabled' && params.value === true) {
              throw new Error('setting write failed')
            }
            const name = String(params.id).slice('setting:quirky.terminal-dock/'.length)
            reported[name] = params.value
            return {}
          }
        }
        publishAgentStatus = () => {}
        readSettings = () => ({ ...reported })
        fixture.calls = calls
        activeRoot = createRoot(host)
        activeRoot.render(h(DockSettings, { context }))
      },
      setAgentStatus(status) { publishAgentStatus(status) },
      getSettings() { return readSettings() },
      unmount() {
        activeRoot?.unmount()
        activeRoot = null
      }
    }

    window.__dockFixture = fixture
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

async function openFixture(theme: Theme, width: number, height: number): Promise<{ context: BrowserContext; page: Page }> {
  if (!browser) throw new Error('The terminal dock browser was not initialized.')
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"></head><body><div id="root"><div id="fixture-host" style="width:${width}px;height:${height}px"></div></div></body></html>`)
  await page.addStyleTag({ content: styles })
  await page.addScriptTag({ content: browserBundle })
  return { context, page }
}

async function closeFixture(context: BrowserContext, page: Page): Promise<void> {
  if (!page.isClosed()) await page.evaluate(() => window.__dockFixture?.unmount())
  await context.close()
}

async function readComposerLayout(page: Page, actionName: 'Send' | 'Stop'): Promise<ComposerLayout> {
  return page.evaluate((name) => {
    const required = <T extends Element>(element: T | null, label: string): T => {
      if (element === null) throw new Error(`Missing ${label}`)
      return element
    }
    const rect = (element: Element): Rect => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
    }
    const padding = (element: Element): number[] => {
      const style = getComputedStyle(element)
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(Number.parseFloat)
    }
    const composer = required(document.querySelector('.qtd-composer'), 'Composer')
    const notice = document.querySelector('.qtd-status-row .qtd-notice')
    const editor = required(document.querySelector('.qtd-editor'), 'editor')
    const overlay = required(document.querySelector('.qtd-editor-overlay'), 'editor overlay')
    const footer = required(document.querySelector('.qtd-actions'), 'footer')
    const options = required(document.querySelector('.qtd-action-controls'), 'options viewport')
    const buttons = required(document.querySelector('.qtd-action-buttons'), 'action buttons')
    const attach = required(document.querySelector('[aria-label="Attach file"]'), 'Attach button') as HTMLButtonElement
    const action = required(document.querySelector(`[aria-label="${name}"]`), `${name} button`) as HTMLButtonElement
    return {
      composer: rect(composer),
      notice: notice === null ? null : { text: notice.textContent?.trim() ?? '', padding: padding(notice) },
      editorPadding: padding(editor),
      overlayPadding: padding(overlay),
      footer: { rect: rect(footer), padding: padding(footer) },
      options: {
        rect: rect(options),
        scrollWidth: (options as HTMLElement).scrollWidth,
        clientWidth: (options as HTMLElement).clientWidth,
        scrollLeft: (options as HTMLElement).scrollLeft
      },
      buttons: rect(buttons),
      attach: rect(attach),
      action: rect(action),
      attachDisabled: attach.disabled,
      actionDisabled: action.disabled,
      selects: [...document.querySelectorAll<HTMLSelectElement>('.qtd-control-option select')].map((select) => ({
        id: select.id,
        labels: [...(select.labels ?? [])].map((label) => label.textContent?.trim() ?? ''),
        disabled: select.disabled
      }))
    }
  }, actionName)
}

function expectNear(actual: number, expected: number, tolerance = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function expectComposerGeometry(layout: ComposerLayout, height: number, width: number, enabled: boolean): void {
  expectNear(layout.composer.width, width)
  expectNear(layout.composer.height, height)
  expect(layout.editorPadding).toEqual([8, 12, 8, 12])
  expect(layout.overlayPadding).toEqual([8, 12, 8, 12])
  expect(layout.footer.padding).toEqual([4, 8, 4, 8])
  if (enabled) expect(layout.notice).toBeNull()
  else {
    expect(layout.notice?.text).toContain('Terminal dock is disabled')
    expect(layout.notice?.padding).toEqual([4, 8, 4, 8])
  }

  for (const button of [layout.attach, layout.action]) {
    expect(button.left).toBeGreaterThanOrEqual(layout.footer.rect.left)
    expect(button.right).toBeLessThanOrEqual(layout.footer.rect.right)
    expect(button.top).toBeGreaterThanOrEqual(layout.footer.rect.top)
    expect(button.bottom).toBeLessThanOrEqual(layout.footer.rect.bottom)
  }
  expectNear(layout.footer.rect.right - layout.buttons.right, 8)
  expectNear(layout.buttons.left - layout.options.rect.right, 8)
  expect(layout.options.clientWidth).toBeGreaterThan(0)
  expect(layout.options.scrollWidth).toBeGreaterThanOrEqual(layout.options.clientWidth)
  expect(layout.attachDisabled).toBe(!enabled)
  expect(layout.actionDisabled).toBe(!enabled)
  expect(layout.selects.map((select) => select.labels)).toEqual([['Model'], ['Effort'], ['Permission']])
  expect(layout.selects.every((select) => select.id !== '')).toBe(true)
  expect(layout.selects.map((select) => select.disabled)).toEqual([!enabled, !enabled, !enabled])
}

async function waitForComposerState(page: Page, enabled: boolean): Promise<void> {
  await page.waitForFunction((isEnabled) => {
    const notice = document.querySelector('.qtd-status-row .qtd-notice')
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.qtd-control-option select')]
    const send = document.querySelector<HTMLButtonElement>('[aria-label="Send"]')
    return selects.length === 3 && selects.every((select) => select.disabled === !isEnabled) &&
      (isEnabled
        ? send !== null && !send.disabled
        : notice?.textContent?.includes('Terminal dock is disabled') === true)
  }, enabled)
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1000, 320]) {
    for (const height of [300, 120]) {
      test(`preserves ${theme} Composer geometry at ${width}×${height}px`, async () => {
        const { context, page } = await openFixture(theme, width, height)
        try {
          await page.evaluate(() => window.__dockFixture.mountComposer(
            document.querySelector<HTMLElement>('#fixture-host')!,
            { enabled: false, draft: 'A draft remains visible while the dock is disabled.' }
          ))
          await waitForComposerState(page, false)
          const disabled = await readComposerLayout(page, 'Send')
          expectComposerGeometry(disabled, height, width, false)

          await page.evaluate(() => window.__dockFixture.unmount())
          await page.evaluate(() => document.querySelector('#fixture-host')!.replaceChildren())
          await page.evaluate(() => window.__dockFixture.mountComposer(
            document.querySelector<HTMLElement>('#fixture-host')!,
            { enabled: true, draft: 'A ready-to-send prompt.' }
          ))
          await waitForComposerState(page, true)
          const send = await readComposerLayout(page, 'Send')
          expectComposerGeometry(send, height, width, true)

          if (width === 320) {
            expect(send.options.scrollWidth).toBeGreaterThan(send.options.clientWidth)
            await page.evaluate(() => {
              const options = document.querySelector<HTMLElement>('.qtd-action-controls')!
              options.scrollLeft = options.scrollWidth
            })
            const scrolled = await readComposerLayout(page, 'Send')
            expect(scrolled.options.scrollLeft).toBeGreaterThan(0)
            expect(scrolled.buttons).toEqual(send.buttons)
            expectComposerGeometry(scrolled, height, width, true)
          }

          await page.evaluate(() => window.__dockFixture.setAgentStatus('working'))
          await page.waitForFunction(() => document.querySelector('[aria-label="Stop"]') !== null && document.querySelector('[aria-label="Send"]') === null)
          const stop = await readComposerLayout(page, 'Stop')
          expectComposerGeometry(stop, height, width, true)
        } finally {
          await closeFixture(context, page)
        }
      })
    }
  }
}

async function readSettingsLayout(page: Page): Promise<SettingsLayout> {
  return page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
    }
    return {
      rows: [...document.querySelectorAll<HTMLElement>('.qtd-settings .ui-form-row')].map((row) => {
        const label = row.querySelector<HTMLLabelElement>('.ui-form-row__label')!
        const control = row.querySelector<HTMLElement>('.ui-form-row__control')!
        const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
        const badge = row.querySelector<HTMLElement>('.ui-badge')!
        return {
          label: label.textContent?.trim() ?? '',
          htmlFor: label.htmlFor,
          inputId: input.id,
          inputLabel: input.getAttribute('aria-label') ?? '',
          disabled: input.disabled,
          checked: input.checked,
          labelRect: rect(label),
          labelLineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
          controlRect: rect(control),
          badge: badge.textContent?.trim() ?? ''
        }
      })
    }
  })
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1000, 320]) {
    test(`preserves ${theme} Dock settings labels at ${width}px and rolls back rejected saves`, async () => {
      const { context, page } = await openFixture(theme, width, 900)
      try {
        await page.evaluate(() => window.__dockFixture.mountSettings(document.querySelector<HTMLElement>('#fixture-host')!))
        await page.waitForSelector('.qtd-settings .ui-form-row')
        const initial = await readSettingsLayout(page)
        expect(initial.rows.map((row) => row.label)).toEqual(['Terminal dock', 'Open automatically for recognized agents'])
        expect(initial.rows.map((row) => row.htmlFor)).toEqual(['qtd-dock-enabled', 'qtd-dock-auto-open'])
        expect(initial.rows.map((row) => row.inputId)).toEqual(['qtd-dock-enabled', 'qtd-dock-auto-open'])
        expect(initial.rows.map((row) => row.inputLabel)).toEqual([
          'Terminal dock (Experimental)',
          'Open automatically for recognized agents (Experimental)'
        ])
        expect(initial.rows.map((row) => row.badge)).toEqual(['Experimental', 'Experimental'])
        expect(initial.rows.every((row) => !row.disabled && row.checked)).toBe(true)
        expect(initial.rows.every((row) => row.labelRect.right <= row.controlRect.left)).toBe(true)
        if (width === 320) expect(initial.rows[1]!.labelRect.height).toBeGreaterThan(initial.rows[1]!.labelLineHeight + 1)

        await page.locator('#qtd-dock-enabled').click()
        await page.waitForFunction(() => {
          const enabled = document.querySelector<HTMLInputElement>('#qtd-dock-enabled')
          const autoOpen = document.querySelector<HTMLInputElement>('#qtd-dock-auto-open')
          return enabled !== null && !enabled.checked && autoOpen !== null && autoOpen.disabled
        })
        expect(await page.evaluate(() => window.__dockFixture.getSettings())).toEqual({ enabled: false, autoOpen: true })

        await page.locator('#qtd-dock-enabled').click()
        await page.waitForFunction(() => {
          const enabled = document.querySelector<HTMLInputElement>('#qtd-dock-enabled')
          const error = document.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
          return enabled !== null && !enabled.checked && error?.textContent?.includes('Could not save Terminal dock settings: setting write failed') === true
        })
        expect(await page.evaluate(() => window.__dockFixture.getSettings())).toEqual({ enabled: false, autoOpen: true })
        expect(await page.locator('.ui-inline-error[role="alert"]').textContent()).toBe('Could not save Terminal dock settings: setting write failed')
        expect(await readSettingsLayout(page)).toMatchObject({
          rows: [
            { inputId: 'qtd-dock-enabled', disabled: false, checked: false },
            { inputId: 'qtd-dock-auto-open', disabled: true, checked: true }
          ]
        })
        expect(await page.evaluate(() => window.__dockFixture.calls.filter((call) => call.method === 'setting.set'))).toEqual([
          { method: 'setting.set', params: { id: 'setting:quirky.terminal-dock/enabled', value: false } },
          { method: 'setting.set', params: { id: 'setting:quirky.terminal-dock/enabled', value: true } }
        ])
      } finally {
        await closeFixture(context, page)
      }
    })
  }
}
