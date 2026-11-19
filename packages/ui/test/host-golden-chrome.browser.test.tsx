import { beforeAll, afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, ControlIcon, FormRow, ListRow, SectionHeader, Tabs, TextField } from '../src/design-system'
import { encodeFileId, PALETTE_SEARCH_LABEL } from '../src/plugins/palette'
import { browserExecutable } from '../../../scripts/test-support/browser'
import * as capture from '../../../scripts/ui-review/capture'

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
const PALETTE_CONTEXT = join(ROOT, 'packages/ui/src/context.tsx')
const PALETTE_COMPONENT = join(ROOT, 'packages/ui/src/plugins/CommandPalette.tsx')
const CHANGES_LIST = join(ROOT, 'plugins/quirky.git/src/panel/list.tsx')
const LONG_PALETTE_TITLE = 'VeryLongUnbrokenCommandName'.repeat(5)
declare global {
  interface Window {
    __paletteFixture: {
      closeCount: number
      mountPalette(options: unknown): unknown
      mountChanges(): void
      last: {
        calls: { method: string; params: unknown }[]
        ran: { commands: string[]; tools: string[]; views: string[] }
      }
    }
  }
}
const executable = browserExecutable()
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'host-golden-palette-browser-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /host-golden-palette-fixture\.ts$/ }, () => ({
      path: 'entry',
      namespace: 'palette-entry'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'palette-entry' }, () => ({
      contents: browserEntry(),
      loader: 'ts',
      resolveDir: ROOT
    }))
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@quirky\/ui|@quirky\/protocol)$/ }, ({ path }) => ({
      path: BROWSER_IMPORTS[path] ?? path
    }))
    builder.onResolve({ filter: /^\.\.\/shell\/attention$/ }, () => ({
      path: 'palette-attention',
      namespace: 'palette-fixture'
    }))
    builder.onLoad({ filter: /.*/, namespace: 'palette-fixture' }, ({ path }) => ({
      loader: 'js',
      contents: path === 'palette-attention'
        ? 'export function useAttention() { return window.__paletteAttention }'
        : ''
    }))
  }
}
let browser: Browser
let browserBundle = ''
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'host-golden-palette-fixture.ts')],
    target: 'browser',
    format: 'iife',
    plugins: [browserDependencyResolver],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
  const output = result.outputs[0]
  if (!output) throw new Error('The host-golden palette browser bundle was empty.')
  browserBundle = await output.text()
  browser = await chromium.launch({ headless: true, executablePath: executable })
}, 60_000)
function browserEntry(): string {
  return `
    import { createElement as h } from 'react'
    import { createRoot } from 'react-dom/client'
    import { AppContext } from ${JSON.stringify(PALETTE_CONTEXT)}
    import { CommandPalette } from ${JSON.stringify(PALETTE_COMPONENT)}
    import { ReviewList } from ${JSON.stringify(CHANGES_LIST)}
    let paletteRoot = null
    const fixture = {
      closeCount: 0,
      mountChanges() {
        const items = [
          { path: 'src/ToolShell.tsx', status: 'M', added: 22, removed: 2, mark: 'reviewed', notes: 2, uncommitted: true },
          { path: 'src/tool-shell.css', status: 'M', added: 8, removed: 1, mark: 'none' },
          { path: 'src/project-title.ts', status: 'A', added: 12, removed: 0, mark: 'changed' }
        ]
        const handlers = { click() {}, contextMenu() {}, dragText: (item) => item.path,
          buttons: () => [{ label: 'Revert', glyph: '↶', run() {} }, { label: 'Open', glyph: '↗', run() {} }] }
        createRoot(document.getElementById('changes-root')).render(h(ReviewList, {
          label: 'Changes files', files: items, viewMode: 'list', collapsed: new Set(),
          selected: items[0].path, handlers, onToggleDir() {}, onKeyDown() {}
        }))
      },
      mountPalette(options = {}) {
        const calls = []
        const ran = { commands: [], tools: [], views: [] }
        fixture.last = { calls, ran }
        const listeners = new Set()
        const worktrees = options.worktrees ?? []
        const state = {
          model: options.model ?? { commands: [], tools: [], views: [] },
          layout: {
            view: null,
            worktree: options.selected === undefined ? 'wt_a' : options.selected,
            paletteRecents: options.recents ?? []
          },
          windowRoute: null
        }
        const store = { dispatch: (action) => calls.push({ method: 'dispatch', params: action }) }
        const connection = {
          store,
          async callAny(method, params) {
            calls.push({ method, params })
            if (method === 'quirky.agents/list') return { agents: [] }
            if (method === 'ui.window.self') return { connId: 4 }
            if (method === 'quirky.editor/quickOpen') {
              return { results: [{ path: 'src/search-result.ts', name: 'search-result.ts', score: 1 }], truncated: false, history: [] }
            }
            return {}
          },
          onEvent: () => () => {},
          onConnected: () => () => {}
        }
        const plugins = {
          getState: () => state,
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          async runCommand(id) { ran.commands.push(id) },
          openTool(id) { ran.tools.push(id) },
          openView(id) { ran.views.push(id) }
        }
        window.__paletteAttention = {
          snapshot: { repos: [], worktrees, errors: { repos: null, worktrees: null } }
        }
        fixture.closeCount = 0
        paletteRoot = createRoot(document.getElementById('palette-root'))
        paletteRoot.render(h(AppContext.Provider, { value: { store, connection, plugins } },
          h(CommandPalette, {
            onClose() {
              fixture.closeCount++
              paletteRoot?.unmount()
              paletteRoot = null
            }
          })
        ))
        return { calls, ran }
      }
    }
    window.__paletteFixture = fixture
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
    result += media && importedUrl.protocol === 'file:' ? `@media ${media} {\\n${imported}\\n}` : imported
    cursor = index + match[0].length
  }
  return result + source.slice(cursor)
}

async function productionStyles(): Promise<string> {
  const shell = await expandStyleImports(new URL('../src/shell/chrome.css', import.meta.url))
  const app = await expandStyleImports(new URL('../src/styles.css', import.meta.url))
  return `${shell}\n${app}`
}
async function savePaletteEvidence(page: Page, theme: string, width: string): Promise<void> {
  const directory = process.env.G3_67_BROWSER_EVIDENCE
  if (!directory) return
  if (!isAbsolute(directory)) throw new Error('G3_67_BROWSER_EVIDENCE must be an absolute directory.')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `palette-${theme}-${width}.png`)
  if (existsSync(path)) throw new Error(`Refusing to overwrite palette evidence: ${path}`)
  await page.screenshot({ path })
}
afterAll(async () => { await browser?.close() }, 30_000)

test('Settings opens from the Window bar when a plugin also has a More button', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`
      <header class="window-bar" aria-label="Window bar">
        <button aria-label="More" onclick="document.querySelector('[role=menu]').hidden=false">Host</button>
      </header>
      <section data-plugin-slot="sidebar:worktrees">
        <button aria-label="More" onclick="document.body.dataset.pluginClicked='true'">Plugin</button>
      </section>
      <div role="menu" hidden><button role="menuitem" onclick="document.querySelector('[role=dialog]').hidden=false">Settings</button></div>
      <div role="dialog" aria-label="Settings" hidden>Settings content</div>
    `)
    await capture.openSettings({ page, options: { timeoutMs: 1_000 } } as Parameters<typeof capture.openSettings>[0])
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('body').getAttribute('data-plugin-clicked')).toBeNull()
  } finally {
    await page.close()
  }
})
test('rejects unavailable host Settings controls without clicking plugin More', async () => {
  const cases = [
    {
      hostControls: '',
      hostMenu: '',
      expectedError: 'host Overflow control is unavailable'
    },
    {
      hostControls: `
        <button aria-label="More">Host one</button>
        <button aria-label="More">Host two</button>
      `,
      hostMenu: '',
      expectedError: 'host Overflow control is unavailable'
    },
    {
      hostControls: `<button aria-label="More" onclick="document.querySelector('[role=menu]').hidden=false">Host</button>`,
      hostMenu: `<div role="menu" hidden><button role="menuitem">Help</button></div>`,
      expectedError: 'host Settings control is unavailable'
    }
  ]
  for (const scenario of cases) {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <header class="window-bar" aria-label="Window bar">
          ${scenario.hostControls}
        </header>
        <section data-plugin-slot="sidebar:worktrees">
          <button aria-label="More" onclick="document.body.dataset.pluginClicked='true'">Plugin</button>
        </section>
        ${scenario.hostMenu}
      `)
      const error = await capture.openSettings({ page, options: { timeoutMs: 1_000 } } as Parameters<typeof capture.openSettings>[0])
        .then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(scenario.expectedError)
      expect(await page.locator('body').getAttribute('data-plugin-clicked')).toBeNull()
    } finally {
      await page.close()
    }
  }
})

