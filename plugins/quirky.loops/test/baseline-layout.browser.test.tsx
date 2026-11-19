import { afterAll, beforeAll, expect, test } from 'bun:test'
import { dirname, join, resolve } from 'node:path'
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
const FIXTURE_ENTRY = join(ROOT, 'plugins/quirky.loops/test/baseline-layout-fixture.ts')
const THEMES = ['dark', 'light'] as const
const VIEWPORTS = [
  { name: '1000x900', width: 1000, height: 900 },
  { name: '320x600', width: 320, height: 600 }
] as const
const BOOLEAN_LABELS = [
  'Start over when the queue is empty',
  'Pause after 3 iterations with no changes',
  'Commit a checkpoint after each iteration',
  'Ask before each new iteration',
  'Resume when the usage limit resets'
]
const ADVANCED_BOOLEAN_LABELS = BOOLEAN_LABELS.slice(1)

type BrowserAction = { action?: string; params?: Record<string, unknown> }
type BrowserCommand = { id: string; args: BrowserAction }
type BrowserCall = { method: string; params: Record<string, unknown> }
type BrowserRead = {
  draft: Record<string, unknown>
  canStart: boolean
  busy: boolean
  loading: boolean
}
type FixtureOptions = {
  workspaceKind?: 'git' | 'folder'
  failCreate?: boolean
  holdCreate?: boolean
  holdAction?: string
  failAction?: string
}

declare global {
  interface Window {
    __loopsFixture: {
      calls: BrowserCall[]
      commandCalls: BrowserCommand[]
      createCalls: BrowserCall[]
      unexpected: string[]
      patches: Record<string, unknown>[]
      toasts: { title: string; body: string }[]
      closeCount: number
      createdCount: number
      mount(options?: FixtureOptions): void
      mountDuplicates(): void
      mountEditing(options?: { disabled?: boolean }): void
      ready(): boolean
      read(index?: number): BrowserRead | null
      releaseCreate(): void
      releaseAction(): void
    }
  }
}

let browser: Browser
let bundle = ''
let styles = ''
const pageErrors = new WeakMap<Page, string[]>()

