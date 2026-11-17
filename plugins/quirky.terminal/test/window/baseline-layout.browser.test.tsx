import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { browserExecutable } from '../../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../../..')
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

type CallRecord = { method: string; params: Record<string, unknown> }
type RoutedCommand = { command: string; args: unknown }
type Confirmation = { title: string }
type ToastRecord = { title: string; body: string }
type OpenViewRecord = { id: string; input: unknown }
type ControllerAction = { action: string; id?: string; input?: unknown }
type BrowserSnapshot = {
  calls: CallRecord[]
  commands: RoutedCommand[]
  confirmations: Confirmation[]
  toasts: ToastRecord[]
  openedViews: OpenViewRecord[]
  controllerActions: ControllerAction[]
}

declare global {
  interface Window {
    __terminalBaseline: {
      mountShortcut(options?: Record<string, unknown>): void
      mountWorkspace(options?: Record<string, unknown>): void
      mountQuickCommands(options?: Record<string, unknown>): void
      mountSessions(options?: Record<string, unknown>): void
      read(): BrowserSnapshot
      deferNextShortcutSave(): void
      releaseShortcutSave(): void
      rejectNextShortcutSave(): void
    }
  }
}

const originalQuirkyHome = process.env.QUIRKY_HOME

let browser: Browser
let bundle = ''
let styles = ''
let temporaryHome = ''
const contexts: BrowserContext[] = []