test('the palette probe requires its named search field inside the Command palette dialog', async () => {
  const page = await browser.newPage()
  try {
    const field = '<input aria-label="Search commands, tools, views, worktrees, and files">'
    await page.setContent(`<div role="dialog" aria-label="Command palette">${field}</div>`)
    expect(await capture.paletteFieldMounted(page)).toBe(true)
    await page.setContent(`${field}<div role="dialog" aria-label="Command palette"><input aria-label="Unrelated"></div>`)
    expect(await capture.paletteFieldMounted(page)).toBe(false)
    await page.setContent(field)
    expect(await capture.paletteFieldMounted(page)).toBe(false)
  } finally {
    await page.close()
  }
})

const themes = [
  { name: 'dark', surface: 'rgb(22, 23, 27)', selected: 'rgb(34, 36, 43)', text: 'rgb(230, 231, 235)', muted: 'rgb(141, 145, 155)', accent: 'rgb(124, 140, 255)', rail: 'rgb(12, 13, 15)' },
  { name: 'light', surface: 'rgb(255, 255, 255)', selected: 'rgb(231, 233, 239)', text: 'rgb(32, 35, 42)', muted: 'rgb(107, 114, 128)', accent: 'rgb(91, 108, 255)', rail: 'rgb(238, 240, 243)' }
] as const

