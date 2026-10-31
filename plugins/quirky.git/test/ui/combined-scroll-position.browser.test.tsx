import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../../..')
const GIT_MODULES = join(ROOT, 'plugins/quirky.git/node_modules')
const CODEMIRROR_MODULES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/merge',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-python',
  '@codemirror/language',
  '@codemirror/theme-one-dark'
]
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(GIT_MODULES, 'react/index.js'),
  'react/jsx-runtime': join(GIT_MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(GIT_MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(GIT_MODULES, 'react-dom/index.js'),
  'react-dom/client': join(GIT_MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts'),
  '@quirky/ui/editor-theme': join(ROOT, 'packages/ui/src/editor-theme.ts'),
  '@quirky/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
  ...Object.fromEntries(CODEMIRROR_MODULES.map((name) => [name, Bun.resolveSync(name, GIT_MODULES)]))
}
const STYLESHEETS = [
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css'
]
const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const combinedDiff = join(ROOT, 'plugins/quirky.git/src/view/CombinedDiff.tsx')
  const diffPane = join(ROOT, 'plugins/quirky.git/src/view/DiffPane.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { CombinedDiff } from ${JSON.stringify(combinedDiff)}
    import { DiffPane } from ${JSON.stringify(diffPane)}

    const paths = Array.from({ length: 6 }, (_, index) => 'file-' + (index + 1) + '.ts')
    const settings = { sideBySide: false, wrap: false, showWhitespace: false, collapseUnchanged: false, fileTree: false }
    const originalFor = (path) => Array.from({ length: 100 }, (_, index) => path + ' line ' + (index + 1)).join('\\n') + '\\n'
    const diffFor = (path) => {
      const original = originalFor(path)
      const modified = original.replace(path + ' line 100', path + ' changed line 100')
      return { path, staged: false, original, modified, binary: false, source: 'commit', kind: 'text', modifiedHash: null }
    }
    const commit = 'c'.repeat(40)
    const context = {
      async call(method, params = {}) {
        if (method === 'quirky.git/commitFiles') {
          return {
            commit,
            entries: paths.map((path) => ({ path, status: 'modified', added: 1, removed: 1, binary: false }))
          }
        }
        if (method === 'quirky.git/diff') return diffFor(params.path)
        if (method === 'quirky.git/notes') return { notes: [] }
        throw new Error('Unexpected call: ' + method)
      },
      subscribe() { return () => {} },
      getSetting() { return undefined },
      toast() {},
      executeCommand() { return Promise.resolve() }
    }
    const input = { mode: 'combined', worktree: 'worktree-1', commit }
    const host = document.getElementById('diff-root')
    let root = null
    const mount = (element) => {
      root?.unmount()
      root = createRoot(host)
      root.render(element)
    }
    window.openCombined = () => mount(createElement(CombinedDiff, {
      context,
      input,
      settings,
      setSetting() {},
      report() {},
      bind() {},
      close() {}
    }))
    window.showSingleFile = () => mount(createElement(DiffPane, {
      context,
      worktree: input.worktree,
      path: paths[0],
      diff: diffFor(paths[0]),
      editable: false,
      settings,
      variant: 'file',
      onState() {},
      bind(handle) { window.singleFileHandle = handle },
      onSaved() {},
      onReload: async () => {}
    }))
    window.singleFileCurrentChange = () => window.singleFileHandle?.currentChange() ?? null
  `
}
function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'git-combined-scroll-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^(?:react|react\\/jsx-runtime|react\\/jsx-dev-runtime|react-dom|react-dom\\/client|@quirky\\/ui(?:\\/editor-theme)?|@quirky\\/protocol|@codemirror\\/(?:state|view|merge|lang-javascript|lang-json|lang-markdown|lang-python|language|theme-one-dark))$/
          },
          ({ path }) => ({ path: BROWSER_IMPORTS[path] })
        )
      }
    }
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(entrypoint)}],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\\\n'))
    await Bun.write(${JSON.stringify(outputPath)}, result.outputs[0]!)
  `
}

type BrowserTestWindow = typeof window & {
  openCombined(): void
  showSingleFile(): void
  singleFileCurrentChange(): number | null
}

async function openPage() {
  const context = await browser!.newContext({ viewport: { width: 900, height: 540 } })
  const page = await context.newPage()
  await page.setContent(`<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; overflow: hidden; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
          #diff-pane { height: 500px; width: 860px; display: flex; flex-direction: column; overflow: hidden; }
          #diff-root { display: flex; flex: 1; min-height: 0; }
        </style>
      </head>
      <body><main id="diff-pane"><div id="diff-root"></div></main></body>
    </html>`)
  for (const stylesheet of STYLESHEETS) {
    await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
  }
  await page.addScriptTag({ content: browserBundle })
  return { context, page }
}

async function waitForSections(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll('#diff-root [data-diff-editor] .cm-editor').length === 6, null, { timeout: 15_000 })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function combinedPosition(page: Page) {
  return page.evaluate(() => {
    const scroll = [...document.querySelectorAll<HTMLElement>('#diff-root .ui-stack')].find(
      (element) => element.style.overflow === 'auto' && element.querySelector(':scope > section[data-path="file-1.ts"]')
    )
    const firstHeader = scroll?.querySelector<HTMLElement>(':scope > section[data-path="file-1.ts"] header')
    if (!scroll || !firstHeader) throw new Error('The combined diff scroll area or first file header did not render.')
    const viewport = scroll.getBoundingClientRect()
    const header = firstHeader.getBoundingClientRect()
    return {
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      firstHeaderVisible: header.top >= viewport.top - 1 && header.bottom <= viewport.bottom + 1
    }
  })
}

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-git-combined-scroll-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const outputPath = join(tempDir, 'browser-bundle.js')
    const buildScript = join(tempDir, 'build-browser-entry.ts')
    writeFileSync(buildScript, browserBuildScript(entrypoint, outputPath))
    const build = Bun.spawnSync([process.execPath, buildScript], { cwd: ROOT })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString() || build.stdout.toString())
    browserBundle = readFileSync(outputPath, 'utf8')
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

test.skipIf(!existsSync(executable))('combined commit diff stays at its first file when opened and reopened', async () => {
  const { context, page } = await openPage()
  try {
    await page.evaluate(() => (window as BrowserTestWindow).openCombined())
    await waitForSections(page)
    const initial = await combinedPosition(page)
    expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight)
    expect(initial.scrollTop).toBe(0)
    expect(initial.firstHeaderVisible).toBe(true)

    await page.evaluate(() => (window as BrowserTestWindow).openCombined())
    await waitForSections(page)
    const reopened = await combinedPosition(page)
    expect(reopened.scrollTop).toBe(initial.scrollTop)
    expect(reopened.scrollTop).toBe(0)
    expect(reopened.firstHeaderVisible).toBe(true)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(executable))('single-file diff still selects its first change on mount', async () => {
  const { context, page } = await openPage()
  try {
    await page.evaluate(() => (window as BrowserTestWindow).showSingleFile())
    await page.waitForFunction(() => (window as BrowserTestWindow).singleFileCurrentChange() === 1, null, { timeout: 15_000 })
    expect(await page.evaluate(() => (window as BrowserTestWindow).singleFileCurrentChange())).toBe(1)
  } finally {
    await context.close()
  }
}, 60_000)