function browserEntry(): string {
  const setupDialog = join(ROOT, 'plugins/quirky.loops/window/SetupDialog.tsx')
  const configForm = join(ROOT, 'plugins/quirky.loops/window/config-form.tsx')
  return `
    import { createElement as h, Fragment } from 'react'
    import { createRoot } from 'react-dom/client'
    import { SetupDialog } from ${JSON.stringify(setupDialog)}
    import { ConfigFields, initialDraft } from ${JSON.stringify(configForm)}

    const root = createRoot(document.getElementById('root'))
    let mountKey = 0
    let handles = []
    let reports = []
    let settings = {}
    let releaseCreateGate = null
    let releaseActionGate = null
    const fixture = {
      calls: [], commandCalls: [], createCalls: [], unexpected: [], patches: [], toasts: [],
      closeCount: 0, createdCount: 0,
      reset(options = {}) {
        settings = options
        handles = []
        reports = []
        releaseCreateGate = null
        releaseActionGate = null
        fixture.calls.length = 0
        fixture.commandCalls.length = 0
        fixture.createCalls.length = 0
        fixture.unexpected.length = 0
        fixture.patches.length = 0
        fixture.toasts.length = 0
        fixture.closeCount = 0
        fixture.createdCount = 0
      },
      context(index) {
        return {
          async call(method, params = {}) {
            fixture.calls.push({ method, params })
            if (method === 'quirky.worktree/show') {
              return { id: 'wt-1', kind: settings.workspaceKind || 'git', path: '/work/project', name: 'project' }
            }
            if (method === 'quirky.agents/list') {
              return {
                defaultAgent: 'codex',
                agents: [
                  { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: false },
                  { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true }
                ]
              }
            }
            if (method === 'quirky.loops/list') return []
            if (method === 'quirky.loops/create') {
              fixture.createCalls.push({ method, params })
              if (settings.holdCreate) await new Promise((resolve) => { releaseCreateGate = resolve })
              if (settings.failCreate) throw new Error('runner refused this loop')
              return { id: 'loop-1', name: 'Do the work', worktreeId: 'wt-1', state: 'running' }
            }
            fixture.unexpected.push(method)
            throw new Error('Unexpected local fixture call ' + method)
          },
          async executeCommand(id, args = {}) {
            fixture.commandCalls.push({ id, args })
            if (id !== 'command:quirky.loops/setup-action') {
              fixture.unexpected.push(id)
              throw new Error('Unexpected command ' + id)
            }
            if (settings.holdAction === args.action) {
              await new Promise((resolve) => { releaseActionGate = resolve })
            }
            if (settings.failAction === args.action) throw new Error('bridge refused')
            const handle = handles[index]
            if (!handle) throw new Error('The local setup surface is unavailable.')
            return handle.dispatch(args.action, args.params || {})
          },
          toast(title, body) { fixture.toasts.push({ title, body }) }
        }
      },
      props(index) {
        const context = fixture.context(index)
        return {
          context,
          workspace: 'workspace-selector',
          onClose() { fixture.closeCount += 1 },
          async onCreated() { fixture.createdCount += 1 },
          onHandle(handle) { handles[index] = handle },
          report(state) { reports[index] = state }
        }
      },
      mount(options = {}) {
        fixture.reset(options)
        root.render(h(SetupDialog, { ...fixture.props(0), key: ++mountKey }))
      },
      mountDuplicates() {
        fixture.reset()
        root.render(h(Fragment, null,
          h(SetupDialog, { ...fixture.props(0), key: ++mountKey }),
          h(SetupDialog, { ...fixture.props(1), key: ++mountKey })
        ))
      },
      mountEditing(options = {}) {
        fixture.reset()
        const draft = {
          ...initialDraft(),
          preset: 'queue',
          advanced: true,
          repeatQueue: false,
          noProgress: true,
          checkpointCommits: false,
          askBeforeNext: false,
          resumeAtLimitReset: false
        }
        root.render(h(ConfigFields, {
          key: ++mountKey,
          draft,
          errors: {},
          workspaceKind: 'git',
          showCost: true,
          editing: true,
          disabled: options.disabled === true,
          onChange(patch) { fixture.patches.push(patch) }
        }))
      },
      ready() { return reports.length > 0 && reports.every((report) => report && report.loading === false) },
      read(index = 0) { return handles[index] ? handles[index].read() : null },
      releaseCreate() {
        const release = releaseCreateGate
        releaseCreateGate = null
        if (release) release()
      },
      releaseAction() {
        const release = releaseActionGate
        releaseActionGate = null
        if (release) release()
      }
    }
    window.__loopsFixture = fixture
  `
}

const browserDependencyResolver: Bun.BunPlugin = {
  name: 'loops-baseline-layout-browser',
  setup(builder) {
    builder.onResolve({ filter: /baseline-layout-fixture\.ts$/ }, () => ({
      path: 'entry',
      namespace: 'loops-baseline-entry'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'loops-baseline-entry' }, () => ({
      contents: browserEntry(),
      loader: 'ts',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
    builder.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => ({
      path: Bun.resolveSync(path, importer ? dirname(importer) : ROOT)
    }))
  }
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
    cursor = match.index! + match[0].length
  }
  return result + source.slice(cursor)
}

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [FIXTURE_ENTRY],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The Loops baseline-layout browser bundle was empty.')
  bundle = await output.text()
  styles = `${await expandStyles(new URL('../../../packages/ui/src/shell/chrome.css', import.meta.url))}\n${await expandStyles(new URL('../../../packages/ui/src/styles.css', import.meta.url))}`
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

async function pageFor(theme: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport })
  pageErrors.set(page, [])
  page.on('pageerror', (error) => pageErrors.get(page)!.push(error.message))
  await page.setContent(`<html data-theme="${theme}"><head><style>${styles}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({ content: bundle })
  return page
}

async function closePage(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      window.__loopsFixture?.releaseCreate()
      window.__loopsFixture?.releaseAction()
    })
    expect(await page.evaluate(() => window.__loopsFixture?.unexpected ?? [])).toEqual([])
    expect(pageErrors.get(page)).toEqual([])
  } finally {
    await page.close()
  }
}

function matrixTest(
  name: string,
  run: (page: Page, viewport: (typeof VIEWPORTS)[number]) => Promise<void>
): void {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${name} (${theme}, ${viewport.name})`, async () => {
        const page = await pageFor(theme, viewport)
        try {
          await run(page, viewport)
        } finally {
          await closePage(page)
        }
      }, 30_000)
    }
  }
}

