import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
type SelectionDensityLog = {
  calls: { method: string; params: Record<string, unknown> }[]
  opens: string[]
  selections: { mode: 'toggle' | 'range' }[]
  renames: { id: string; name: string }[]
}
declare global { interface Window { __selectionDensityLog: SelectionDensityLog } }

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.worktree/node_modules')
const EXECUTABLE = [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].find((path) => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
})
const BRANCH = 'long-feature-branch-of-repeated-characters'.repeat(4)
const IDS = ['selected', 'parent', 'child', 'grandchild', 'sleeping'] as const
const WIDTHS = [320, 240, 160, 116] as const
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/rpc.ts'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'worktree-selection-density-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/protocol|@quirky\/ui)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}

type BrowserBundle = { js: string; css: string }
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

let browser: Browser | null = null
let bundle: BrowserBundle = { js: '', css: '' }
let previousQuirkyHome: string | undefined
let isolatedHome = ''
const pages: Page[] = []

function browserEntry(): string {
  const treeModule = resolve(ROOT, 'plugins/quirky.worktree/src/Tree.tsx')
  const viewModelModule = resolve(ROOT, 'plugins/quirky.worktree/src/view-model.ts')
  const viewTypesModule = resolve(ROOT, 'plugins/quirky.worktree/src/view-types.ts')
  const controlTypesModule = resolve(ROOT, 'plugins/quirky.worktree/src/control-types.ts')
  const uiControlModule = resolve(ROOT, 'plugins/quirky.worktree/src/ui-control.ts')
  return `
    import { createRoot } from 'react-dom/client'
    import { ToolPanelFrame } from '@quirky/ui'
    import { Tree } from ${JSON.stringify(treeModule)}
    import { buildTree } from ${JSON.stringify(viewModelModule)}
    import { DEFAULT_ACTIVITY_PREFERENCES, allSpecFromStock } from ${JSON.stringify(viewTypesModule)}
    import { DEFAULT_STOCK_OPTIONS } from ${JSON.stringify(controlTypesModule)}
    import { dispatchUiControl, UI_CONTROL_COMMAND } from ${JSON.stringify(uiControlModule)}

    const branch = document.getElementById('host').dataset.branch ?? ${JSON.stringify(BRANCH)}
    const repo = { id: 'repo', name: 'QuirkyApp', path: '/workspace/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }
    const tags = [
      { id: 'urgent', name: 'urgent', color: 'coral' },
      { id: 'release', name: 'release-2.4', color: null },
      { id: 'docs', name: 'docs', color: null }
    ]
    const worktree = (id, name, manualOrder, extra = {}) => ({
      id,
      repoId: 'repo',
      path: '/workspace/QuirkyApp/' + id,
      branch,
      head: 'abc123',
      isMain: false,
      name,
      instanceId: id,
      kind: 'git',
      displayName: null,
      comment: '',
      status: 'in-progress',
      pinned: false,
      unread: false,
      parentId: null,
      createdAt: 1,
      createdBy: 'api',
      baseRef: null,
      keepBranch: false,
      removing: false,
      groupId: null,
      projectGroupId: null,
      lastActivityAt: 9999000,
      manualOrder,
      sleeping: false,
      sleepChangedAt: null,
      references: [],
      archivedAt: null,
      cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
      externalVisible: true,
      externalVisibility: 'show',
      externalInboxSuppressed: false,
      tagIds: [],
      ...extra
    })
    const worktrees = [
      worktree('selected', 'selected', 5, { tagIds: ['urgent', 'release', 'docs'] }),
      worktree('parent', 'parent', 4, { unread: true }),
      worktree('child', 'child', 3, { parentId: 'parent' }),
      worktree('grandchild', 'grandchild', 2, { parentId: 'child' }),
      worktree('sleeping', 'sleeping', 1, { sleeping: true })
    ]
    const marks = new Map([['parent', 'waiting']])
    const options = { ...DEFAULT_STOCK_OPTIONS, groupBy: 'project', sortBy: 'manual', showSleeping: true }
    const baseSpec = allSpecFromStock(options, DEFAULT_ACTIVITY_PREFERENCES)
    const model = buildTree({
      worktrees,
      repos: [repo],
      groups: [],
      tags,
      spec: { ...baseSpec, display: { ...baseSpec.display, groupBy: 'project', sortBy: 'manual', showNested: true, showAsleep: true } },
      viewId: 'all',
      projection: null,
      marks,
      checks: new Map()
    })
    const log = window.__selectionDensityLog = { calls: [], opens: [], selections: [], renames: [] }
    const context = {
      async call(method, params = {}) {
        log.calls.push({ method, params })
        if (method === 'ui.window.self') return { connId: 7 }
        if (method === 'ui.window.command.run') {
          if (params.connId !== 7 || params.id !== UI_CONTROL_COMMAND) throw new Error('Unexpected local UI control command')
          return { result: dispatchUiControl(context, params.args) }
        }
        return []
      },
      toast() {},
      log() {},
      subscribe() { return () => {} },
      onConnection() { return () => {} },
      openView() {}
    }
    const treeProps = {
      context,
      model,
      tagsById: new Map(tags.map((tag) => [tag.id, tag])),
      rowFact: 'branch',
      repos: [repo],
      groups: [],
      sessions: [],
      selectedId: 'selected',
      multiSelected: new Set(['parent']),
      automationExpandedId: null,
      automationAvailability: null,
      onToggleAutomationDetails() {},
      now: 10000000,
      separatorEnabled: false,
      options,
      canShowSleeping: () => true,
      statusDefinitions: [
        { id: 'todo', label: 'Todo' },
        { id: 'in-progress', label: 'In progress' },
        { id: 'in-review', label: 'In review' },
        { id: 'done', label: 'Done' }
      ],
      projectIdentities: {},
      allWorktrees: worktrees,
      onDropPreviewChange() {},
      onSeparatorStateChange() {},
      openDialog() {},
      requestDelete() {},
      onOpen(id) { log.opens.push(id) },
      onSelectToggle(id, mode, rendered) { log.selections.push({ id, mode, rendered: rendered || [] }) },
      onRename(id, name) { log.renames.push({ id, name }) }
    }

    function Fixture() {
      return (
        <ToolPanelFrame title="Worktrees">
          <div id="tree-scroll" className="ui-scroll">
            <Tree {...treeProps} groupBy="project" />
          </div>
        </ToolPanelFrame>
      )
    }

    createRoot(document.getElementById('host')).render(<Fixture />)
  `
}

