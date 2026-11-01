import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { createRoot as createRootFunction } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import type { ExplorerPanel as ExplorerPanelComponent } from '../../../plugins/quirky.editor/src/window/ExplorerPanel'
import type { ToolPanelFrame as ToolPanelFrameComponent } from '../src/design-system'

const ROOT = resolve(import.meta.dir, '../../..')
const EDITOR_MODULES = join(ROOT, 'plugins/quirky.editor/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(EDITOR_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(EDITOR_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(EDITOR_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(EDITOR_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(EDITOR_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'explorer-inline-layout-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''
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
  editorSidebarWidth: 320,
}
const listing = {
  root: '/repo',
  entries: [
    ...Array.from({ length: 12 }, (_, index) => {
      const name = `file-${String(index + 1).padStart(2, '0')}.txt`
      return { path: `/repo/${name}`, name, isDirectory: false, isSymlink: false }
    }),
    {
      path: '/repo/a-very-long-file-name-for-narrow-ellipsis-check.txt',
      name: 'a-very-long-file-name-for-narrow-ellipsis-check.txt',
      isDirectory: false,
      isSymlink: false,
    },
  ],
  showDotfiles: true,
  showIgnored: false,
  followSymlinkedDirectories: false,
}
const liveRootEntries = [
  ...listing.entries.slice(0, 7),
  { path: '/repo/src', name: 'src', isDirectory: true, isSymlink: false },
  { path: '/repo/notes.md', name: 'notes.md', isDirectory: false, isSymlink: false },
  { path: '/repo/README.md', name: 'README.md', isDirectory: false, isSymlink: false },
]
const liveChildListing = {
  root: '/repo/src',
  entries: [{ path: '/repo/src/child.md', name: 'child.md', isDirectory: false, isSymlink: false }],
  showDotfiles: true,
  showIgnored: false,
  followSymlinkedDirectories: false,
}
const LIVE_ROW_COUNT = liveRootEntries.length + liveChildListing.entries.length
const liveListing = { ...listing, entries: liveRootEntries }

let createRoot: typeof createRootFunction
let ExplorerPanel: typeof ExplorerPanelComponent
let ToolPanelFrame: typeof ToolPanelFrameComponent
let root: Root | null = null
let container: HTMLDivElement

// dom registration must precede these browser-bound module imports.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ExplorerPanel } = await import('../../../plugins/quirky.editor/src/window/ExplorerPanel'))
  ;({ ToolPanelFrame } = await import('../src/design-system'))
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-explorer-inline-layout-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, liveBrowserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'esm',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The Explorer inline-layout browser bundle was empty.')
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
  await GlobalRegistrator.unregister()
}, 60_000)

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function makeContext(layoutWorktree: string | null): UiPluginContext {
  const respond = (method: string): unknown => {
    if (method === 'quirky.editor/state') {
      return { buffers: [], tabs: [], explorer: { worktreeId: 'w1', showDotfiles: true, expanded: [] }, search: null, quickOpenHistory: [], closeRequests: [] }
    }
    if (method === 'quirky.editor/documentRoot') return { id: 'w1', path: '/repo' }
    if (method === 'quirky.editor/explorer') return listing
    if (method === 'quirky.git/status') return { files: [] }
    if (method === 'quirky.worktree/list') return [{ id: 'w1', path: '/repo', name: 'repo' }, { id: 'w2', path: '/other', name: 'other' }]
    return {}
  }
  return {
    pluginId: 'quirky.editor',
    log() {},
    call: async (method: string) => respond(method),
    subscribe: () => () => {},
    getSetting: (name: string) => settings[name],
    getLayout: () => ({ worktree: layoutWorktree, view: null, panel: null, sidebar: true, focus: 'view' }),
    onLayout: () => () => {},
    onConnection: () => () => {},
    toast() {},
  } as unknown as UiPluginContext
}

