import { afterAll, beforeAll, expect, test } from 'bun:test'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.agent-status/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'agent-status-activity-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s);]+))\s*\)?([^;]*);/g
const SURFACES = ['sidebar', 'center'] as const
const WIDTH_CASES = [
  { sidebar: 160, center: 240 },
  { sidebar: 160, center: 680 },
  { sidebar: 240, center: 240 },
  { sidebar: 240, center: 680 }
] as const
const FIXTURE_THREADS = [
  {
    sessionId: 's-audit',
    worktreeId: 'wt2',
    worktreeName: 'feature',
    sessionName: 'Audit session',
    agent: 'codex',
    turn: 'turn-2',
    turnStartedAt: 20,
    updatedAt: 30,
    display: 'working',
    label: 'Working',
    prompt: 'audit filter behavior',
    detail: 'Review shared filters',
    children: [],
    unread: true,
    live: true
  },
  {
    sessionId: 's-done',
    worktreeId: 'wt1',
    worktreeName: 'main',
    sessionName: 'Finished session',
    agent: 'claude',
    turn: 'turn-1',
    turnStartedAt: 10,
    updatedAt: 15,
    display: 'done',
    label: 'Done',
    prompt: 'completed an old task',
    detail: 'Finished',
    children: [],
    unread: false,
    live: false
  }
]

type Surface = (typeof SURFACES)[number]
type ActivityCall = { method: string; params: Record<string, unknown> }
type OpenedView = { id: string; input?: unknown }
type ActivityHarness = { calls: ActivityCall[]; opened: OpenedView[] }
type BrowserTestState = Record<Surface, ActivityHarness>
declare global { interface Window { __activityTest: BrowserTestState } }

let executable: string | null = null
let browser: Browser | null = null
let browserBundle = ''
let productionCss = ''

function inlineStylesheet(path: string, active = new Set<string>()): string {
  const absolute = resolve(path)
  if (active.has(absolute)) throw new Error(`Cyclic stylesheet import: ${absolute}`)
  active.add(absolute)
  const source = readFileSync(absolute, 'utf8')
  const expanded = source.replace(CSS_IMPORT, (statement, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined, suffix: string) => {
    const importedPath = doubleQuoted ?? singleQuoted ?? bare
    if (!importedPath || /^(?:[a-z]+:|\/\/)/i.test(importedPath)) return statement
    const imported = inlineStylesheet(resolve(dirname(absolute), importedPath), active)
    const media = suffix.trim()
    return media ? `@media ${media} {\n${imported}\n}` : imported
  })
  active.delete(absolute)
  return expanded
}