beforeAll(async () => {
  if (!EXECUTABLE) throw new Error('Worktree selection-density browser tests require an installed Chromium-family executable.')
  previousQuirkyHome = process.env.QUIRKY_HOME
  isolatedHome = mkdtempSync(join(tmpdir(), 'quirky-selection-density-home-'))
  process.env.QUIRKY_HOME = isolatedHome

  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-selection-density-build-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.tsx')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint, resolve(ROOT, 'packages/ui/src/styles.css')],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    for (const output of result.outputs) {
      if (output.path.endsWith('.js')) bundle.js = await output.text()
      if (output.path.endsWith('.css')) bundle.css = await output.text()
    }
    if (!bundle.js || !bundle.css) throw new Error('The production React or UI stylesheet browser bundle was empty.')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE })
}, 60_000)

afterEach(async () => {
  for (const page of pages.splice(0)) await page.close()
})

afterAll(async () => {
  await browser?.close()
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true })
})

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function mount(width = 320, theme: 'dark' | 'light' = 'dark', branch = BRANCH): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } })
  pages.push(page)
  await page.setContent(`<!doctype html>
    <html data-theme="${theme}"><head><style>
      ${bundle.css}
      html, body { width: 100%; height: 100%; margin: 0; }
      #host { box-sizing: border-box; width: ${width}px; height: 360px; min-width: 0; }
      #host > .ui-tool-panel-frame { height: 100%; min-width: 0; }
      #tree-scroll { box-sizing: border-box; height: 280px; min-width: 0; width: 100%; }
    </style></head><body><div id="host" data-tool-panel=""></div></body></html>`)
  await page.locator('#host').evaluate((element, value) => {
    ;(element as HTMLElement).dataset.branch = value
  }, branch)
  await page.addScriptTag({ content: bundle.js })
  await page.waitForFunction(() => document.querySelectorAll('.worktree-tree [data-worktree-id]').length === 5)
  await settle(page)
  return page
}