async function mountSetup(page: Page, options: FixtureOptions = {}): Promise<void> {
  await page.evaluate((fixtureOptions) => window.__loopsFixture.mount(fixtureOptions), options)
  await page.locator('.ui-dialog').first().waitFor()
  await page.waitForFunction(() => window.__loopsFixture.ready())
}

async function mountEditing(page: Page, disabled = false): Promise<void> {
  await page.evaluate((options) => window.__loopsFixture.mountEditing(options), { disabled })
  await page.getByRole('checkbox', { name: BOOLEAN_LABELS[0], exact: true }).waitFor()
}

async function booleanGeometry(page: Page, labels: string[]) {
  return page.evaluate((expectedLabels) => expectedLabels.map((expectedLabel) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('.ui-form-row')).find((candidate) =>
      candidate.querySelector('.ui-form-row__label')?.textContent?.trim() === expectedLabel)
    const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const label = row?.querySelector<HTMLLabelElement>('.ui-form-row__label')
    if (!row || !input || !label) return { present: false as const, label: expectedLabel }
    const range = document.createRange()
    range.selectNodeContents(label)
    const firstLine = range.getClientRects().item(0)
    if (!firstLine) return { present: false as const, label: expectedLabel }
    const inputRect = input.getBoundingClientRect()
    const labelRect = label.getBoundingClientRect()
    const help = Array.from(row.querySelectorAll<HTMLElement>('.ui-help-text')).map((node) => ({
      id: node.id,
      left: node.getBoundingClientRect().left
    }))
    return {
      present: true as const,
      label: expectedLabel,
      labelText: label.textContent?.trim() || '',
      htmlFor: label.htmlFor,
      id: input.id,
      idCount: input.id
        ? Array.from(document.querySelectorAll<HTMLElement>('[id]')).filter((node) => node.id === input.id).length
        : 0,
      inputType: input.type,
      inputClass: input.className,
      accessibleName: input.getAttribute('aria-label'),
      describedBy: input.getAttribute('aria-describedby') || '',
      inline: row.classList.contains('ui-form-row--inline'),
      width: inputRect.width,
      height: inputRect.height,
      gap: labelRect.left - inputRect.right,
      centerDelta: Math.abs((inputRect.top + inputRect.height / 2) - (firstLine.top + firstLine.height / 2)),
      labelLeft: labelRect.left,
      help
    }
  }), labels)
}

async function assertInlineBooleanRows(page: Page, labels: string[]): Promise<string[]> {
  const rows = await booleanGeometry(page, labels)
  const ids: string[] = []
  for (const row of rows) {
    expect(row.present).toBe(true)
    if (!row.present) continue
    expect(row.inline).toBe(true)
    expect(row.inputType).toBe('checkbox')
    expect(row.inputClass.split(/\s+/)).toContain('ui-checkbox__input')
    expect(row.id).not.toBe('')
    expect(row.idCount).toBe(1)
    expect(row.htmlFor).toBe(row.id)
    expect(row.accessibleName).toBe(row.labelText)
    expect(row.labelText).toBe(row.label)
    expect(Math.abs(row.width - 14)).toBeLessThanOrEqual(1)
    expect(Math.abs(row.height - 14)).toBeLessThanOrEqual(1)
    expect(Math.abs(row.gap - 8)).toBeLessThanOrEqual(1)
    expect(row.centerDelta).toBeLessThanOrEqual(1)
    for (const help of row.help) {
      expect(row.describedBy.split(/\s+/)).toContain(help.id)
      expect(Math.abs(help.left - row.labelLeft)).toBeLessThanOrEqual(0.5)
    }
    ids.push(row.id)
  }
  expect(new Set(ids).size).toBe(ids.length)
  return ids
}

