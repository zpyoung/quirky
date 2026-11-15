import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHORD_PLATFORM } from '@quirky/protocol'
import { chromium, type Browser, type Page } from 'playwright'
import type { SourceSymbolsReport } from '../src/window/sourceNavigation'

type EditorCall = { method: string; params: Record<string, unknown> }
type NavigationLocation = {
  path: string
  relativePath: string | null
  line: number
  column: number
  endLine: number
  endColumn: number
  preview: string
}
type NavigationResponse = {
  worktreeId: string
  language: string
  locations: NavigationLocation[]
  truncated: boolean
}

// the fixture owns these globals; browser evaluation runs outside its TypeScript module.
type BrowserRaceState = {
  __bridgeGate: { method: string; promise: Promise<void> }
  __releaseBridge(): void
  __findReferences(): Promise<unknown>
  __controlResults: unknown[]
  __controlReport: { sourceSymbols: SourceSymbolsReport }
}

function expectLookupAtGreet(params: Record<string, unknown>): void {
  expect(params).toMatchObject({ worktree: `id:${WORKTREE_ID}`, path: 'src/use.ts', line: 4 })
  const column = params.column
  if (typeof column !== 'number') throw new Error('The symbol lookup did not include a numeric column.')
  expect(column).toBeGreaterThanOrEqual(27)
  expect(column).toBeLessThanOrEqual(32)
}