async function resize(page: Page, width: number): Promise<void> {
  await page.locator('#host').evaluate((element, nextWidth) => {
    ;(element as HTMLElement).style.width = `${nextWidth}px`
  }, width)
  await settle(page)
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.locator('html').evaluate((element, nextTheme) => {
    ;(element as HTMLElement).dataset.theme = nextTheme
  }, theme)
  await settle(page)
}

async function measureRows(page: Page) {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('#tree-scroll')!
    const box = (element: Pick<Element, 'getBoundingClientRect'>): Rect => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    return {
      panel: { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth },
      frameWidth: document.querySelector<HTMLElement>('.ui-tool-panel-frame')!.getBoundingClientRect().width,
      rows: [...scroll.querySelectorAll<HTMLElement>('[data-worktree-id]')].map((item) => {
        const row = item.querySelector<HTMLElement>('.worktree-row')!
        const main = row.querySelector<HTMLElement>('.worktree-row__main')!
        const name = row.querySelector<HTMLElement>('.worktree-name')!
        const fact = row.querySelector<HTMLElement>('.worktree-fact')!
        const menu = row.querySelector<HTMLElement>('.worktree-menu')!
        const text = name.firstChild
        const range = document.createRange()
        if (!text) throw new Error(`Missing name text for ${item.dataset.worktreeId}`)
        range.setStart(text, 0)
        range.setEnd(text, 1)
        const glyph = range.getBoundingClientRect()
        const hit = document.elementFromPoint(glyph.left + glyph.width / 2, glyph.top + glyph.height / 2)
        const mark = row.querySelector<HTMLElement>('.ui-activity-mark')
        const unread = row.querySelector<HTMLElement>('.worktree-unread-dot')
        const child = row.querySelector<HTMLElement>('.worktree-child-toggle')
        return {
          id: item.dataset.worktreeId!,
          depth: Number(item.style.getPropertyValue('--depth')),
          row: box(row),
          main: box(main),
          name: box(name),
          glyph: box({ getBoundingClientRect: () => glyph }),
          glyphHit: hit !== null && main.contains(hit),
          glyphHitTarget: hit?.className,
          fact: box(fact),
          nameTitle: name.title,
          factTitle: fact.title,
          menu: box(menu),
          mark: mark ? box(mark) : null,
          unread: unread ? box(unread) : null,
          child: child ? box(child) : null,
          tags: [...item.querySelectorAll<HTMLElement>('.ui-tag-chips > .ui-tag-chip')].map((tag) => tag.textContent?.trim() ?? ''),
          moreTags: item.querySelector<HTMLElement>('.ui-tag-chips > .ui-tag-chips__more')?.textContent?.trim() ?? null
        }
      })
    }
  })
}

function rowById<T extends { id?: string }>(rows: T[], id: string): T {
  const row = rows.find((item) => item.id === id)
  if (!row) throw new Error(`Missing row ${id}`)
  return row
}

function expectContained(inner: Rect, outer: Rect): void {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
  expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
}

function expectNear(actual: number, expected: number, tolerance = 0.5): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

for (const theme of ['dark', 'light'] as const) {
  test(`keeps short fact text aligned to the trail and hidden menu at 320px (${theme})`, async () => {
    const page = await mount(320, theme, 'now')
    const metrics = await page.locator('[data-worktree-id="grandchild"] .worktree-trail').evaluate((trail) => {
      const fact = trail.querySelector<HTMLElement>('.worktree-fact')!
      const reveal = trail.querySelector<HTMLElement>('.worktree-reveal')!
      const menu = reveal.querySelector<HTMLElement>('.worktree-menu')!
      const text = fact.firstChild!
      const range = document.createRange()
      range.selectNodeContents(text)
      const glyphs = range.getBoundingClientRect()
      return {
        text: range.toString(),
        factOpacity: getComputedStyle(fact).opacity,
        menuOpacity: getComputedStyle(reveal).opacity,
        glyphWidth: glyphs.width,
        slotWidth: trail.getBoundingClientRect().width,
        textRight: glyphs.right,
        trailRight: trail.getBoundingClientRect().right,
        menuRight: menu.getBoundingClientRect().right
      }
    })
    expect(metrics.text).toBe('now')
    expect(metrics.factOpacity).toBe('1')
    expect(metrics.menuOpacity).toBe('0')
    expect(metrics.slotWidth - metrics.glyphWidth).toBeGreaterThan(1)
    expectNear(metrics.textRight, metrics.trailRight)
    expectNear(metrics.textRight, metrics.menuRight)
  }, 60_000)
}

