import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dirname, join, resolve } from 'node:path'
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
const pageErrors = new WeakMap<Page, string[]>()
declare global {
  interface Window {
    __repairFixture: {
      changes: boolean[]
      mount(options: { disabled?: boolean; long?: boolean; mixed?: boolean }): void
      calls: { method: string; params: Record<string, unknown> }[]
      unexpected: string[]
      mountQuick(purpose: 'files' | 'markdown-open' | 'markdown-new', long?: boolean): void
      mountAutomations(options?: { rejectSettings?: boolean }): void
      mountTasks(options?: { rejectPreferences?: boolean }): void
      mountReview(provider: 'github' | 'gitlab', options?: {
        submitting?: boolean
        generating?: boolean
        stackSupported?: boolean
        failDraft?: 'draft' | 'template'
        holdDraft?: boolean
        holdStack?: boolean
      }): void
      releaseDraft(): void
      releaseStack(): void
    }
  }
}

function browserEntry() {
  return `
    import { createElement as h, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Checkbox, FormRow } from '@quirky/ui'
    import { QuickOpenOverlay } from '${ROOT}/plugins/quirky.editor/src/window/QuickOpenOverlay.tsx'
    import { showQuickOpen, clearOverlayRequests } from '${ROOT}/plugins/quirky.editor/src/window/overlayState.ts'
    import { EditorUiControlProvider, createEditorUiControlReportScope, runEditorUiControl } from '${ROOT}/plugins/quirky.editor/src/window/uiControl.tsx'
    import { activate as activateAutomations } from '${ROOT}/plugins/quirky.automations/src/ui.tsx'
    import { activate as activateTasks } from '${ROOT}/plugins/quirky.tasks/src/ui.tsx'
    import { CreateReview } from '${ROOT}/plugins/quirky.reviews/src/create/CreateReview.tsx'
    import { runReviewsUiControl } from '${ROOT}/plugins/quirky.reviews/src/checks/data.ts'
    const root = createRoot(document.getElementById('root'))
    let mountKey = 0
    const fixture = { changes: [], calls: [], unexpected: [], releaseDraft() {}, releaseStack() {}, mountQuick(purpose, long = false) {
      clearOverlayRequests()
      fixture.calls = []
      fixture.unexpected = []
      const context = {
        async call(method, params = {}) {
          if (method === 'ui.window.self') return { connId: 22 }
          if (method === 'ui.window.command.run') return { result: await runEditorUiControl(params.args) }
          fixture.calls.push({ method, params })
          if (method === 'quirky.editor/quickOpen') return {
            results: [
              { path: long ? 'a'.repeat(237) + '.md' : 'docs/alpha.md', name: long ? 'VeryLongFilename'.repeat(16) + '.md' : 'alpha.md', score: 1 },
              { path: 'docs/beta.md', name: 'beta.md', score: 1, line: 12, column: 3 }
            ], history: [], truncated: false
          }
          if (method === 'quirky.editor/markdown') return { templates: [{ relativePath: 'templates/note.md', title: 'Note' }] }
          if (method === 'quirky.editor/open') return {}
          fixture.unexpected.push(method)
          throw new Error('Unexpected method ' + method)
        }, toast() {}
      }
      const scope = createEditorUiControlReportScope(undefined, { surface: 'overlay:quirky.editor/quick-open' })
      showQuickOpen(context, 'worktree-1', '', purpose, 'group-1')
      root.render(h(EditorUiControlProvider, { scope }, h(QuickOpenOverlay, { context })))
    }, mount(options = {}) {
      fixture.changes = []
      function Probe() {
        const [checked, setChecked] = useState(false)
        const label = options.long ? 'Keep this deliberately long boolean setting label readable when it wraps onto several lines at narrow widths' : 'Probe setting'
        return h(FormRow, { label, htmlFor: 'probe', layout: 'inline', help: 'Help', error: 'Failed' },
          h(Checkbox, { label, hideLabel: true, checked, disabled: options.disabled, indeterminate: options.mixed,
            onChange(value) { fixture.changes.push(value); setChecked(value) } }))
      }
      root.render(h(Probe, { key: ++mountKey }))
    } }
    const mountPluginSurface = (activate, surfaceId, context) => {
      const provided = new Map()
      context.provide = (id, implementation) => provided.set(id, implementation)
      activate(context)
      const element = document.createElement('div')
      document.getElementById('root').append(element)
      const mount = provided.get(surfaceId)
      if (typeof mount !== 'function') throw new Error('Missing activated surface ' + surfaceId)
      const cleanup = mount(element, {})
      return () => { if (typeof cleanup === 'function') cleanup(); element.remove() }
    }
    const unexpectedCall = (method) => {
      fixture.unexpected.push(method)
      throw new Error('Unexpected service call ' + method)
    }
    const taskState = (providers) => ({
      revision: 1,
      navigation: { source: 'github', mode: 'prs', repoIds: null, query: '', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: '', page: 1 } },
      preferences: { showTasksButton: true, visibleTaskProviders: providers, defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
      issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
      projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
      links: {}
    })
    Object.assign(fixture, {
      mountAutomations(options = {}) {
        fixture.calls = []
        fixture.unexpected = []
        const context = {
          async call(method, params = {}) {
            fixture.calls.push({ method, params })
            if (method !== 'setting.set') return unexpectedCall(method)
            if (options.rejectSettings) throw new Error('Settings are read-only.')
            return {}
          },
          getSetting() { return true },
          subscribe() { return () => {} },
          toast() {}
        }
        fixture.cleanup = mountPluginSurface(activateAutomations, 'view:quirky.automations/settings', context)
      },
      mountTasks(options = {}) {
        fixture.calls = []
        fixture.unexpected = []
        let state = taskState(['github'])
        const context = {
          async call(method, params = {}) {
            fixture.calls.push({ method, params })
            if (method === 'quirky.tasks/state') return state
            if (method === 'quirky.tasks/repositories') return [{ id: 'repo', name: 'Fixture', path: '/fixture', kind: 'git', worktree: '/work/browser' }]
            if (method === 'quirky.hosting/diagnoseAuth') return { ghAvailable: true, requiredHostAuthenticated: true }
            if (method === 'quirky.tasks/preferences') {
              if (options.rejectPreferences) throw new Error('Preferences are read-only.')
              state = { ...state, revision: state.revision + 1, preferences: { ...state.preferences, ...params } }
              return {}
            }
            return unexpectedCall(method)
          },
          subscribe() { return () => {} },
          toast() {},
          async executeCommand(method) { return unexpectedCall(method) }
        }
        fixture.cleanup = mountPluginSurface(activateTasks, 'view:quirky.tasks/settings', context)
      },
      mountReview(provider, options = {}) {
        fixture.calls = []
        fixture.unexpected = []
        let resolveDraft
        let resolveStack
        let heldDraft = false
        let heldStack = false
        let serverRevision = 0
        let failedField = false
        const serverCreation = {
          worktree: '/work/browser', generation: 1, loading: false, error: null,
          eligibility: {
            provider, eligible: true, confirmedAt: Date.now(),
            stackSupported: provider === 'github' && options.stackSupported !== false,
            stackParentNumber: 42, stackEnabled: false
          },
          title: 'Fixture title', body: 'Fixture description', base: 'main', head: 'feature',
          draft: false, useTemplate: false, bases: ['main', 'release'], generating: options.generating === true,
          requestId: null, submitting: options.submitting === true, generated: false, result: null,
          defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
        }
        const context = {
          async call(method, params = {}) {
            fixture.calls.push({ method, params })
            if (method === 'ui.window.self') return { connId: 71 }
            if (method === 'ui.window.command.run') {
              if (params.connId !== 71 || params.id !== 'command:quirky.reviews/ui-control') return unexpectedCall(method)
              return { result: await runReviewsUiControl(context, params.args) }
            }
            if (method === 'quirky.reviews/createDraft') {
              if (options.holdDraft && !heldDraft) {
                heldDraft = true
                const pending = Promise.withResolvers()
                resolveDraft = pending.resolve
                return pending.promise
              }
              if (!failedField && options.failDraft === 'draft' && Object.hasOwn(params, 'draft')) {
                failedField = true
                throw new Error('Draft field write failed.')
              }
              if (!failedField && options.failDraft === 'template' && Object.hasOwn(params, 'useTemplate')) {
                failedField = true
                throw new Error('Template field write failed.')
              }
              if (Object.hasOwn(params, 'draft')) serverCreation.draft = params.draft
              if (Object.hasOwn(params, 'useTemplate')) serverCreation.useTemplate = params.useTemplate
              serverRevision += 1
              return {}
            }
            if (method === 'quirky.reviews/createBase') {
              if (options.holdStack && !heldStack) {
                heldStack = true
                const pending = Promise.withResolvers()
                resolveStack = pending.resolve
                return pending.promise
              }
              if (Object.hasOwn(params, 'stack')) serverCreation.eligibility.stackEnabled = params.stack
              serverRevision += 1
              return {}
            }
            return unexpectedCall(method)
          },
          getLayout() { return { worktree: '/work/browser', view: { id: 'view:quirky.reviews/create' }, panel: null, sidebar: true, focus: 'view' } },
          subscribe() { return () => {} },
          getSetting() { return undefined },
          toast() {},
          log() {}
        }
        fixture.releaseDraft = () => { if (resolveDraft) { const resolve = resolveDraft; resolveDraft = null; resolve({}) } }
        fixture.releaseStack = () => { if (resolveStack) { const resolve = resolveStack; resolveStack = null; resolve({}) } }
        let refreshedRevision = 0
        function ReviewFixture() {
          const [state, setState] = useState({ creation: { ...serverCreation, eligibility: { ...serverCreation.eligibility } } })
          const [snapshot, setSnapshot] = useState(0)
          const refresh = async () => {
            if (serverRevision === refreshedRevision) return
            refreshedRevision = serverRevision
            setState({ creation: { ...serverCreation, eligibility: { ...serverCreation.eligibility } } })
            setSnapshot((value) => value + 1)
          }
          return h(CreateReview, { context, state, refresh, snapshot })
        }
        root.render(h(ReviewFixture, { key: ++mountKey }))
      }
    })
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
      build.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => ({
        path: Bun.resolveSync(path, importer ? dirname(importer) : ROOT),
      }))
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
  pageErrors.set(page, [])
  page.on('pageerror', (error) => pageErrors.get(page)!.push(error.message))
  await page.setContent(`<html data-theme="${theme}"><head><style>${styles}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({ content: bundle })
  return page
}
async function closePage(page: Page) {
  try {
    expect(await page.evaluate(() => window.__repairFixture?.unexpected ?? [])).toEqual([])
    expect(pageErrors.get(page)).toEqual([])
  } finally { await page.close() }
}
async function mountProbe(page: Page, options: { disabled?: boolean; long?: boolean; mixed?: boolean } = {}) {
  await page.evaluate((options) => window.__repairFixture.mount(options), options)
  await page.locator('input').waitFor()
}
async function assertPluginCheckbox(page: Page, label: string, id: string, describedBy: string | null = null) {
  const input = page.getByRole('checkbox', { name: label, exact: true })
  await input.waitFor()
  expect(await input.getAttribute('id')).toBe(id)
  expect(await input.getAttribute('aria-describedby')).toBe(describedBy)
  expect(await page.locator(`label.ui-form-row__label[for="${id}"]`).innerText()).toBe(label)
  await assertBooleanRow(page, id)
  return input
}
async function waitForChecked(page: Page, id: string, checked: boolean) {
  await page.waitForFunction(({ id, checked }) => (document.getElementById(id) as HTMLInputElement | null)?.checked === checked, { id, checked })
}
async function mountAutomations(page: Page, rejectSettings = false) {
  await page.evaluate((options) => window.__repairFixture.mountAutomations(options), { rejectSettings })
}
async function mountTasks(page: Page, rejectPreferences = false) {
  await page.evaluate((options) => window.__repairFixture.mountTasks(options), { rejectPreferences })
}
async function mountReview(page: Page, provider: 'github' | 'gitlab', options: {
  submitting?: boolean
  generating?: boolean
  stackSupported?: boolean
  failDraft?: 'draft' | 'template'
  holdDraft?: boolean
  holdStack?: boolean
} = {}) {
  await page.evaluate(({ provider, options }) => window.__repairFixture.mountReview(provider, options), { provider, options })
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
    } finally { await closePage(page) }
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
    } finally { await closePage(page) }
  })
}