async function footerGeometry(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.ui-dialog')
    const body = document.querySelector<HTMLElement>('.ui-dialog__body')
    const footer = document.querySelector<HTMLElement>('.ui-dialog__actions')
    const form = document.querySelector<HTMLFormElement>('form[aria-label="New loop"]')
    const header = document.querySelector<HTMLElement>('.ui-dialog__header')
    if (!dialog || !body || !footer || !form || !header) return null
    const dialogRect = dialog.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const footerRect = footer.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const buttons = Array.from(footer.querySelectorAll<HTMLButtonElement>('button'))
    const buttonRects = buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      return {
        text: button.textContent?.trim() || '',
        type: button.type,
        formAttribute: button.getAttribute('form'),
        associatedForm: button.form === form,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        disabled: button.disabled
      }
    })
    const dialogStyle = getComputedStyle(dialog)
    const bodyStyle = getComputedStyle(body)
    return {
      formId: form.id,
      formContainsFooter: form.contains(footer),
      bodyContainsForm: body.contains(form),
      footerIsDialogChild: footer.parentElement === dialog,
      submitFormId: buttons.find((button) => button.type === 'submit')?.getAttribute('form') || null,
      dialogHasScrollBody: dialog.classList.contains('ui-dialog--scroll-body'),
      dialog: {
        left: dialogRect.left,
        right: dialogRect.right,
        top: dialogRect.top,
        bottom: dialogRect.bottom,
        padding: dialogStyle.padding,
        gap: dialogStyle.gap,
        borderLeft: parseFloat(dialogStyle.borderLeftWidth),
        borderRight: parseFloat(dialogStyle.borderRightWidth),
        borderTop: parseFloat(dialogStyle.borderTopWidth),
        borderBottom: parseFloat(dialogStyle.borderBottomWidth),
        boxShadow: dialogStyle.boxShadow
      },
      header: { top: headerRect.top, bottom: headerRect.bottom },
      body: {
        top: bodyRect.top,
        bottom: bodyRect.bottom,
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        scrollTop: body.scrollTop,
        overflowY: bodyStyle.overflowY
      },
      footer: { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom },
      buttons: buttonRects,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth
    }
  })
}

type FooterPosition = {
  dialog: { top: number; bottom: number }
  header: { top: number; bottom: number }
  footer: { top: number; bottom: number }
  innerHeight: number
}

function expectFooterInsideViewport(geometry: FooterPosition): void {
  expect(geometry.footer.top).toBeGreaterThanOrEqual(geometry.dialog.top - 1)
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.dialog.bottom + 1)
  expect(geometry.footer.top).toBeGreaterThanOrEqual(15)
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.innerHeight - 15)
  expect(geometry.header.top).toBeGreaterThanOrEqual(geometry.dialog.top - 1)
  expect(geometry.header.bottom).toBeLessThanOrEqual(geometry.dialog.bottom + 1)
}

async function waitForDraft(page: Page, key: string, value: unknown): Promise<void> {
  await page.waitForFunction(({ key, value }) => window.__loopsFixture.read()?.draft?.[key] === value, { key, value })
}
async function waitForCanStart(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__loopsFixture.read()?.canStart === true)
}

async function queueOnePrompt(page: Page, prompt: string): Promise<void> {
  await page.getByLabel('Run', { exact: true }).selectOption('queue')
  await page.getByLabel('New queue item', { exact: true }).waitFor()
  await page.getByLabel('New queue item', { exact: true }).fill(prompt)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await page.getByLabel('Queue item 1', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const items = window.__loopsFixture.read()?.draft.queueItems
    return Array.isArray(items) && items.length === 1 && window.__loopsFixture.read()?.canStart === true
  })
}

matrixTest('New loop actions use the shared scrollable dialog footer', async (page) => {
  await mountSetup(page)
  const footer = page.locator('.ui-dialog__actions')
  expect(await footer.count()).toBe(1)
  const geometry = await footerGeometry(page)
  expect(geometry).not.toBeNull()
  if (!geometry) return
  expect(geometry.dialogHasScrollBody).toBe(true)
  expect(geometry.bodyContainsForm).toBe(true)
  expect(geometry.formContainsFooter).toBe(false)
  expect(geometry.footerIsDialogChild).toBe(true)
  expect(geometry.formId).not.toBe('')
  expect(geometry.submitFormId).toBe(geometry.formId)
  expect(geometry.buttons.map((button) => button.text)).toEqual(['Cancel', 'Start loop'])
  expect(geometry.buttons.map((button) => button.type)).toEqual(['button', 'submit'])
  expect(geometry.buttons[0]?.associatedForm).toBe(false)
  expect(geometry.buttons[1]?.associatedForm).toBe(true)
  expect(geometry.dialog.padding).toBe('16px')
  expect(geometry.dialog.gap).toBe('12px')
  expect(geometry.body.overflowY).toBe('auto')
  expect(Math.abs((geometry.footer.top - geometry.body.bottom) - 12)).toBeLessThanOrEqual(1)
  expect(Math.abs((geometry.dialog.right - geometry.footer.right) - geometry.dialog.borderRight - 16)).toBeLessThanOrEqual(1)
  expect(geometry.buttons).toHaveLength(2)
  expect(Math.abs((geometry.buttons[1]!.left - geometry.buttons[0]!.right) - 8)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.footer.right - geometry.buttons[1]!.right)).toBeLessThanOrEqual(1)
  expectFooterInsideViewport(geometry)
})

