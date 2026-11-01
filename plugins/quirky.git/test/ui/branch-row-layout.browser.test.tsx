import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

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
const STYLESHEETS = [
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/git-rows.css'
]
const executable = chromium.executablePath()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const header = join(ROOT, 'plugins/quirky.git/src/panel/Header.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { BranchRow } from ${JSON.stringify(header)}

    const longBranch = 'branch-' + 'x'.repeat(123)
    const cleanStatus = { branch: longBranch, detached: false, ahead: 0, behind: 0 }
    const panel = document.getElementById('branch-root')
    const root = createRoot(panel)
    window.baseRefClicks = 0
    window.renderBranchRows = () => {
      window.baseRefClicks = 0
      root.render(createElement('div', null,
        createElement('section', { 'data-branch-case': 'clean' },
          createElement(BranchRow, {
            status: cleanStatus,
            compare: { base: 'main', status: 'ready', added: 0, removed: 0 },
            onChangeBase: () => { window.baseRefClicks++ }
          })
        ),
        createElement('section', { 'data-branch-case': 'with-badges' },
          createElement(BranchRow, {
            status: { ...cleanStatus, ahead: 4, behind: 2 },
            compare: { base: 'main', status: 'ready', added: 17, removed: 3 },
            onChangeBase: () => { window.baseRefClicks++ }
          })
        ),
        createElement('section', { 'data-branch-case': 'wide-badges' },
          createElement(BranchRow, {
            status: { ...cleanStatus, ahead: 4000, behind: 2000 },
            compare: { base: 'origin/release/2026.11', status: 'ready', added: 17000, removed: 3000 },
            onChangeBase: () => { window.baseRefClicks++ }
          })
        )
      ))
    }
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'git-branch-row-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          { filter: /^(?:react|react\\/jsx-runtime|react\\/jsx-dev-runtime|react-dom|react-dom\\/client|@quirky\\/ui|@quirky\\/protocol)$/ },
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
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\\n'))
    await Bun.write(${JSON.stringify(outputPath)}, result.outputs[0]!)
  `
}

type BrowserTestWindow = typeof window & {
  baseRefClicks: number
  renderBranchRows(): void
}

async function openPage() {
  const context = await browser!.newContext({ viewport: { width: 800, height: 600 } })
  const page = await context.newPage()
  await page.setContent(`<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
          #branch-panel { width: 280px; }
        </style>
      </head>
      <body>
        <main id="branch-panel" class="git-rows" data-git-panel>
          <div id="branch-root"></div>
        </main>
      </body>
    </html>`)
  for (const stylesheet of STYLESHEETS) {
    await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
  }
  await page.addScriptTag({ content: browserBundle })
  return { context, page }
}

beforeAll(async () => {
  if (!existsSync(executable)) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-git-branch-row-'))
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

test.skipIf(!existsSync(executable))('long branch names ellipsize beside a usable base ref with or without status badges', async () => {
  const { context, page } = await openPage()
  try {
    await page.evaluate(() => (window as BrowserTestWindow).renderBranchRows())
    await page.waitForFunction(() => document.querySelectorAll('[data-branch-row]').length === 3)

    const layouts = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#branch-panel')
      if (!panel) throw new Error('The git panel did not render.')
      const panelRect = panel.getBoundingClientRect()
      const panelStyle = getComputedStyle(panel)
      const contentLeft = panelRect.left + parseFloat(panelStyle.borderLeftWidth) + parseFloat(panelStyle.paddingLeft)
      const contentRight = panelRect.right - parseFloat(panelStyle.borderRightWidth) - parseFloat(panelStyle.paddingRight)

      return ['clean', 'with-badges', 'wide-badges'].map((caseName) => {
        const caseElement = document.querySelector<HTMLElement>(`[data-branch-case="${caseName}"]`)
        const row = caseElement?.querySelector<HTMLElement>('[data-branch-row]')
        const branch = row?.querySelector<HTMLElement>('[data-branch-name]')
        const arrow = row?.querySelector<HTMLElement>('[aria-hidden="true"]')
        const base = row?.querySelector<HTMLElement>('[data-base-ref]')
        if (!caseElement || !row || !branch || !arrow || !base) {
          throw new Error(`The ${caseName} branch row did not render its branch, arrow, and base ref.`)
        }

        const branchRect = branch.getBoundingClientRect()
        const arrowRect = arrow.getBoundingClientRect()
        const baseRect = base.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const branchStyle = getComputedStyle(branch)
        return {
          caseName,
          contentWidth: contentRight - contentLeft,
          contentLeft,
          contentRight,
          rowWidth: rowRect.width,
          branchWidth: branchRect.width,
          branchClientWidth: branch.clientWidth,
          branchScrollWidth: branch.scrollWidth,
          textOverflow: branchStyle.textOverflow,
          whiteSpace: branchStyle.whiteSpace,
          overflowX: branchStyle.overflowX,
          branchCenterY: branchRect.top + branchRect.height / 2,
          branchRight: branchRect.right,
          arrowCenterY: arrowRect.top + arrowRect.height / 2,
          arrowLeft: arrowRect.left,
          arrowRight: arrowRect.right,
          baseCenterY: baseRect.top + baseRect.height / 2,
          baseLeft: baseRect.left,
          baseRight: baseRect.right,
          badgesWithinRow: Array.from(row.querySelectorAll<HTMLElement>('.ui-badge')).every((badge) => {
            const rect = badge.getBoundingClientRect()
            return rect.left >= contentLeft && rect.right <= contentRight
          }),
          badgeLabels: Array.from(row.querySelectorAll<HTMLElement>('.ui-badge')).map((badge) => badge.getAttribute('aria-label'))
        }
      })
    })

    for (const layout of layouts) {
      expect(layout.contentWidth).toBe(256)
      expect(layout.rowWidth).toBe(256)
      expect(layout.textOverflow).toBe('ellipsis')
      expect(layout.whiteSpace).toBe('nowrap')
      expect(layout.overflowX).toBe('hidden')
      expect(layout.branchWidth).toBeLessThan(layout.contentWidth)
      expect(layout.branchWidth).toBeGreaterThan(0)
      expect(layout.branchScrollWidth).toBeGreaterThan(layout.branchClientWidth)
      expect(Math.abs(layout.branchCenterY - layout.arrowCenterY)).toBeLessThanOrEqual(1)
      expect(Math.abs(layout.arrowCenterY - layout.baseCenterY)).toBeLessThanOrEqual(1)
      expect(layout.arrowLeft).toBeGreaterThanOrEqual(layout.branchRight)
      expect(layout.baseLeft).toBeGreaterThanOrEqual(layout.arrowRight)
      expect(layout.baseLeft).toBeGreaterThanOrEqual(layout.contentLeft)
      expect(layout.baseRight).toBeLessThanOrEqual(layout.contentRight)
      expect(layout.badgesWithinRow).toBe(true)
    }

    expect(layouts[1]!.badgeLabels).toContain('4 commit(s) to push')
    expect(layouts[1]!.badgeLabels).toContain('2 commit(s) to pull')
    expect(layouts[1]!.badgeLabels).toContain('Lines changed on this branch')

    for (const [index, caseName] of ['clean', 'with-badges', 'wide-badges'].entries()) {
      await page.locator(`[data-branch-case="${caseName}"] [data-base-ref]`).click()
      expect(await page.evaluate(() => (window as BrowserTestWindow).baseRefClicks)).toBe(index + 1)
    }
  } finally {
    await context.close()
  }
}, 60_000)