test('keeps the real Worktree tree dense, hit-testable and inside its panel at narrow widths', async () => {
  const page = await mount()
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme)
    for (const width of WIDTHS) {
      await resize(page, width)
      await page.mouse.move(1100, 790)
      const layout = await measureRows(page)
      expect(layout.frameWidth).toBeCloseTo(width, 0)
      expect(layout.panel.scrollWidth).toBeLessThanOrEqual(layout.panel.clientWidth + 1)
      expect(layout.rows.map((row) => row.id)).toEqual([...IDS])
      expect(layout.rows.map((row) => row.depth)).toEqual([0, 0, 1, 2, 0])

      for (const row of layout.rows) {
        expect(row.row.height).toBeCloseTo(26, 0)
        expect(row.glyph.width).toBeGreaterThan(0)
        expect(row.glyph.left).toBeGreaterThanOrEqual(row.name.left - 0.5)
        expect(row.glyph.top).toBeGreaterThanOrEqual(row.name.top - 0.5)
        expect(row.glyph.right).toBeLessThanOrEqual(row.name.right + 0.5)
        expect(row.glyph.bottom).toBeLessThanOrEqual(row.name.bottom + 0.5)
        expect(row.glyphHit, JSON.stringify({ theme, width, id: row.id, main: row.main, name: row.name, fact: row.fact, target: row.glyphHitTarget, menu: row.menu, child: row.child })).toBe(true)
        expect(row.nameTitle).toBe(row.id)
        expectContained(row.menu, row.row)
        for (const control of [row.mark, row.unread, row.child]) if (control) {
          expect(control.width).toBeGreaterThan(0)
          expect(control.height).toBeGreaterThan(0)
        }
        if (row.mark) expectContained(row.mark, row.row)
        if (row.unread) expectContained(row.unread, row.row)
        if (row.child) expectContained(row.child, row.row)
      }
      for (let index = 0; index < layout.rows.length - 1; index += 1) {
        expectNear(layout.rows[index + 1]!.row.top - layout.rows[index]!.row.bottom, 4)
      }
      expectNear(rowById(layout.rows, 'child').row.left - rowById(layout.rows, 'parent').row.left, 12)
      expectNear(rowById(layout.rows, 'grandchild').row.left - rowById(layout.rows, 'child').row.left, 12)

      if (width === 240 || width === 320) {
        const selected = rowById(layout.rows, 'selected')
        expect(selected.tags.length).toBeLessThanOrEqual(2)
        expect(selected.tags).toEqual(['urgent', 'release-2.4'].slice(0, selected.tags.length))
        expect(Number(selected.moreTags?.slice(1) ?? 0)).toBe(3 - selected.tags.length)
        expect(selected.moreTags).toBe(`+${3 - selected.tags.length}`)
      }
    }

    await resize(page, 116)
    await page.locator('[data-worktree-id="grandchild"]').hover()
    await page.waitForFunction((branch) => document.querySelector('.worktree-hover__branch')?.textContent === branch, BRANCH)
    expect(await page.locator('.worktree-hover__branch').textContent()).toBe(BRANCH)
  }
}, 60_000)

