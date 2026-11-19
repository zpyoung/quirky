import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
declare global {
  interface Window {
    setNotesCase(value: string): void
  }
}

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.worktree/node_modules')
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
  name: 'worktree-notes-hover-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/protocol|@quirky\/ui)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}
const STYLESHEETS = [
  'packages/ui/src/design-system/compatibility-tokens.css',
  'packages/ui/src/design-system/tokens.css',
  'packages/ui/src/design-system/components.css',
  'packages/ui/src/design-system/icons/icons.css',
  'packages/ui/src/design-system/worktree-tree.css',
  'packages/ui/src/design-system/worktree-primitives.css'
]
const NOTE = 'see the auth bug\nthen ship'

let browser: Browser | null = null
let browserBundle = ''

function browserEntry(): string {
  const treeModule = join(ROOT, 'plugins/quirky.worktree/src/Tree.tsx')
  const controlTypesModule = join(ROOT, 'plugins/quirky.worktree/src/control-types.ts')
  return `
    import { createElement as h, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Tree } from ${JSON.stringify(treeModule)}
    import { DEFAULT_STOCK_OPTIONS } from ${JSON.stringify(controlTypesModule)}

    const note = ${JSON.stringify(NOTE)}
    const repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }
    const treeContext = {
      call: async () => [],
      toast() {},
      log() {},
      subscribe() { return () => {} },
      onConnection() { return () => {} }
    }
    const worktreeFor = (comment) => ({
      id: 'notes', repoId: 'r1', path: '/repo/QuirkyApp/fix-login', branch: 'fix-login', head: 'abc', isMain: false,
      name: 'fix-login', instanceId: 'notes', kind: 'git', displayName: null, comment, status: 'in-progress',
      pinned: false, unread: false, parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false,
      removing: false, groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false,
      sleepChangedAt: null, references: [], archivedAt: null,
      cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
      externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false, tagIds: [],
      linkedPR: {
        provider: 'github', kind: 'pullRequest', number: 42, title: 'Add route', url: 'https://example.test/42',
        repository: { host: 'github.com', owner: 'o', repo: 'r' }
      }
    })

    function NotesFixture() {
      const [caseName, setCaseName] = useState('visible')
      window.setNotesCase = setCaseName
      const comment = caseName === 'empty' ? '' : caseName === 'whitespace' ? '   ' : note
      const worktree = worktreeFor(comment)
      const row = { worktree, depth: 0, mark: 'idle', childCount: 0, childAttention: 'none' }
      const group = { key: 'project:r1', kind: 'project', title: 'QuirkyApp', attention: 'none', attentionCount: 0, rows: [row] }
      const options = {
        ...DEFAULT_STOCK_OPTIONS,
        showComment: caseName !== 'hidden-comment',
        showProperties: caseName === 'hidden-property'
          ? DEFAULT_STOCK_OPTIONS.showProperties.filter((property) => property !== 'notes')
          : DEFAULT_STOCK_OPTIONS.showProperties
      }
      return h(Tree, {
        context: treeContext,
        model: { groups: [group], hidden: { count: 0, reasons: [] }, needsYouCount: 0, erroredCount: 0 },
        tagsById: new Map(),
        rowFact: 'last-activity',
        repos: [repo],
        groups: [],
        sessions: [],
        selectedId: null,
        automationExpandedId: null,
        automationAvailability: null,
        onToggleAutomationDetails() {},
        now: 10000000,
        separatorEnabled: false,
        options,
        canShowSleeping: () => true,
        statusDefinitions: [
          { id: 'todo', label: 'Todo' }, { id: 'in-progress', label: 'In progress' },
          { id: 'in-review', label: 'In review' }, { id: 'done', label: 'Done' }
        ],
        projectIdentities: {},
        openDialog() {},
        requestDelete() {},
        onDropPreviewChange() {},
        onSeparatorStateChange() {}
      })
    }

    createRoot(document.getElementById('root')).render(h(NotesFixture))
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body, #root { min-height: 100%; margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
          #root { width: min(100%, 560px); padding: 32px; }
        </style>
      </head>
      <body><div id="root"></div></body>
    </html>`
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-worktree-notes-hover-'))
  try {
    const entrypoint = join(tempDir, 'browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The worktree notes hover browser bundle was empty.')
    browserBundle = await output.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('shows Notes in the browser hover card at desktop and mobile widths, and hides disabled or empty notes', async () => {
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    const trigger = page.locator('[data-worktree-id="notes"] .worktree-row__main')
    await trigger.focus()
    const card = page.locator('.worktree-hover')
    await card.waitFor()
    const terms = await card.locator('dt').allTextContents()
    expect(terms.slice(terms.indexOf('Agent'), terms.indexOf('Review') + 1)).toEqual(['Agent', 'Notes', 'Review'])
    const noteText = await card.evaluate((element) => {
      const term = [...element.querySelectorAll('dt')].find((item) => item.textContent === 'Notes')
      return term?.nextElementSibling?.textContent ?? null
    })
    expect(noteText).toBe(NOTE)
    const desktopSurfaceBounds = await page.locator('.ui-hover-card').boundingBox()
    expect(desktopSurfaceBounds).not.toBeNull()
    expect(desktopSurfaceBounds!.x).toBeGreaterThanOrEqual(0)
    expect(desktopSurfaceBounds!.x + desktopSurfaceBounds!.width).toBeLessThanOrEqual(800)
    expect(desktopSurfaceBounds!.y).toBeGreaterThanOrEqual(0)
    expect(desktopSurfaceBounds!.y + desktopSurfaceBounds!.height).toBeLessThanOrEqual(600)
    const desktopScreenshotPath = join(tmpdir(), 'quirky-worktree-notes-hover-desktop.png')
    await page.locator('.ui-hover-card').screenshot({ path: desktopScreenshotPath })
    console.log(`NOTES_HOVER_DESKTOP_SCREENSHOT=${desktopScreenshotPath}`)

    await trigger.blur()
    await page.setViewportSize({ width: 390, height: 844 })
    await trigger.focus()
    await card.waitFor()
    const mobileTerms = await card.locator('dt').allTextContents()
    expect(mobileTerms.slice(mobileTerms.indexOf('Agent'), mobileTerms.indexOf('Review') + 1)).toEqual(['Agent', 'Notes', 'Review'])
    const mobileNoteText = await card.evaluate((element) => {
      const term = [...element.querySelectorAll('dt')].find((item) => item.textContent === 'Notes')
      return term?.nextElementSibling?.textContent ?? null
    })
    expect(mobileNoteText).toBe(NOTE)
    const mobileSurfaceBounds = await page.locator('.ui-hover-card').boundingBox()
    expect(mobileSurfaceBounds).not.toBeNull()
    expect(mobileSurfaceBounds!.x).toBeGreaterThanOrEqual(0)
    expect(mobileSurfaceBounds!.x + mobileSurfaceBounds!.width).toBeLessThanOrEqual(390)
    expect(mobileSurfaceBounds!.y).toBeGreaterThanOrEqual(0)
    expect(mobileSurfaceBounds!.y + mobileSurfaceBounds!.height).toBeLessThanOrEqual(844)
    const mobileRowBounds = await trigger.boundingBox()
    expect(mobileRowBounds).not.toBeNull()
    expect(mobileRowBounds!.x).toBeGreaterThanOrEqual(0)
    expect(mobileRowBounds!.x + mobileRowBounds!.width).toBeLessThanOrEqual(390)
    const mobileScreenshotPath = join(tmpdir(), 'quirky-worktree-notes-hover-mobile.png')
    await page.locator('.ui-hover-card').screenshot({ path: mobileScreenshotPath })
    console.log(`NOTES_HOVER_MOBILE_SCREENSHOT=${mobileScreenshotPath}`)

    const expectNoNotes = async (name: string) => {
      await page.evaluate((caseName) => {
        window.setNotesCase(caseName)
      }, name)
      await page.waitForFunction(() => {
        const hoverCard = document.querySelector<HTMLElement>('.worktree-hover')
        return hoverCard !== null && ![...hoverCard.querySelectorAll('dt')].some((term) => term.textContent === 'Notes')
      })
    }

    await expectNoNotes('hidden-comment')
    await expectNoNotes('hidden-property')
    await expectNoNotes('empty')
    await expectNoNotes('whitespace')
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
}, 60_000)