function browserEntry(): string {
  const shortcut = join(ROOT, 'plugins/quirky.terminal/src/window/ShortcutSettings.tsx')
  const workspace = join(ROOT, 'plugins/quirky.terminal/src/window/workspace/WorkspaceView.tsx')
  const quickCommands = join(ROOT, 'plugins/quirky.terminal/src/window/quick-commands/QuickCommandsPanel.tsx')
  const sessions = join(ROOT, 'plugins/quirky.terminal/src/window/SessionsPanel.tsx')
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Button, ControlIcon, IconButton, ToolPanelFrame } from '@quirky/ui'
    import { ShortcutSettings } from ${JSON.stringify(shortcut)}
    import { WorkspaceView } from ${JSON.stringify(workspace)}
    import { QuickCommandsPanel } from ${JSON.stringify(quickCommands)}
    import { SessionsPanel } from ${JSON.stringify(sessions)}

    let root = null
    let last = null
    let shortcutSaveResolve = null
    let deferShortcutSave = false
    let rejectShortcutSave = false

    function makeContext(handlers = {}, options = {}) {
      const calls = []
      const commands = []
      const confirmations = []
      const toasts = []
      const openedViews = []
      const listeners = new Set()
      const answers = [...(options.confirmAnswers || [])]
      const layout = { worktree: null, view: null, panel: null, sidebar: true, focus: null }
      const context = {
        pluginId: 'quirky.terminal',
        async call(method, params = {}) {
          calls.push({ method, params })
          if (handlers[method]) return await handlers[method](params)
          if (method === 'ui.window.self') return { connId: 1 }
          if (method === 'ui.window.command.run') {
            const { id, args } = params
            commands.push({ command: id, args })
            if (options.onWindowCommand) options.onWindowCommand(id, args)
            return { result: undefined }
          }
          throw new Error('Unexpected fake call: ' + method)
        },
        async executeCommand(command, args) {
          commands.push({ command, args })
          return handlers.executeCommand ? await handlers.executeCommand(command, args) : undefined
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getLayout() { return layout },
        onLayout() { return () => {} },
        getSetting() { return undefined },
        confirm(request) {
          confirmations.push(request)
          return Promise.resolve(answers.shift() ?? false)
        },
        toast(title, body) { toasts.push({ title, body }) },
        openView(id, input) { openedViews.push({ id, input }) },
        log() {}
      }
      return { context, calls, commands, confirmations, toasts, openedViews, listeners, answers }
    }

    function mount(node) {
      if (root) root.unmount()
      root = createRoot(document.getElementById('root'))
      root.render(h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0
        }
      }, node))
    }

    const fixture = {
      mountShortcut(options = {}) {
        const active = {
          id: 'binding-a', plugin: 'quirky.terminal', key: 'mod+t', command: 'command:new-tab', status: 'active'
        }
        const wrapped = {
          id: 'binding-wrapped', plugin: 'quirky.terminal', key: null, command: 'command:long-label',
          status: 'unbound', shadowedBy: 'mod+shift+t'
        }
        const bindings = [active, wrapped]
        const state = makeContext({
          'ui.contributions': () => ({
            commands: [
              { id: active.command, title: 'New tab' },
              { id: wrapped.command, title: 'A deliberately long terminal command label that wraps above its input track' }
            ],
            keybindings: bindings
          }),
          'keybinding.set': (params) => {
            if (deferShortcutSave) {
              deferShortcutSave = false
              const pending = Promise.withResolvers()
              shortcutSaveResolve = () => pending.resolve(bindings)
              return pending.promise
            }
            if (rejectShortcutSave) {
              rejectShortcutSave = false
              throw new Error('The shortcut chord was refused.')
            }
            return bindings
          },
          'keybinding.reset': () => bindings
        })
        last = state
        mount(h(ShortcutSettings, { context: state.context }))
      },

      mountWorkspace(options = {}) {
        const workspaceId = options.workspaceId || 'wt-main'
        const groupId = 'group-main'
        const tabs = (options.tabs || []).map((title, index) => {
          const paneId = 'pane-' + index
          const sessionId = 'session-' + index
          return {
            id: 'tab-' + index,
            defaultTitle: title,
            customTitle: null,
            liveTitle: null,
            color: 'none',
            pinned: false,
            root: { kind: 'pane', id: paneId, session: sessionId, title: null, exit: null },
            activePane: paneId,
            expandedPane: null,
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        })
        let group = {
          kind: 'group', id: groupId, tabs, activeTab: tabs[options.activeIndex ?? 0]?.id ?? null,
          recent: tabs.map((tab) => tab.id), lastQuickCommand: null
        }
        let workspace = { id: workspaceId, revision: 1, root: group, activeGroup: groupId, closed: [] }
        const state = {
          status: 'ready', selectionError: null, workspace, sessions: {}, cwds: {},
          settings: { 'divider-thickness': 3 }, epoch: 1, agents: [], menu: null, dialog: null,
          rename: null, preview: null, dragging: false, focusFlash: null, paneStates: {},
          dockStates: {}, dockHosts: {}, tabDrag: null, paneDrag: null, overflowGroup: null
        }
        const updates = new Set()
        let snapshot = state
        const publish = () => {
          snapshot = { ...state }
          for (const update of updates) update()
        }
        const controllerActions = []
        let controller
        const fake = makeContext({}, {
          onWindowCommand(id, args) {
            if (id === 'command:quirky.terminal/workspace-menu-action' && args.action === 'hidden-tabs') {
              state.overflowGroup = args.open ? args.target : null
              publish()
            }
          }
        })
        if (options.stripExtras) {
          controller = {
            workspaceId,
            selector: workspaceId,
            floating: workspaceId === 'floating',
            context: fake.context,
            options: {
              stripExtras: () => h(IconButton, {
                className: 'baseline-strip-extra', label: 'Build command', title: 'Build command',
                onClick: () => controllerActions.push({ action: 'extra' })
              }, h(ControlIcon, { name: 'plus' }))
            }
          }
        } else {
          controller = {
            workspaceId,
            selector: workspaceId,
            floating: workspaceId === 'floating',
            context: fake.context,
            options: {}
          }
        }
        Object.assign(controller, {
          root: null,
          subscribe(listener) { updates.add(listener); return () => updates.delete(listener) },
          getSnapshot() { return snapshot },
          previewedRoot(node) { return node },
          activateTab(id) {
            controllerActions.push({ action: 'activateTab', id })
            group = { ...group, activeTab: id }
            workspace = { ...workspace, revision: workspace.revision + 1, root: group }
            state.workspace = workspace
            publish()
          },
          closeTab(id) {
            controllerActions.push({ action: 'closeTab', id })
            const nextTabs = group.tabs.filter((tab) => tab.id !== id)
            group = { ...group, tabs: nextTabs, activeTab: group.activeTab === id ? nextTabs[0]?.id ?? null : group.activeTab }
            workspace = { ...workspace, revision: workspace.revision + 1, root: group }
            state.workspace = workspace
            publish()
          },
          newTab(input) { controllerActions.push({ action: 'newTab', input }); return Promise.resolve() },
          toggleExpand() {},
          commitRename() {},
          cancelRename() {},
          overTabDrag() {},
          beginTabDrag() {},
          endTabDrag() {},
          dropTab() { return Promise.resolve() },
          dropCommand() { return Promise.resolve() },
          previewDivider() {},
          endDividerDrag() { return Promise.resolve() },
          resetDivider() { return Promise.resolve() }
        })
        last = { ...fake, workspaceId, state, controllerActions }
        mount(h(WorkspaceView, { controller }))
      },
      mountQuickCommands(options = {}) {
        let commands = options.commands || [
          { id: 'hello', label: 'Hello World', kind: 'terminal', agent: null, command: 'echo hello', appendEnter: true, scope: 'global', repo: null },
          { id: 'project', label: 'Project Build', kind: 'terminal', agent: null, command: 'bun test', appendEnter: true, scope: 'repo', repo: 'repo-api' },
          { id: 'draft', label: 'Draft note', kind: 'terminal', agent: null, command: 'echo draft', appendEnter: false, scope: 'global', repo: null }
        ]
        const state = makeContext({
          'quirky.terminal/quickCommands': () => ({ commands }),
          'quirky.terminal/removeQuickCommand': (params) => {
            commands = commands.filter((command) => command.id !== params.id)
            return { ok: true }
          }
        }, { confirmAnswers: options.confirmAnswers || [] })
        last = state
        mount(h(ToolPanelFrame, {
          title: 'Quick Commands',
          children: h(QuickCommandsPanel, { context: state.context, repo: null })
        }))
      },

      mountSessions(options = {}) {
        const rows = options.sessions || Array.from({ length: 24 }, (_, index) => ({
          sessionId: index === 1 ? 's-error' : 's-' + index,
          state: index === 2 ? 'waiting' : 'running',
          worktreeId: 'wt-main',
          workspace: 'repo/main',
          cwd: '/tmp/repo/main',
          tabTitle: index === 0
            ? 'A very long unbroken terminal title that should ellipsize without covering the kill action'
            : 'Terminal session ' + index,
          worktreeName: 'main'
        }))
        let sessionRequests = 0
        const state = makeContext({
          'quirky.terminal/sessions': () => {
            sessionRequests++
            if (options.failFirstLoad && sessionRequests === 1) throw new Error('host unavailable')
            return { sessions: rows }
          },
          'quirky.terminal/kill': (params) => {
            if (params.session === 's-error') throw new Error('kill refused')
            return { ok: true }
          },
          'quirky.terminal/killAll': () => ({ killedCount: rows.length }),
          'quirky.terminal/restartHost': () => { throw new Error('restart refused') }
        }, { confirmAnswers: options.confirmAnswers || [] })
        last = { ...state, get sessionRequests() { return sessionRequests } }
        mount(h(SessionsPanel, { context: state.context, report() {} }))
      },

      read() {
        if (!last) return {}
        const { calls = [], commands = [], confirmations = [], toasts = [], openedViews = [], controllerActions = [] } = last
        return { calls, commands, confirmations, toasts, openedViews, controllerActions }
      },
      deferNextShortcutSave() { deferShortcutSave = true },
      releaseShortcutSave() { shortcutSaveResolve?.(); shortcutSaveResolve = null },
      rejectNextShortcutSave() { rejectShortcutSave = true }
    }
    window.__terminalBaseline = fixture
  `
}

const browserDependencies: Bun.BunPlugin = {
  name: 'terminal-baseline-browser-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /^terminal-baseline-fixture\.tsx$/ }, () => ({ path: 'entry', namespace: 'terminal-baseline-entry' }))
    builder.onLoad({ filter: /.*/, namespace: 'terminal-baseline-entry' }, () => ({
      contents: browserEntry(),
      loader: 'tsx',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
    builder.onResolve({ filter: /^\.\/PaneLayer$/ }, () => ({ path: 'terminal-pane-layer', namespace: 'terminal-pane-layer' }))
    builder.onLoad({ filter: /.*/, namespace: 'terminal-pane-layer' }, () => ({
      contents: `export function PaneLayer() { return null }\nexport function InlineField() { return null }`,
      loader: 'tsx'
    }))
  }
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
  const shell = await expandStyleImports(new URL('../../../../packages/ui/src/shell/chrome.css', import.meta.url))
  const app = await expandStyleImports(new URL('../../../../packages/ui/src/styles.css', import.meta.url))
  return `${shell}\n${app}`
}

beforeAll(async () => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'quirky-terminal-baseline-'))
  process.env.QUIRKY_HOME = temporaryHome
  const result = await Bun.build({
    entrypoints: ['terminal-baseline-fixture.tsx'],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencies],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Terminal baseline browser bundle was empty.')
  bundle = await output.text()
  styles = await productionStyles()
  browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()))
})

afterAll(async () => {
  await browser?.close()
  if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true })
  if (originalQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = originalQuirkyHome
})

async function newPage(width: number, height: number, theme: 'dark' | 'light'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } })
  contexts.push(context)
  const page = await context.newPage()
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head></head><body><div id="root" style="position:fixed;inset:0"></div></body></html>`)
  await page.addStyleTag({ content: styles })
  await page.addScriptTag({ content: bundle })
  return page
}
async function expectQuickCommandCount(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => document.querySelectorAll('[data-command]').length === count, expected)
  expect(await page.locator('[data-command]').count()).toBe(expected)
}