test('preserves neutral selection, ordinary hover/focus and unclipped focus rings with either panel marker', async () => {
  const page = await mount()
  const expectedSelection: Record<'dark' | 'light', string> = {
    dark: 'rgb(34, 36, 43)',
    light: 'rgb(231, 233, 239)'
  }
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme)
    for (const panelFocused of [false, true]) {
      await page.locator('#host').evaluate((element, focused) => {
        if (focused) element.setAttribute('data-panel-focused', '')
        else element.removeAttribute('data-panel-focused')
      }, panelFocused)
      await page.mouse.move(1100, 790)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await settle(page)
      const resting = await page.evaluate(() => {
        const styles = (id: string) => {
          const row = document.querySelector<HTMLElement>(`[data-worktree-id="${id}"] .worktree-row`)!
          const name = row.querySelector<HTMLElement>('.worktree-name')!
          return { background: getComputedStyle(row).backgroundColor, weight: getComputedStyle(name).fontWeight, color: getComputedStyle(name).color }
        }
        const accent = document.createElement('span')
        accent.style.color = 'var(--ui-accent)'
        document.body.append(accent)
        const accentColor = getComputedStyle(accent).color
        accent.remove()
        const muted = document.createElement('span')
        muted.style.color = 'var(--ui-muted)'
        document.body.append(muted)
        const mutedColor = getComputedStyle(muted).color
        muted.remove()
        return { selected: styles('selected'), multi: styles('parent'), ordinary: styles('grandchild'), sleeping: styles('sleeping'), accentColor, mutedColor }
      })
      expect(resting.selected.background).toBe(expectedSelection[theme])
      expect(resting.selected.background).not.toBe(resting.accentColor)
      expect(resting.selected.weight).toBe('600')
      expect(resting.multi.background).toBe(expectedSelection[theme])
      expect(resting.multi.weight).toBe('600')
      expect(resting.ordinary.background).toBe('rgba(0, 0, 0, 0)')
      expect(resting.sleeping.color).toBe(resting.mutedColor)

      const beforeReveal = await measureRows(page)
      const ordinaryMain = page.locator('[data-worktree-id="grandchild"] .worktree-row__main')
      await page.locator('[data-worktree-id="grandchild"]').hover()
      await page.waitForTimeout(180)
      const hovered = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-worktree-id="grandchild"] .worktree-row')!
        return { background: getComputedStyle(row).backgroundColor, weight: getComputedStyle(row.querySelector('.worktree-name')!).fontWeight }
      })
      expect(hovered.background).toBe(expectedSelection[theme])
      expect(hovered.weight).toBe('400')
      await page.mouse.move(1100, 790)
      await page.waitForTimeout(180)
      await page.keyboard.press('Tab')
      await ordinaryMain.focus()
      const mainFocus = await inspectFocus(page, '[data-worktree-id="grandchild"] .worktree-row__main')
      expect(mainFocus.focusVisible).toBe(true)
      expect(mainFocus.outlineStyle).toBe('solid')
      expect(mainFocus.outlineWidth).toBe('2px')
      expect(mainFocus.outlineColor).toBe(mainFocus.accentColor)
      expect(mainFocus.clipped).toBe(false)
      const focusedRow = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-worktree-id="grandchild"] .worktree-row')!
        return { background: getComputedStyle(row).backgroundColor, weight: getComputedStyle(row.querySelector('.worktree-name')!).fontWeight }
      })
      expect(focusedRow.background).toBe(expectedSelection[theme])
      expect(focusedRow.weight).toBe('400')

      const menuButton = page.locator('[data-worktree-id="grandchild"] .worktree-menu')
      await menuButton.focus()
      const menuFocus = await inspectFocus(page, '[data-worktree-id="grandchild"] .worktree-menu')
      expect(menuFocus.focusVisible).toBe(true)
      expect(menuFocus.outlineStyle).toBe('solid')
      expect(menuFocus.outlineWidth).toBe('2px')
      expect(menuFocus.outlineColor).toBe(menuFocus.accentColor)
      expect(menuFocus.clipped).toBe(false)
      const afterReveal = await measureRows(page)
      for (const id of IDS) {
        const before = rowById(beforeReveal.rows, id).row
        const after = rowById(afterReveal.rows, id).row
        const beforeMenu = rowById(beforeReveal.rows, id).menu
        const afterMenu = rowById(afterReveal.rows, id).menu
        for (const edge of ['left', 'top', 'width', 'height'] as const) expectNear(afterMenu[edge], beforeMenu[edge])
        expectNear(after.top, before.top)
        expectNear(after.height, before.height)
      }
    }
  }
}, 60_000)

