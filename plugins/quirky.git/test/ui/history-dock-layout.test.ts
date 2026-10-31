import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css'
]
const WIDTHS = [240, 280, 400] as const
const THEMES = ['light', 'dark'] as const
const SUBJECT = 'Keep the full commit subject readable while refs wrap independently in a narrow history dock'
const LONG_REF = `refs/remotes/origin/feature/${'commit-chip-layout-'.repeat(8)}`
const COMMIT_OID = '8f4c29a01e76c58b8d2f7f3b126a6935a8de3192'

function chromiumExecutable(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

const executable = chromiumExecutable()
let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const historyDock = join(ROOT, 'plugins/quirky.git/src/panel/HistoryDock.tsx')
  return `
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    import { HistoryDock } from ${JSON.stringify(historyDock)}
    import type { GitCommit, GitHistory, UiPluginContext } from ${JSON.stringify(join(ROOT, 'packages/protocol/src/index.ts'))}

    const subject = ${JSON.stringify(SUBJECT)}
    const longRef = ${JSON.stringify(LONG_REF)}
    const commit = (oid: string, refs: string[]): GitCommit => ({
      oid,
      parents: [],
      author: 'History Dock Regression',
      email: 'history-dock@example.test',
      authoredAt: Date.now() - 60_000,
      committedAt: Date.now() - 60_000,
      subject,
      body: '',
      refs
    })
    const history = {
      commits: [
        commit(${JSON.stringify(COMMIT_OID)}, ['HEAD -> main', 'origin/main', longRef]),
        commit('0d01f66c30ca3ce4127ab77f6264229c7788bc66', [])
      ],
      hasMore: false
    } as GitHistory
    const calls: string[] = []
    const context = {
      call(method: string) {
        calls.push(method)
        if (method === 'quirky.git/history') return Promise.resolve(history)
        if (method === 'quirky.git/commitFiles') return Promise.resolve({ entries: [] })
        throw new Error('Unexpected HistoryDock method: ' + method)
      }
    } as unknown as UiPluginContext
    const state = { opened: 0, calls }
    const testWindow = window as Window & { __historyDockState?: typeof state }
    testWindow.__historyDockState = state

    createRoot(document.getElementById('history')!).render(createElement(HistoryDock, {
      context,
      worktree: '/mock/worktree',
      open: true,
      onToggle: () => {},
      head: '8f4c29a01e76c58b8d2f7f3b126a6935a8de3192',
      onOpenCommit: () => { state.opened += 1 },
      onOpenFile: () => {}
    }))
  `
}