matrixTest('React-generated form IDs uniquely associate each external submit button', async (page) => {
  await page.evaluate(() => window.__loopsFixture.mountDuplicates())
  await page.waitForFunction(() => window.__loopsFixture.ready())
  const forms = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLFormElement>('form[aria-label="New loop"]')).map((form) => ({
    id: form.id,
    submitters: Array.from(document.querySelectorAll<HTMLButtonElement>('.ui-dialog__actions button[type="submit"]'))
      .filter((button) => button.form === form)
      .map((button) => button.getAttribute('form'))
  })))
  expect(forms).toHaveLength(2)
  expect(forms.every((form) => form.id !== '')).toBe(true)
  expect(new Set(forms.map((form) => form.id)).size).toBe(2)
  expect(forms.map((form) => form.submitters)).toEqual(forms.map((form) => [form.id]))
  expect(await page.locator('.ui-dialog__actions').count()).toBe(2)
})

matrixTest('setup and editing queue booleans retain inline geometry and boolean patches', async (page) => {
  await mountSetup(page)
  await queueOnePrompt(page, 'Queue a task')
  await page.getByRole('button', { name: /Advanced/ }).click()
  await page.getByRole('checkbox', { name: ADVANCED_BOOLEAN_LABELS[0], exact: true }).waitFor()
  const setupIds = await assertInlineBooleanRows(page, BOOLEAN_LABELS)

  const updates = [
    { label: BOOLEAN_LABELS[0], key: 'repeatQueue', value: true },
    { label: BOOLEAN_LABELS[1], key: 'noProgress', value: false },
    { label: BOOLEAN_LABELS[2], key: 'checkpointCommits', value: true },
    { label: BOOLEAN_LABELS[3], key: 'askBeforeNext', value: true },
    { label: BOOLEAN_LABELS[4], key: 'resumeAtLimitReset', value: true }
  ]
  for (const update of updates) {
    await page.getByRole('checkbox', { name: update.label, exact: true }).click()
    await waitForDraft(page, update.key, update.value)
  }
  const patches = await page.evaluate(() => window.__loopsFixture.commandCalls
    .filter((call) => call.id === 'command:quirky.loops/setup-action' && call.args.action === 'update')
    .map((call) => call.args.params?.patch))
  expect(patches).toContainEqual({ repeatQueue: true })
  expect(patches).toContainEqual({ noProgress: false })
  expect(patches).toContainEqual({ checkpointCommits: true })
  expect(patches).toContainEqual({ askBeforeNext: true })
  expect(patches).toContainEqual({ resumeAtLimitReset: true })
  expect(new Set(setupIds).size).toBe(BOOLEAN_LABELS.length)

  await page.evaluate(() => window.__loopsFixture.mountEditing())
  await page.getByRole('checkbox', { name: BOOLEAN_LABELS[0], exact: true }).waitFor()
  const editingIds = await assertInlineBooleanRows(page, BOOLEAN_LABELS)
  for (const update of updates) {
    await page.getByRole('checkbox', { name: update.label, exact: true }).click()
  }
  const editingPatches = await page.evaluate(() => window.__loopsFixture.patches)
  expect(editingPatches).toEqual(updates.map(({ key, value }) => ({ [key]: value })))
  expect(new Set(editingIds).size).toBe(BOOLEAN_LABELS.length)
})

matrixTest('editing queue booleans preserve their native disabled state', async (page) => {
  await mountEditing(page, true)
  await assertInlineBooleanRows(page, BOOLEAN_LABELS)
  for (const label of BOOLEAN_LABELS) {
    const checkbox = page.getByRole('checkbox', { name: label, exact: true })
    expect(await checkbox.isDisabled()).toBe(true)
  }
  expect(await page.evaluate(() => window.__loopsFixture.patches)).toEqual([])
})

matrixTest('empty prompt validation stays associated with its field', async (page) => {
  await mountSetup(page)
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
  const start = page.getByRole('button', { name: 'Start loop', exact: true })
  expect(await start.isDisabled()).toBe(true)
  expect(await prompt.getAttribute('aria-invalid')).toBe('true')
  const error = page.getByRole('alert').filter({ hasText: 'Enter a prompt to start the loop.' })
  await error.waitFor()
  expect(await error.getAttribute('id')).toBe('loop-setup-prompt-error')
  const describedBy = (await prompt.getAttribute('aria-describedby'))?.split(/\s+/) ?? []
  expect(describedBy).toContain('loop-setup-prompt-error')
  expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(0)
})

