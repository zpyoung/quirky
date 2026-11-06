import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { fitToolShellGeometry, toolShellCssVariables, type ToolShellChrome } from '../../../../packages/ui/src/shell/ToolShell'

const ROOT = resolve(import.meta.dir, '../../../..')
const GIT_MODULES = join(ROOT, 'plugins/quirky.git/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(GIT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(GIT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(GIT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(GIT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(GIT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts')
}
const PANEL_ID = 'panel:quirky.git/source-control'
const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''

/** The app's stylesheet for the shell and the panel, with every `@import` inlined; vendor sheets the checkout lacks are left out. */
function appStyles(): string {
  const inline = (file: string): string =>
    existsSync(file)
      ? readFileSync(file, 'utf8').replace(/^@import ['"]([^'"]+)['"];\s*$/gm, (_match, target: string) => inline(join(dirname(file), target)))
      : ''

  return ['styles.css', 'shell/chrome.css', 'shell/tool-shell.css'].map((name) => inline(join(ROOT, 'packages/ui/src', name))).join('\n')
}

function browserEntry(): string {
  const sourceControl = join(ROOT, 'plugins/quirky.git/src/SourceControl.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ToolPanelFrame } from '@quirky/ui'
    import { RpcErrorCode } from '@quirky/protocol'
    import { SourceControl } from ${JSON.stringify(sourceControl)}

    const PANEL = ${JSON.stringify(PANEL_ID)}
    const ZERO = 'a'.repeat(40)
    const row = (path, extra) => ({
      path, status: 'M', added: 12, removed: 3, binary: false, uncommitted: true, staged: false, mark: 'none', notes: 0, ...extra
    })
    const files = [
      row('src/app.ts'),
      row('src/flags.ts'),
      row('src/util.ts', { uncommitted: false }),
      row('README.md', { status: 'A', uncommitted: false })
    ].sort((a, b) => (a.path < b.path ? -1 : 1))
    const status = {
      branch: 'zoe/ui-review-ready', upstream: 'origin/zoe/ui-review-ready', ahead: 0, behind: 0, files: [], head: ZERO,
      detached: false, unborn: false, operation: 'none', capped: false, busy: null,
      entries: files.filter((file) => file.uncommitted).map((file) => ({ path: file.path, area: 'unstaged', status: 'modified' })),
      upstreamStatus: { hasUpstream: true, name: 'origin/zoe/ui-review-ready', sha: 'b'.repeat(40), ahead: 0, behind: 0, behindPatchEquivalent: null }
    }
    const compare = {
      status: 'ready', base: 'origin/main', baseSource: 'detected', message: null, baseOid: 'c'.repeat(40), headOid: ZERO,
      mergeBase: 'c'.repeat(40), ahead: 0, behind: 0, entries: [], added: 48, removed: 12
    }
    const review = {
      worktreeId: 'feat', branch: status.branch,
      base: { name: 'origin/main', source: 'detected', isCurrentBranch: false },
      compare: { status: 'ready', mergeBase: compare.mergeBase, headOid: ZERO },
      totals: { added: 48, removed: 12 },
      counts: { files: files.length, reviewed: 0, changed: 0, uncommitted: 2, staged: 0 },
      capped: false, files
    }
    const layout = {
      worktree: 'feat', view: { id: 'view:quirky.session/worktree', input: { worktree: 'feat' } }, panel: PANEL, sidebar: true, focus: 'panel'
    }
    window.unexpectedCalls = []
    const context = {
      pluginId: 'quirky.git',
      nativeBrowser: {},
      nativeDropPaths: async () => null,
      readClipboardText: async () => '',
      log() {},
      provide() {},
      async call(method) {
        switch (method) {
          case 'quirky.git/status': return status
          case 'quirky.git/review': return review
          case 'quirky.git/compare': return compare
          case 'quirky.git/notes': return { notes: [] }
          case 'quirky.hosting/cachedReviews': return { workspaces: [] }
          case 'quirky.hosting/forBranch': throw Object.assign(new Error('unknown method: ' + method), { code: RpcErrorCode.MethodNotFound })
          case 'quirky.git/history': return { commits: [], hasMore: false }
          case 'quirky.git/hugeFolders': return { folders: [] }
          case 'quirky.git/branches': return { refs: [], current: null }
          case 'quirky.worktree/resolve': return { path: '/repo/feat' }
        }
        window.unexpectedCalls.push(method)
        return {}
      },
      subscribe: () => () => {},
      getSetting: () => undefined,
      executeCommand: async () => {},
      openView() {},
      closeView() {},
      togglePanel() {},
      getLayout: () => layout,
      setPalette() {},
      onLayout: () => () => {},
      onStream: () => () => {},
      onConnection: () => () => {},
      confirm: async () => true,
      toast() {},
      setPanelBadge() {},
      setContext() {},
      mountView: () => () => {}
    }

    createRoot(document.getElementById('panel')).render(
      createElement(ToolPanelFrame, { title: 'Source control', onMinimize() {} },
        createElement('section', { className: 'plugin-slot', 'data-plugin-slot': PANEL },
          createElement('div', { className: 'plugin-slot-body' },
            createElement(SourceControl, { context, report() {} }))))
    )
  `
}

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-git-done-criteria-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [
        {
          name: 'git-done-criteria-browser-dependencies',
          setup(builder) {
            builder.onResolve(
              { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui|@quirky\/protocol)$/ },
              ({ path }) => ({ path: BROWSER_IMPORTS[path]! })
            )
          }
        }
      ],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    browserBundle = await result.outputs[0]!.text()
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

test.skipIf(!existsSync(executable))('criterion 1: at 1280x720 with the tool slots open, the first changed file shows without scrolling under only the title, header line and count line', async () => {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } })
  try {
    // the app's own shell: window bar, workspace holding the tool panels, then the status bar
    await page.setContent(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
      <style>html, body, #root { height: 100%; margin: 0; }</style><style>${appStyles()}</style></head>
      <body><div id="root"><div class="app">
        <header class="window-bar"></header>
        <div class="shell-workspace">
          <div class="tool-shell"><aside class="tool-shell__panels">
            <section id="panel" class="tool-shell__panel tool-shell__panel--right-top" data-tool-panel="${PANEL_ID}"></section>
          </aside></div>
        </div>
        <footer class="shell-statusbar"><span>status</span></footer>
      </div></div></body></html>`)

    const measured = await page.locator('.shell-workspace').evaluate((workspace) => {
      const styles = getComputedStyle(workspace)
      const read = (name: string) => Number.parseFloat(styles.getPropertyValue(name)) || 0
      return {
        width: workspace.clientWidth,
        height: workspace.clientHeight,
        chrome: {
          rail: read('--tool-shell-rail-width'),
          splitter: read('--tool-shell-splitter-width'),
          centerMinWidth: read('--tool-shell-center-min-width'),
          centerMinHeight: read('--tool-shell-center-min-height'),
          gap: read('--tool-shell-card-gap')
        }
      }
    })
    expect(measured.width).toBe(1280)
    expect(measured.height).toBeGreaterThan(0)
    expect(measured.height).toBeLessThan(720)

    // the default layout: worktrees on the left, Source control above the lower right tool
    const sizes = { left: 280, right: 280, bottom: 176, leftSplit: 0.75, rightSplit: 0.5, bottomSplit: 0.5 }
    const open = { 'left-top': true, 'left-bottom': false, 'right-top': true, 'right-bottom': true, 'bottom-left': false, 'bottom-right': false }
    const geometry = fitToolShellGeometry(sizes, { width: measured.width, height: measured.height }, open, measured.chrome as ToolShellChrome)
    await page.locator('.shell-workspace').evaluate((workspace, variables) => {
      for (const [name, value] of Object.entries(variables)) workspace.style.setProperty(name, String(value))
    }, toolShellCssVariables(geometry) as Record<string, number>)

    await page.addScriptTag({ content: browserBundle })
    await page.waitForFunction(() => document.querySelectorAll('[data-git-content] [role="option"][data-row-path]').length === 4)

    const layout = await page.evaluate(() => {
      const rect = (element: Element) => {
        const { top, bottom, height } = element.getBoundingClientRect()
        return { top, bottom, height }
      }
      const visible = (element: Element) => element.getBoundingClientRect().height > 0
      const body = document.querySelector<HTMLElement>('.ui-tool-panel-frame__body')!
      const frame = document.querySelector<HTMLElement>('.ui-tool-panel-frame')!
      const panel = document.querySelector<HTMLElement>('[data-git-panel]')!
      const content = panel.querySelector<HTMLElement>('[data-git-content]')!
      const first = content.querySelector<HTMLElement>('[role="option"][data-row-path]')!
      const label = (element: Element) =>
        element.matches('.ui-tool-panel-frame__header') ? 'title'
          : element.matches('[data-branch-row]') ? 'header line'
            : element.matches('[data-count-line]') ? 'count line'
              : element.className || element.tagName.toLowerCase()
      const aboveInFrame = [...frame.children].filter((child) => child !== body && visible(child) && rect(child).bottom <= rect(first).top + 0.5).map(label)
      const aboveInPanel = [...panel.children].filter((child) => child !== content && visible(child) && rect(child).bottom <= rect(first).top + 0.5).map(label)
      const listbox = first.closest('[role="listbox"]')!
      return {
        panelHeight: rect(document.querySelector('[data-tool-panel]')!).height,
        body: { ...rect(body), clientHeight: body.clientHeight, scrollTop: body.scrollTop },
        content: { ...rect(content), scrollTop: content.scrollTop },
        first: rect(first),
        title: rect(frame.querySelector('.ui-tool-panel-frame__header')!),
        headerLine: rect(panel.querySelector('[data-branch-row]')!),
        countLine: rect(panel.querySelector('[data-count-line]')!),
        aboveInFrame,
        aboveInPanel,
        beforeListInContent: [...content.children].indexOf(listbox),
        rowsBeforeFirst: [...listbox.children].indexOf(first),
        rowPaths: [...content.querySelectorAll('[role="option"][data-row-path]')].map((el) => el.getAttribute('data-row-path')),
        unexpectedCalls: (window as unknown as { unexpectedCalls: string[] }).unexpectedCalls
      }
    })

    expect(layout.panelHeight).toBeGreaterThan(200)
    expect(layout.panelHeight).toBeLessThan(measured.height / 2 + 1)
    expect(layout.rowPaths).toEqual(['README.md', 'src/app.ts', 'src/flags.ts', 'src/util.ts'])
    expect(layout.body.scrollTop).toBe(0)
    expect(layout.content.scrollTop).toBe(0)
    // the row's top sits inside the panel's client height, and the whole row is on screen
    expect(layout.first.top - layout.body.top).toBeLessThan(layout.body.clientHeight)
    expect(layout.first.top).toBeGreaterThanOrEqual(layout.content.top)
    expect(layout.first.bottom).toBeLessThanOrEqual(layout.content.bottom + 0.5)

    expect(layout.aboveInFrame).toEqual(['title'])
    expect(layout.aboveInPanel).toEqual(['header line', 'count line'])
    expect(layout.beforeListInContent).toBe(0)
    expect(layout.rowsBeforeFirst).toBe(0)
    expect(layout.title.bottom).toBeLessThanOrEqual(layout.headerLine.top + 0.5)
    expect(layout.headerLine.bottom).toBeLessThanOrEqual(layout.countLine.top + 0.5)
    expect(layout.countLine.bottom).toBeLessThanOrEqual(layout.first.top + 0.5)
    expect(layout.unexpectedCalls).toEqual([])
  } finally {
    await page.close()
  }
}, 60_000)