const ROOT = resolve(import.meta.dir, '../../..')
const EDITOR_MODULES = join(ROOT, 'plugins/quirky.editor/node_modules')
const SOURCE_FIXTURE = readFileSync(join(ROOT, 'plugins/quirky.navigation/test/fixtures/ts/src/use.ts'), 'utf8')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(EDITOR_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(EDITOR_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(EDITOR_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(EDITOR_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(EDITOR_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
  '@codemirror/view': Bun.resolveSync('@codemirror/view', EDITOR_MODULES),
  'editor-activation-fixture': join(ROOT, 'plugins/quirky.editor/src/ui.tsx')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'source-symbols-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol|@codemirror\/view|editor-activation-fixture)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/icons/icons.css',
  'packages/ui/src/design-system/editor-window.css'
]
const executable = chromium.executablePath()
const WORKTREE_ID = 'wt-source-symbols-browser'
const primaryModifier: 'Meta' | 'Control' = CHORD_PLATFORM === 'darwin' ? 'Meta' : 'Control'
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const sourceEditor = join(ROOT, 'plugins/quirky.editor/src/window/SourceEditor.tsx')
  const controls = join(ROOT, 'plugins/quirky.editor/src/window/uiControl.tsx')
  return `
    import { createElement, createRef } from 'react'
    import { createRoot } from 'react-dom/client'
    import { EditorView } from '@codemirror/view'
    import { SourceEditor, SourceEditorControlScope } from ${JSON.stringify(sourceEditor)}
    import type { SourceEditorHandle } from ${JSON.stringify(sourceEditor)}
    import { EditorUiControlProvider, createEditorUiControlReportScope, runEditorUiControl } from ${JSON.stringify(controls)}
    import { activate } from 'editor-activation-fixture'
    import type { UiPluginContext } from '@quirky/protocol'
    type BrowserCall = { method: string; params: Record<string, unknown> }
    type BrowserLocation = {
      path: string
      relativePath: string | null
      line: number
      column: number
      endLine: number
      endColumn: number
      preview: string
    }
    type BrowserRuntime = Window & {
      __unsupportedFixture?: boolean
      __editorCalls: BrowserCall[]
      __initialSelection: { anchor: number; head: number }
      __sourceSelection(): { anchor: number; head: number }
      __findReferences(): Promise<unknown>
      __controlResults: unknown[]
      __bridgeGate?: { method: string; promise: Promise<void> }
      __releaseBridge?: () => void
      __navigationResponses: Record<'definition' | 'references', {
        worktreeId: string
        language: string
        locations: BrowserLocation[]
        truncated: boolean
      }>
      __controlReport?: unknown
    }
    const browserWindow = window as BrowserRuntime

    const worktreeId = ${JSON.stringify(WORKTREE_ID)}
    const bufferId = 'buffer-source-symbols-browser'
    const tabId = 'tab-source-symbols-browser'
    const unsupported = browserWindow.__unsupportedFixture === true
    const content = unsupported ? "const greet = 'documented';\\n" : ${JSON.stringify(SOURCE_FIXTURE)}
    const relativePath = unsupported ? 'README.md' : 'src/use.ts'
    const path = '/workspace/' + relativePath
    const initialStart = content.indexOf(unsupported ? 'greet' : 'who')
    const initialSelection = { anchor: initialStart, head: initialStart + (unsupported ? 5 : 3) }
    const calls: BrowserCall[] = []
    const provided = new Map<string, (...args: unknown[]) => unknown>()
    const settings: Record<string, unknown> = { editorSidebarWidth: 300 }
    browserWindow.__editorCalls = calls
    browserWindow.__initialSelection = initialSelection
    browserWindow.__controlResults = []
    browserWindow.__sourceSelection = () => {
      const node = document.querySelector('.cm-content')
      const view = node ? EditorView.findFromDOM(node as HTMLElement) : null
      if (!view) throw new Error('The source editor is not mounted.')
      const { anchor, head } = view.state.selection.main
      return { anchor, head }
    }
    browserWindow.__navigationResponses = {
      definition: { worktreeId, language: 'typescript', locations: [], truncated: false },
      references: { worktreeId, language: 'typescript', locations: [], truncated: false }
    }
    const context = {
      pluginId: 'quirky.editor',
      provide(id: string, handler: (...args: unknown[]) => unknown) { provided.set(id, handler) },
      async call(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params: structuredClone(params) })
        const gate = browserWindow.__bridgeGate
        if (gate?.method === method) await gate.promise
        if (method === 'ui.window.self') return { connId: 22 }
        if (method === 'ui.window.command.run') {
          if (params.connId !== 22) throw new Error('The source-symbol bridge used a different window.')
          const handler = provided.get(String(params.id))
          if (!handler) throw new Error('The source-symbol command bridge was not activated.')
          if (params.id === 'command:quirky.editor/ui-control' && handler !== runEditorUiControl) {
            throw new Error('The activated UI-control command did not use runEditorUiControl.')
          }
          const result = { result: await handler(params.args) }
          browserWindow.__controlResults.push(result)
          return result
        }
        if (method === 'quirky.navigation/definition' || method === 'quirky.navigation/references') {
          const kind = method.endsWith('/definition') ? 'definition' : 'references'
          return structuredClone(browserWindow.__navigationResponses[kind])
        }
        if (method === 'quirky.editor/open') {
          if (params.window !== 22) throw new Error('A source location was opened without this window identity.')
          return { openedTabId: 'tab-opened-source-location', bufferId: 'buffer-opened-source-location' }
        }
        return {}
      },
      subscribe() { return () => {} },
      onConnection() { return () => {} },
      getSetting(name: string) { return settings[name] },
      getLayout() { return { worktree: worktreeId, view: null, panel: null, sidebar: true, focus: 'view' } },
      setContext() {},
      toast() {},
      togglePanel() {},
      executeCommand() { return Promise.resolve() },
      openView() { return Promise.resolve() },
      confirm() { return Promise.resolve(false) },
      nativeDropPaths() { return Promise.resolve(null) }
    }
    activate(context as unknown as UiPluginContext)
    const scope = createEditorUiControlReportScope((report) => {
      browserWindow.__controlReport = report
    }, { surface: 'view:quirky.editor/document', context: context as unknown as UiPluginContext })
    scope.report({ mounted: true })
    const buffer = {
      id: bufferId,
      worktreeId,
      root: '/workspace',
      path,
      relativePath,
      name: relativePath.split('/').at(-1),
      kind: 'text',
      content,
      draft: null,
      baseline: null,
      size: content.length,
      readOnly: false,
      diskWritable: true,
      dirty: false,
      external: null,
      diskContent: null,
      mode: 'source',
      tabId,
      preview: false,
      pinned: false,
      untitled: false,
      revision: 1,
      contentRevision: 1,
      view: { byTabId: { [tabId]: { selection: initialSelection } } },
      error: null,
      contentLength: content.length,
      draftLength: null,
      diskContentLength: null,
      contentBytes: new TextEncoder().encode(content).byteLength,
      draftBytes: null,
      diskContentBytes: null,
      diskSignature: null
    }
    const editorRef = createRef<SourceEditorHandle>()
    browserWindow.__findReferences = () => {
      if (!editorRef.current) throw new Error('The source editor is not mounted.')
      return editorRef.current.references({ line: 4, column: 27 })
    }
    const editor = createElement(SourceEditor, {
      ref: editorRef,
      buffer,
      tabId,
      wrap: false,
      minimap: false,
      fontSize: 13,
      fontFamily: 'monospace',
      onDraft() {},
      async flushDraft() {},
      onView() {},
      onEditorFocus() {},
      onSearchInFiles() {},
      onError() {},
      symbols: { context, refusal() { return null } }
    })
    createRoot(document.getElementById('editor-root')!).render(
      createElement(EditorUiControlProvider, {
        scope,
        children: createElement(SourceEditorControlScope, { context: context as unknown as UiPluginContext, children: editor })
      })
    )
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body { font: var(--compat-px-13)/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
          #editor-pane { display: flex; height: 640px; width: min(980px, 100vw); }
          #editor-root { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
        </style>
      </head>
      <body><main id="editor-pane"><div id="editor-root"></div></main></body>
    </html>`
}

async function mountEditor(page: Page, unsupported = false): Promise<void> {
  await page.setContent(pageMarkup())
  await page.evaluate((isUnsupported) => {
    (window as unknown as { __unsupportedFixture: boolean }).__unsupportedFixture = isUnsupported
  }, unsupported)
  for (const stylesheet of STYLESHEETS) {
    await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
  }
  await page.addScriptTag({ type: 'module', content: browserBundle })
  await page.locator('.cm-content').waitFor()
  await page.waitForFunction((expectSymbols) => {
    const state = window as unknown as { __controlReport?: unknown }
    const report = state.__controlReport
    if (typeof report !== 'object' || report === null || !('uiControls' in report) || !Array.isArray(report.uiControls)) return false
    const controls = report.uiControls as unknown[]
    const hasTarget = (prefix: string) => controls.some((control) =>
      typeof control === 'object' && control !== null && 'target' in control &&
      typeof control.target === 'string' && control.target.startsWith(prefix)
    )
    return hasTarget('source:') && (!expectSymbols || hasTarget('source-symbols:'))
  }, !unsupported)
}

async function sourcePoint(page: Page, needle = 'greet', lineNumber = 4): Promise<{ x: number; y: number }> {
  return page.evaluate(({ target, line }) => {
    const sourceLine = document.querySelectorAll<HTMLElement>('.cm-line')[line - 1]
    if (!sourceLine) throw new Error('The requested source line is not rendered.')
    const walker = document.createTreeWalker(sourceLine, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? ''
      const index = text.indexOf(target)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) break
      return { x: rect.left + Math.min(rect.width * 0.25, 3), y: rect.top + rect.height / 2 }
    }
    throw new Error(`The source token ${target} is not rendered on line ${line}.`)
  }, { target: needle, line: lineNumber })
}

async function clickSource(page: Page, options: { button?: 'left' | 'right'; modifiers?: Array<'Meta' | 'Control' | 'Shift' | 'Alt'>; needle?: string; lineNumber?: number } = {}): Promise<void> {
  const point = await sourcePoint(page, options.needle, options.lineNumber)
  const modifiers = options.modifiers ?? []
  for (const modifier of modifiers) await page.keyboard.down(modifier)
  try {
    await page.mouse.click(point.x, point.y, { button: options.button ?? 'left' })
  } finally {
    for (const modifier of modifiers.toReversed()) await page.keyboard.up(modifier)
  }
}

async function setNavigationResponse(page: Page, kind: 'definition' | 'references', result: NavigationResponse): Promise<void> {
  await page.evaluate(({ key, response }) => {
    const state = window as unknown as { __navigationResponses: Record<'definition' | 'references', NavigationResponse> }
    state.__navigationResponses[key] = response
  }, { key: kind, response: result })
}

async function callsFor(page: Page, method: string): Promise<EditorCall[]> {
  return page.evaluate((name) => {
    const state = window as unknown as { __editorCalls: EditorCall[] }
    return state.__editorCalls.filter((call) => call.method === name)
  }, method)
}

async function waitForCall(page: Page, method: string): Promise<void> {
  await page.waitForFunction((name) => {
    const state = window as unknown as { __editorCalls: EditorCall[] }
    return state.__editorCalls.some((call) => call.method === name)
  }, method)
}

function navigationResult(locations: NavigationLocation[]): NavigationResponse {
  return { worktreeId: WORKTREE_ID, language: 'typescript', locations, truncated: false }
}

function location(relativePath: string, line: number, column: number, endColumn: number, preview: string): NavigationLocation {
  return {
    path: `/workspace/${relativePath}`,
    relativePath,
    line,
    column,
    endLine: line,
    endColumn,
    preview
  }
}

function referencesFixture() {
  return navigationResult(Array.from({ length: 50 }, (_, index) => {
    const row = String(index + 1).padStart(2, '0')
    return location(`src/references/${row}.ts`, index + 1, 3, 8, `const reference${row} = greet()`)
  }))
}

async function focusedRowTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.closest('.ui-list-row')?.querySelector('.ui-list-row__title')?.textContent?.trim() ?? null)
}

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-source-symbols-browser-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'esm',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The source-symbol browser bundle was empty.')
    browserBundle = await output.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