const PALETTE_SCENARIO_MODEL = {
  commands: [
    { id: 'command:layout/short-command', plugin: 'layout', title: 'Short command', description: 'Command detail', module: null },
    { id: 'command:layout/long-command', plugin: 'layout', title: LONG_PALETTE_TITLE, description: 'Long command detail', module: null },
    { id: 'command:layout/title-only-command', plugin: 'layout', title: 'Title-only command', module: null }
  ],
  tools: [
    { id: 'tool:layout/short-tool', title: 'Short tool', icon: 'terminal-window', hue: 'teal', defaultSlot: 'bottom-left' },
    { id: 'tool:layout/long-tool', title: LONG_PALETTE_TITLE, icon: 'terminal-window', hue: 'teal', defaultSlot: 'bottom-right' }
  ],
  views: [
    { id: 'view:layout/short-view', kind: 'view', plugin: 'layout', title: 'Short view', order: 0, module: null },
    { id: 'view:layout/long-view', kind: 'view', plugin: 'layout', title: LONG_PALETTE_TITLE, order: 1, module: null }
  ]
}
const PALETTE_SCENARIO_WORKTREES = [
  { id: 'wt_short', repoId: 'repo', name: 'Short worktree', branch: 'short-branch', path: '/wt/short' },
  { id: 'wt_long', repoId: 'repo', name: LONG_PALETTE_TITLE, branch: 'long-branch', path: '/wt/long' }
]
const PALETTE_SCENARIO_RECENTS = [
  `file:${encodeFileId('wt_short', 'src/Short file')}`,
  `file:${encodeFileId('wt_long', LONG_PALETTE_TITLE)}`
]

type PaletteGeometry = {
  kind: string
  variant: string
  titleText: string
  row: { left: number; right: number; top: number; bottom: number; height: number; scrollWidth: number; clientWidth: number; paddingTop: number; paddingRight: number; paddingBottom: number }
  icon: { left: number; right: number; top: number; bottom: number; width: number; height: number }
  title: { left: number; right: number; top: number; bottom: number; width: number; height: number; scrollWidth: number; clientWidth: number; fontSize: string; lineHeight: string; rects: { left: number; right: number; top: number; bottom: number }[] }
  description: null | { left: number; right: number; top: number; bottom: number; scrollWidth: number; clientWidth: number; fontSize: string; lineHeight: string; rects: { left: number; right: number; top: number; bottom: number }[] }
}

async function styledPage(theme: string, markup: string) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 880 } })
  const styles = await productionStyles()
  await page.setContent(`<html data-theme="${theme}"><head><style>${styles}</style></head><body>${markup}</body></html>`)
  return page
}

async function palettePage(theme: string, markup: string) {
  const page = await styledPage(theme, markup)
  await page.addScriptTag({ content: browserBundle })
  return page
}

async function readPaletteGeometry(page: Page, selector: string): Promise<PaletteGeometry[]> {
  return page.locator(selector).evaluateAll((options, longTitle) => options.map((option) => {
    const row = option.querySelector<HTMLElement>('.ui-list-row')!
    const titleNode = option.querySelector<HTMLElement>('.ui-list-row__title > span > span:last-child')!
    const icon = option.querySelector<SVGElement>('.ui-list-row__title svg')!
    const description = option.querySelector<HTMLElement>('.ui-list-row__description')
    const rowRect = row.getBoundingClientRect()
    const iconRect = icon.getBoundingClientRect()
    const titleRect = titleNode.getBoundingClientRect()
    const titleStyle = getComputedStyle(titleNode)
    const titleRange = document.createRange()
    titleRange.selectNodeContents(titleNode)
    const titleRects = Array.from(titleRange.getClientRects(), (rect) => ({
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
    }))
    const descriptionRect = description?.getBoundingClientRect()
    const descriptionStyle = description ? getComputedStyle(description) : null
    const descriptionRects = description ? (() => {
      const range = document.createRange()
      range.selectNodeContents(description)
      return Array.from(range.getClientRects(), (rect) => ({
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
      }))
    })() : []
    const titleText = titleNode.textContent?.trim() ?? ''
    const iconClass = icon.getAttribute('class') ?? ''
    const detail = description?.textContent ?? ''
    const kind = iconClass.includes('ui-file-icon') ? 'file' : detail.startsWith('Tool · ') ? 'tool' : detail === 'View' ? 'view' : detail.endsWith('Worktree') ? 'worktree' : 'command'
    const variant = titleText === longTitle ? 'long' : titleText.startsWith('Short ') ? 'short' : description === null ? 'title-only' : 'other'
    const rowStyle = getComputedStyle(row)
    return {
      kind,
      variant,
      titleText,
      row: {
        left: rowRect.left, right: rowRect.right, top: rowRect.top, bottom: rowRect.bottom, height: rowRect.height,
        scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
        paddingTop: parseFloat(rowStyle.paddingTop), paddingRight: parseFloat(rowStyle.paddingRight), paddingBottom: parseFloat(rowStyle.paddingBottom)
      },
      icon: { left: iconRect.left, right: iconRect.right, top: iconRect.top, bottom: iconRect.bottom, width: iconRect.width, height: iconRect.height },
      title: {
        left: titleRect.left, right: titleRect.right, top: titleRect.top, bottom: titleRect.bottom,
        width: titleRect.width, height: titleRect.height, scrollWidth: titleNode.scrollWidth, clientWidth: titleNode.clientWidth,
        fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight, rects: titleRects
      },
      description: description && descriptionRect && descriptionStyle ? {
        left: descriptionRect.left, right: descriptionRect.right, top: descriptionRect.top, bottom: descriptionRect.bottom,
        scrollWidth: description.scrollWidth, clientWidth: description.clientWidth,
        fontSize: descriptionStyle.fontSize, lineHeight: descriptionStyle.lineHeight, rects: descriptionRects
      } : null
    }
  }), LONG_PALETTE_TITLE)
}