async function waitForExplorerReady(selector: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (container.querySelector(selector) !== null) return
    const { promise: ready, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 10)
    await act(async () => { await ready })
  }
  throw new Error(`Explorer did not render ${selector}`)
}
async function mountExplorer(layoutWorktree: string | null): Promise<string> {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <ToolPanelFrame title="Explorer">
        <section className="plugin-slot">
          <div className="plugin-slot-body">
            <ExplorerPanel context={makeContext(layoutWorktree)} />
          </div>
        </section>
      </ToolPanelFrame>,
    )
  })
  await waitForExplorerReady(layoutWorktree === null ? '.qe-explorer-worktree' : '.qe-explorer-row')
  const frame = container.querySelector<HTMLElement>('.ui-tool-panel-frame')
  if (frame === null) throw new Error('Explorer did not render its host frame')
  return frame.outerHTML
}

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

function liveBrowserEntry(): string {
  const explorerPanel = join(ROOT, 'plugins/quirky.editor/src/window/ExplorerPanel.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ToolPanelFrame } from '@quirky/ui'
    import { ExplorerPanel } from ${JSON.stringify(explorerPanel)}

    const settings = ${JSON.stringify(settings)}
    const listing = ${JSON.stringify(liveListing)}
    const childListing = ${JSON.stringify(liveChildListing)}

    const context = {
      pluginId: 'quirky.editor',
      log() {},
      call: async (method, params) => {
        if (method === 'quirky.editor/state') {
          return { buffers: [], tabs: [], explorer: { worktreeId: 'w1', showDotfiles: true, expanded: ['src'] }, search: null, quickOpenHistory: [], closeRequests: [] }
        }
        if (method === 'quirky.editor/documentRoot') return { id: 'w1', path: '/repo' }
        if (method === 'quirky.editor/explorer') {
          return params?.path === '/repo/src' ? childListing : listing
        }
        if (method === 'quirky.git/status') return { files: [] }
        if (method === 'quirky.worktree/list') return [{ id: 'w1', path: '/repo', name: 'repo' }]
        return {}
      },
      subscribe: () => () => {},
      getSetting: (name) => settings[name],
      getLayout: () => ({ worktree: 'w1', view: null, panel: null, sidebar: true, focus: 'view' }),
      onLayout: () => () => {},
      onConnection: () => () => {},
      toast() {}
    }
    const explorer = createElement(ExplorerPanel, { context })
    const pluginSlot = createElement('section', { className: 'plugin-slot' }, createElement('div', { className: 'plugin-slot-body' }, explorer))
    const panel = createElement(ToolPanelFrame, { title: 'Explorer' }, pluginSlot)
    createRoot(document.getElementById('explorer-mount')).render(panel)
  `
}

function liveExplorerMarkup(): string {
  return '<main data-theme="dark" style="position:relative;overflow:hidden;width:1280px;height:720px"><div id="explorer-mount" class="tool-shell__panel tool-shell__panel--left-bottom" style="left:0;top:0;width:280px;height:655px"></div></main>'
}

async function mountLiveExplorer(page: Page): Promise<void> {
  await page.setContent(`<style>${await designSystemStyles()}</style>${liveExplorerMarkup()}`)
  await page.addScriptTag({ type: 'module', content: browserBundle })
  await page.waitForFunction((expectedCount) => document.querySelectorAll('.qe-explorer-row').length === expectedCount, LIVE_ROW_COUNT)
}

async function inlineRowGeometry(page: Page) {
  return page.locator('.qe-explorer-inline-row').evaluate((row) => {
    const tree = row.closest<HTMLElement>('.qe-explorer-tree')
    const footer = document.querySelector<HTMLElement>('.qe-explorer-footer')
    const input = row.querySelector<HTMLInputElement>('input')
    if (!tree || !footer || !input) throw new Error('The inline Explorer form did not render inside its tree.')
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left }
    }
    const treeBounds = tree.getBoundingClientRect()
    const left = treeBounds.left + tree.clientLeft
    const top = treeBounds.top + tree.clientTop
    return {
      focused: document.activeElement === input,
      scrollTop: tree.scrollTop,
      scrollport: { top, right: left + tree.clientWidth, bottom: top + tree.clientHeight, left },
      row: rect(row),
      footer: rect(footer),
      controls: [input, ...row.querySelectorAll('button')].map((control) => ({
        label: control instanceof HTMLButtonElement ? control.textContent?.trim() ?? '' : 'input',
        ...rect(control)
      }))
    }
  })
}

function slotMarkup(frame: string, height: number, width = 160): string {
  return `<main data-theme="dark" style="position:relative;overflow:hidden;width:${width}px;height:${height}px"><div class="tool-shell__panel tool-shell__panel--left-bottom" style="left:0;top:0;width:${width}px;height:${height}px">${frame}</div></main>`
}

async function rowFitsInTree(row: Locator): Promise<boolean> {
  return row.evaluate((element) => {
    const tree = element.closest<HTMLElement>('.qe-explorer-tree')
    const panel = element.closest<HTMLElement>('.tool-shell__panel')
    if (tree === null || panel === null) return false
    const rowBounds = element.getBoundingClientRect()
    const treeBounds = tree.getBoundingClientRect()
    const panelBounds = panel.getBoundingClientRect()
    const treeTop = treeBounds.top + tree.clientTop
    const treeBottom = treeTop + tree.clientHeight
    return rowBounds.height >= 24
      && rowBounds.top >= treeTop - 0.5
      && rowBounds.bottom <= treeBottom + 0.5
      && rowBounds.bottom <= panelBounds.bottom + 0.5
  })
}

test.skipIf(!existsSync(executable))('file rows are visible and scrollable in short Explorer panels without changing the tall layout', async () => {
  const frame = await mountExplorer('w1')
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    const styles = await designSystemStyles()
    for (const height of [170, 205, 400]) {
      await page.setContent(`<style>${styles}</style>${slotMarkup(frame, height)}`)
      const first = page.locator('[role="treeitem"][data-path="/repo/file-01.txt"]')
      const last = page.locator('[role="treeitem"]').last()
      expect(await rowFitsInTree(first)).toBe(true)

      const tree = page.locator('.qe-explorer-tree')
      const scrollMetrics = await tree.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }))
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
      await tree.evaluate((element) => { element.scrollTop = element.scrollHeight })
      expect(await tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      expect(await rowFitsInTree(last)).toBe(true)
      if (height === 170) {
        for (const width of [160, 320]) {
          if (width !== 160) await page.setContent(`<style>${styles}</style>${slotMarkup(frame, height, width)}`)
          await page.locator('summary[aria-label="More Explorer Actions"]').click()
          const menu = page.locator('.qe-explorer-more-actions .qe-file-actions-menu')
          const bounds = await menu.evaluate((element) => {
            const menuBounds = element.getBoundingClientRect()
            const panelBounds = element.closest<HTMLElement>('.tool-shell__panel')!.getBoundingClientRect()
            const menuElement = element as HTMLElement
            return {
              left: menuBounds.left >= panelBounds.left - 0.5,
              right: menuBounds.right <= panelBounds.right + 0.5,
              top: menuBounds.top >= panelBounds.top - 0.5,
              bottom: menuBounds.bottom <= panelBounds.bottom + 0.5,
              scrollable: menuElement.scrollHeight > menuElement.clientHeight,
            }
          })
          expect(bounds).toEqual({ left: true, right: true, top: true, bottom: true, scrollable: true })

          for (const label of ['Copy Path', 'Copy Relative Path', 'Delete', 'Search in Files']) {
            const action = page.getByRole('button', { name: label })
            await action.scrollIntoViewIfNeeded()
            const reachable = await action.evaluate((button) => {
              const menu = button.closest<HTMLElement>('.qe-file-actions-menu')!
              const buttonBounds = button.getBoundingClientRect()
              const menuBounds = menu.getBoundingClientRect()
              const top = menuBounds.top + menu.clientTop
              const left = menuBounds.left + menu.clientLeft
              return buttonBounds.top >= top - 0.5
                && buttonBounds.bottom <= top + menu.clientHeight + 0.5
                && buttonBounds.left >= left - 0.5
                && buttonBounds.right <= left + menu.clientWidth + 0.5
            })
            expect(reachable).toBe(true)
          }
        }
      }

      if (height === 400) {
        expect(await page.locator('.qe-explorer-root').isVisible()).toBe(true)
        expect(await page.locator('.qe-explorer-query .ui-text-field__label').isVisible()).toBe(true)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('Explorer rows and controls stay usable at narrow panel widths', async () => {
  const frame = await mountExplorer('w1')
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 600 } })
    const styles = await designSystemStyles()
    for (const width of [116, 128, 160, 320]) {
      await page.setContent(`<style>${styles}</style>${slotMarkup(frame, 600, width)}`)
      const layout = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.tool-shell__panel')!
        const frame = document.querySelector<HTMLElement>('.ui-tool-panel-frame')!
        const row = document.querySelector<HTMLElement>('.qe-explorer-row[data-path="/repo/file-01.txt"]')!
        const listRow = row.querySelector<HTMLElement>('.ui-list-row')!
        const name = row.querySelector<HTMLElement>('.qe-explorer-name')!
        const longName = document.querySelector<HTMLElement>('.qe-explorer-row[data-path="/repo/a-very-long-file-name-for-narrow-ellipsis-check.txt"] .qe-explorer-name')!
        const rowAction = row.querySelector<HTMLElement>('.qe-explorer-row-action-trigger')!
        const modeGroup = document.querySelector<HTMLElement>('.qe-explorer-search-mode')!
        const modeButtons = Array.from(modeGroup.querySelectorAll<HTMLElement>(':scope > .ui-button'))
        const rail = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__rail')!
        const toolButtons = Array.from(rail.querySelectorAll<HTMLElement>(':scope > .ui-icon-button'))
        const actionSummary = frame.querySelector<HTMLElement>('.ui-tool-panel-frame__actions summary[aria-label="More Explorer Actions"]')!
        const bounds = (element: Element | Range) => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        }
        const textBounds = (element: Element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          return bounds(range)
        }
        const panelBounds = bounds(panel)
        const rowBounds = bounds(listRow)
        const nameBounds = bounds(name)
        const rowActionBounds = bounds(rowAction)
        const groupBounds = bounds(modeGroup)
        const buttonBounds = modeButtons.map(bounds)
        const labels = modeButtons.map(textBounds)
        const railBounds = bounds(rail)
        const toolbarTargets = [...toolButtons, actionSummary].map(bounds)
        const toolbarTargetsSized = toolbarTargets.every((target) => target.width >= 24 && target.height >= 24)
        const toolbarTargetsInsidePanel = toolbarTargets.every((target) =>
          target.left >= panelBounds.left - 0.5
          && target.right <= panelBounds.right + 0.5
          && target.top >= panelBounds.top - 0.5
          && target.bottom <= panelBounds.bottom + 0.5)
        const railScrollable = rail.scrollWidth > rail.clientWidth + 1

        const toolbarTargetsSeparated = toolbarTargets.every((target, index) =>
          toolbarTargets.slice(index + 1).every((other) =>
            target.right <= other.left + 0.5
            || other.right <= target.left + 0.5
            || target.bottom <= other.top + 0.5
            || other.bottom <= target.top + 0.5))
        const modesContained = buttonBounds.every((button, index) =>
          button.left >= groupBounds.left - 0.5
          && button.right <= groupBounds.right + 0.5
          && labels[index]!.left >= button.left - 0.5
          && labels[index]!.right <= button.right + 0.5)
        const rowRect = bounds(row)
        return {
          panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
          rowHeight: rowRect.height,
          rowActionNameCenterDelta: Math.abs(
            (rowActionBounds.top + rowActionBounds.bottom) / 2
            - (nameBounds.top + nameBounds.bottom) / 2,
          ),
          nameWidth: nameBounds.width,
          nameContained: nameBounds.left >= rowBounds.left - 0.5 && nameBounds.right <= rowBounds.right + 0.5,
          longNameOverflows: longName.scrollWidth > longName.clientWidth,
          nameTextOverflow: getComputedStyle(name).textOverflow,
          nameWhiteSpace: getComputedStyle(name).whiteSpace,
          nameOverflowStyle: getComputedStyle(name).overflow,
          modeGap: buttonBounds[1]!.left - buttonBounds[0]!.right,
          modesContained,
          toolbarButtonCount: toolButtons.length,
          railContained: toolButtons.every((button) => {
            const target = bounds(button)
            return target.left >= railBounds.left - 0.5
              && target.right <= railBounds.right + 0.5
              && target.top >= railBounds.top - 0.5
              && target.bottom <= railBounds.bottom + 0.5
          }),
          toolbarTargetsInsidePanel,
          toolbarTargetsSized,
          toolbarTargetsSeparated,
          railScrollable,
        }
      })

      expect(layout.panelOverflow).toBe(false)
      expect(layout.rowHeight).toBeLessThanOrEqual(32)
      if (width === 320) expect(layout.rowHeight).toBe(32)
      expect(layout.rowActionNameCenterDelta).toBeLessThan(1)
      expect(layout.nameWidth).toBeGreaterThan(0)
      expect(layout.nameContained).toBe(true)
      expect(layout.nameTextOverflow).toBe('ellipsis')
      expect(layout.nameWhiteSpace).toBe('nowrap')
      expect(layout.nameOverflowStyle).toBe('hidden')
      if (width === 116) expect(layout.longNameOverflows).toBe(true)
      expect(layout.modeGap).toBeGreaterThanOrEqual(3.5)
      expect(layout.modesContained).toBe(true)
      expect(layout.toolbarButtonCount).toBeGreaterThanOrEqual(6)
      expect(layout.toolbarTargetsSized).toBe(true)
      expect(layout.toolbarTargetsSeparated).toBe(true)
      if (width === 160) {
        expect(layout.railScrollable).toBe(true)
        const finalToolVisible = await page.locator('.ui-tool-panel-frame__rail').evaluate((element) => {
          const rail = element as HTMLElement
          const buttons = rail.querySelectorAll<HTMLElement>(':scope > .ui-icon-button')
          const lastButton = buttons.item(buttons.length - 1)!
          rail.scrollLeft = rail.scrollWidth
          const railBounds = rail.getBoundingClientRect()
          const buttonBounds = lastButton.getBoundingClientRect()
          const left = railBounds.left + rail.clientLeft
          return buttonBounds.left >= left - 0.5
            && buttonBounds.right <= left + rail.clientWidth + 0.5
        })
        expect(finalToolVisible).toBe(true)
      } else {
        expect(layout.railContained).toBe(true)
        expect(layout.toolbarTargetsInsidePanel).toBe(true)
      }
    }

    for (const [width, height] of [[116, 170], [128, 180]] as const) {
      await page.setContent(`<style>${styles}</style>${slotMarkup(frame, height, width)}`)
      const first = page.locator('[role="treeitem"][data-path="/repo/file-01.txt"]')
      const railMetrics = await page.locator('.ui-tool-panel-frame__rail').evaluate((element) => {
        const rail = element as HTMLElement
        return {
          height: rail.getBoundingClientRect().height,
          scrollable: rail.scrollWidth > rail.clientWidth + 1,
        }
      })
      expect(await rowFitsInTree(first)).toBe(true)
      expect(railMetrics.height).toBeLessThanOrEqual(34)
      expect(railMetrics.scrollable).toBe(true)
      const finalToolVisible = await page.locator('.ui-tool-panel-frame__rail').evaluate((element) => {
        const rail = element as HTMLElement
        const buttons = rail.querySelectorAll<HTMLElement>(':scope > .ui-icon-button')
        const lastButton = buttons.item(buttons.length - 1)!
        rail.scrollLeft = rail.scrollWidth
        const railBounds = rail.getBoundingClientRect()
        const buttonBounds = lastButton.getBoundingClientRect()
        const left = railBounds.left + rail.clientLeft
        return buttonBounds.left >= left - 0.5
          && buttonBounds.right <= left + rail.clientWidth + 0.5
      })
      expect(finalToolVisible).toBe(true)
    }
  } finally {
    await browser.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('file names align with sibling folders in a 300px Explorer rail', async () => {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
  try {
    const page = await context.newPage()
    await mountLiveExplorer(page)
    await page.locator('.tool-shell__panel').evaluate((panel) => {
      ;(panel as HTMLElement).style.width = '300px'
    })
    const alignment = await page.locator('.qe-explorer-row[data-path="/repo/notes.md"]').evaluate((file) => {
      const folder = document.querySelector('.qe-explorer-row[data-path="/repo/src"]')!
      return {
        fileSlotWidth: file.querySelector('.qe-explorer-chevron')!.getBoundingClientRect().width,
        folderSlotWidth: folder.querySelector('.qe-explorer-chevron')!.getBoundingClientRect().width,
        fileNameLeft: file.querySelector('.qe-explorer-name')!.getBoundingClientRect().left,
        folderNameLeft: folder.querySelector('.qe-explorer-name')!.getBoundingClientRect().left,
      }
    })
    expect(alignment.fileSlotWidth).toBeGreaterThan(0)
    expect(alignment.fileSlotWidth).toBe(alignment.folderSlotWidth)
    expect(alignment.fileNameLeft).toBe(alignment.folderNameLeft)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('shows full Markdown filenames and keeps Explorer row actions reachable at 116px', async () => {
  const context = await browser!.newContext({ viewport: { width: 647, height: 900 } })
  try {
    const page = await context.newPage()
    await mountLiveExplorer(page)
    await page.locator('.tool-shell__panel').evaluate((panel) => {
      const main = panel.closest<HTMLElement>('main')
      if (main === null) throw new Error('The Explorer panel did not render inside its shell.')
      main.style.width = '647px'
      main.style.height = '900px'
      ;(panel as HTMLElement).style.width = '116px'
      ;(panel as HTMLElement).style.height = '900px'
    })
    await page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      return promise
    })

    const filenames = await page.locator('.qe-explorer-row').evaluateAll((rows) => {
      return ['/repo/notes.md', '/repo/README.md'].map((path) => {
        const row = rows.find((candidate) => candidate.getAttribute('data-path') === path)
        const name = row?.querySelector<HTMLElement>('.qe-explorer-name')
        if (row === undefined || name === null || name === undefined) throw new Error(`The Explorer did not render ${path}.`)
        const bounds = name.getBoundingClientRect()
        return {
          name: name.textContent,
          fullyVisible: name.scrollWidth <= name.clientWidth && bounds.width > 0,
        }
      })
    })
    expect(filenames.map(({ name }) => name)).toEqual(['notes.md', 'README.md'])
    expect(filenames.every(({ fullyVisible }) => fullyVisible)).toBe(true)

    const hierarchy = await page.locator('.qe-explorer-row[data-path="/repo/src"]').evaluate((folder) => {
      const rootName = document.querySelector<HTMLElement>('.qe-explorer-row[data-path="/repo/file-01.txt"] .qe-explorer-name')
      const child = document.querySelector<HTMLElement>('.qe-explorer-row[data-path="/repo/src/child.md"]')
      const childName = child?.querySelector<HTMLElement>('.qe-explorer-name')
      if (rootName === null || child === null || childName == null) throw new Error('The nested Explorer folder did not render.')
      return {
        expanded: folder.getAttribute('aria-expanded'),
        disclosureVisible: (folder.querySelector('.qe-explorer-chevron')?.getBoundingClientRect().width ?? 0) > 0,
        childLevel: child.getAttribute('aria-level'),
        childNameOffset: childName.getBoundingClientRect().left - rootName.getBoundingClientRect().left,
      }
    })
    expect(hierarchy.expanded).toBe('true')
    expect(hierarchy.disclosureVisible).toBe(true)
    expect(hierarchy.childLevel).toBe('2')
    expect(hierarchy.childNameOffset).toBeGreaterThan(0)

    const notesRow = page.locator('.qe-explorer-row[data-path="/repo/notes.md"]')
    const notesAction = page.getByRole('button', { name: 'Actions for notes.md' })
    await notesRow.hover()
    const revealedAction = async (action: Locator) => action.evaluate((button) => {
      const row = button.closest('.qe-explorer-row')!
      const name = row.querySelector('.qe-explorer-name')!
      return {
        opacity: getComputedStyle(button.parentElement!).opacity,
        separated: name.getBoundingClientRect().right <= button.getBoundingClientRect().left,
      }
    })
    expect(await revealedAction(notesAction)).toEqual({ opacity: '1', separated: true })
    await notesAction.click()
    expect(await notesAction.getAttribute('aria-expanded')).toBe('true')
    await notesAction.click()

    await page.locator('.qe-explorer-tree-content').focus()
    for (let index = 0; index < LIVE_ROW_COUNT; index++) await page.keyboard.press('Tab')
    const readmeAction = page.getByRole('button', { name: 'Actions for README.md' })
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe('Actions for README.md')
    expect(await revealedAction(readmeAction)).toEqual({ opacity: '1', separated: true })
    await page.keyboard.press('Enter')
    expect(await readmeAction.getAttribute('aria-expanded')).toBe('true')
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable)).each(['New File', 'New Folder', 'Rename'] as const)(
  'scrolls complete inline Explorer %s form into view after autofocus',
  async (action) => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
    try {
      const page = await context.newPage()
      await mountLiveExplorer(page)
      const tree = page.locator('.qe-explorer-tree')
      expect(await tree.evaluate((element) => element.scrollTop)).toBe(0)
      if (action === 'Rename') {
        await page.getByRole('button', { name: 'Actions for file-01.txt' }).click()
        await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      } else {
        await page.getByRole('button', { name: action, exact: true }).click()
      }
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')
        return input !== null && document.activeElement === input
      })
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>()
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        return promise
      })

      const geometry = await inlineRowGeometry(page)
      expect(geometry.focused).toBe(true)
      expect(geometry.controls.map(({ label }) => label)).toEqual(action === 'Rename' ? ['input', 'Rename', 'Cancel'] : ['input', 'Create', 'Cancel'])
      expect(geometry.row.top).toBeGreaterThanOrEqual(geometry.scrollport.top - 0.5)
      expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.scrollport.bottom + 0.5)
      expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.footer.top + 0.5)
      for (const control of geometry.controls) {
        expect(control.top).toBeGreaterThanOrEqual(geometry.scrollport.top - 0.5)
        expect(control.bottom).toBeLessThanOrEqual(geometry.scrollport.bottom + 0.5)
        expect(control.left).toBeGreaterThanOrEqual(geometry.scrollport.left - 0.5)
        expect(control.right).toBeLessThanOrEqual(geometry.scrollport.right + 0.5)
      }
    } finally {
      await context.close()
    }
  },
  60_000,
)

test.skipIf(!existsSync(executable))('search mode keeps its named input and a selector stays available without a layout worktree', async () => {
  await mountExplorer('w1')
  const modeGroup = container.querySelector<HTMLElement>('[aria-label="Explorer search mode"]')!
  const names = modeGroup.querySelectorAll<HTMLButtonElement>('button')[0]!
  const contents = modeGroup.querySelectorAll<HTMLButtonElement>('button')[1]!

  expect(names.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { contents.click() })
  expect(contents.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('.qe-explorer-query .ui-text-field__label')?.textContent).toBe('Search files')
  expect(container.querySelector('.qe-explorer-query input')?.getAttribute('placeholder')).toBe('Search')
  await act(async () => { names.click() })
  expect(names.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('.qe-explorer-query .ui-text-field__label')?.textContent).toBe('Find files')

  const frame = await mountExplorer(null)
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`<style>${await designSystemStyles()}</style>${slotMarkup(frame, 170)}`)
    const worktree = page.getByRole('combobox', { name: 'Worktree' })
    expect(await worktree.isVisible()).toBe(true)
    const bounds = await worktree.boundingBox()
    expect(bounds?.width).toBeGreaterThan(0)
    expect(await page.getByRole('textbox', { name: 'Find files' }).count()).toBe(1)
  } finally {
    await browser.close()
  }
}, 60_000)
