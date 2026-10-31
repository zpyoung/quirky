import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../..')
const EDITOR_MODULES = join(ROOT, 'plugins/quirky.editor/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(EDITOR_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(EDITOR_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(EDITOR_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(EDITOR_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(EDITOR_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@codemirror/view': Bun.resolveSync('@codemirror/view', EDITOR_MODULES),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'document-header-layout-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol|@codemirror\/view)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/editor-window.css',
  'packages/ui/src/design-system/editor-markdown.css'
]

const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const documentSurface = join(ROOT, 'plugins/quirky.editor/src/window/DocumentSurface.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import type { UiPluginContext } from '@quirky/protocol'
    import { DocumentSurface } from ${JSON.stringify(documentSurface)}

    const bufferId = 'buffer-document-header-layout'
    const tabId = 'tab-document-header-layout'
    const worktreeId = 'wt-document-header-layout'
    const mode = location.hash === '#preview' ? 'preview' : 'rich'
    const content = '# Notes\\n\\nCurrent notes for the layout fixture.\\n'
    const baseline = '# Notes\\n\\nOriginal notes for the layout fixture.\\n'
    const buffer = {
      id: bufferId,
      worktreeId,
      root: '/workspace',
      path: '/workspace/notes.md',
      relativePath: 'notes.md',
      name: 'notes.md',
      kind: 'markdown',
      content,
      draft: null,
      baseline,
      size: content.length,
      readOnly: false,
      diskWritable: true,
      dirty: false,
      external: null,
      diskContent: null,
      mode,
      tabId,
      preview: false,
      pinned: false,
      untitled: false,
      revision: 1,
      contentRevision: 1,
      view: {},
      error: null,
      contentLength: content.length,
      draftLength: null,
      diskContentLength: null,
      contentBytes: new TextEncoder().encode(content).byteLength,
      draftBytes: null,
      diskContentBytes: null,
      diskSignature: null
    }
    const state = {
      buffers: [buffer],
      tabs: [{ tabId, bufferId, mode: 'edit' }],
      explorer: { worktreeId, showDotfiles: false, expanded: [] },
      search: null,
      quickOpenHistory: [],
      closeRequests: []
    }
    const settings: Record<string, unknown> = {
      editorAutoSave: false,
      editorAutoSaveDelayMs: 1000,
      editorWordWrap: false,
      editorFontFamily: 'monospace',
      editorPreviewTabsEnabled: true,
      richMarkdownSpellcheckEnabled: false,
      markdownReviewToolsEnabled: false,
      showGitIgnoredFiles: false,
      followSymlinkedDirectories: false,
      editorFontZoomLevel: 0,
      editorMinimapEnabled: false,
      editorSidebarWidth: 300
    }
    const context = {
      pluginId: 'quirky.editor',
      call(method: string, params: Record<string, unknown> = {}) {
        if (method === 'quirky.editor/state') return Promise.resolve(state)
        if (method === 'quirky.git/diff') {
          return Promise.resolve({ kind: 'text', original: baseline, modified: content })
        }
        if (method === 'quirky.editor/markdown') {
          if (params.action === 'capabilities') {
            return Promise.resolve({ richEligible: true, previewAvailable: true, previewHtml: '<h1>Notes</h1>', imageUrls: {} })
          }
          if (params.action === 'notes') return Promise.resolve({ notes: [] })
          if (params.action === 'toc') return Promise.resolve({ headings: [] })
          if (params.action === 'documents') return Promise.resolve({ documents: [], total: 0, truncated: false })
          return Promise.resolve({ safe: true, kind: 'external' })
        }
        if (method === 'quirky.editor/notes') return Promise.resolve({ notes: [] })
        if (method === 'setting.set') {
          const id = typeof params.id === 'string' ? params.id.replace(/^setting:quirky\\.editor\\//, '') : ''
          settings[id] = params.value
        }
        return Promise.resolve({})
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
    } as unknown as UiPluginContext

    createRoot(document.getElementById('document-root')!).render(
      createElement(DocumentSurface, { context, input: { bufferId, tabId, mode } })
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
          #document-pane { height: 600px; width: 400px; }
          #document-root { height: 100%; }
        </style>
      </head>
      <body><main id="document-pane"><div id="document-root"></div></main></body>
    </html>`
}

async function measureHeader(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('#document-pane')
    const header = document.querySelector<HTMLElement>('.qe-document-header')
    if (!pane || !header) throw new Error('The document pane or header did not render.')
    const pathGroup = header.querySelector<HTMLElement>('.qe-document-path-group')
    const actionStrip = header.querySelector<HTMLElement>('.qe-document-action-strip')
    const path = header.querySelector<HTMLElement>('.qe-document-path')
    const fileActions = header.querySelector<HTMLElement>('.qe-file-actions summary')
    if (!pathGroup || !actionStrip || !path || !fileActions) throw new Error('A document header row control did not render.')
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
    }
    const visibleControls = [...header.querySelectorAll<HTMLElement>('button, summary')]
      .filter((control) => control.checkVisibility())
      .map((control) => ({
        label: control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '',
        ...rect(control)
      }))
    const rowCenters: number[] = []
    for (const control of visibleControls) {
      const center = (control.top + control.bottom) / 2
      if (!rowCenters.some((row) => Math.abs(row - center) <= 1)) rowCenters.push(center)
    }
    const actionControls = [...actionStrip.querySelectorAll<HTMLElement>('button')]
      .filter((control) => control.checkVisibility())
      .map(rect)
    const changes = actionStrip.querySelector<HTMLElement>('button[aria-label$="Changes"]')
    if (!changes) throw new Error('The Changes header action did not render.')
    return {
      rowCount: rowCenters.length,
      pane: rect(pane),
      header: rect(header),
      pathGroup: rect(pathGroup),
      actionStrip: rect(actionStrip),
      path: rect(path),
      fileActions: rect(fileActions),
      changes: rect(changes),
      controls: visibleControls,
      actionControls
    }
  })
}
async function measurePreviewToolbar(page: Page) {
  return page.evaluate(() => {
    const contentPane = document.querySelector<HTMLElement>('.qe-document-content')
    const surface = document.querySelector<HTMLElement>('.markdown-surface--preview')
    const toolbar = surface?.querySelector<HTMLElement>('.markdown-toolbar')
    if (!contentPane || !surface || !toolbar) throw new Error('The Markdown preview or content pane did not render.')
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
    }
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].map((button) => ({
      label: button.textContent?.trim() ?? '',
      ...rect(button)
    }))
    const exportButton = buttons.find((button) => button.label === 'Export as PDF')
    const label = [...toolbar.querySelectorAll<HTMLElement>('span')]
      .find((element) => element.textContent?.trim() === 'Markdown Preview')
    if (!exportButton || !label || buttons.length < 3) throw new Error('The preview toolbar controls did not render.')
    return {
      contentPane: rect(contentPane),
      toolbar: rect(toolbar),
      buttons,
      exportButton,
      label: rect(label)
    }
  })
}

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-document-header-layout-'))
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
    if (!output) throw new Error('The document header browser bundle was empty.')
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

test.skipIf(!existsSync(executable))('keeps the Markdown document header in two rows at 400px with Changes open and closed', async () => {
  const context = await browser!.newContext({ viewport: { width: 800, height: 600 } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ type: 'module', content: browserBundle })
    await page.locator('.qe-document-path').waitFor()

    const initial = await measureHeader(page)
    expect(initial.pane.width).toBe(400)
    expect(initial.controls.map((control) => control.label)).toContain('notes.md')
    expect(initial.controls.map((control) => control.label)).toContain('File actions')
    expect(initial.rowCount).toBe(2)
    expect(Math.abs((initial.path.top + initial.path.bottom) / 2 - (initial.fileActions.top + initial.fileActions.bottom) / 2)).toBeLessThanOrEqual(1)
    expect(initial.path.right).toBeLessThanOrEqual(initial.fileActions.left)
    expect(initial.actionStrip.top).toBeGreaterThanOrEqual(initial.pathGroup.bottom)
    expect(initial.actionControls.length).toBe(5)
    expect(initial.actionControls.every((control) => Math.abs(control.top - initial.actionControls[0]!.top) <= 1)).toBe(true)
    for (const control of initial.controls) {
      expect(control.left).toBeGreaterThanOrEqual(initial.pane.left)
      expect(control.right).toBeLessThanOrEqual(initial.pane.right)
    }

    await page.getByRole('button', { name: 'Changes', exact: true }).click()
    await page.getByRole('button', { name: 'Close Changes', exact: true }).waitFor()
    await page.locator('.qe-changes-surface').waitFor()
    const changesOpen = await measureHeader(page)
    expect(changesOpen.header.height).toBe(initial.header.height)
    expect(changesOpen.rowCount).toBe(2)
    expect(changesOpen.actionControls.every((control) => Math.abs(control.top - changesOpen.actionControls[0]!.top) <= 1)).toBe(true)
    for (const control of changesOpen.controls) {
      expect(control.left).toBeGreaterThanOrEqual(changesOpen.pane.left)
      expect(control.right).toBeLessThanOrEqual(changesOpen.pane.right)
    }

    await page.getByRole('button', { name: 'Close Changes', exact: true }).click()
    await page.getByRole('button', { name: 'Changes', exact: true }).waitFor()
    const changesClosed = await measureHeader(page)
    expect(changesClosed.header.height).toBe(initial.header.height)
    expect(changesClosed.rowCount).toBe(2)
    expect(changesClosed.actionControls.every((control) => Math.abs(control.top - changesClosed.actionControls[0]!.top) <= 1)).toBe(true)
    for (const control of changesClosed.controls) {
      expect(control.left).toBeGreaterThanOrEqual(changesClosed.pane.left)
      expect(control.right).toBeLessThanOrEqual(changesClosed.pane.right)
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('keeps every rich Markdown toolbar command visible without horizontal scrolling', async () => {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ type: 'module', content: browserBundle })
    const toolbar = page.getByRole('toolbar', { name: 'Markdown formatting' })
    await toolbar.waitFor()

    for (const width of [400, 624, 1000]) {
      await page.locator('#document-pane').evaluate((pane, width) => {
        pane.style.width = `${width}px`
      }, width)
      const layout = await toolbar.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          controls: [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect()
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
          })
        }
      })
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
      for (const control of layout.controls) {
        expect(control.left).toBeGreaterThanOrEqual(layout.left)
        expect(control.right).toBeLessThanOrEqual(layout.right)
        expect(control.top).toBeGreaterThanOrEqual(layout.top)
        expect(control.bottom).toBeLessThanOrEqual(layout.bottom)
      }
    }

    await toolbar.getByRole('button', { name: 'Find', exact: true }).click()
    await page.getByRole('textbox', { name: 'Find in rich editor', exact: true }).waitFor()

    await page.locator('#document-pane').evaluate((pane) => {
      pane.style.width = '400px'
      pane.style.height = '200px'
    })
    const richViewport = await page.locator('.markdown-rich-content').evaluate((element) => ({
      height: element.clientHeight,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight)
    }))
    expect(richViewport.height).toBeGreaterThanOrEqual(richViewport.lineHeight * 2)
    await page.locator('.tiptap p').click()
    expect(await page.locator('.tiptap').evaluate((element) => element.contains(document.activeElement))).toBe(true)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('spans the Markdown preview toolbar across the content pane at 620px and 400px', async () => {
  const context = await browser!.newContext({ viewport: { width: 800, height: 600 } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.evaluate(() => { location.hash = '#preview' })
    await page.addScriptTag({ type: 'module', content: browserBundle })
    await page.getByRole('button', { name: 'Export as PDF', exact: true }).waitFor()

    for (const width of [620, 400]) {
      await page.locator('#document-pane').evaluate((pane, paneWidth) => {
        ;(pane as HTMLElement).style.width = `${paneWidth}px`
      }, width)
      const preview = await measurePreviewToolbar(page)
      expect(preview.contentPane.width).toBe(width)
      expect(Math.abs(preview.toolbar.left - preview.contentPane.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(preview.toolbar.right - preview.contentPane.right)).toBeLessThanOrEqual(1)
      for (const control of [...preview.buttons, preview.label]) {
        expect(control.left).toBeGreaterThanOrEqual(preview.contentPane.left)
        expect(control.right).toBeLessThanOrEqual(preview.contentPane.right)
      }

      const firstButton = preview.buttons[0]!
      const secondButton = preview.buttons[1]!
      const interButtonGap = secondButton.left - firstButton.right
      expect(Math.abs(firstButton.top - secondButton.top)).toBeLessThanOrEqual(1)
      const exportCenter = (preview.exportButton.top + preview.exportButton.bottom) / 2
      const labelCenter = (preview.label.top + preview.label.bottom) / 2
      if (width === 620) expect(Math.abs(exportCenter - labelCenter)).toBeLessThanOrEqual(1)
      if (Math.abs(exportCenter - labelCenter) <= 1) {
        const exportToLabelGap = preview.label.left - preview.exportButton.right
        expect(exportToLabelGap).toBeGreaterThanOrEqual(8)
        expect(exportToLabelGap).toBeGreaterThanOrEqual(interButtonGap)
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)