async function settleWorkspace(page: Page): Promise<{ clipped: number; reported: number; scrollLeft: number }> {
  return page.evaluate(async () => {
    const measure = () => {
      const viewports = [...document.querySelectorAll<HTMLElement>('.qt-tabs')]
      if (viewports.length === 0) return null
      const geometry = viewports.map((viewport) => {
        const bounds = viewport.getBoundingClientRect()
        const tabs = [...viewport.children].map((tab) => tab.getBoundingClientRect())
        const clipped = tabs.filter((rect) => {
          const showing = Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left)
          return showing < Math.min(rect.width, bounds.width) - 1
        }).length
        const more = viewport.parentElement?.querySelector<HTMLElement>('.qt-tab-more')
        const count = Number(more?.querySelector('.qt-tab-more-count')?.textContent ?? 0)
        return {
          valid: clipped === count && Boolean(more) === (clipped > 0),
          width: bounds.width,
          scrollLeft: viewport.scrollLeft,
          tabs: tabs.map((rect) => [rect.left, rect.width]),
          clipped,
          count
        }
      })
      return geometry.every((entry) => entry.valid) ? geometry : null
    }
    let previous = ''
    let stableFrames = 0
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      const current = measure()
      const signature = current === null ? '' : JSON.stringify(current)
      stableFrames = signature !== '' && signature === previous ? stableFrames + 1 : 0
      if (current !== null && stableFrames >= 2) {
        return { clipped: current[0]!.clipped, reported: current[0]!.count, scrollLeft: current[0]!.scrollLeft }
      }
      previous = signature
      const next = Promise.withResolvers<void>()
      requestAnimationFrame(() => next.resolve())
      await next.promise
    }
    throw new Error('The tab strip geometry and hidden count did not settle.')
  })
}