for (const theme of ['dark', 'light']) for (const width of [1000, 320]) {
  for (const purpose of ['files', 'markdown-open'] as const) {
    test(`Quick Open selection and navigation ${purpose} ${theme} ${width}`, async () => {
      const page = await pageFor(theme, width)
      try {
        await page.evaluate((purpose) => window.__repairFixture.mountQuick(purpose, true), purpose)
        const options = page.getByRole('option')
        await options.nth(1).waitFor()
        const input = page.getByRole('textbox')
        expect(await input.evaluate((node) => node === document.activeElement)).toBe(true)
        const colors = theme === 'dark'
          ? { accent: 'rgb(124, 140, 255)', rail: 'rgb(12, 13, 15)', text: 'rgb(236, 238, 242)', muted: 'rgb(124, 130, 141)' }
          : { accent: 'rgb(91, 108, 255)', rail: 'rgb(238, 240, 243)', text: 'rgb(27, 29, 34)', muted: 'rgb(128, 134, 143)' }
        const appearance = async (index: number) => options.nth(index).evaluate((node) => {
          const style = getComputedStyle(node)
          return {
            background: style.backgroundColor, name: getComputedStyle(node.querySelector('span')!).color,
            path: getComputedStyle(node.querySelector('small')!).color,
            padding: style.padding, border: style.borderWidth,
          }
        })
        expect(await appearance(0)).toEqual({ background: colors.accent, name: colors.rail, path: colors.rail, padding: '8px', border: '0px' })
        expect(await appearance(1)).toEqual({ background: 'rgba(0, 0, 0, 0)', name: colors.text, path: colors.muted, padding: '8px', border: '0px' })
        await options.first().hover()
        expect((await appearance(0)).background).toBe(colors.accent)
        const geometry = await page.getByRole('listbox').evaluate((node) => ({
          padding: getComputedStyle(node).padding,
          margins: [...node.children].map((child) => getComputedStyle(child).marginBlock),
          overflow: node.scrollWidth > node.clientWidth,
          contained: [...node.querySelectorAll('button, span, small')].every((child) => child.getBoundingClientRect().right <= node.getBoundingClientRect().right),
        }))
        expect(geometry).toEqual({ padding: '8px', margins: ['0px', '0px'], overflow: false, contained: true })
        await page.keyboard.press('ArrowDown')
        expect(await options.nth(1).getAttribute('aria-selected')).toBe('true')
        expect((await appearance(1)).path).toBe(colors.rail)
        await page.keyboard.press('Enter')
        await page.getByRole('dialog').waitFor({ state: 'detached' })
        const calls = await page.evaluate(() => window.__repairFixture.calls)
        expect(calls.filter((call) => call.method === 'quirky.editor/open')).toEqual([{
          method: 'quirky.editor/open', params: { worktree: 'worktree-1', group: 'group-1', path: 'docs/beta.md', line: 12, column: 3, focus: true, preview: false },
        }])
        expect(calls.filter((call) => call.params.action === 'record')).toEqual([{
          method: 'quirky.editor/quickOpen', params: { action: 'record', worktree: 'worktree-1', path: 'docs/beta.md' },
        }])
        await page.evaluate((purpose) => window.__repairFixture.mountQuick(purpose), purpose)
        await page.getByRole('option').first().waitFor()
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({ state: 'detached' })
        expect(await page.evaluate(() => window.__repairFixture.calls.some((call) => call.method === 'quirky.editor/open'))).toBe(false)
      } finally { await closePage(page) }
    })
  }
  test(`New Markdown template treatment and keyboard focus remain ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await page.evaluate(() => window.__repairFixture.mountQuick('markdown-new'))
      const template = page.getByRole('button', { name: 'Note templates/note.md' })
      await template.waitFor()
      expect(await page.getByRole('listbox').count()).toBe(0)
      expect(await template.evaluate((node) => getComputedStyle(node).borderWidth)).toBe('1px')
      await template.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      expect(await template.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none')
    } finally { await closePage(page) }
  })
}
async function waitForMethodCount(page: Page, method: string, count: number) {
  await page.waitForFunction(({ method, count }) =>
    window.__repairFixture.calls.filter((call) => call.method === method).length >= count, { method, count })
}
for (const theme of ['dark', 'light']) for (const width of [1000, 320]) {
  test(`Automations settings retain label and Space routes ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountAutomations(page)
      const sidebar = await assertPluginCheckbox(page, 'Show Automations Button', 'auto-setting-sidebar', 'auto-setting-sidebar-help')
      const deletion = await assertPluginCheckbox(page, 'Ask Before Deleting Automations', 'auto-setting-delete', 'auto-setting-delete-help')
      expect(await page.locator('#auto-setting-sidebar-help').innerText()).toBe('Show the Automations shortcut in the sidebar.')
      expect(await page.locator('#auto-setting-delete-help').innerText()).toBe('Show a confirmation before deleting automations and their run history.')

      await page.locator('label[for="auto-setting-sidebar"]').click()
      await waitForChecked(page, 'auto-setting-sidebar', false)
      await deletion.focus()
      await page.keyboard.press('Space')
      await waitForChecked(page, 'auto-setting-delete', false)
      expect(await page.evaluate(() => window.__repairFixture.calls)).toEqual([
        { method: 'setting.set', params: { id: 'setting:quirky.automations/show-automations-button', value: false } },
        { method: 'setting.set', params: { id: 'setting:quirky.automations/ask-before-delete', value: false } }
      ])
    } finally { await closePage(page) }
  })
  test(`Automations rejected save keeps the native setting ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountAutomations(page, true)
      const sidebar = await assertPluginCheckbox(page, 'Show Automations Button', 'auto-setting-sidebar', 'auto-setting-sidebar-help')
      await page.locator('label[for="auto-setting-sidebar"]').click()
      await page.getByRole('alert').waitFor()
      expect(await sidebar.isChecked()).toBe(true)
      expect(await page.getByRole('alert').innerText()).toContain('Settings are read-only.')
      expect(await page.evaluate(() => window.__repairFixture.calls)).toEqual([
        { method: 'setting.set', params: { id: 'setting:quirky.automations/show-automations-button', value: false } }
      ])
    } finally { await closePage(page) }
  })
  test(`Tasks settings protect providers and save exact preference patches ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountTasks(page)
      const shortcut = await assertPluginCheckbox(page, 'Show Tasks button', 'tasks-show-button')
      const github = await assertPluginCheckbox(page, 'GitHub', 'tasks-provider-github')
      const gitlab = await assertPluginCheckbox(page, 'GitLab', 'tasks-provider-gitlab')
      const linear = await assertPluginCheckbox(page, 'Linear', 'tasks-provider-linear')
      const jira = await assertPluginCheckbox(page, 'Jira', 'tasks-provider-jira')
      await page.getByText('GitHub · Ready', { exact: true }).waitFor()
      expect(await github.isChecked()).toBe(true)
      expect(await github.isDisabled()).toBe(true)
      expect(await shortcut.isChecked()).toBe(true)
      expect(await gitlab.isChecked()).toBe(false)
      expect(await linear.isChecked()).toBe(false)
      expect(await jira.isChecked()).toBe(false)
      const initialCallCount = await page.evaluate(() => window.__repairFixture.calls.length)

      await page.locator('label[for="tasks-provider-github"]').click({ force: true })
      await github.focus()
      await page.keyboard.press('Space')
      expect(await github.isChecked()).toBe(true)
      expect((await page.evaluate(() => window.__repairFixture.calls.slice())).filter((call) => call.method === 'quirky.tasks/preferences')).toEqual([])

      await page.locator('label[for="tasks-provider-gitlab"]').click()
      await waitForChecked(page, 'tasks-provider-gitlab', true)
      await waitForMethodCount(page, 'quirky.tasks/preferences', 1)
      await gitlab.focus()
      await page.keyboard.press('Space')
      await waitForChecked(page, 'tasks-provider-gitlab', false)
      await waitForMethodCount(page, 'quirky.tasks/preferences', 2)
      await shortcut.focus()
      await page.keyboard.press('Space')
      await waitForChecked(page, 'tasks-show-button', false)
      await waitForMethodCount(page, 'quirky.tasks/preferences', 3)

      const calls = await page.evaluate((start) => window.__repairFixture.calls.slice(start), initialCallCount)
      expect(calls.map((call) => call.method)).toEqual([
        'quirky.tasks/preferences', 'quirky.tasks/state',
        'quirky.tasks/preferences', 'quirky.tasks/state',
        'quirky.tasks/preferences', 'quirky.tasks/state'
      ])
      expect(calls.filter((call) => call.method === 'quirky.tasks/preferences').map((call) => call.params)).toEqual([
        { visibleTaskProviders: ['github', 'gitlab'] },
        { visibleTaskProviders: ['github'] },
        { showTasksButton: false }
      ])
    } finally { await closePage(page) }
  })
  test(`Tasks rejected preference save retains its checked state ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountTasks(page, true)
      const shortcut = await assertPluginCheckbox(page, 'Show Tasks button', 'tasks-show-button')
      await page.getByText('GitHub · Ready', { exact: true }).waitFor()
      await page.locator('label[for="tasks-show-button"]').click()
      await page.getByRole('alert').waitFor()
      expect(await shortcut.isChecked()).toBe(true)
      expect(await page.getByRole('alert').innerText()).toContain('Preferences are read-only.')
      expect((await page.evaluate(() => window.__repairFixture.calls)).filter((call) => call.method === 'quirky.tasks/preferences')).toEqual([
        { method: 'quirky.tasks/preferences', params: { showTasksButton: false } }
      ])
    } finally { await closePage(page) }
  })
}
for (const theme of ['dark', 'light']) for (const width of [1000, 320]) {
  test(`Reviews creation options preserve provider labels and boolean routes ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountReview(page, 'github')
      const draft = await assertPluginCheckbox(page, 'Create as draft', 'review-create-draft')
      const template = await assertPluginCheckbox(page, 'Use repository pull-request template when the description is empty', 'review-use-template')
      const stack = await assertPluginCheckbox(page, 'Create pull request in stack with #42', 'review-create-stack')

      await page.locator('label[for="review-create-draft"]').click()
      await waitForChecked(page, 'review-create-draft', true)
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 1)
      await template.focus()
      await page.keyboard.press('Space')
      await waitForChecked(page, 'review-use-template', true)
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 2)
      await page.locator('label[for="review-create-stack"]').click()
      await waitForMethodCount(page, 'quirky.reviews/createBase', 1)
      await waitForChecked(page, 'review-create-stack', true)
      await stack.focus()
      await page.keyboard.press('Space')
      await waitForMethodCount(page, 'quirky.reviews/createBase', 2)
      await waitForChecked(page, 'review-create-stack', false)

      const githubCalls = await page.evaluate(() => window.__repairFixture.calls)
      expect(githubCalls.filter((call) => call.method === 'quirky.reviews/createDraft').map((call) => call.params)).toEqual([
        { worktree: '/work/browser', draft: true, generation: 1 },
        { worktree: '/work/browser', useTemplate: true, generation: 1 }
      ])
      expect(githubCalls.filter((call) => call.method === 'quirky.reviews/createBase').map((call) => call.params)).toEqual([
        { worktree: '/work/browser', base: 'main', stack: true, generation: 1 },
        { worktree: '/work/browser', base: 'main', stack: false, generation: 1 }
      ])
      const controlCalls = githubCalls.filter((call) => call.method === 'ui.window.command.run').map((call) => {
        const args = call.params.args as { action: string; value?: unknown }
        return { id: call.params.id, connId: call.params.connId, action: args.action, value: args.value }
      })
      expect(controlCalls).toEqual([
        { id: 'command:quirky.reviews/ui-control', connId: 71, action: 'stack-set', value: { enabled: true } },
        { id: 'command:quirky.reviews/ui-control', connId: 71, action: 'stack-set', value: { enabled: false } }
      ])
      expect(githubCalls.some((call) => call.method === 'quirky.reviews/createSubmit')).toBe(false)

      await mountReview(page, 'gitlab')
      const gitlabDraft = await assertPluginCheckbox(page, 'Create as draft', 'review-create-draft')
      const gitlabTemplate = await assertPluginCheckbox(page, 'Use repository merge-request template when the description is empty', 'review-use-template')
      expect(await page.locator('#review-create-stack').count()).toBe(0)
      await gitlabDraft.focus()
      await page.keyboard.press('Space')
      await waitForChecked(page, 'review-create-draft', true)
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 1)
      await page.locator('label[for="review-use-template"]').click()
      await waitForChecked(page, 'review-use-template', true)
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 2)
      expect(await page.evaluate(() => window.__repairFixture.calls.filter((call) => call.method === 'quirky.reviews/createDraft').map((call) => call.params))).toEqual([
        { worktree: '/work/browser', draft: true, generation: 1 },
        { worktree: '/work/browser', useTemplate: true, generation: 1 }
      ])
      expect(await page.evaluate(() => window.__repairFixture.calls.some((call) => call.method === 'quirky.reviews/createSubmit'))).toBe(false)
      expect(await gitlabDraft.getAttribute('aria-describedby')).toBe(null)
      expect(await gitlabTemplate.getAttribute('aria-describedby')).toBe(null)
    } finally { await closePage(page) }
  })
  test(`Reviews draft and template errors associate and clear on successful writes ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountReview(page, 'github', { failDraft: 'draft' })
      const draft = await assertPluginCheckbox(page, 'Create as draft', 'review-create-draft')
      await page.locator('label[for="review-create-draft"]').click()
      const draftError = page.locator('#review-create-draft-error')
      await draftError.waitFor()
      expect(await draft.getAttribute('aria-describedby')).toBe('review-create-draft-error')
      expect(await draft.getAttribute('aria-invalid')).toBe('true')
      expect(await draftError.innerText()).toBe('Draft field write failed.')
      await assertBooleanRow(page, 'review-create-draft')
      await draft.focus()
      await page.keyboard.press('Space')
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 2)
      await draftError.waitFor({ state: 'detached' })
      expect(await draft.getAttribute('aria-describedby')).toBe(null)
      expect(await draft.getAttribute('aria-invalid')).toBe(null)
      expect(await page.evaluate(() => window.__repairFixture.calls.filter((call) => call.method === 'quirky.reviews/createDraft').map((call) => call.params))).toEqual([
        { worktree: '/work/browser', draft: true, generation: 1 },
        { worktree: '/work/browser', draft: false, generation: 1 }
      ])

      await mountReview(page, 'gitlab', { failDraft: 'template' })
      const template = await assertPluginCheckbox(page, 'Use repository merge-request template when the description is empty', 'review-use-template')
      await template.focus()
      await page.keyboard.press('Space')
      const templateError = page.locator('#review-use-template-error')
      await templateError.waitFor()
      expect(await template.getAttribute('aria-describedby')).toBe('review-use-template-error')
      expect(await template.getAttribute('aria-invalid')).toBe('true')
      expect(await templateError.innerText()).toBe('Template field write failed.')
      await assertBooleanRow(page, 'review-use-template')
      await page.locator('label[for="review-use-template"]').click()
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 2)
      await templateError.waitFor({ state: 'detached' })
      expect(await template.getAttribute('aria-describedby')).toBe(null)
      expect(await template.getAttribute('aria-invalid')).toBe(null)
      expect(await page.evaluate(() => window.__repairFixture.calls.filter((call) => call.method === 'quirky.reviews/createDraft').map((call) => call.params))).toEqual([
        { worktree: '/work/browser', useTemplate: true, generation: 1 },
        { worktree: '/work/browser', useTemplate: false, generation: 1 }
      ])
    } finally { await closePage(page) }
  })
  test(`Reviews fieldset locks block labels and Space ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      for (const lock of ['submitting', 'generating'] as const) {
        await mountReview(page, 'github', { [lock]: true })
        const ids = ['review-create-draft', 'review-use-template', 'review-create-stack']
        for (const id of ids) {
          const input = page.locator(`#${id}`)
          await input.waitFor()
          expect(await input.isDisabled()).toBe(true)
        }
        expect(await page.locator('fieldset').evaluate((node) => (node as HTMLFieldSetElement).disabled)).toBe(true)
        for (const id of ids) {
          await page.locator(`label[for="${id}"]`).click({ force: true })
          await page.evaluate((id) => (document.getElementById(id) as HTMLInputElement).focus(), id)
          await page.keyboard.press('Space')
          expect(await page.locator(`#${id}`).isChecked()).toBe(false)
        }
        expect(await page.evaluate(() => window.__repairFixture.calls)).toEqual([])
      }

      await mountReview(page, 'github', { holdDraft: true })
      await assertPluginCheckbox(page, 'Create as draft', 'review-create-draft')
      const template = await assertPluginCheckbox(page, 'Use repository pull-request template when the description is empty', 'review-use-template')
      const stack = await assertPluginCheckbox(page, 'Create pull request in stack with #42', 'review-create-stack')
      await page.locator('label[for="review-create-draft"]').click()
      await waitForMethodCount(page, 'quirky.reviews/createDraft', 1)
      await page.getByRole('button', { name: 'Create PR', exact: true }).click()
      await page.waitForFunction(() => (document.querySelector('fieldset') as HTMLFieldSetElement | null)?.disabled === true)
      expect(await page.locator('#review-create-draft').isDisabled()).toBe(true)
      expect(await template.isDisabled()).toBe(true)
      expect(await stack.isDisabled()).toBe(true)
      await page.locator('label[for="review-use-template"]').click({ force: true })
      await page.evaluate(() => (document.getElementById('review-use-template') as HTMLInputElement).focus())
      await page.keyboard.press('Space')
      await page.locator('label[for="review-create-draft"]').click({ force: true })
      await page.evaluate(() => (document.getElementById('review-create-draft') as HTMLInputElement).focus())
      await page.keyboard.press('Space')
      expect(await template.isChecked()).toBe(false)
      expect(await page.locator('#review-create-draft').isChecked()).toBe(true)
      expect((await page.evaluate(() => window.__repairFixture.calls)).filter((call) => call.method === 'quirky.reviews/createDraft')).toEqual([
        { method: 'quirky.reviews/createDraft', params: { worktree: '/work/browser', draft: true, generation: 1 } }
      ])
      expect(await page.evaluate(() => window.__repairFixture.calls.some((call) => call.method === 'quirky.reviews/createSubmit'))).toBe(false)
    } finally { await closePage(page) }
  })
  test(`Reviews stack option locks its native input while saving ${theme} ${width}`, async () => {
    const page = await pageFor(theme, width)
    try {
      await mountReview(page, 'github', { holdStack: true })
      const stack = await assertPluginCheckbox(page, 'Create pull request in stack with #42', 'review-create-stack')
      expect(await stack.isDisabled()).toBe(false)
      await page.locator('label[for="review-create-stack"]').click()
      await waitForMethodCount(page, 'quirky.reviews/createBase', 1)
      await page.waitForFunction(() => (document.getElementById('review-create-stack') as HTMLInputElement | null)?.matches(':disabled') === true)
      expect(await stack.isDisabled()).toBe(true)
      await page.locator('label[for="review-create-stack"]').click({ force: true })
      await page.evaluate(() => (document.getElementById('review-create-stack') as HTMLInputElement).focus())
      await page.keyboard.press('Space')
      expect(await stack.isChecked()).toBe(false)
      const calls = await page.evaluate(() => window.__repairFixture.calls)
      expect(calls.filter((call) => call.method === 'quirky.reviews/createBase')).toEqual([
        { method: 'quirky.reviews/createBase', params: { worktree: '/work/browser', base: 'main', stack: true, generation: 1 } }
      ])
      expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
    } finally { await closePage(page) }
  })
}
