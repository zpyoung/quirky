import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../..')
const UI_MODULES = join(ROOT, 'plugins/quirky.editor/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(UI_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(UI_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(UI_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(UI_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(UI_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'tool-panel-header-layout-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] }),
    )
  },
}
const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-tool-panel-header-layout-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'esm',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The tool panel header browser bundle was empty.')
    browserBundle = await output.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

async function designSystemStyles(): Promise<string> {
  const [compatibilityTokens, tokens, components, icons, editorWindow, globalStyles, shell] = await Promise.all([
    Bun.file(new URL('../src/design-system/compatibility-tokens.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/components.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/icons/icons.css', import.meta.url)).text(),
    Bun.file(new URL('../src/design-system/editor-window.css', import.meta.url)).text(),
    Bun.file(new URL('../src/styles.css', import.meta.url)).text(),
    Bun.file(new URL('../src/shell/tool-shell.css', import.meta.url)).text(),
  ])
  const globalRules = globalStyles.replace(/^@import ['"][^'"]+['"];\s*/gm, '')
  return `${compatibilityTokens}\n${tokens}\n${components}\n${icons}\n${editorWindow}\n${globalRules}\n${shell}`
}

function browserEntry(): string {
  return `
    import { createElement, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ControlIcon, IconButton, Tabs, ToolPanelFrame } from '@quirky/ui'

    function TasksPanel() {
      const [activeTab, setActiveTab] = useState('issues')
      return createElement(ToolPanelFrame, {
        title: 'Tasks',
        tabs: createElement(Tabs, {
          label: 'Task views',
          items: [
            { id: 'issues', label: 'Issues' },
            { id: 'prs', label: 'PRs' },
            { id: 'projects', label: 'Projects' },
          ],
          value: activeTab,
          onChange: setActiveTab,
        }),
        actions: createElement(IconButton, { label: 'Tasks settings' }, createElement(ControlIcon, { name: 'gear' })),
        onMinimize: () => {},
      }, createElement('div', null, 'Task panel content'))
    }

    createRoot(document.getElementById('mount')).render(createElement(TasksPanel))
  `
}

function panelMarkup(width: number): string {
  return `<main data-theme="dark" style="position:relative;overflow:hidden;width:1054px;height:900px"><div id="mount" class="tool-shell__panel tool-shell__panel--left-bottom" data-tool-panel="tasks" style="left:0;top:0;width:${width}px;height:900px"></div></main>`
}

async function panelGeometry(page: Page) {
  return page.locator('.ui-tool-panel-frame__header').evaluate((header) => {
    const title = header.querySelector<HTMLElement>('.ui-tool-panel-frame__title')
    const tabsViewport = header.querySelector<HTMLElement>('.ui-tool-panel-frame__tabs')
    const actions = header.querySelector<HTMLElement>('.ui-tool-panel-frame__actions')
    if (!title || !tabsViewport || !actions) throw new Error('The Tasks panel header did not render.')
    const tabs = [...tabsViewport.querySelectorAll<HTMLElement>('[role="tab"]')]
    const rect = (element: Element) => {
      const { top, right, bottom, left, width, height } = element.getBoundingClientRect()
      return { top, right, bottom, left, width, height }
    }
    return {
      header: rect(header),
      title: { text: title.textContent?.trim() ?? '', clientWidth: title.clientWidth, scrollWidth: title.scrollWidth, ...rect(title) },
      tabsViewport: { clientWidth: tabsViewport.clientWidth, scrollWidth: tabsViewport.scrollWidth, ...rect(tabsViewport) },
      tabs: tabs.map((tab) => ({ text: tab.textContent?.trim() ?? '', ...rect(tab) })),
      actions: rect(actions),
      controls: [...actions.querySelectorAll<HTMLButtonElement>('button')].map((button) => ({
        label: button.getAttribute('aria-label') ?? '',
        ...rect(button),
      })),
    }
  })
}

function expectContained(inner: { top: number; right: number; bottom: number; left: number }, outer: { top: number; right: number; bottom: number; left: number }) {
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - 1)
  expect(inner.right).toBeLessThanOrEqual(outer.right + 1)
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 1)
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 1)
}

test.skipIf(!existsSync(executable))('Tasks title, tabs, and controls fit one header row at the default panel width', async () => {
  const page = await browser!.newPage({ viewport: { width: 1054, height: 900 } })
  try {
    await page.setContent(`<style>html,body{margin:0}</style><style>${await designSystemStyles()}</style>${panelMarkup(280)}`)
    await page.addScriptTag({ type: 'module', content: browserBundle })
    await page.waitForFunction(() => {
      const header = document.querySelector('.ui-tool-panel-frame__header')
      return header?.querySelectorAll('[role="tab"]').length === 3
        && header.querySelectorAll('.ui-tool-panel-frame__actions button').length === 2
    })

    const geometry = await panelGeometry(page)
    expect(geometry.header.width).toBeCloseTo(280, 0)
    expect(geometry.title.text).toBe('Tasks')
    expect(geometry.title.scrollWidth).toBeLessThanOrEqual(geometry.title.clientWidth + 0.5)
    expect(geometry.tabs.map((tab) => tab.text)).toEqual(['Issues', 'PRs', 'Projects'])
    expect(geometry.controls.map((control) => control.label)).toEqual(['Tasks settings', 'Minimize Tasks'])
    expect(geometry.controls.every((control) => control.width > 0 && control.height > 0)).toBe(true)
    expectContained(geometry.title, geometry.header)
    expectContained(geometry.tabsViewport, geometry.header)
    expectContained(geometry.actions, geometry.header)
    for (const control of geometry.controls) expectContained(control, geometry.actions)
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.tabsViewport.left + 1)
    expect(geometry.tabsViewport.right).toBeLessThanOrEqual(geometry.actions.left + 1)
    expect(geometry.controls[0]!.right).toBeLessThanOrEqual(geometry.controls[1]!.left + 1)

    const tabTops = geometry.tabs.map((tab) => tab.top)
    expect(Math.max(...tabTops) - Math.min(...tabTops)).toBeLessThanOrEqual(1)
    const titleCenter = (geometry.title.top + geometry.title.bottom) / 2
    for (const tab of geometry.tabs) {
      expect(tab.left).toBeGreaterThanOrEqual(geometry.tabsViewport.left - 1)
      expect(tab.right).toBeLessThanOrEqual(geometry.tabsViewport.right + 1)
      expect(Math.abs((tab.top + tab.bottom) / 2 - titleCenter)).toBeLessThanOrEqual(1)
    }

    await page.locator('#mount').evaluate((panel) => { panel.style.width = '160px' })
    const narrowGeometry = await panelGeometry(page)
    expect(narrowGeometry.tabs.map((tab) => tab.text)).toEqual(['Issues', 'PRs', 'Projects'])
    expect(narrowGeometry.tabs.every((tab) => tab.width > 0 && tab.height > 0)).toBe(true)
    await page.getByRole('tab', { name: 'Issues' }).focus()
    await page.keyboard.press('End')
    const narrowKeyboardState = await page.evaluate(() => ({
      focused: document.activeElement?.textContent?.trim() ?? '',
      selected: document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? '',
    }))
    expect(narrowKeyboardState).toEqual({ focused: 'Projects', selected: 'Projects' })
  } finally {
    await page.close()
  }
}, 60_000)