function assertPaletteGeometry(metrics: PaletteGeometry[]): void {
  for (const metric of metrics) {
    expect(metric.icon.width).toBeCloseTo(16, 2)
    expect(metric.icon.height).toBeCloseTo(16, 2)
    expect(metric.title.rects.length).toBeGreaterThan(0)
    expect(metric.title.rects[0]!.left - metric.icon.right).toBeCloseTo(8, 1)
    expect(Math.abs((metric.icon.top + metric.icon.bottom) / 2 - (metric.title.rects[0]!.top + metric.title.rects[0]!.bottom) / 2)).toBeLessThanOrEqual(0.5)
    expect(metric.title.fontSize).toBe('12px')
    expect(metric.title.lineHeight).toBe('16px')
    expect(metric.row.scrollWidth).toBeLessThanOrEqual(metric.row.clientWidth)
    expect(metric.title.scrollWidth).toBeLessThanOrEqual(metric.title.clientWidth)
    expect(metric.title.left).toBeGreaterThanOrEqual(metric.row.left - 0.5)
    expect(metric.title.right).toBeLessThanOrEqual(metric.row.right - metric.row.paddingRight + 0.5)
    expect(metric.title.top).toBeGreaterThanOrEqual(metric.row.top + metric.row.paddingTop - 0.5)
    expect(metric.title.bottom).toBeLessThanOrEqual(metric.row.bottom - metric.row.paddingBottom + 0.5)
    for (const rect of metric.title.rects) {
      expect(rect.left).toBeGreaterThanOrEqual(metric.row.left - 0.5)
      expect(rect.right).toBeLessThanOrEqual(metric.row.right - metric.row.paddingRight + 0.5)
    }
    if (metric.description) {
      expect(Math.abs(metric.description.left - metric.title.rects[0]!.left)).toBeLessThanOrEqual(0.5)
      expect(metric.description.fontSize).toBe('11px')
      expect(Math.abs(parseFloat(metric.description.lineHeight) - 15.4)).toBeLessThanOrEqual(0.05)
      expect(metric.description.scrollWidth).toBeLessThanOrEqual(metric.description.clientWidth)
      expect(metric.title.bottom).toBeLessThanOrEqual(metric.description.top + 0.5)
      expect(metric.description.left).toBeGreaterThanOrEqual(metric.row.left - 0.5)
      expect(metric.description.right).toBeLessThanOrEqual(metric.row.right - metric.row.paddingRight + 0.5)
      expect(metric.description.bottom).toBeLessThanOrEqual(metric.row.bottom - metric.row.paddingBottom + 0.5)
      for (const rect of metric.description.rects) {
        expect(rect.left).toBeGreaterThanOrEqual(metric.row.left - 0.5)
        expect(rect.right).toBeLessThanOrEqual(metric.row.right - metric.row.paddingRight + 0.5)
      }
    }
    if (metric.variant === 'short' && metric.description) expect(metric.row.height).toBeLessThanOrEqual(50)
    if (metric.variant === 'title-only') {
      expect(metric.description).toBeNull()
      expect(metric.row.height).toBeLessThanOrEqual(32)
    }
  }
  const ordered = [...metrics].sort((left, right) => left.row.top - right.row.top)
  for (let index = 1; index < ordered.length; index++) {
    expect(ordered[index]!.row.top).toBeGreaterThanOrEqual(ordered[index - 1]!.row.bottom - 0.5)
  }
}

async function setPaletteFixture(page: Page): Promise<void> {
  await page.addScriptTag({ content: browserBundle })
  await page.evaluate((options) => {
    ;(window as typeof window & { __paletteFixture: { mountPalette(options: unknown): unknown } }).__paletteFixture.mountPalette(options)
  }, {
    model: PALETTE_SCENARIO_MODEL,
    worktrees: PALETTE_SCENARIO_WORKTREES,
    recents: PALETTE_SCENARIO_RECENTS,
    selected: 'wt_short'
  })
}