function browserBuildScript(entrypoint: string, outputPath: string): string {
  return `
    const BROWSER_IMPORTS = ${JSON.stringify(BROWSER_IMPORTS)}
    const browserDependencyResolver = {
      name: 'history-dock-layout-browser-dependencies',
      setup(builder) {
        builder.onResolve(
          { filter: new RegExp('^(?:react|react/jsx-runtime|react/jsx-dev-runtime|react-dom|react-dom/client|@quirky/ui|@quirky/protocol)$') },
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

beforeAll(async () => {
  if (!executable) return
  const tempDir = mkdtempSync(join(ROOT, 'plugins/quirky.git/.history-dock-layout-'))
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
    executablePath: executable,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

function contrastRatio(foreground: string, background: string): number {
  const channels = (color: string) => {
    const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (!values || values.length !== 3) throw new Error(`Unexpected computed color: ${color}`)
    return values.map((value) => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
  }
  const luminance = (color: string) => {
    const [red, green, blue] = channels(color)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

describe('HistoryDock commit refs layout', () => {
  test.skipIf(!executable)('keeps subjects readable and ref badges bounded, separated, and legible at narrow widths', async () => {
    const context = await browser!.newContext({ viewport: { width: 440, height: 900 } })
    const page = await context.newPage()
    try {
      await page.setContent('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>html, body { margin: 0; min-height: 100%; }</style></head><body><div id="history" style="width: 400px"></div></body></html>')
      for (const stylesheet of STYLESHEETS) {
        await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
      }
      await page.addScriptTag({ content: browserBundle })
      const rows = page.locator('[data-commit-row]')
      await rows.nth(1).waitFor()
      expect(await rows.count()).toBe(2)
      const withRefs = rows.nth(0)
      const withoutRefs = rows.nth(1)
      const subject = withRefs.getByText(SUBJECT, { exact: true })
      await subject.waitFor()
      expect(await subject.isVisible()).toBe(true)
      const longBadge = withRefs.getByRole('img', { name: `Commit ref ${LONG_REF}`, exact: true })
      await longBadge.waitFor()
      expect(await longBadge.isVisible()).toBe(true)

      for (const theme of THEMES) {
        await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme)
        for (const width of WIDTHS) {
          await page.locator('#history').evaluate((element, value) => {
            ;(element as HTMLElement).style.width = `${value}px`
          }, width)
          await page.evaluate(() => {
            const { promise, resolve } = Promise.withResolvers<void>()
            requestAnimationFrame(() => resolve())
            return promise
          })

          const rowBox = await withRefs.locator('.ui-list-row').boundingBox()
          const subjectLines = (row: typeof withRefs) => row.getByText(SUBJECT, { exact: true }).evaluate((element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            return Array.from(range.getClientRects()).map(({ x, y, width, height }) => ({ x, y, width, height }))
          })
          const [withRefLines, withoutRefLines] = await Promise.all([subjectLines(withRefs), subjectLines(withoutRefs)])
          expect(rowBox).not.toBeNull()
          expect(withRefLines.length).toBeGreaterThan(0)
          expect(withRefLines.length).toBe(withoutRefLines.length)
          for (let index = 0; index < withRefLines.length; index += 1) {
            expect(withRefLines[index]!.width).toBeCloseTo(withoutRefLines[index]!.width, 0)
          }

          const badges = await withRefs.getByRole('img', { name: /^Commit ref / }).evaluateAll((elements) => elements.map((element) => {
            const box = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            const label = element.querySelector(':scope > span')
            const labelStyle = label ? getComputedStyle(label) : null
            const labelBox = label?.getBoundingClientRect()
            return {
              x: box.x,
              y: box.y,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
              color: style.color,
              background: style.backgroundColor,
              title: element.getAttribute('title'),
              labelText: label?.textContent,
              labelOverflow: labelStyle?.overflow,
              labelWhiteSpace: labelStyle?.whiteSpace,
              labelTextOverflow: labelStyle?.textOverflow,
              labelClientWidth: label?.clientWidth ?? 0,
              labelScrollWidth: label?.scrollWidth ?? 0,
              labelX: labelBox?.x ?? 0
            }
          }))
          expect(badges.length).toBe(3)
          for (const badge of badges) {
            expect(badge.width).toBeGreaterThan(0)
            expect(badge.parentWidth).toBeGreaterThan(0)
            expect(badge.width).toBeLessThanOrEqual(badge.parentWidth + 1)
            expect(badge.x).toBeGreaterThanOrEqual(rowBox!.x)
            expect(badge.right).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
            const ratio = contrastRatio(badge.color, badge.background)
            expect(ratio).toBeGreaterThanOrEqual(4.5)
          }

          const badgeBoxes = badges.map(({ x, y, right, bottom }) => ({ x, y, right, bottom }))
          for (let first = 0; first < badgeBoxes.length; first += 1) {
            for (let second = first + 1; second < badgeBoxes.length; second += 1) {
              const a = badgeBoxes[first]!
              const b = badgeBoxes[second]!
              const horizontalGap = Math.max(a.x - b.right, b.x - a.right, 0)
              const verticalGap = Math.max(a.y - b.bottom, b.y - a.bottom, 0)
              expect(horizontalGap >= 4 || verticalGap >= 4).toBe(true)
            }
          }

          const subjectBottom = Math.max(...withRefLines.map((line) => line.y + line.height))
          expect(Math.min(...badges.map((badge) => badge.y))).toBeGreaterThan(subjectBottom)
          expect(badges.find((badge) => badge.labelText === LONG_REF)).toMatchObject({
            title: LONG_REF,
            labelOverflow: 'hidden',
            labelWhiteSpace: 'nowrap',
            labelTextOverflow: 'ellipsis'
          })
          const longBadgeMetrics = badges.find((badge) => badge.labelText === LONG_REF)!
          expect(longBadgeMetrics.labelClientWidth).toBeGreaterThan(0)
          expect(longBadgeMetrics.labelScrollWidth).toBeGreaterThan(longBadgeMetrics.labelClientWidth)
          expect(longBadgeMetrics.labelX + longBadgeMetrics.labelClientWidth).toBeLessThanOrEqual(longBadgeMetrics.right)

          const expand = withRefs.getByRole('button', { name: 'Expand commit 8f4c29a', exact: true })
          const expandBox = await expand.boundingBox()
          expect(expandBox).not.toBeNull()
          expect(expandBox!.x).toBeGreaterThanOrEqual(rowBox!.x)
          expect(expandBox!.x + expandBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
          for (const badge of badges) {
            const overlapX = badge.x < expandBox!.x + expandBox!.width && badge.right > expandBox!.x
            const overlapY = badge.y < expandBox!.y + expandBox!.height && badge.bottom > expandBox!.y
            expect(overlapX && overlapY).toBe(false)
          }
        }
      }

      await withRefs.getByRole('button', { name: 'Expand commit 8f4c29a', exact: true }).click()
      const collapse = withRefs.getByRole('button', { name: 'Collapse commit 8f4c29a', exact: true })
      await collapse.waitFor()
      expect(await collapse.getAttribute('aria-expanded')).toBe('true')
      await withRefs.getByText(SUBJECT, { exact: true }).click()
      const interactionState = await page.evaluate(() => {
        const testWindow = window as Window & { __historyDockState?: { opened: number; calls: string[] } }
        if (!testWindow.__historyDockState) throw new Error('HistoryDock browser state was not initialized')
        return testWindow.__historyDockState
      })
      expect(interactionState.opened).toBe(1)
      expect(interactionState.calls).toContain('quirky.git/commitFiles')
    } finally {
      await context.close()
    }
  }, 60_000)
})