async function inspectFocus(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    const width = Number.parseFloat(style.outlineWidth)
    const offset = Number.parseFloat(style.outlineOffset)
    const extent = Math.max(0, width + offset)
    const ring = { left: bounds.left - extent, top: bounds.top - extent, right: bounds.right + extent, bottom: bounds.bottom + extent }
    let clipped = false
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor)
      const ancestorBounds = ancestor.getBoundingClientRect()
      const clipLeft = ancestorBounds.left + ancestor.clientLeft
      const clipTop = ancestorBounds.top + ancestor.clientTop
      const clipRight = clipLeft + ancestor.clientWidth
      const clipBottom = clipTop + ancestor.clientHeight
      if (ancestorStyle.overflowX !== 'visible' && (ring.left < clipLeft - 0.5 || ring.right > clipRight + 0.5)) clipped = true
      if (ancestorStyle.overflowY !== 'visible' && (ring.top < clipTop - 0.5 || ring.bottom > clipBottom + 0.5)) clipped = true
    }
    const accent = document.createElement('span')
    accent.style.color = 'var(--ui-accent)'
    document.body.append(accent)
    const accentColor = getComputedStyle(accent).color
    accent.remove()
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      accentColor,
      clipped
    }
  })
}

test('keeps row menu focus return, child folding, navigation, rename and modified selection working', async () => {
  const page = await mount(320)
  const parentToggle = page.locator('[data-worktree-id="parent"] .worktree-child-toggle')
  await parentToggle.click()
  await page.waitForFunction(() => !document.querySelector('[data-worktree-id="child"]'))
  await parentToggle.click()
  await page.waitForFunction(() => document.querySelector('[data-worktree-id="grandchild"]') !== null)

  const childToggle = page.locator('[data-worktree-id="child"] .worktree-child-toggle')
  await childToggle.click()
  await page.waitForFunction(() => !document.querySelector('[data-worktree-id="grandchild"]'))
  await childToggle.click()
  await page.waitForFunction(() => document.querySelector('[data-worktree-id="grandchild"]') !== null)

  const grandchildMain = page.locator('[data-worktree-id="grandchild"] .worktree-row__main')
  await grandchildMain.click({ modifiers: ['Meta'] })
  if (process.platform === 'darwin') {
    await grandchildMain.click({ modifiers: ['Control'] })
    const contextMenu = page.getByRole('menu', { name: 'Actions for grandchild', exact: true })
    await contextMenu.waitFor({ state: 'visible' })
    expect(await page.evaluate(() => window.__selectionDensityLog.selections.map((item) => item.mode))).toEqual(['toggle'])
    await page.keyboard.press('Escape')
    await contextMenu.waitFor({ state: 'detached' })
  } else {
    await grandchildMain.click({ modifiers: ['Control'] })
  }
  await grandchildMain.click({ modifiers: ['Shift'] })
  const selectionModes = await page.evaluate(() => window.__selectionDensityLog.selections.map((item) => item.mode))
  expect(selectionModes).toEqual(process.platform === 'darwin' ? ['toggle', 'range'] : ['toggle', 'toggle', 'range'])

  await grandchildMain.click()
  await page.waitForFunction(() => window.__selectionDensityLog.calls.some((call) => call.method === 'quirky.worktree/navigate'))
  const navigation = await page.evaluate(() => ({
    opened: window.__selectionDensityLog.opens,
    calls: window.__selectionDensityLog.calls.filter((call) => call.method === 'quirky.worktree/navigate')
  }))
  expect(navigation.opened).toContain('grandchild')
  expect(navigation.calls.some((call) => call.params.worktree === 'grandchild')).toBe(true)

  const menuButton = page.locator('[data-worktree-id="sleeping"] .worktree-menu')
  await page.locator('[data-worktree-id="sleeping"]').hover()
  await page.waitForTimeout(180)
  await menuButton.click()
  const menu = page.getByRole('menu', { name: 'Actions for sleeping', exact: true })
  await menu.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  expect(await menuButton.evaluate((element) => document.activeElement === element)).toBe(true)

  await menuButton.click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('textbox', { name: 'Rename sleeping', exact: true })
  await rename.waitFor({ state: 'visible' })
  await rename.fill('sleeping-renamed')
  await rename.press('Enter')
  await page.waitForFunction(() => window.__selectionDensityLog.renames.length === 1)
  expect(await page.evaluate(() => window.__selectionDensityLog.renames)).toEqual([
    { id: 'sleeping', name: 'sleeping-renamed' }
  ])
}, 60_000)
