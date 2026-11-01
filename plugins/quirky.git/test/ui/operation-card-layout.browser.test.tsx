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
const PARAGRAPH = 'Resolved files move back to normal changes after they leave the live conflict state.'
const AI_PRIMARY = 'Start the default AI agent to resolve these conflicts'
const AI_CHOOSER = 'Choose an agent to resolve these conflicts'
const REVIEW = 'Review conflicts'
const CASES = [
  { name: '256-idle', width: 256, busy: false },
  { name: '256-busy', width: 256, busy: true },
  { name: '280-idle', width: 280, busy: false },
  { name: '280-busy', width: 280, busy: true }
]
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const operationCard = join(ROOT, 'plugins/quirky.git/src/panel/Cards.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { OperationCard } from ${JSON.stringify(operationCard)}

    const cases = ${JSON.stringify(CASES)}
    const root = createRoot(document.getElementById('operation-root'))
    window.renderOperationCards = () => {
      root.render(createElement('main', { id: 'operation-panel' }, cases.map(({ name, width, busy }) => {
        return createElement('section', {
          key: name,
          'data-operation-case': name,
          style: { width: width + 'px' }
        }, createElement(OperationCard, {
          operation: 'merge',
          unresolved: 2,
          busy,
          onReview: () => {},
          onContinue: () => {},
          onAbort: () => {},
          fix: {
            action: 'resolveConflicts',
            busy,
            onFix: () => {},
            onCustomize: () => {}
          }
        }))
      })))
    }
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'git-operation-card-browser-dependencies',
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
  renderOperationCards(): void
}

async function openPage() {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  await page.setContent(`<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
          #operation-panel { display: grid; grid-template-columns: repeat(2, 280px); gap: 16px; align-items: start; }
        </style>
      </head>
      <body>
        <div class="git-rows" data-git-panel id="operation-root"></div>
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
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-git-operation-card-'))
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

test.skipIf(!existsSync(executable))('conflict card keeps its description and AI controls usable in a narrow panel', async () => {
  const { context, page } = await openPage()
  try {
    await page.evaluate(() => (window as BrowserTestWindow).renderOperationCards())
    await page.waitForFunction(() => document.querySelectorAll('[data-operation-case] article').length === 4)

    for (const scenario of CASES) {
      const scope = page.locator(`[data-operation-case="${scenario.name}"]`)
      const card = scope.getByRole('article')
      const paragraph = scope.getByText(PARAGRAPH, { exact: true })
      const review = card.getByRole('button', { name: REVIEW })
      const aiPrimary = card.getByRole('button', { name: AI_PRIMARY })
      const aiChooser = card.getByRole('button', { name: AI_CHOOSER })
      const abort = card.getByRole('button', { name: 'Abort merge' })
      const cardBox = await card.boundingBox()
      const paragraphBox = await paragraph.boundingBox()
      const aiPrimaryBox = await aiPrimary.boundingBox()
      const aiChooserBox = await aiChooser.boundingBox()
      if (!cardBox || !paragraphBox || !aiPrimaryBox || !aiChooserBox) {
        throw new Error(`The ${scenario.name} conflict card did not render all required controls.`)
      }

      const paragraphRight = paragraphBox.x + paragraphBox.width
      const contentRight = await card.evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
      })
      expect(cardBox.width).toBe(scenario.width)
      expect(Math.abs(paragraphRight - contentRight)).toBeLessThanOrEqual(1)
      expect(Math.abs((aiPrimaryBox.y + aiPrimaryBox.height / 2) - (aiChooserBox.y + aiChooserBox.height / 2))).toBeLessThanOrEqual(1)
      expect(await aiPrimary.evaluate((button) => {
        const label = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === 'Resolve with AI')
        if (!label) return 0
        const range = document.createRange()
        range.selectNodeContents(label)
        return range.getClientRects().length
      })).toBe(1)
      expect(await aiPrimary.isDisabled()).toBe(scenario.busy)
      expect(await aiChooser.isDisabled()).toBe(scenario.busy)
      expect(await abort.isDisabled()).toBe(scenario.busy)
      expect(await review.isDisabled()).toBe(false)

      const controlsWithinCard = await card.getByRole('button').evaluateAll((buttons) => {
        const cardRect = buttons[0]?.closest('article')?.getBoundingClientRect()
        if (!cardRect) return false
        return buttons.every((button) => {
          const rect = button.getBoundingClientRect()
          return rect.left >= cardRect.left && rect.right <= cardRect.right && rect.top >= cardRect.top && rect.bottom <= cardRect.bottom
        })
      })
      expect(controlsWithinCard).toBe(true)
    }

  } finally {
    await context.close()
  }
}, 60_000)
