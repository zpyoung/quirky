import { afterAll, beforeAll, expect, test } from 'bun:test'
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
const NOTIFICATIONS_VIEW = join(ROOT, 'plugins/quirky.notifications/src/window/NotificationsView.tsx')
const NOTIFICATIONS_MODEL = join(ROOT, 'plugins/quirky.notifications/src/window/model.ts')
const executable = browserExecutable()

const switches = [
  { name: 'enabled', label: 'Enable Notifications', description: 'Native system notifications for background events.', checked: true },
  { name: 'agentTaskComplete', label: 'Agent Task Complete', description: 'A coding agent finishes or needs input.', checked: true },
  { name: 'terminalBell', label: 'Terminal Bell', description: 'A background terminal emits a bell character.', checked: false },
  { name: 'terminalNotifications', label: 'Terminal Notifications', description: 'A terminal program sends a notification (OSC 9, 99 or 777).', checked: true },
  { name: 'suppressWhenFocused', label: 'Suppress While Focused', description: 'Skip notifications when the triggering worktree is already visible.', checked: true },
  { name: 'showMenuBarIcon', label: 'Show Menu Bar Icon', description: 'Keep a Quirky shortcut and activity indicator in the macOS menu bar.', checked: true }
] as const

const themes = [
  { name: 'dark', muted: 'rgb(124, 130, 141)', text: 'rgb(236, 238, 242)' },
  { name: 'light', muted: 'rgb(128, 134, 143)', text: 'rgb(27, 29, 34)' }
] as const
const widths = [1000, 700, 320] as const

declare global {
  interface Window {
    __notificationsFixture?: {
      calls: { method: string; params: Record<string, unknown> }[]
      settings: Record<string, boolean | number | string>
      unmount(): void
    }
  }
}

const browserDependencyResolver: Bun.BunPlugin = {
  name: 'notifications-baseline-browser-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /notifications-baseline-fixture\.ts$/ }, () => ({
      path: 'entry',
      namespace: 'notifications-entry'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'notifications-entry' }, () => ({
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
let styles = ''

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'notifications-baseline-fixture.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Notifications browser bundle was empty.')
  browserBundle = await output.text()
  styles = await productionStyles()
  browser = await chromium.launch({ headless: true, executablePath: executable })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 30_000)

test('Notifications switch helpers retain muted colors and switch descriptions in both themes', async () => {
  const { page, pageErrors, requests } = await openNotificationsPage('dark', 1000)
  try {
    for (const theme of themes) {
      await page.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme.name)
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 })
        const result = await page.evaluate((expectedSwitches) => {
          const root = document.getElementById('notifications-root')!
          const tokenColor = (token: '--ui-muted' | '--ui-text') => {
            const probe = document.createElement('span')
            probe.style.color = `var(${token})`
            document.body.append(probe)
            const color = getComputedStyle(probe).color
            probe.remove()
            return color
          }
          const rows = expectedSwitches.map((expected) => {
            const row = root.querySelector(`[data-setting="${expected.name}"]`)
            const input = row?.querySelector<HTMLInputElement>('input[role="switch"]') ?? null
            const label = row?.querySelector<HTMLLabelElement>('.ui-form-row__label') ?? null
            const describedBy = input?.getAttribute('aria-describedby') ?? ''
            const helper = describedBy ? document.getElementById(describedBy) : null
            return {
              name: row?.getAttribute('data-setting') ?? null,
              label: label?.textContent?.trim() ?? null,
              labelFor: label?.htmlFor ?? null,
              labelColor: label ? getComputedStyle(label).color : null,
              inputId: input?.id ?? null,
              inputIdCount: input ? [...document.querySelectorAll('[id]')].filter((node) => node.id === input.id).length : 0,
              inputType: input?.type ?? null,
              role: input?.getAttribute('role') ?? null,
              ariaLabel: input?.getAttribute('aria-label') ?? null,
              ariaChecked: input?.getAttribute('aria-checked') ?? null,
              checked: input?.checked ?? null,
              describedBy,
              helperId: helper?.id ?? null,
              helperText: helper?.textContent?.trim() ?? null,
              helperColor: helper ? getComputedStyle(helper).color : null,
              helperResolves: Boolean(input && helper && helper.id === describedBy && document.getElementById(describedBy) === helper)
            }
          })
          return {
            width: root.getBoundingClientRect().width,
            switchCount: root.querySelectorAll('[role="switch"]').length,
            mutedToken: tokenColor('--ui-muted'),
            textToken: tokenColor('--ui-text'),
            rows
          }
        }, switches)

        expect(result.width).toBe(width)
        expect(result.switchCount).toBe(switches.length)
        expect(result.mutedToken).toBe(theme.muted)
        expect(result.textToken).toBe(theme.text)
        expect(result.rows).toHaveLength(switches.length)
        for (const [index, actual] of result.rows.entries()) {
          const expected = switches[index]!
          expect(actual.name).toBe(expected.name)
          expect(actual.label).toBe(expected.label)
          expect(actual.labelFor).toBeTruthy()
          expect(actual.labelFor).toBe(actual.inputId)
          expect(actual.inputIdCount).toBe(1)
          expect(actual.inputType).toBe('checkbox')
          expect(actual.role).toBe('switch')
          expect(actual.ariaLabel).toBe(expected.label)
          expect(actual.ariaChecked).toBe(String(expected.checked))
          expect(actual.checked).toBe(expected.checked)
          expect(actual.describedBy).toBe(`${actual.inputId}-help`)
          expect(actual.helperId).toBe(actual.describedBy)
          expect(actual.helperText).toBe(expected.description)
          expect(actual.helperResolves).toBe(true)
          expect(actual.helperColor).toBe(result.mutedToken)
          expect(actual.labelColor).toBe(result.textToken)
        }
      }
    }
    expect(await page.evaluate(() => window.__notificationsFixture?.calls)).toEqual([])
  } finally {
    await closePage(page, pageErrors, requests)
  }
}, 60_000)