for (const theme of themes) {
  test(`underline tabs match the center strip without changing boxed tabs (${theme.name})`, async () => {
    const items = [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]
    const page = await styledPage(theme.name, renderToStaticMarkup(<>
      <Tabs label="Underline" variant="underline" items={items} value="one" onChange={() => {}} />
      <Tabs label="Default" items={items} value="one" onChange={() => {}} />
    </>))
    try {
      const strip = page.getByRole('tablist', { name: 'Underline' })
      expect(await strip.getAttribute('class')).toBe('ui-tabs ui-tabs--underline')
      const rule = await strip.evaluate((node) => {
        const style = getComputedStyle(node)
        return { width: style.borderBottomWidth, style: style.borderBottomStyle, color: style.borderBottomColor, border: style.getPropertyValue('--ui-border').trim() }
      })
      expect(rule.width).toBe('1px')
      expect(rule.style).toBe('solid')
      const selected = await strip.getByRole('tab', { selected: true }).evaluate((node) => {
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, radius: style.borderRadius, shadow: style.boxShadow }
      })
      expect(selected.background).toBe(theme.surface)
      expect(selected.border).toBe('0px')
      expect(selected.radius).toBe('0px')
      expect(selected.shadow).toContain('inset')
      expect(selected.shadow).toContain('-2px')
      expect(selected.shadow).toContain(theme.accent)
      const unselected = await strip.getByRole('tab', { selected: false }).evaluate((node) => {
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow, color: style.color }
      })
      expect(unselected.background).toBe('rgba(0, 0, 0, 0)')
      expect(unselected.border).toBe('0px')
      expect(unselected.shadow).toBe('none')
      const tokenColors = await strip.evaluate((node) => {
        const probe = document.createElement('span')
        node.append(probe)
        probe.style.color = 'var(--ui-text)'
        const text = getComputedStyle(probe).color
        probe.style.color = 'var(--ui-muted)'
        const muted = getComputedStyle(probe).color
        probe.style.color = 'var(--ui-border)'
        const border = getComputedStyle(probe).color
        probe.remove()
        return { text, muted, border }
      })
      expect(selected.color).toBe(tokenColors.text)
      expect(unselected.color).toBe(tokenColors.muted)
      expect(rule.color).toBe(tokenColors.border)
      const boxed = page.getByRole('tablist', { name: 'Default' })
      expect(await boxed.getAttribute('class')).toBe('ui-tabs')
      expect(await boxed.getByRole('tab', { selected: true }).evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.borderTopWidth]
      })).toEqual([theme.selected, '1px'])
    } finally {
      await page.close()
    }
  })

  test(`top dialogs are search popups while centered dialogs retain their scrim (${theme.name})`, async () => {
    const search = renderToStaticMarkup(<div className="shell-palette"><div className="shell-palette__search"><ControlIcon name="magnifying-glass" /><TextField label="Search" value="" readOnly /></div></div>)
    const dialog = `<section class="ui-dialog"><header class="ui-dialog__header"><h2 class="ui-dialog__title">Command palette</h2><button class="ui-dialog__close" aria-label="Close dialog">×</button></header><div class="ui-dialog__body">${search}</div></section>`
    const page = await styledPage(theme.name, `<div class="ui-dialog-backdrop ui-dialog-backdrop--top">${dialog}</div><div class="ui-dialog-backdrop" id="center">${dialog}</div>`)
    try {
      expect(await page.locator('.ui-dialog-backdrop--top').evaluate((node) => getComputedStyle(node, '::before').opacity)).toBe('0')
      expect(await page.locator('#center').evaluate((node) => getComputedStyle(node, '::before').opacity)).toBe('0.4')
      const popup = page.locator('.ui-dialog-backdrop--top')
      expect(await popup.locator('.ui-dialog').evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none')
      const title = await popup.locator('.ui-dialog__title').evaluate((node) => {
        const style = getComputedStyle(node)
        return { width: style.width, clip: style.clip }
      })
      expect(title.width).toBe('1px')
      expect(title.clip).not.toBe('auto')
      expect(await popup.locator('.ui-dialog__header').evaluate((node) => getComputedStyle(node).position)).toBe('absolute')
      expect(await popup.locator('.ui-dialog__close').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor]
      })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      const geometry = await popup.evaluate((node) => ({
        close: node.querySelector('.ui-dialog__close')!.getBoundingClientRect().toJSON(),
        search: node.querySelector('.shell-palette__search')!.getBoundingClientRect().toJSON(),
        input: node.querySelector('input')!.getBoundingClientRect().toJSON()
      }))
      expect(geometry.close.right).toBeLessThanOrEqual(geometry.search.right)
      expect(geometry.close.top).toBeGreaterThanOrEqual(geometry.search.top)
      expect(geometry.close.bottom).toBeLessThanOrEqual(geometry.search.bottom)
      expect(geometry.close.left).toBeGreaterThan(geometry.input.right)
    } finally {
      await page.close()
    }
  })

  test(`palette search and results use the golden popup surfaces (${theme.name})`, async () => {
    const page = await styledPage(theme.name, renderToStaticMarkup(
      <div className="shell-palette">
        <div className="shell-palette__search"><ControlIcon name="magnifying-glass" /><TextField label="Search" value="" readOnly /></div>
        <div className="ui-option-list"><ListRow title="Open view" description="A view" selected /></div>
      </div>
    ))
    try {
      expect(await page.locator('.shell-palette__search').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(theme.selected)
      expect(await page.getByRole('textbox').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor]
      })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      expect(await page.locator('.ui-text-field__label').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.width, style.clip !== 'auto']
      })).toEqual(['1px', true])
      expect(await page.locator('.ui-option-list').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.borderTopWidth, style.maxHeight]
      })).toEqual(['rgba(0, 0, 0, 0)', '0px', '528px'])
      const clearance = await page.locator('.ui-option-list').evaluate((node) => {
        const list = node.getBoundingClientRect()
        const row = node.querySelector('.ui-list-row')!.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          inset: [row.top - list.top, list.right - row.right, list.bottom - row.bottom, row.left - list.left]
        }
      })
      expect(clearance.padding).toEqual(['8px', '8px', '8px', '8px'])
      for (const inset of clearance.inset) expect(inset).toBeGreaterThanOrEqual(8)
      expect(await page.locator('.ui-list-row--selected').evaluate((node) => {
        const style = getComputedStyle(node)
        const description = node.querySelector('.ui-list-row__description')!
        return [style.backgroundColor, style.color, getComputedStyle(description).color, style.borderTopWidth, style.paddingTop, style.paddingBottom]
      })).toEqual([theme.accent, theme.rail, theme.rail, '0px', '8px', '8px'])
      await page.getByRole('textbox').focus()
      expect(await page.locator('.shell-palette__search').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.outlineStyle, style.outlineWidth, style.outlineColor]
      })).toEqual(['solid', '2px', theme.accent])
      expect(await page.getByRole('textbox').evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('none')
      expect(await page.locator('.shell-palette').evaluate((node) => getComputedStyle(node).rowGap)).toBe('12px')
    } finally {
      await page.close()
    }
  })

  for (const defect of ['description indent', 'description leading', 'long-title icon wrapping'] as const) {
    test(`the real palette corrects ${defect} (${theme.name})`, async () => {
      const page = await styledPage(theme.name, '<div id="palette-root"></div>')
      try {
        await setPaletteFixture(page)
        await page.getByRole('dialog', { name: 'Command palette' }).waitFor()
        await page.locator('.ui-dialog').evaluate((node) => { (node as HTMLElement).style.width = '320px' })
        const metrics = await readPaletteGeometry(page, '[role="option"]')
        const deltas = metrics.filter((row) => defect === 'long-title icon wrapping' ? row.variant === 'long' : row.description !== null)
          .map((row) => defect === 'description indent'
            ? Math.abs(row.description!.left - row.title.rects[0]!.left)
            : defect === 'description leading'
              ? Math.abs(parseFloat(row.description!.lineHeight) - 15.4)
              : Math.abs((row.icon.top + row.icon.bottom) / 2 - (row.title.rects[0]!.top + row.title.rects[0]!.bottom) / 2))
        expect(deltas.length).toBeGreaterThan(0)
        expect(Math.max(...deltas)).toBeLessThanOrEqual(defect === 'description leading' ? 0.05 : 0.5)
      } finally {
        await page.close()
      }
    })
  }
  test(`the mounted CommandPalette retains its real entry geometry (${theme.name})`, async () => {
    const page = await styledPage(theme.name, '<div id="palette-root"></div>')
    try {
      await setPaletteFixture(page)
      const dialog = page.getByRole('dialog', { name: 'Command palette' })
      await dialog.waitFor()
      expect(await page.getByRole('textbox', { name: PALETTE_SEARCH_LABEL }).count()).toBe(1)
      expect(await page.locator('.ui-option-list').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.maxHeight, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      })).toEqual(['528px', '8px', '8px', '8px', '8px'])
      expect(await page.locator('.shell-palette').evaluate((node) => getComputedStyle(node).rowGap)).toBe('12px')
      expect(await page.locator('.shell-palette .ui-tabs').getAttribute('class')).toBe('ui-tabs ui-tabs--underline')
      expect(await page.locator('.shell-palette__search').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(theme.selected)
      expect(await page.locator('.ui-list-row--selected').evaluate((node) => {
        const style = getComputedStyle(node)
        const description = node.querySelector('.ui-list-row__description')!
        return [style.backgroundColor, style.color, getComputedStyle(description).color, style.paddingTop, style.paddingBottom]
      })).toEqual([theme.accent, theme.rail, theme.rail, '8px', '8px'])
      await page.locator('.ui-list-row--selected').hover()
      expect(await page.locator('.ui-list-row--selected').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.color, getComputedStyle(node.querySelector('.ui-list-row__description')!).color]
      })).toEqual([theme.accent, theme.rail, theme.rail])

      await savePaletteEvidence(page, theme.name, 'wide')
      const widePalette = await readPaletteGeometry(page, '.ui-dialog-backdrop--top [role="option"]')
      expect(widePalette).toHaveLength(11)
      expect(new Set(widePalette.map((row) => row.kind))).toEqual(new Set(['command', 'tool', 'view', 'worktree', 'file']))
      expect(widePalette.filter((row) => row.variant === 'short')).toHaveLength(5)
      expect(widePalette.filter((row) => row.variant === 'long')).toHaveLength(5)
      expect(widePalette.filter((row) => row.variant === 'title-only')).toHaveLength(1)
      expect(widePalette.filter((row) => row.variant === 'long').every((row) => row.titleText === LONG_PALETTE_TITLE)).toBe(true)

      await page.locator('.ui-dialog-backdrop--top .ui-dialog').evaluate((node) => {
        ;(node as HTMLElement).style.width = '320px'
      })
      expect(await page.locator('.ui-dialog-backdrop--top .ui-dialog').evaluate((node) => node.getBoundingClientRect().width)).toBeCloseTo(320, 1)
      const bounds = await dialog.evaluate((node) => ({
        search: node.querySelector('.shell-palette__search')!.getBoundingClientRect().toJSON(),
        input: node.querySelector('input')!.getBoundingClientRect().toJSON(),
        close: node.querySelector('.ui-dialog__close')!.getBoundingClientRect().toJSON()
      }))
      expect(bounds.close.left).toBeGreaterThan(bounds.input.right)
      expect(bounds.close.right).toBeLessThanOrEqual(bounds.search.right)
      expect(bounds.close.top).toBeGreaterThanOrEqual(bounds.search.top)
      expect(bounds.close.bottom).toBeLessThanOrEqual(bounds.search.bottom)
      await savePaletteEvidence(page, theme.name, 'dialog-320')
      const narrowPalette = await readPaletteGeometry(page, '.ui-dialog-backdrop--top [role="option"]')
      expect(narrowPalette.filter((row) => row.variant === 'long').every((row) => row.title.rects.length > 1)).toBe(true)

      assertPaletteGeometry(widePalette)
      assertPaletteGeometry(narrowPalette)
    } finally {
      await page.close()
    }
  })
  test(`Settings uses compact headings, borderless close and wrapping navigation (${theme.name})`, async () => {
    const page = await styledPage(theme.name, renderToStaticMarkup(
      <div className="ui-dialog">
        <header className="ui-dialog__header"><h2 className="ui-dialog__title">Settings</h2><button className="ui-dialog__close" aria-label="Close dialog">×</button></header>
        <form id="settings-form" className="ui-stack">
          <section className="ui-stack" role="group" aria-label="Plugin settings">
            <SectionHeader title="Plugin settings" className="ui-settings-group-heading" />
            <div className="ui-stack"><Button>Automations</Button><Button>Browser Settings</Button></div>
          </section>
          <FormRow label="Sidebar section separators" htmlFor="separators" help="Show dividers">
            <input id="separators" type="checkbox" defaultChecked />
          </FormRow>
        </form>
      </div>
    ))
    try {
      expect(await page.locator('.ui-settings-group-heading .ui-section-header__title').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.fontSize, style.fontWeight]
      })).toEqual(['12px', '600'])
      expect(await page.locator('.ui-dialog__close').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.borderTopColor, style.backgroundColor]
      })).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      expect(await page.locator('[aria-label="Plugin settings"] > .ui-stack').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.flexDirection, style.flexWrap]
      })).toEqual(['row', 'wrap'])
      expect(await page.getByRole('button', { name: 'Automations' }).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      expect(await page.locator('.ui-dialog').evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none')
      expect(await page.locator('.ui-dialog__close').evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.width, style.height, style.fontSize]
      })).toEqual(['26px', '26px', '16px'])
      const checkbox = page.getByRole('checkbox', { name: 'Sidebar section separators' })
      expect(await checkbox.evaluate((node) => getComputedStyle(node).accentColor)).toBe(theme.accent)
      expect(await page.locator('.ui-form-row').evaluate((node) => {
        const label = node.querySelector('.ui-form-row__label')!.getBoundingClientRect()
        const control = node.querySelector('input')!.getBoundingClientRect()
        return Math.abs((label.top + label.bottom) / 2 - (control.top + control.bottom) / 2)
      })).toBeLessThan(1)
    } finally {
      await page.close()
    }
  })

  test(`Window-bar search keeps its neutral pill and compact light dimensions (${theme.name})`, async () => {
    const page = await styledPage(theme.name, renderToStaticMarkup(
      <header className="window-bar" aria-label="Window bar">
        <div /><div />
        <div className="window-bar__group window-bar__group--end">
          <button className="window-bar__button window-bar__search" aria-label="Search commands, tools, views, and worktrees">
            <ControlIcon name="magnifying-glass" /><span>Search</span><kbd>⌘K</kbd><span>(outside terminal)</span>
          </button>
        </div>
      </header>
    ))
    try {
      const search = page.getByRole('button', { name: 'Search commands, tools, views, and worktrees', exact: true })
      expect(await search.evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.borderTopWidth, style.borderRadius, style.height, style.paddingLeft, style.paddingRight]
      })).toEqual([theme.name === 'light' ? theme.selected : theme.surface, '0px', '7px', theme.name === 'light' ? '22px' : '26px', '8px', '8px'])
      expect(await search.getByText('(outside terminal)', { exact: true }).isVisible()).toBe(true)
    } finally {
      await page.close()
    }
  })
  test(`palette keyboard, pointer, file search and dismissal paths remain usable (${theme.name})`, async () => {
    const page = await styledPage(theme.name, '<button id="opener">Open palette</button><div id="palette-root"></div>')
    const open = async () => {
      await page.getByRole('button', { name: 'Open palette' }).focus()
      await setPaletteFixture(page)
      await page.getByRole('dialog', { name: 'Command palette' }).waitFor()
    }
    try {
      await open()
      const input = page.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
      expect(await page.getByRole('group', { name: 'Recent', exact: true }).count()).toBe(1)
      const selectedTitle = () => page.locator('[role="option"][aria-selected="true"] .ui-list-row__title').textContent()
      const first = await selectedTitle()
      await input.press('ArrowDown')
      expect(await selectedTitle()).not.toBe(first)
      await input.press('ArrowUp')
      expect(await selectedTitle()).toBe(first)
      await input.press('Tab')
      expect(await page.getByRole('tab', { name: 'Worktrees', selected: true }).count()).toBe(1)
      await input.press('Shift+Tab')
      expect(await page.getByRole('tab', { name: 'All', selected: true }).count()).toBe(1)
      await page.getByRole('tab', { name: 'Commands', exact: true }).click()
      await input.fill('Short command')
      await page.getByRole('option').waitFor()
      await input.press('Enter')
      await page.waitForFunction(() => window.__paletteFixture.last.ran.commands.includes('command:layout/short-command'))
      await page.waitForFunction(() => document.activeElement?.id === 'opener')

      await open()
      await page.getByRole('option').filter({ hasText: 'Short tool' }).getByRole('button').click()
      expect(await page.evaluate(() => window.__paletteFixture.last.ran.tools)).toEqual(['tool:layout/short-tool'])
      await open()
      await page.getByRole('tab', { name: 'Files', exact: true }).click()
      await input.fill('search-result')
      await page.getByRole('option').filter({ hasText: 'search-result.ts' }).waitFor()
      await input.press('Enter')
      await page.waitForFunction(() => window.__paletteFixture.last.calls.some((call) => call.method === 'quirky.editor/open'))
      const calls = await page.evaluate(() => window.__paletteFixture.last.calls)
      expect(calls).toContainEqual({ method: 'quirky.editor/open', params: { worktree: 'wt_short', path: 'src/search-result.ts', focus: true } })
      expect(calls).toContainEqual({ method: 'ui.palette.recent', params: { id: `file:${encodeFileId('wt_short', 'src/search-result.ts')}` } })

      for (const dismissal of ['Escape', 'close', 'backdrop']) {
        await open()
        if (dismissal === 'Escape') await input.press('Escape')
        else if (dismissal === 'close') await page.getByRole('button', { name: 'Close dialog' }).click()
        else await page.locator('.ui-dialog-backdrop').click({ position: { x: 1, y: 1 } })
        await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ state: 'detached' })
        await page.waitForFunction(() => document.activeElement?.id === 'opener')
      }
    } finally {
      await page.close()
    }
  })

  test(`real Changes rows report density and visible parts without imposing a new density bar (${theme.name})`, async () => {
    const page = await palettePage(theme.name, '<div id="changes-root" style="width:320px"></div>')
    try {
      await page.evaluate(() => window.__paletteFixture.mountChanges())
      await page.locator('.git-row').first().waitFor()
      const rows = await page.locator('.git-row').evaluateAll((nodes) => nodes.map((row, index) => {
        const box = row.getBoundingClientRect()
        const next = nodes[index + 1]?.getBoundingClientRect()
        const name = row.querySelector<HTMLElement>('[data-row-name]')!
        const font = getComputedStyle(name)
        const parts = Array.from(row.querySelectorAll<HTMLElement>('.git-row__mark, .ui-file-icon, [data-row-name], [data-row-dir], .git-row__added, .git-row__removed, .git-row__notes, .git-row__dirty, .git-row__status, .git-row__actions'), (part) => {
          const bounds = part.getBoundingClientRect()
          return { part: part.getAttribute('class') ?? part.tagName, text: part.textContent, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
            clipped: part.scrollWidth > part.clientWidth || bounds.left < box.left || bounds.right > box.right }
        })
        const overlap = parts.some((left, partIndex) => parts.slice(partIndex + 1).some((right) =>
          left.right > right.left + 0.5 && right.right > left.left + 0.5 && left.bottom > right.top + 0.5 && right.bottom > left.top + 0.5))
        return { path: row.getAttribute('data-row-path'), height: box.height, gapAfter: next ? next.top - box.bottom : null,
          fontSize: font.fontSize, lineHeight: font.lineHeight, parts, clipping: parts.some((part) => part.clipped), overlap }
      }))
      console.log(`CHANGES_DIAGNOSTIC ${JSON.stringify({ theme: theme.name, viewport: { width: 1400, height: 880 }, panelWidth: 320, rows })}`)
      expect(rows.map((row) => row.path).sort()).toEqual(['src/ToolShell.tsx', 'src/tool-shell.css', 'src/project-title.ts'].sort())
      expect(await page.getByRole('button', { name: 'Open src/ToolShell.tsx', exact: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Revert src/ToolShell.tsx', exact: true }).count()).toBe(1)
      expect(await page.locator('[data-note-count]').textContent()).toBe('✎2')
    } finally {
      await page.close()
    }
  })
}