matrixTest('clicking the associated footer submitter creates a queue loop once', async (page) => {
  await mountSetup(page)
  await queueOnePrompt(page, 'Use the queued prompt')
  const initialUrl = page.url()
  await page.getByRole('button', { name: 'Start loop', exact: true }).click()
  await page.waitForFunction(() => window.__loopsFixture.closeCount === 1)
  const actions = await page.evaluate(() => window.__loopsFixture.commandCalls.map((call) => call.args.action))
  expect(actions).toEqual(['update', 'queue-add', 'start'])
  const creates = await page.evaluate(() => window.__loopsFixture.createCalls)
  expect(creates).toHaveLength(1)
  expect(creates[0]?.params).toMatchObject({
    worktreeId: 'wt-1',
    config: { promptSource: { kind: 'queue', repeatQueue: false } },
    queueItems: [{ body: 'Use the queued prompt' }]
  })
  expect(await page.evaluate(() => window.__loopsFixture.createdCount)).toBe(1)
  expect(await page.url()).toBe(initialUrl)
})

matrixTest('Enter submits the form through its native associated submitter exactly once', async (page) => {
  await mountSetup(page)
  await page.getByLabel('Prompt', { exact: true }).fill('Submit with Enter')
  await waitForDraft(page, 'prompt', 'Submit with Enter')
  await page.getByLabel('Loop name', { exact: true }).fill('Keyboard start')
  await waitForDraft(page, 'name', 'Keyboard start')
  await waitForCanStart(page)
  const initialUrl = page.url()
  await page.getByLabel('Loop name', { exact: true }).press('Enter')
  await page.waitForFunction(() => window.__loopsFixture.closeCount === 1)
  const starts = await page.evaluate(() => window.__loopsFixture.commandCalls
    .filter((call) => call.args.action === 'start'))
  expect(starts).toHaveLength(1)
  expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(1)
  expect(await page.evaluate(() => window.__loopsFixture.createdCount)).toBe(1)
  expect(await page.url()).toBe(initialUrl)
})

matrixTest('Cancel is a non-submit action and routes only cancel while idle', async (page) => {
  await mountSetup(page)
  const form = page.locator('form[aria-label="New loop"]')
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  expect(await cancel.getAttribute('type')).toBe('button')
  expect(await cancel.evaluate((button: HTMLButtonElement) => button.form)).toBeNull()
  await cancel.click()
  await page.waitForFunction(() => window.__loopsFixture.closeCount === 1)
  expect(await page.evaluate(() => window.__loopsFixture.commandCalls.map((call) => call.args.action))).toEqual(['cancel'])
  expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(0)
  expect(await form.count()).toBe(1)
})

matrixTest('busy creation locks Cancel and every visible setup boolean', async (page) => {
  await mountSetup(page, { holdCreate: true })
  try {
    await queueOnePrompt(page, 'Wait for a runner')
    await page.getByRole('button', { name: /Advanced/ }).click()
    await page.getByRole('checkbox', { name: ADVANCED_BOOLEAN_LABELS[0], exact: true }).waitFor()
    await page.locator('form[aria-label="New loop"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await page.waitForFunction(() => window.__loopsFixture.createCalls.length === 1 && window.__loopsFixture.read()?.busy === true)
    await page.waitForFunction((expectedCheckboxes) => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      const cancel = buttons.find((button) => button.textContent?.trim() === 'Cancel')
      const submit = buttons.find((button) => button.type === 'submit')
      const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      return cancel?.disabled === true && submit?.disabled === true &&
        checkboxes.length === expectedCheckboxes && checkboxes.every((checkbox) => checkbox.disabled)
    }, BOOLEAN_LABELS.length)

    expect(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled()).toBe(true)
    expect(await page.locator('button[type="submit"]').isDisabled()).toBe(true)
    for (const label of BOOLEAN_LABELS) {
      expect(await page.getByRole('checkbox', { name: label, exact: true }).isDisabled()).toBe(true)
    }
    expect(await page.evaluate(() => window.__loopsFixture.commandCalls.filter((call) => call.args.action === 'cancel').length)).toBe(0)
    expect(await page.evaluate(() => window.__loopsFixture.closeCount)).toBe(0)

    await page.evaluate(() => window.__loopsFixture.releaseCreate())
    await page.waitForFunction(() => window.__loopsFixture.closeCount === 1)
    expect(await page.evaluate(() => window.__loopsFixture.commandCalls.filter((call) => call.args.action === 'start').length)).toBe(1)
  } finally {
    await page.evaluate(() => window.__loopsFixture.releaseCreate())
  }
})