function browserEntry(): string {
  const activityView = join(ROOT, 'plugins/quirky.agent-status/src/ActivityView.tsx')
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ToolPanelFrame } from '@quirky/ui'
    import { ActivitySidebarView, ActivityView } from ${JSON.stringify(activityView)}

    const fixtureThreads = ${JSON.stringify(FIXTURE_THREADS)}
    function makeContext(record) {
      return {
        async call(method, params = {}) {
          const query = JSON.parse(JSON.stringify(params))
          record.calls.push({ method, params: query })
          if (method === 'quirky.agent-status/activity') {
            const text = typeof query.text === 'string' ? query.text.toLocaleLowerCase() : ''
            const threads = fixtureThreads
              .filter((thread) => !query.worktree || thread.worktreeId === query.worktree)
              .filter((thread) => !query.unreadOnly || thread.unread)
              .filter((thread) => !text || [thread.prompt, thread.agent, thread.worktreeName, thread.sessionName].some((value) => value.toLocaleLowerCase().includes(text)))
              .map((thread) => ({ ...thread, children: [...thread.children] }))
            return { threads }
          }
          if (method === 'quirky.agent-status/acknowledge') return { acknowledged: 1 }
          if (method === 'quirky.agent-status/clearCompleted') return { cleared: 1 }
          throw new Error('Unexpected browser context call: ' + method)
        },
        subscribe() { return () => {} },
        onConnection() { return () => {} },
        openView(id, input) { record.opened.push({ id, input: JSON.parse(JSON.stringify(input)) }) },
        async executeCommand() {},
        toast() {}
      }
    }

    const sidebarState = { calls: [], opened: [] }
    const centerState = { calls: [], opened: [] }
    window.__activityTest = { sidebar: sidebarState, center: centerState }
    const sidebarRoot = createRoot(document.getElementById('sidebar-mount'), { identifierPrefix: 'quirky-agent-status-activity-sidebar-' })
    sidebarRoot.render(h(ToolPanelFrame, { title: 'Sidebar host frame' }, h(ActivitySidebarView, { context: makeContext(sidebarState) })))
    const centerRoot = createRoot(document.getElementById('center-mount'), { identifierPrefix: 'quirky-agent-status-activity-view-' })
    centerRoot.render(h(ToolPanelFrame, { title: 'Center host frame' }, h(ActivityView, { context: makeContext(centerState), input: { group: 'status' } })))
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          html, body { height: 100%; margin: 0; min-width: 0; min-height: 0; }
          #mounts { align-items: stretch; display: flex; gap: 16px; height: 780px; min-width: 0; width: max-content; }
          .surface-mount { display: flex; flex: 0 0 auto; flex-direction: column; height: 780px; min-height: 0; min-width: 0; }
        </style>
      </head>
      <body>
        <div id="mounts">
          <div id="sidebar-mount" class="surface-mount" style="width: 160px"></div>
          <div id="center-mount" class="surface-mount" style="width: 240px"></div>
        </div>
      </body>
    </html>`
}

async function openFixture(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport: { width: 1200, height: 900 } })
  try {
    const page = await context.newPage()
    await page.setContent(pageMarkup())
    await page.addStyleTag({ content: productionCss })
    await page.addScriptTag({ content: browserBundle })
    await page.waitForFunction(() => {
      const state = (window as Window & { __activityTest?: BrowserTestState }).__activityTest
      if (!state || !state.sidebar.calls.some((call) => call.method === 'quirky.agent-status/activity') || !state.center.calls.some((call) => call.method === 'quirky.agent-status/activity')) return false
      return ['sidebar-mount', 'center-mount'].every((id) => {
        const mount = document.getElementById(id)
        return mount?.querySelectorAll('.ui-tool-panel-frame').length === 1
          && mount.querySelectorAll('button[aria-label="Mark all read"]').length === 1
          && mount.querySelectorAll('button[aria-label="Clear completed activity"]').length === 1
          && mount.querySelector('[data-session-id="s-audit"]') !== null
      })
    })
    return { context, page }
  } catch (cause) {
    await context.close()
    throw cause
  }
}

async function setWidths(page: Page, widths: { sidebar: number; center: number }): Promise<void> {
  await page.evaluate((value) => {
    for (const surface of ['sidebar', 'center'] as const) {
      const mount = document.getElementById(surface + '-mount')!
      mount.style.width = `${value[surface]}px`
      mount.style.flexBasis = `${value[surface]}px`
    }
  }, widths)
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme)
}

async function activityCalls(page: Page, surface: Surface): Promise<Record<string, unknown>[]> {
  return page.evaluate((name) => {
    const state = window.__activityTest[name]
    return state.calls.filter((call) => call.method === 'quirky.agent-status/activity').map((call) => call.params)
  }, surface)
}

async function openedViews(page: Page, surface: Surface): Promise<OpenedView[]> {
  return page.evaluate((name) => window.__activityTest[name].opened, surface)
}

async function waitForActivityCalls(page: Page, surface: Surface, count: number): Promise<void> {
  await page.waitForFunction((expected) => {
    const state = (window as Window & { __activityTest?: BrowserTestState }).__activityTest?.[expected.surface]
    return (state?.calls.filter((call) => call.method === 'quirky.agent-status/activity').length ?? 0) >= expected.count
  }, { surface, count })
}

function mount(page: Page, surface: Surface) {
  return page.locator(`#${surface}-mount`)
}

function expectWithin(actual: number, expected: number, tolerance = 0.5): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