async function workspaceMetrics(page: Page): Promise<Record<string, number | boolean>> {
  return page.locator('.qt-strip').evaluate((strip) => {
    const bounds = (element: Element) => element.getBoundingClientRect()
    const box = bounds(strip)
    const navigation = strip.querySelector<HTMLElement>('.qt-tab-navigation')!
    const navigationBox = bounds(navigation)
    const plus = strip.querySelector<HTMLElement>('.qt-plus')!
    const plusBox = bounds(plus)
    const actions = strip.querySelector<HTMLElement>('.qt-actions')!
    const actionsBox = bounds(actions)
    return {
      leadingFromStrip: plusBox.left - box.left,
      leadingFromNavigation: plusBox.left - navigationBox.right,
      plusTrailingMargin: Number.parseFloat(getComputedStyle(plus).marginInlineEnd),
      plusLeadingMargin: Number.parseFloat(getComputedStyle(plus).marginInlineStart),
      actionLeadingMargin: Number.parseFloat(getComputedStyle(actions).marginInlineStart),
      actionTrailingMargin: Number.parseFloat(getComputedStyle(actions).marginInlineEnd),
      actionGap: actionsBox.left - plusBox.right,
      plusWidth: plusBox.width,
      plusHeight: plusBox.height,
      actionsWidth: actionsBox.width,
      actionsHeight: actionsBox.height,
      wraps: plusBox.top >= navigationBox.bottom - 1,
      navigationWidth: navigation.clientWidth
    }
  })
}

test('repair shortcut control-track alignment in both themes and at wide and narrow widths', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1000, 320]) {
      const page = await newPage(width, 900, theme)
      await page.evaluate(() => window.__terminalBaseline.mountShortcut())
      await page.getByLabel('Shortcut for binding-a').waitFor()
      const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tt-shortcut-row')].map((row) => {
        const rect = (selector: string) => row.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        const field = rect('input')
        const status = rect('.tt-shortcut-status')
        const actions = rect('.ui-cluster')
        const rowBox = row.getBoundingClientRect()
        const label = rect('.ui-form-row__label')
        const buttons = [...row.querySelectorAll<HTMLElement>('.ui-cluster button')].map((button) => button.getBoundingClientRect())
        return {
          centers: [field, status, actions].map((box) => (box.top + box.bottom) / 2),
          labelGap: field.top - label.bottom,
          labelHeight: label.height,
          buttonGaps: buttons.slice(1).map((button, index) => button.left - buttons[index]!.right),
          withinRow: [field, status, actions, ...buttons].every((box) =>
            box.left >= rowBox.left - 0.5 && box.right <= rowBox.right + 0.5 &&
            box.top >= rowBox.top - 0.5 && box.bottom <= rowBox.bottom + 0.5
          )
        }
      }))
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(Math.max(...row.centers) - Math.min(...row.centers)).toBeLessThanOrEqual(1)
        expect(row.labelGap).toBeCloseTo(4, 1)
        expect(row.buttonGaps).toEqual([8, 8])
        expect(row.withinRow).toBe(true)
      }
      if (width === 320) expect(rows[1]!.labelHeight).toBeGreaterThan(rows[0]!.labelHeight)
    }
  }
}, 120_000)

test('repair New tab leading spacing in empty and populated main and floating workspaces', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const workspaceId of ['wt-main', 'floating']) {
      for (const width of [1000, 320]) {
        for (const tabs of [[], ['Selected terminal', 'Build output', 'Logs', 'Tests']]) {
          const page = await newPage(width, 900, theme)
          await page.evaluate(({ workspaceId, tabs }) => window.__terminalBaseline.mountWorkspace({ workspaceId, tabs }), { workspaceId, tabs })
          await page.locator('.qt-plus').waitFor()
          await settleWorkspace(page)
          const metrics = await workspaceMetrics(page)
          if (tabs.length === 0 || width === 320) {
            expect(metrics.leadingFromStrip).toBeCloseTo(8, 1)
            if (tabs.length > 0) expect(metrics.wraps).toBe(true)
          } else {
            expect(metrics.leadingFromNavigation).toBeCloseTo(8, 1)
            expect(metrics.wraps).toBe(false)
          }
          expect(metrics.plusLeadingMargin).toBe(8)
          expect(metrics.plusTrailingMargin).toBe(2)
          expect(metrics.actionLeadingMargin).toBe(2)
          expect(metrics.actionTrailingMargin).toBe(2)
          expect(metrics.plusWidth).toBe(24)
          expect(metrics.plusHeight).toBe(24)
          expect(metrics.actionsWidth).toBe(24)
          expect(metrics.actionsHeight).toBe(24)
          expect(metrics.actionGap).toBe(4)
          if (tabs.length === 0) {
            await page.keyboard.press('Tab')
            const focus = await page.locator('.qt-plus').evaluate((button) => ({
              focused: document.activeElement === button,
              visible: button.matches(':focus-visible'),
              outlineStyle: getComputedStyle(button).outlineStyle,
              outlineWidth: Number.parseFloat(getComputedStyle(button).outlineWidth)
            }))
            expect(focus).toEqual({ focused: true, visible: true, outlineStyle: 'solid', outlineWidth: 2 })
          }
          const paneActions = page.getByRole('button', { name: 'Pane actions' })
          expect(await paneActions.isDisabled()).toBe(true)
          await page.evaluate(() => (document.querySelector<HTMLButtonElement>('[aria-label="Pane actions"]'))?.click())
          const afterDisabledClick = await page.evaluate(() => window.__terminalBaseline.read())
          expect(afterDisabledClick.commands).toEqual([])

          await page.getByRole('button', { name: 'New tab' }).click()
          const calls = await page.evaluate(() => window.__terminalBaseline.read())
          expect(calls.commands).toContainEqual({ command: 'command:quirky.terminal/open-menu', args: { kind: 'plus', target: 'group-main' } })
          if (tabs.length === 0) {
            await page.getByRole('button', { name: 'New Terminal' }).waitFor({ state: 'visible' })
            if (workspaceId === 'floating') {
              await page.getByRole('button', { name: 'Minimize' }).waitFor({ state: 'visible' })
              await page.getByRole('button', { name: 'Minimize' }).click()
              expect(await page.evaluate(() => window.__terminalBaseline.read())).toMatchObject({
                calls: expect.arrayContaining([{ method: 'quirky.terminal/setFloating', params: { open: false } }])
              })
            } else {
              expect(await page.getByRole('button', { name: 'Minimize' }).count()).toBe(0)
            }
            await page.getByRole('button', { name: 'New Terminal' }).click()
            expect(await page.evaluate(() => window.__terminalBaseline.read())).toMatchObject({
              controllerActions: expect.arrayContaining([{ action: 'newTab', input: { group: 'group-main' } }])
            })
          }
        }
      }
    }
  }
}, 120_000)