matrixTest('a pending rejected setup write refuses native start until it is synced', async (page) => {
  await mountSetup(page, { holdAction: 'update', failAction: 'update' })
  try {
    await page.getByLabel('Prompt', { exact: true }).fill('Pending prompt write')
    await page.waitForFunction(() => window.__loopsFixture.commandCalls.some((call) => call.args.action === 'update'))
    expect(await page.locator('button[type="submit"]').isDisabled()).toBe(true)

    await page.locator('form[aria-label="New loop"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    expect(await page.evaluate(() => window.__loopsFixture.commandCalls.filter((call) => call.args.action === 'start').length)).toBe(0)
    expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(0)
    await page.evaluate(() => window.__loopsFixture.releaseAction())
    await page.getByText('Wait for pending setup edits to finish before starting.', { exact: true }).waitFor()
    expect(await page.evaluate(() => window.__loopsFixture.commandCalls.map((call) => call.args.action))).toEqual(['update'])
    expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(0)
    expect(await page.getByLabel('Prompt', { exact: true }).isEnabled()).toBe(true)
  } finally {
    await page.evaluate(() => window.__loopsFixture.releaseAction())
  }
})

matrixTest('a create error leaves the same editable form available', async (page) => {
  await mountSetup(page, { failCreate: true })
  await page.getByLabel('Prompt', { exact: true }).fill('Keep this draft')
  await waitForDraft(page, 'prompt', 'Keep this draft')
  await waitForCanStart(page)
  await page.getByRole('button', { name: 'Start loop', exact: true }).click()
  const error = page.locator('.ui-inline-error[role="alert"]').filter({ hasText: 'runner refused this loop' })
  await error.waitFor()
  expect(await error.textContent()).toBe('runner refused this loop')
  await page.waitForFunction(() => window.__loopsFixture.read()?.busy === false)

  expect(await page.getByLabel('Prompt', { exact: true }).inputValue()).toBe('Keep this draft')
  expect(await page.getByLabel('Prompt', { exact: true }).isEnabled()).toBe(true)
  expect(await page.getByRole('button', { name: 'Start loop', exact: true }).isEnabled()).toBe(true)
  expect(await page.evaluate(() => window.__loopsFixture.closeCount)).toBe(0)
  expect(await page.evaluate(() => window.__loopsFixture.createCalls.length)).toBe(1)
  expect(await page.evaluate(() => window.__loopsFixture.toasts)).toContainEqual({
    title: 'Could not start the loop.',
    body: 'runner refused this loop'
  })
})

matrixTest('Advanced queue content and field errors scroll without hiding the footer', async (page) => {
  await mountSetup(page)
  await page.getByLabel('Run', { exact: true }).selectOption('queue')
  const composer = page.getByLabel('New queue item', { exact: true })
  await composer.waitFor()
  for (let index = 0; index < 8; index += 1) {
    const prompt = `Queue item ${index + 1}: ${'Detailed work that should wrap within the form. '.repeat(12)}`
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await page.getByLabel(`Queue item ${index + 1}`, { exact: true }).waitFor()
  }
  await page.waitForFunction(() => {
    const items = window.__loopsFixture.read()?.draft.queueItems
    return Array.isArray(items) && items.length === 8
  })
  await page.getByRole('button', { name: /Advanced/ }).click()
  await page.getByLabel('Done check command', { exact: true }).fill('echo done')
  await page.getByLabel('Check timeout (seconds)', { exact: true }).fill('0')
  await waitForDraft(page, 'checkTimeout', '0')
  await page.getByRole('alert').filter({ hasText: 'Enter 1 to 600 seconds.' }).waitFor()
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLElement>('.ui-dialog__body')
    return body !== null && body.scrollHeight > body.clientHeight
  })

  const footer = page.locator('.ui-dialog__actions')
  expect(await footer.count()).toBe(1)
  const beforeScroll = await footerGeometry(page)
  expect(beforeScroll).not.toBeNull()
  if (!beforeScroll) return
  expect(beforeScroll.body.scrollHeight).toBeGreaterThan(beforeScroll.body.clientHeight)
  expect(beforeScroll.buttons.map((button) => button.text)).toEqual(['Cancel', 'Start loop'])
  expectFooterInsideViewport(beforeScroll)
  expect(beforeScroll.documentWidth).toBeLessThanOrEqual(beforeScroll.innerWidth)

  await page.locator('.ui-dialog__body').evaluate((body: HTMLElement) => { body.scrollTop = body.scrollHeight })
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLElement>('.ui-dialog__body')
    return body !== null && body.scrollTop > 0
  })
  const afterScroll = await footerGeometry(page)
  expect(afterScroll).not.toBeNull()
  if (!afterScroll) return
  expect(afterScroll.body.scrollTop).toBeGreaterThan(0)
  expect(Math.abs(afterScroll.footer.top - beforeScroll.footer.top)).toBeLessThanOrEqual(1)
  expect(Math.abs(afterScroll.footer.bottom - beforeScroll.footer.bottom)).toBeLessThanOrEqual(1)
  expectFooterInsideViewport(afterScroll)
  expect(afterScroll.documentWidth).toBeLessThanOrEqual(afterScroll.innerWidth)
  expect(await page.getByRole('button', { name: 'Start loop', exact: true }).isDisabled()).toBe(true)
})