beforeAll(async () => {
  executable = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].find((path) => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  }) ?? null
  if (!executable) throw new Error('Activity layout browser tests require an installed Chromium-family executable.')

  productionCss = inlineStylesheet(join(ROOT, 'packages/ui/src/styles.css'))
  const directory = mkdtempSync(join(tmpdir(), 'quirky-agent-status-activity-layout-'))
  try {
    const entrypoint = join(directory, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The Activity layout browser bundle was empty.')
    browserBundle = await output.text()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  browser = await chromium.launch({ executablePath: executable, headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

test('renders one shared implicitly labelled Checkbox on each simultaneous Activity surface', async () => {
  const { context, page } = await openFixture()
  try {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme)
      for (const widths of WIDTH_CASES) {
        await setWidths(page, widths)
        for (const surface of SURFACES) {
          const panel = mount(page, surface)
          const checkbox = panel.locator('.ui-checkbox')
          const input = panel.locator('.ui-checkbox__input')
          const text = panel.locator('.ui-checkbox__text')
          expect(await checkbox.count()).toBe(1)
          expect(await input.count()).toBe(1)
          expect(await text.count()).toBe(1)
          expect(await panel.locator('.ui-form-row .ui-checkbox').count()).toBe(0)
          expect(await panel.getByRole('checkbox', { name: 'Unread only', exact: true }).count()).toBe(1)
          expect(await checkbox.isVisible()).toBe(true)
          expect(await text.isVisible()).toBe(true)

          const geometry = await checkbox.evaluate((label) => {
            const control = label.querySelector<HTMLInputElement>('.ui-checkbox__input')!
            const textElement = label.querySelector<HTMLElement>('.ui-checkbox__text')!
            const range = document.createRange()
            range.selectNodeContents(textElement)
            const textRect = range.getBoundingClientRect()
            const inputRect = control.getBoundingClientRect()
            return {
              type: control.type,
              width: inputRect.width,
              height: inputRect.height,
              gap: getComputedStyle(label).columnGap,
              inputCenter: inputRect.top + inputRect.height / 2,
              textCenter: textRect.top + textRect.height / 2
            }
          })
          expect(geometry.type).toBe('checkbox')
          expectWithin(geometry.width, 14)
          expectWithin(geometry.height, 14)
          expect(geometry.gap).toBe('6px')
          expect(Math.abs(geometry.inputCenter - geometry.textCenter)).toBeLessThan(1)
        }
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test('uses one shared SelectField with its native appearance and Activity accessible name', async () => {
  const { context, page } = await openFixture()
  try {
    for (const surface of SURFACES) {
      const panel = mount(page, surface)
      const group = panel.getByRole('combobox', { name: 'Group Activity by', exact: true })
      expect(await group.count()).toBe(1)
      expect(await panel.locator('.ui-select-field').count()).toBe(1)
      expect(await panel.locator('.ui-text-field').count()).toBe(surface === 'sidebar' ? 2 : 3)
      expect(await group.evaluate((select) => select.classList.contains('ui-select-field') && select.parentElement?.classList.contains('ui-text-field'))).toBe(true)
      expect(await panel.locator('label').evaluateAll((labels) => labels.filter((label) => label.textContent?.trim() === 'Group by').length)).toBe(1)
      const options = await group.locator('option').evaluateAll((items) => items.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() })))
      expect(options).toEqual([
        { value: 'status', text: 'Status' },
        { value: 'worktree', text: 'Workspace' },
        { value: 'provider', text: 'Provider' },
        { value: 'none', text: 'No groups' }
      ])
      expect(await group.evaluate((select) => getComputedStyle(select).appearance)).toBe('auto')
    }
  } finally {
    await context.close()
  }
}, 60_000)

test('keeps every visible filter label associated with a unique control on its own surface', async () => {
  const { context, page } = await openFixture()
  try {
    for (const surface of SURFACES) {
      const panel = mount(page, surface)
      const associations = await panel.evaluate((element) => {
        const form = element.querySelector('form')!
        const labels = [...form.querySelectorAll<HTMLLabelElement>('label')]
        return {
          formCount: element.querySelectorAll('form').length,
          labels: labels.map((label) => {
            const control = label.control
            const explicit = Boolean(label.htmlFor)
            const target = explicit ? document.getElementById(label.htmlFor) : control
            return {
              text: label.textContent?.trim(),
              explicit,
              associated: control !== null && control === target && form.contains(control),
              implicitContainsControl: explicit || (control !== null && label.contains(control))
            }
          }),
          uniqueControls: new Set(labels.map((label) => label.control)).size
        }
      })
      const expectedLabels = surface === 'sidebar'
        ? ['Search Activity', 'Unread only', 'Group by']
        : ['Search Activity', 'Worktree ID', 'Unread only', 'Group by']
      expect(associations.formCount).toBe(1)
      expect(associations.labels.map((label) => label.text)).toEqual(expectedLabels)
      expect(associations.labels.every((label) => label.associated && label.implicitContainsControl)).toBe(true)
      expect(associations.uniqueControls).toBe(expectedLabels.length)
      expect(await panel.getByRole('searchbox', { name: 'Search Activity', exact: true }).count()).toBe(1)
      expect(await panel.getByRole('searchbox', { name: 'Worktree ID', exact: true }).count()).toBe(surface === 'sidebar' ? 0 : 1)
      expect(await panel.getByRole('checkbox', { name: 'Unread only', exact: true }).count()).toBe(1)
      expect(await panel.getByRole('combobox', { name: 'Group Activity by', exact: true }).count()).toBe(1)
    }
    const duplicateIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id)
      return ids.filter((id, index) => ids.indexOf(id) !== index)
    })
    expect(duplicateIds).toEqual([])
  } finally {
    await context.close()
  }
}, 60_000)

test('keeps search and group labels aligned and every filter inside narrow and wide forms', async () => {
  const { context, page } = await openFixture()
  try {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme)
      for (const widths of WIDTH_CASES) {
        await setWidths(page, widths)
        const results = await page.evaluate(() => ['sidebar', 'center'].map((surface) => {
          const mount = document.getElementById(surface + '-mount')!
          const form = mount.querySelector('form')!
          const findLabel = (name: string) => [...form.querySelectorAll<HTMLLabelElement>('.ui-text-field__label')]
            .find((label) => label.textContent?.trim() === name)!
          const textBounds = (label: HTMLLabelElement) => {
            const range = document.createRange()
            range.selectNodeContents(label)
            const rect = range.getBoundingClientRect()
            return { left: rect.left, right: rect.right }
          }
          const formRect = form.getBoundingClientRect()
          return {
            surface,
            scrollWidth: form.scrollWidth,
            clientWidth: form.clientWidth,
            searchLabel: textBounds(findLabel('Search Activity')),
            groupLabel: textBounds(findLabel('Group by')),
            form: { left: formRect.left, right: formRect.right },
            controls: [...form.querySelectorAll<HTMLElement>('input, select, button')].map((control) => {
              const rect = control.getBoundingClientRect()
              return { left: rect.left, right: rect.right }
            })
          }
        }))
        for (const result of results) {
          expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth + 1)
          expect(Math.abs(result.searchLabel.left - result.groupLabel.left)).toBeLessThanOrEqual(1)
          expect(result.controls.length).toBe(result.surface === 'sidebar' ? 4 : 5)
          for (const control of result.controls) {
            expect(control.left).toBeGreaterThanOrEqual(result.form.left - 0.5)
            expect(control.right).toBeLessThanOrEqual(result.form.right + 0.5)
          }
        }
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test('preserves Activity rail portals, icon geometry, theme treatment, and unread badge padding', async () => {
  const { context, page } = await openFixture()
  try {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme)
      await setWidths(page, { sidebar: 160, center: 680 })
      const metrics = await page.evaluate(() => ['sidebar', 'center'].map((surface) => {
        const mount = document.getElementById(surface + '-mount')!
        const frames = [...mount.querySelectorAll<HTMLElement>('.ui-tool-panel-frame')]
        const frame = frames[0]!
        const rail = frame.querySelector<HTMLElement>(':scope > .ui-tool-panel-frame__rail')!
        const buttons = [...rail.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
        const badge = mount.querySelector<HTMLElement>('.ui-badge[aria-label="Unread"]')!
        const badgeStyle = getComputedStyle(badge)
        return {
          surface,
          frameCount: frames.length,
          railDirection: getComputedStyle(rail).flexDirection,
          badgePadding: [badgeStyle.paddingTop, badgeStyle.paddingRight, badgeStyle.paddingBottom, badgeStyle.paddingLeft],
          actions: buttons.map((button) => {
            const rect = button.getBoundingClientRect()
            const frameRect = button.closest('.ui-tool-panel-frame')
            const glyph = button.querySelector<SVGElement>('.ui-control-icon')!
            const glyphRect = glyph.getBoundingClientRect()
            return {
              name: button.getAttribute('aria-label'),
              buttonClass: button.classList.contains('ui-icon-button'),
              glyphClass: glyph.classList.contains('ui-control-icon'),
              inNearestFrameRail: frameRect === frame && button.closest('.ui-tool-panel-frame__rail') === rail,
              width: rect.width,
              height: rect.height,
              glyphWidth: glyphRect.width,
              glyphHeight: glyphRect.height,
              centerX: rect.left + rect.width / 2,
              centerY: rect.top + rect.height / 2,
              glyphCenterX: glyphRect.left + glyphRect.width / 2,
              glyphCenterY: glyphRect.top + glyphRect.height / 2
            }
          })
        }
      }))

      for (const result of metrics) {
        expect(result.frameCount).toBe(1)
        expect(result.railDirection).toBe(result.surface === 'sidebar' ? 'row' : 'column')
        expect(result.badgePadding).toEqual(['2px', '4px', '2px', '4px'])
        expect(result.actions.map((action) => action.name)).toEqual(['Mark all read', 'Clear completed activity'])
        for (const action of result.actions) {
          expect(action.buttonClass).toBe(true)
          expect(action.glyphClass).toBe(true)
          expect(action.inNearestFrameRail).toBe(true)
          expectWithin(action.width, 26)
          expectWithin(action.height, 26)
          expectWithin(action.glyphWidth, 16)
          expectWithin(action.glyphHeight, 16)
          expectWithin(action.centerX, action.glyphCenterX)
          expectWithin(action.centerY, action.glyphCenterY)
        }
      }

      for (const surface of SURFACES) {
        const panel = mount(page, surface)
        for (const name of ['Mark all read', 'Clear completed activity']) {
          const button = panel.getByRole('button', { name, exact: true })
          expect(await button.isEnabled()).toBe(true)
          const resting = await button.evaluate((element) => {
            const style = getComputedStyle(element)
            return { background: style.backgroundColor, border: style.borderColor }
          })
          expect(resting.background).toBe('rgba(0, 0, 0, 0)')
          expect(resting.border).toBe('rgba(0, 0, 0, 0)')

          await button.hover()
          await page.waitForFunction((selector) => {
            const element = document.querySelector<HTMLElement>(selector)
            return element !== null && getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)'
          }, `#${surface}-mount button[aria-label="${name}"]`)
          const hoveredBackground = await button.evaluate((element) => getComputedStyle(element).backgroundColor)
          expect(hoveredBackground).not.toBe(resting.background)

          await page.mouse.move(1190, 890)
          await button.focus()
          await page.keyboard.press('Tab')
          await page.keyboard.press('Shift+Tab')
          expect(await button.evaluate((element) => document.activeElement === element)).toBe(true)
          const focus = await button.evaluate((element) => {
            const style = getComputedStyle(element)
            return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor }
          })
          expect(focus.width).toBe('2px')
          expect(focus.style).toBe('solid')
          expect(focus.color).not.toBe('rgba(0, 0, 0, 0)')
        }
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test('keeps keyboard filtering, draft submission, unread, grouping, and navigation in sync', async () => {
  const { context, page } = await openFixture()
  try {
    for (const surface of SURFACES) {
      const panel = mount(page, surface)
      const selectors = surface === 'sidebar'
        ? ['input[aria-label="Search Activity"]', '.ui-checkbox__input', 'select[aria-label="Group Activity by"]', 'button[aria-label="Apply Activity filters"]']
        : ['input[aria-label="Search Activity"]', 'input[aria-label="Worktree ID"]', '.ui-checkbox__input', 'select[aria-label="Group Activity by"]', 'button[aria-label="Apply Activity filters"]']
      const fields = selectors.map((selector) => panel.locator(selector))
      await fields[0]!.focus()
      for (let index = 1; index < fields.length; index += 1) {
        await page.keyboard.press('Tab')
        expect(await fields[index]!.evaluate((element) => document.activeElement === element)).toBe(true)
      }
      for (let index = fields.length - 2; index >= 0; index -= 1) {
        await page.keyboard.press('Shift+Tab')
        expect(await fields[index]!.evaluate((element) => document.activeElement === element)).toBe(true)
      }
    }

    const sidebar = mount(page, 'sidebar')
    const sidebarSearch = sidebar.getByRole('searchbox', { name: 'Search Activity', exact: true })
    let sidebarCalls = await activityCalls(page, 'sidebar')
    await sidebarSearch.fill('audit')
    expect(await activityCalls(page, 'sidebar')).toHaveLength(sidebarCalls.length)
    await sidebar.getByRole('button', { name: 'Apply Activity filters', exact: true }).click()
    await waitForActivityCalls(page, 'sidebar', sidebarCalls.length + 1)
    sidebarCalls = await activityCalls(page, 'sidebar')
    expect(sidebarCalls.at(-1)).toEqual({ text: 'audit' })
    expect(await openedViews(page, 'sidebar')).toEqual([])
    expect(await sidebar.getByRole('searchbox', { name: 'Worktree ID', exact: true }).count()).toBe(0)

    const sidebarCheckbox = sidebar.getByRole('checkbox', { name: 'Unread only', exact: true })
    const sidebarBeforeToggle = sidebarCalls.length
    await sidebar.locator('.ui-checkbox__text').click()
    await waitForActivityCalls(page, 'sidebar', sidebarBeforeToggle + 1)
    sidebarCalls = await activityCalls(page, 'sidebar')
    expect(sidebarCalls).toHaveLength(sidebarBeforeToggle + 1)
    expect(await sidebarCheckbox.isChecked()).toBe(true)
    expect(sidebarCalls.at(-1)).toEqual({ text: 'audit', unreadOnly: true })
    expect(await openedViews(page, 'sidebar')).toEqual([])

    const center = mount(page, 'center')
    const centerSearch = center.getByRole('searchbox', { name: 'Search Activity', exact: true })
    const worktree = center.getByRole('searchbox', { name: 'Worktree ID', exact: true })
    const centerCheckbox = center.getByRole('checkbox', { name: 'Unread only', exact: true })
    const group = center.getByRole('combobox', { name: 'Group Activity by', exact: true })
    let centerCalls = await activityCalls(page, 'center')
    await centerSearch.fill('audit')
    await worktree.fill('wt2')
    expect(await activityCalls(page, 'center')).toHaveLength(centerCalls.length)

    await centerSearch.press('Enter')
    await waitForActivityCalls(page, 'center', centerCalls.length + 1)
    centerCalls = await activityCalls(page, 'center')
    expect(centerCalls.at(-1)).toEqual({ text: 'audit', worktree: 'wt2' })

    const beforeUnread = centerCalls.length
    await centerCheckbox.press('Space')
    await waitForActivityCalls(page, 'center', beforeUnread + 1)
    centerCalls = await activityCalls(page, 'center')
    expect(centerCalls).toHaveLength(beforeUnread + 1)
    expect(await centerCheckbox.isChecked()).toBe(true)
    expect(centerCalls.at(-1)).toEqual({ text: 'audit', worktree: 'wt2', unreadOnly: true })

    const beforeGroup = centerCalls.length
    await group.focus()
    await page.keyboard.press('w')
    await page.keyboard.press('Tab')
    await waitForActivityCalls(page, 'center', beforeGroup + 1)
    centerCalls = await activityCalls(page, 'center')
    expect(await group.inputValue()).toBe('worktree')
    expect(centerCalls).toHaveLength(beforeGroup + 1)
    expect(centerCalls.at(-1)).toEqual({ text: 'audit', worktree: 'wt2', unreadOnly: true })
    let centerOpened = await openedViews(page, 'center')
    expect(centerOpened.at(-1)).toMatchObject({
      id: 'view:quirky.agent-status/activity',
      input: { text: 'audit', worktree: 'wt2', unreadOnly: true, group: 'worktree' }
    })

    const beforeUnreadOff = centerCalls.length
    await centerCheckbox.press('Space')
    await waitForActivityCalls(page, 'center', beforeUnreadOff + 1)
    centerCalls = await activityCalls(page, 'center')
    expect(centerCalls).toHaveLength(beforeUnreadOff + 1)
    expect(centerCalls.at(-1)).toEqual({ text: 'audit', worktree: 'wt2' })

    const beforeClear = centerCalls.length
    await centerSearch.fill('')
    await worktree.fill('')
    expect(await activityCalls(page, 'center')).toHaveLength(beforeClear)
    await center.getByRole('button', { name: 'Apply Activity filters', exact: true }).click()
    await waitForActivityCalls(page, 'center', beforeClear + 1)
    centerCalls = await activityCalls(page, 'center')
    expect(centerCalls.at(-1)).toEqual({})
    centerOpened = await openedViews(page, 'center')
    expect(centerOpened.at(-1)).toMatchObject({ input: { group: 'worktree', unreadOnly: false } })
    expect(centerOpened.at(-1)?.input).not.toHaveProperty('text')
    expect(centerOpened.at(-1)?.input).not.toHaveProperty('worktree')
    expect(await openedViews(page, 'sidebar')).toEqual([])
  } finally {
    await context.close()
  }
}, 60_000)