test('the shared strip wraps at 480px, agrees between workspace ids, and measures overflow through extras', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [480, 481]) {
      const paired: Record<string, Record<string, number | boolean>> = {}
      const pairedHidden: Record<string, { actual: number; reported: number }> = {}
      for (const workspaceId of ['wt-main', 'floating']) {
        const page = await newPage(width, 900, theme)
        const tabs = ['Selected terminal', 'Build output', 'Long-running integration tests', 'Debug logs', 'Terminal five']
        await page.evaluate(({ workspaceId, tabs }) => window.__terminalBaseline.mountWorkspace({ workspaceId, tabs, stripExtras: true }), { workspaceId, tabs })
        await page.locator('.qt-plus').waitFor()
        await settleWorkspace(page)
        const metrics = await workspaceMetrics(page)
        const hiddenCount = await page.locator('.qt-tabs').evaluate((viewport) => {
          const bounds = viewport.getBoundingClientRect()
          const actual = [...viewport.children].filter((tab) => {
            const rect = tab.getBoundingClientRect()
            const visible = Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left)
            return visible < Math.min(rect.width, bounds.width) - 1
          }).length
          const more = viewport.parentElement?.querySelector<HTMLElement>('.qt-tab-more')
          return { actual, reported: Number(more?.querySelector('.qt-tab-more-count')?.textContent ?? 0) }
        })
        expect(hiddenCount.reported).toBe(hiddenCount.actual)
        pairedHidden[workspaceId] = hiddenCount
        paired[workspaceId] = metrics
        expect(await page.locator('.baseline-strip-extra').count()).toBe(1)
        if (width === 480) {
          expect(metrics.wraps).toBe(true)
          expect(metrics.leadingFromStrip).toBeCloseTo(8, 1)
        } else {
          expect(metrics.wraps).toBe(false)
          expect(metrics.leadingFromNavigation).toBeCloseTo(8, 1)
        }
      }
      expect(paired.floating).toEqual(paired['wt-main'])
      expect(pairedHidden.floating).toEqual(pairedHidden['wt-main'])
    }
  }

  for (const theme of ['dark', 'light'] as const) {
    const page = await newPage(1000, 900, theme)
    const tabs = ['Selected terminal', 'Build output', 'Long-running integration tests', 'Debug logs', 'Terminal five', 'Terminal six', 'Terminal seven', 'Terminal eight']
    await page.evaluate(({ tabs }) => window.__terminalBaseline.mountWorkspace({ workspaceId: 'wt-main', tabs, activeIndex: 0, stripExtras: true }), { tabs })
    await page.locator('.qt-plus').waitFor()
    await settleWorkspace(page)
    const isSettled = async () => {
      const { clipped, reported } = await settleWorkspace(page)
      return { clipped, reported }
    }
    let low = 481
    let high = await page.locator('.qt-strip').evaluate((strip) => {
      const viewport = strip.querySelector<HTMLElement>('.qt-tabs')!
      const tabWidth = [...viewport.children].reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0)
      return Math.ceil(tabWidth + strip.getBoundingClientRect().width - viewport.clientWidth) + 1
    })
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      await page.setViewportSize({ width: middle, height: 900 })
      const measured = await isSettled()
      if (measured.clipped === 0) high = middle
      else low = middle + 1
    }
    await page.setViewportSize({ width: low, height: 900 })
    const fit = await isSettled()
    expect(fit).toEqual({ clipped: 0, reported: 0 })
    await page.setViewportSize({ width: Math.max(320, low - 2), height: 900 })
    const clipped = await isSettled()
    expect(clipped.clipped).toBeGreaterThan(0)
    expect(clipped.reported).toBe(clipped.clipped)
    const hidden = await page.locator('.qt-tab-more').innerText()
    const hiddenCount = Number(hidden.match(/\d+/)?.[0] ?? 0)
    expect(hiddenCount).toBe(clipped.clipped)

    const hiddenIds = await page.locator('.qt-tabs > [data-tab][style*="visibility: hidden"]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab')))
    expect(hiddenIds.length).toBeGreaterThan(0)
    await page.locator('.qt-tab-more').click()
    await page.getByRole('menu').waitFor()
    const menuLabels = await page.getByRole('menuitem').allTextContents()
    for (const id of hiddenIds) {
      const label = await page.locator(`[data-tab="${id}"] .qt-tab-title`).textContent() ?? ''
      expect(menuLabels.join(' ')).toContain(label)
    }
    const nextHidden = hiddenIds.at(-1)!
    const selectedTitle = await page.locator(`[data-tab="${nextHidden}"] .qt-tab-title`).textContent()
    await page.getByRole('menuitem').filter({ hasText: selectedTitle! }).click()
    await settleWorkspace(page)
    const selectedUsable = await page.locator('.qt-tab.qt-selected').evaluate((tab) => {
      const viewport = tab.closest<HTMLElement>('.qt-tabs')!
      const bounds = viewport.getBoundingClientRect()
      const title = tab.querySelector<HTMLElement>('.qt-tab-title')!.getBoundingClientRect()
      const close = tab.querySelector<HTMLElement>('.qt-tab-close')!.getBoundingClientRect()
      return title.left >= bounds.left - 0.5 && title.right <= bounds.right + 0.5 && close.left >= bounds.left - 0.5 && close.right <= bounds.right + 0.5
    })
    expect(selectedUsable).toBe(true)
    const activeId = await page.locator('.qt-tab.qt-selected').getAttribute('data-tab')
    await page.getByRole('button', { name: `Close ${selectedTitle}` }).click()
    await settleWorkspace(page)
    expect(await page.locator(`[data-tab="${activeId}"]`).count()).toBe(0)

    await page.setViewportSize({ width: 320, height: 900 })
    await settleWorkspace(page)
    await page.locator('.qt-tabs').evaluate((viewport) => {
      const element = viewport as HTMLElement
      element.scrollLeft = element.scrollWidth
    })
    const afterScroll = await settleWorkspace(page)
    expect(afterScroll.scrollLeft).toBeGreaterThan(0)
    expect(afterScroll.reported).toBe(afterScroll.clipped)

    await page.setViewportSize({ width: 1000, height: 900 })
    await settleWorkspace(page)
    expect(await page.locator('.baseline-strip-extra').count()).toBe(1)
  }
}, 120_000)