matrixTest('interval controls, Git-only checkpoint, and ready-agent cost visibility are preserved', async (page) => {
  await mountSetup(page, { workspaceKind: 'git' })
  await page.getByLabel('Run', { exact: true }).selectOption('interval')
  await page.getByLabel('Run every (minutes)', { exact: true }).waitFor()
  await page.getByLabel('Counted from', { exact: true }).waitFor()
  await page.getByRole('button', { name: /Advanced/ }).click()
  await page.getByLabel('Maximum cost (USD)', { exact: true }).waitFor()
  await page.getByLabel('Commit a checkpoint after each iteration', { exact: true }).waitFor()

  await page.evaluate(() => window.__loopsFixture.mount({ workspaceKind: 'folder' }))
  await page.locator('.ui-dialog').first().waitFor()
  await page.waitForFunction(() => window.__loopsFixture.ready())
  await page.getByRole('button', { name: /Advanced/ }).click()
  await page.getByLabel('Pause after 3 iterations with no changes', { exact: true }).waitFor()
  expect(await page.getByLabel('Commit a checkpoint after each iteration', { exact: true }).count()).toBe(0)
  expect(await page.getByLabel('Maximum cost (USD)', { exact: true }).count()).toBe(1)
})

matrixTest('the dialog retains its rail scrim, field radii, and keyboard focus ring', async (page) => {
  await mountSetup(page)
  const preserved = await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>('.ui-dialog-backdrop')
    const dialog = document.querySelector<HTMLElement>('.ui-dialog')
    const scrim = backdrop ? getComputedStyle(backdrop, '::before') : null
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      '.ui-dialog input:not([type="checkbox"]), .ui-dialog textarea, .ui-dialog select'
    ))
    return {
      scrimOpacity: scrim ? parseFloat(scrim.opacity) : null,
      scrimColor: scrim?.backgroundColor || '',
      dialogShadow: dialog ? getComputedStyle(dialog).boxShadow : '',
      radii: controls.map((control) => getComputedStyle(control).borderRadius)
    }
  })
  expect(preserved.scrimOpacity).toBeCloseTo(0.4, 2)
  expect(preserved.scrimColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(preserved.dialogShadow).toBe('none')
  expect(preserved.radii.length).toBeGreaterThanOrEqual(3)
  expect(preserved.radii.every((radius) => radius === '7px')).toBe(true)

  await page.locator('.ui-dialog__close').focus()
  await page.keyboard.press('Tab')
  const focus = await page.getByLabel('Loop name', { exact: true }).evaluate((control: HTMLElement) => ({
    focused: document.activeElement === control,
    visible: control.matches(':focus-visible'),
    outlineWidth: getComputedStyle(control).outlineWidth,
    outlineStyle: getComputedStyle(control).outlineStyle
  }))
  expect(focus.focused).toBe(true)
  expect(focus.visible).toBe(true)
  expect(parseFloat(focus.outlineWidth)).toBeGreaterThan(0)
  expect(focus.outlineStyle).toBe('solid')
})