test.skipIf(!existsSync(executable))('routes only the platform primary-modifier click without moving the CodeMirror selection', async () => {
  const context = await browser!.newContext({ viewport: { width: 1100, height: 760 } })
  const page = await context.newPage()
  try {
    await mountEditor(page)
    await setNavigationResponse(page, 'definition', navigationResult([]))

    await clickSource(page, { modifiers: [primaryModifier] })
    await waitForCall(page, 'quirky.navigation/definition')
    const definitionCalls = await callsFor(page, 'quirky.navigation/definition')
    expect(definitionCalls).toHaveLength(1)
    expectLookupAtGreet(definitionCalls[0]!.params)

    const bridgeCalls = await callsFor(page, 'ui.window.command.run')
    const symbolControl = bridgeCalls.find((call) => call.params.id === 'command:quirky.editor/ui-control')?.params.args
    expect(symbolControl).toMatchObject({ action: 'definition', data: { line: 4 } })
    if (typeof symbolControl !== 'object' || symbolControl === null || Array.isArray(symbolControl) || !('data' in symbolControl)) {
      throw new Error('The primary click did not send a symbol-control position.')
    }
    const controlData = symbolControl.data
    if (typeof controlData !== 'object' || controlData === null || Array.isArray(controlData) ||
        !('column' in controlData) || typeof controlData.column !== 'number') {
      throw new Error('The primary click did not send a numeric control column.')
    }
    expect(controlData.column).toBeGreaterThanOrEqual(27)
    expect(controlData.column).toBeLessThanOrEqual(32)

    const selectionAfterPrimaryClick = await page.evaluate(() => {
      const state = window as unknown as { __sourceSelection(): { anchor: number; head: number } }
      return state.__sourceSelection()
    })
    const initialSelection = await page.evaluate(() => {
      const state = window as unknown as { __initialSelection: { anchor: number; head: number } }
      return state.__initialSelection
    })
    expect(selectionAfterPrimaryClick).toEqual(initialSelection)

    const routedBeforeNegativeClicks = (await callsFor(page, 'quirky.navigation/definition')).length
    await clickSource(page)
    await page.waitForTimeout(30)
    expect(await callsFor(page, 'quirky.navigation/definition')).toHaveLength(routedBeforeNegativeClicks)
    await clickSource(page, { modifiers: [primaryModifier, 'Shift'] })
    await page.waitForTimeout(30)
    expect(await callsFor(page, 'quirky.navigation/definition')).toHaveLength(routedBeforeNegativeClicks)
    await clickSource(page, { modifiers: [primaryModifier, 'Alt'] })
    await page.waitForTimeout(30)
    expect(await callsFor(page, 'quirky.navigation/definition')).toHaveLength(routedBeforeNegativeClicks)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('opens context-menu symbol actions at the right-clicked source position and omits them for unsupported files', async () => {
  const context = await browser!.newContext({ viewport: { width: 1100, height: 760 } })
  try {
    const page = await context.newPage()
    await mountEditor(page)
    await setNavigationResponse(page, 'definition', navigationResult([
      location('src/greet.ts', 3, 17, 22, 'export function greet(name: Name): string {')
    ]))
    await setNavigationResponse(page, 'references', navigationResult([
      location('src/use.ts', 1, 10, 15, "import { greet, Greeter, type Name } from './index'"),
      location('src/use.ts', 4, 27, 32, "const label = 'héllo 🙂'; greet(who)")
    ]))

    await clickSource(page, { button: 'right' })
    let menu = page.getByRole('menu', { name: 'Editor actions' })
    await menu.waitFor()
    let menuItems = (await menu.getByRole('menuitem').allTextContents()).map((text) => text.trim())
    const definitionIndex = menuItems.indexOf('Go to Definition')
    const referencesIndex = menuItems.indexOf('Find References')
    const searchIndex = menuItems.indexOf('Search in Files')
    expect(definitionIndex).toBeGreaterThanOrEqual(0)
    expect(referencesIndex).toBeGreaterThan(definitionIndex)
    expect(searchIndex).toBeGreaterThan(referencesIndex)

    await menu.getByRole('menuitem', { name: 'Go to Definition', exact: true }).click()
    await waitForCall(page, 'quirky.navigation/definition')
    await page.getByRole('menu').waitFor({ state: 'detached' })
    const definitionCalls = await callsFor(page, 'quirky.navigation/definition')
    expect(definitionCalls).toHaveLength(1)
    expectLookupAtGreet(definitionCalls[0]!.params)
    expect((await callsFor(page, 'quirky.editor/open'))[0]!.params).toMatchObject({
      worktree: WORKTREE_ID,
      path: 'src/greet.ts',
      mode: 'source',
      line: 3,
      column: 17,
      matchLength: 5,
      window: 22
    })
    const firstMenuControl = (await callsFor(page, 'ui.window.command.run'))
      .map((call) => call.params.args)
      .find((args) => typeof args === 'object' && args !== null && !Array.isArray(args) &&
        'target' in args && typeof args.target === 'string' && args.target.startsWith('source-menu:'))
    expect(firstMenuControl).toMatchObject({ action: 'definition' })

    await clickSource(page, { button: 'right' })
    menu = page.getByRole('menu', { name: 'Editor actions' })
    await menu.waitFor()
    await menu.getByRole('menuitem', { name: 'Find References', exact: true }).click()
    await waitForCall(page, 'quirky.navigation/references')
    await page.getByRole('menu').waitFor({ state: 'detached' })
    const referencesCalls = await callsFor(page, 'quirky.navigation/references')
    expect(referencesCalls).toHaveLength(1)
    expectLookupAtGreet(referencesCalls[0]!.params)
    await page.getByRole('heading', { name: 'References to greet' }).waitFor()
    expect((await callsFor(page, 'ui.window.command.run')).map((call) => call.params.args)
      .some((args) => typeof args === 'object' && args !== null && !Array.isArray(args) &&
        'target' in args && typeof args.target === 'string' && args.target.startsWith('source-menu:') &&
        'action' in args && args.action === 'references')).toBe(true)

    const unsupportedPage = await context.newPage()
    await mountEditor(unsupportedPage, true)
    await clickSource(unsupportedPage, { button: 'right', lineNumber: 1 })
    const unsupportedMenu = unsupportedPage.getByRole('menu', { name: 'Editor actions' })
    await unsupportedMenu.waitFor()
    const unsupportedItems = (await unsupportedMenu.getByRole('menuitem').allTextContents()).map((text) => text.trim())
    expect(unsupportedItems).toEqual(['Search in Files'])
    expect(await callsFor(unsupportedPage, 'quirky.navigation/definition')).toHaveLength(0)
    expect(await callsFor(unsupportedPage, 'quirky.navigation/references')).toHaveLength(0)
  } finally {
    await context.close()
  }
}, 60_000)

for (const width of [1100, 390]) test.skipIf(!existsSync(executable))(`keeps a 50-reference list scrollable within 40% of the editor and supports its keyboard flow at ${width}px`, async () => {
  const context = await browser!.newContext({ viewport: { width, height: 760 } })
  const page = await context.newPage()
  try {
    await mountEditor(page)
    await setNavigationResponse(page, 'references', referencesFixture())
    await page.locator('.cm-content').evaluate((element: HTMLElement) => element.focus())
    await clickSource(page, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Editor actions' })
    await menu.waitFor()
    await menu.getByRole('menuitem', { name: 'Find References', exact: true }).click()
    await waitForCall(page, 'quirky.navigation/references')

    const panel = page.locator('.qe-source-locations')
    await panel.waitFor()
    await page.getByRole('heading', { name: 'References to greet' }).waitFor()
    await page.getByText('50 results', { exact: true }).waitFor()
    const rows = panel.locator('.ui-list-row__main')
    expect(await rows.count()).toBe(50)
    const layout = await page.evaluate(() => {
      const editor = document.querySelector('.qe-source-editor')
      const panelElement = editor?.querySelector('.qe-source-locations')
      if (!(editor instanceof HTMLElement) || !(panelElement instanceof HTMLElement)) throw new Error('The source locations panel was not mounted.')
      const scrollRegion = Array.from(panelElement.querySelectorAll<HTMLElement>('*'))
        .find((element) => element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1)
      const editorHeight = editor.getBoundingClientRect().height
      const panelHeight = panelElement.getBoundingClientRect().height
      return {
        editorHeight,
        panelHeight,
        scrollHeight: scrollRegion?.scrollHeight ?? 0,
        clientHeight: scrollRegion?.clientHeight ?? 0
      }
    })
    expect(layout.panelHeight).toBeLessThanOrEqual(layout.editorHeight * 0.4 + 1)
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)

    const screenshotHome = process.env.QUIRKY_HOME
    if (screenshotHome) {
      mkdirSync(screenshotHome, { recursive: true })
      await page.screenshot({ path: join(screenshotHome, `source-symbols.references.${width}.png`), fullPage: true })
    }

    const firstTitle = 'src/references/01.ts:1:3'
    const secondTitle = 'src/references/02.ts:2:3'
    const lastTitle = 'src/references/50.ts:50:3'
    expect(await focusedRowTitle(page)).toBe(firstTitle)
    await page.keyboard.press('Home')
    expect(await focusedRowTitle(page)).toBe(firstTitle)
    await page.keyboard.press('ArrowUp')
    expect(await focusedRowTitle(page)).toBe(firstTitle)
    await page.keyboard.press('End')
    expect(await focusedRowTitle(page)).toBe(lastTitle)
    await page.keyboard.press('Home')
    expect(await focusedRowTitle(page)).toBe(firstTitle)
    await page.keyboard.press('ArrowDown')
    expect(await focusedRowTitle(page)).toBe(secondTitle)
    await page.keyboard.press('Enter')
    await waitForCall(page, 'quirky.editor/open')
    expect((await callsFor(page, 'quirky.editor/open')).at(-1)!.params).toMatchObject({
      worktree: WORKTREE_ID,
      path: 'src/references/02.ts',
      mode: 'source',
      line: 2,
      column: 3,
      matchLength: 5,
      window: 22
    })

    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    const editorHasFocus = await page.locator('.cm-content').evaluate((element) => element === document.activeElement || element.contains(document.activeElement))
    expect(editorHasFocus).toBe(true)
  } finally {
    await context.close()
  }
}, 60_000)

for (const stage of ['identity', 'dispatch'] as const) test.skipIf(!existsSync(executable))(`keeps newer reference results after an older modifier-click completes ${stage} transport`, async () => {
  const context = await browser!.newContext({ viewport: { width: 1100, height: 760 } })
  const page = await context.newPage()
  try {
    await mountEditor(page)
    await setNavigationResponse(page, 'definition', navigationResult([
      location('src/greet.ts', 3, 17, 22, 'export function greet(name: Name): string {')
    ]))
    await setNavigationResponse(page, 'references', navigationResult([
      location('src/use.ts', 4, 27, 32, "const label = 'héllo 🙂'; greet(who)")
    ]))
    const method = stage === 'identity' ? 'ui.window.self' : 'ui.window.command.run'
    await page.evaluate((heldMethod) => {
      const gate = Promise.withResolvers<void>()
      const state = window as unknown as BrowserRaceState
      state.__bridgeGate = { method: heldMethod, promise: gate.promise }
      state.__releaseBridge = gate.resolve
    }, method)
    await clickSource(page, { modifiers: [primaryModifier] })
    await waitForCall(page, method)
    expect(await callsFor(page, 'quirky.navigation/definition')).toEqual([])
    await page.evaluate(async () => {
      const state = window as unknown as BrowserRaceState
      await state.__findReferences()
    })
    await page.getByRole('heading', { name: 'References to greet' }).waitFor()
    const report = await page.evaluate(() => {
      const state = window as unknown as BrowserRaceState
      return state.__controlReport.sourceSymbols
    })
    await page.evaluate(() => {
      const state = window as unknown as BrowserRaceState
      state.__releaseBridge()
    })
    await page.waitForFunction(() => {
      const state = window as unknown as BrowserRaceState
      return state.__controlResults.length === 1
    })
    expect(await page.evaluate(() => {
      const state = window as unknown as BrowserRaceState
      return state.__controlResults
    }))
      .toEqual([{ result: { delivered: false } }])
    expect(await callsFor(page, 'quirky.navigation/definition')).toEqual([])
    expect(await callsFor(page, 'quirky.editor/open')).toEqual([])
    const currentReport = await page.evaluate(() => {
      const state = window as unknown as BrowserRaceState
      return state.__controlReport.sourceSymbols
    })
    expect(currentReport).toEqual(report)
    expect(await page.locator('.qe-source-locations h2').textContent()).toBe('References to greet')
    expect(await page.locator('.qe-source-locations .ui-list-row').count()).toBe(1)
  } finally {
    await context.close()
  }
}, 60_000)