test('shortcut writes keep their API, pending lock, Enter route, and retry after rejection', async () => {
  const page = await newPage(1000, 900, 'dark')
  await page.evaluate(() => window.__terminalBaseline.mountShortcut())
  const input = page.getByLabel('Shortcut for binding-a')
  await input.waitFor()
  await input.fill('mod+shift+t')
  await input.press('Enter')
  await page.waitForFunction(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'keybinding.set'))
  expect(await page.evaluate(() => window.__terminalBaseline.read().calls.filter((call) => call.method === 'keybinding.set').map((call) => call.params))).toContainEqual({ id: 'binding-a', key: 'mod+shift+t' })

  await page.evaluate(() => window.__terminalBaseline.deferNextShortcutSave())
  await page.getByRole('button', { name: 'Save' }).first().click()
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Shortcut for binding-a"]')
    const row = input?.closest('.tt-shortcut-row')
    return Boolean(input?.disabled && row && [...row.querySelectorAll('button')].every((button) => button.disabled))
  })
  await page.evaluate(() => window.__terminalBaseline.releaseShortcutSave())
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('[aria-label="Shortcut for binding-a"]')?.disabled)

  await input.fill('mod+bad')
  await page.evaluate(() => window.__terminalBaseline.rejectNextShortcutSave())
  await page.getByRole('button', { name: 'Save' }).first().click()
  const shortcutAlert = page.getByRole('alert')
  await shortcutAlert.waitFor({ state: 'visible' })
  expect(await shortcutAlert.innerText()).toContain('The shortcut chord was refused.')
  expect(await input.isEnabled()).toBe(true)
  await page.getByRole('button', { name: 'Save' }).first().click()
  await page.waitForFunction(() => window.__terminalBaseline.read().calls.filter((call) => call.method === 'keybinding.set').length >= 4)
  await page.getByRole('button', { name: 'Disable' }).first().click()
  await page.waitForFunction(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'keybinding.set' && call.params.key === null))
  await page.getByRole('button', { name: 'Reset' }).first().click()
  const methods = await page.evaluate(() => window.__terminalBaseline.read().calls)
  expect(methods.filter((call) => call.method === 'keybinding.set').map((call) => call.params)).toContainEqual({ id: 'binding-a', key: null })
  expect(methods.filter((call) => call.method === 'keybinding.reset').map((call) => call.params)).toContainEqual({ id: 'binding-a' })
}, 120_000)