test('turning Notifications off and on persists through its setting.set route', async () => {
  const { page, pageErrors, requests } = await openNotificationsPage('dark', 1000)
  try {
    const enabled = page.getByRole('switch', { name: 'Enable Notifications' })
    await enabled.click()
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('#notifications-root [data-setting="enabled"] [role="switch"]')
      return input?.checked === false && input.getAttribute('aria-checked') === 'false'
    })
    expect(await page.evaluate(() => window.__notificationsFixture?.calls)).toEqual([
      { method: 'setting.set', params: { id: 'setting:quirky.notifications/enabled', value: false } }
    ])
    expect(await page.evaluate(() => window.__notificationsFixture?.settings.enabled)).toBe(false)

    await enabled.click()
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLInputElement>('#notifications-root [data-setting="enabled"] [role="switch"]')
      return input?.checked === true && input.getAttribute('aria-checked') === 'true'
    })
    expect(await page.evaluate(() => window.__notificationsFixture?.calls)).toEqual([
      { method: 'setting.set', params: { id: 'setting:quirky.notifications/enabled', value: false } },
      { method: 'setting.set', params: { id: 'setting:quirky.notifications/enabled', value: true } }
    ])
    expect(await page.evaluate(() => window.__notificationsFixture?.settings.enabled)).toBe(true)
  } finally {
    await closePage(page, pageErrors, requests)
  }
}, 60_000)

async function openNotificationsPage(theme: 'dark' | 'light', width: number): Promise<{
  page: Page
  pageErrors: string[]
  requests: string[]
}> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const pageErrors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`))
  try {
    await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="notifications-root" class="plugin-slot-body" style="width:100vw;height:900px"></div></body></html>`)
    await page.addScriptTag({ content: browserBundle })
    await page.waitForSelector('#notifications-root [role="switch"]')
    return { page, pageErrors, requests }
  } catch (error) {
    await page.close()
    throw error
  }
}

async function closePage(page: Page, pageErrors: string[], requests: string[]): Promise<void> {
  try {
    await page.evaluate(() => window.__notificationsFixture?.unmount())
  } finally {
    await page.close()
  }
  expect(pageErrors).toEqual([])
  expect(requests).toEqual([])
}

function browserEntry(): string {
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { NotificationsView } from ${JSON.stringify(NOTIFICATIONS_VIEW)}
    import { NotificationsStore } from ${JSON.stringify(NOTIFICATIONS_MODEL)}

    const settings = {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      terminalNotifications: true,
      sound: 'system',
      customSoundPath: '',
      volume: 100,
      suppressWhenFocused: true,
      showMenuBarIcon: true
    }
    const listeners = new Set()
    const calls = []
    const toasts = []
    const context = {
      pluginId: 'quirky.notifications',
      log() {},
      async call(method, params = {}) {
        calls.push({ method, params: { ...params } })
        if (method !== 'setting.set') throw new Error('Unexpected Notifications API call: ' + method)
        const id = params.id
        const value = params.value
        const prefix = 'setting:quirky.notifications/'
        if (typeof id !== 'string' || !id.startsWith(prefix)) throw new Error('Unexpected Notifications setting route: ' + String(id))
        const name = id.slice(prefix.length)
        if (!Object.prototype.hasOwnProperty.call(settings, name)) throw new Error('Undeclared Notifications setting: ' + name)
        if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid Notifications setting value')
        settings[name] = value
        for (const listener of [...listeners]) listener({ type: 'setting.changed', id, value })
        return {}
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSetting(name) {
        if (!Object.prototype.hasOwnProperty.call(settings, name)) throw new Error('Undeclared Notifications setting: ' + name)
        return settings[name]
      },
      toast(title, body) {
        toasts.push({ title, body })
      }
    }
    const store = new NotificationsStore(context, () => {})
    store.start()
    const root = createRoot(document.getElementById('notifications-root'))
    window.__notificationsFixture = {
      calls,
      settings,
      unmount() {
        root.unmount()
        store.stop()
      }
    }
    root.render(h(NotificationsView, { store }))
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