test('Quick Commands stays in the host rail and preserves filtering and dialog routes at both widths and themes', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1000, 320]) {
      const page = await newPage(width, 900, theme)
      await page.evaluate(() => window.__terminalBaseline.mountQuickCommands({ confirmAnswers: [false, true] }))
      await page.getByRole('button', { name: 'Add Command' }).waitFor()
      expect(await page.locator('.ui-tool-panel-frame__header').count()).toBe(1)
      expect(await page.locator('.ui-tool-panel-frame__header h2').innerText()).toBe('Quick Commands')
      await page.getByRole('button', { name: 'Add Command' }).waitFor({ state: 'visible' })
      await page.locator('#quick-command-search').waitFor({ state: 'visible' })
      await page.locator('#quick-command-scope').waitFor({ state: 'visible' })
      const structure = await page.evaluate(() => {
        const add = document.querySelector<HTMLElement>('[aria-label="Add Command"]')!
        const rail = add.closest<HTMLElement>('.ui-tool-panel-frame__rail')!
        const body = document.querySelector<HTMLElement>('.ui-tool-panel-frame__body')!
        const searchLabel = document.querySelector<HTMLLabelElement>('label[for="quick-command-search"]')!
        const search = document.querySelector<HTMLElement>('#quick-command-search')!
        const scopeLabel = document.querySelector<HTMLLabelElement>('label[for="quick-command-scope"]')!
        const scope = document.querySelector<HTMLElement>('#quick-command-scope')!
        return {
          addInRail: rail.contains(add),
          searchInBody: body.contains(search),
          scopeInBody: body.contains(scope),
          addBeforeBody: rail.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
          searchGap: search.getBoundingClientRect().top - searchLabel.getBoundingClientRect().bottom,
          scopeGap: scope.getBoundingClientRect().top - scopeLabel.getBoundingClientRect().bottom,
          searchAssociated: searchLabel.control === search,
          scopeAssociated: scopeLabel.control === scope
        }
      })
      expect(structure.addInRail).toBe(true)
      expect(structure.searchInBody).toBe(true)
      expect(structure.scopeInBody).toBe(true)
      if (width === 320) expect(structure.addBeforeBody).toBe(true)
      expect(structure.searchGap).toBeCloseTo(4, 1)
      expect(structure.scopeGap).toBeCloseTo(4, 1)
      expect(structure.searchAssociated).toBe(true)
      expect(structure.scopeAssociated).toBe(true)

      await page.locator('#quick-command-scope').selectOption('global')
      await expectQuickCommandCount(page, 2)
      await page.locator('#quick-command-search').fill('dra')
      await expectQuickCommandCount(page, 1)
      await page.locator('[data-command="draft"]').waitFor({ state: 'visible' })
      await page.locator('#quick-command-search').fill('')
      await page.locator('#quick-command-scope').selectOption('repo')
      await expectQuickCommandCount(page, 1)
      await page.locator('[data-command="project"]').waitFor({ state: 'visible' })

      await page.locator('#quick-command-scope').selectOption('all')
      await page.getByRole('button', { name: 'Add Command' }).click()
      await page.getByRole('button', { name: 'Edit Project Build' }).click()
      await page.getByRole('button', { name: 'Delete Hello World' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().confirmations.length === 1)
      expect(await page.locator('[data-command="hello"]').count()).toBe(1)
      expect(await page.evaluate(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'quirky.terminal/removeQuickCommand'))).toBe(false)
      await page.getByRole('button', { name: 'Delete Hello World' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'quirky.terminal/removeQuickCommand'))
      await page.locator('[data-command="hello"]').waitFor({ state: 'detached' })
      const actions = await page.evaluate(() => window.__terminalBaseline.read())
      expect(actions.commands).toContainEqual({ command: 'command:quirky.terminal/quick-command-dialog', args: { action: 'open' } })
      expect(actions.commands).toContainEqual({ command: 'command:quirky.terminal/quick-command-dialog', args: { action: 'open', command: 'project' } })
      expect(actions.confirmations.map((item) => item.title)).toEqual(['Delete "Hello World"?', 'Delete "Hello World"?'])
      expect(actions.calls.filter((call) => call.method === 'quirky.terminal/removeQuickCommand').map((call) => call.params)).toEqual([{ id: 'hello', yes: true }])
      expect(await page.locator('[data-command="hello"]').count()).toBe(0)
    }
  }
}, 120_000)

test('Sessions retains shared rows, scroll insets, destructive actions, confirmations, and error routes', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [1000, 320]) {
      const page = await newPage(width, 240, theme)
      await page.evaluate(() => window.__terminalBaseline.mountSessions({
        confirmAnswers: [false, true, false, true, false, true]
      }))
      await page.locator('[data-session="s-0"]').waitFor()
      expect(await page.locator('[data-session]').count()).toBe(24)
      expect((await page.getByRole('button', { name: 'Kill all sessions' }).getAttribute('class') ?? '')).toContain('ui-button--destructive')
      expect(await page.getByRole('button', { name: 'Restart terminal host' }).count()).toBe(1)
      const geometry = await page.locator('[data-session="s-0"] .ui-list-row').evaluate((row) => {
        const rect = (selector: string) => row.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        const list = row.closest<HTMLElement>('.tt-sessions-list')!
        const listStyle = getComputedStyle(list)
        const status = rect('.ui-list-row__status')
        const main = rect('.ui-list-row__body')
        const title = row.querySelector<HTMLElement>('.sessions-workspace')!
        const killButton = row.querySelector<HTMLButtonElement>('[aria-label="Kill session s-0"]')!
        const kill = killButton.getBoundingClientRect()
        return {
          doubleRow: row.classList.contains('ui-list-row--double'),
          listPaddingLeft: Number.parseFloat(listStyle.paddingLeft),
          listPaddingRight: Number.parseFloat(listStyle.paddingRight),
          contentInsetLeft: rowBox.left - (list.getBoundingClientRect().left + list.clientLeft),
          contentInsetRight: list.getBoundingClientRect().right - rowBox.right,
          statusGap: main.left - status.right,
          longTitle: title.textContent,
          killUnobscured: [0.25, 0.5, 0.75].every((fractionX) =>
            [0.25, 0.5, 0.75].every((fractionY) =>
              killButton.contains(document.elementFromPoint(kill.left + kill.width * fractionX, kill.top + kill.height * fractionY))
            )
          ),
          killInsideRow: kill.left >= rowBox.left && kill.right <= rowBox.right,
          destructive: row.querySelector('[aria-label="Kill session s-0"]')?.classList.contains('ui-button--destructive')
        }
      })
      expect(geometry.doubleRow).toBe(true)
      expect(geometry.listPaddingLeft).toBe(8)
      expect(geometry.listPaddingRight).toBe(8)
      expect(geometry.contentInsetLeft).toBeCloseTo(8, 1)
      expect(geometry.contentInsetRight).toBeCloseTo(8, 1)
      expect(geometry.statusGap).toBeCloseTo(8, 1)
      expect(geometry.longTitle).toContain('A very long unbroken terminal title')
      expect(geometry.killUnobscured).toBe(true)
      expect(geometry.killInsideRow).toBe(true)
      expect(geometry.destructive).toBe(true)
      const scrolling = await page.locator('.tt-sessions-list').evaluate((list) => {
        const element = list as HTMLElement
        return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
      })
      expect(scrolling.scrollHeight).toBeGreaterThan(scrolling.clientHeight)
      await page.locator('.tt-sessions-list').evaluate((list) => { (list as HTMLElement).scrollTop = (list as HTMLElement).scrollHeight })
      await page.waitForFunction(() => {
        const list = document.querySelector<HTMLElement>('.tt-sessions-list')
        return Boolean(list && list.scrollTop > 0)
      })
      const insetsAfterScroll = await page.locator('.tt-sessions-list').evaluate((list) => {
        const element = list as HTMLElement
        const row = element.querySelector<HTMLElement>('[data-session] .ui-list-row')!
        return {
          left: row.getBoundingClientRect().left - (element.getBoundingClientRect().left + element.clientLeft),
          right: element.getBoundingClientRect().right - row.getBoundingClientRect().right
        }
      })
      expect(insetsAfterScroll.left).toBeCloseTo(8, 1)
      expect(insetsAfterScroll.right).toBeCloseTo(8, 1)

      await page.locator('[data-session="s-0"] [aria-label="Kill session s-0"]').click()
      await page.waitForFunction(() => window.__terminalBaseline.read().confirmations.length === 1)
      expect(await page.evaluate(() => window.__terminalBaseline.read().openedViews)).toEqual([])
      await page.locator('[data-session="s-0"] .sessions-workspace').click()
      await page.waitForFunction(() => window.__terminalBaseline.read().openedViews.length === 1)
      await page.locator('[data-session="s-error"] [aria-label="Kill session s-error"]').click()
      await page.waitForFunction(() => window.__terminalBaseline.read().toasts.some((toast) => toast.title === 'Could not kill session'))
      await page.getByRole('button', { name: 'Kill all sessions' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().confirmations.length === 3)
      await page.getByRole('button', { name: 'Kill all sessions' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'quirky.terminal/killAll'))
      await page.getByRole('button', { name: 'Restart terminal host' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().confirmations.length === 5)
      expect(await page.evaluate(() => window.__terminalBaseline.read().calls.some((call) => call.method === 'quirky.terminal/restartHost'))).toBe(false)
      await page.getByRole('button', { name: 'Restart terminal host' }).click()
      await page.waitForFunction(() => window.__terminalBaseline.read().toasts.some((toast) => toast.title === 'Restart failed — check logs.'))
      const actions = await page.evaluate(() => window.__terminalBaseline.read())
      expect(actions.openedViews).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'wt-main', session: 's-0' } }])
      expect(actions.confirmations.map((item) => item.title)).toEqual([
        'Kill this session?', 'Kill this session?', 'Kill all terminal sessions?', 'Kill all terminal sessions?',
        'Restart the terminal service?', 'Restart the terminal service?'
      ])
      expect(actions.calls.filter((call) => call.method === 'quirky.terminal/kill').map((call) => call.params)).toEqual([{ session: 's-error', yes: true }])
      expect(actions.calls.filter((call) => call.method === 'quirky.terminal/killAll').map((call) => call.params)).toEqual([{ yes: true }])
      expect(actions.calls.filter((call) => call.method === 'quirky.terminal/restartHost').map((call) => call.params)).toEqual([{ yes: true }])
      expect(actions.toasts).toContainEqual({ title: 'Could not kill session', body: 'kill refused' })
      expect(actions.toasts).toContainEqual({ title: 'Killed 24 sessions.', body: '' })
      expect(actions.toasts).toContainEqual({ title: 'Restart failed — check logs.', body: 'restart refused' })
    }
  }
}, 120_000)

test('Sessions reports a load failure and retries into its empty state', async () => {
  const page = await newPage(320, 240, 'light')
  await page.evaluate(() => window.__terminalBaseline.mountSessions({ failFirstLoad: true, sessions: [] }))
  const error = page.getByRole('alert')
  await error.waitFor({ state: 'visible' })
  expect(await error.innerText()).toContain('Could not load sessions: host unavailable')
  await page.getByRole('button', { name: 'Retry' }).click()
  const emptyState = page.locator('.ui-empty-state')
  await emptyState.waitFor({ state: 'visible' })
  expect(await emptyState.innerText()).toContain('No sessions.')
  expect(await page.evaluate(() => window.__terminalBaseline.read())).toMatchObject({
    calls: expect.arrayContaining([
      { method: 'quirky.terminal/sessions', params: {} },
      { method: 'quirky.terminal/sessions', params: {} }
    ])
  })
}, 60_000)
