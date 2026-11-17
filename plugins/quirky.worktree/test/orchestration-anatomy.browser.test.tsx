import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { hostContractContext } from '../../../scripts/ui-review/host-contracts'
import type { CaptureTarget } from '../../../scripts/ui-review/contracts'

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
const THEMES = ['dark', 'light'] as const
const CONTRACT_TARGET = {
  id: 'sidebar-section:quirky.worktree/worktrees',
  plugin: 'quirky.worktree',
  title: 'Worktrees',
  kind: 'sidebar-section'
} satisfies CaptureTarget
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
  name: 'worktree-orchestration-anatomy-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/protocol|@quirky\/ui)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] })
    )
  }
}

type BrowserBundle = { js: string; css: string }
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
type OrchestrationMeasurement = {
  className: string
  title: string
  titleScrollWidth: number
  titleClientWidth: number
  description: string
  row: Rect
  descriptionRect: Rect
}
type LayoutMeasurement = {
  checkoutRows: { id: string; rect: Rect }[]
  checkoutRowGap: string
  orchestrationRows: OrchestrationMeasurement[]
}

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
      branch: 'worktree-anatomy-fixture',
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
    const worker = {
      dispatchId: 'dispatch',
      taskId: 'task',
      runId: 'run',
      workerState: 'waiting',
      currentAssignment: false,
      taskTitle: 'Unverified task',
      displayName: 'Unverified worker',
      coordinatorSessionId: 'coord',
      parentSessionId: 'coord',
      dispatchStatus: 'running',
      agentTerminalHandle: null,
      terminalState: 'unavailable',
      resource: { ownerDispatchId: 'dispatch', ownershipState: 'owned', releaseState: 'not_requested', worktreeId: 'selected', sessionId: 'gone' },
      projection: {
        workspace: { id: 'selected' },
        liveness: { status: 'unverifiable', reason: 'assignment unverified' },
        evidence: { liveStatus: 'unavailable', lastObservedAt: null },
        stage: { activity: 'unknown' }
      }
    }
    const sessions = [{
      id: 'coord',
      agent: 'claude',
      kind: 'terminal',
      status: 'running',
      title: 'UI review coordinator',
      worktreeId: 'selected',
      cwd: '/workspace/QuirkyApp/selected',
      createdAt: 1,
      lastActivityAt: 1,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: true
    }]
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
      marks: new Map([['parent', 'waiting']]),
      checks: new Map()
    })
    const context = {
      async call(method, params = {}) {
        if (method === 'plugin.list') return [{ id: 'quirky.orchestration', state: 'active' }]
        if (method === 'quirky.orchestration/workerList') {
          return { workers: [worker], page: { nextCursor: null, snapshotId: 'snapshot', total: 1 }, partialHostErrors: [] }
        }
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
      sessions,
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
      onOpen() {},
      onSelectToggle() {},
      onRename() {}
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
  if (!EXECUTABLE) throw new Error('Worktree orchestration-anatomy browser tests require an installed Chromium-family executable.')
  previousQuirkyHome = process.env.QUIRKY_HOME
  isolatedHome = mkdtempSync(join(tmpdir(), 'quirky-orchestration-anatomy-home-'))
  process.env.QUIRKY_HOME = isolatedHome

  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-orchestration-anatomy-build-'))
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

async function mount(width: number, theme: typeof THEMES[number]): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } })
  pages.push(page)
  await page.setContent(`<!doctype html>
    <html data-theme="${theme}"><head><style>
      ${bundle.css}
      html, body { width: 100%; height: 100%; margin: 0; }
      #host { box-sizing: border-box; width: ${width}px; height: 360px; min-width: 0; }
      #host > .ui-tool-panel-frame { height: 100%; min-width: 0; }
      #tree-scroll { box-sizing: border-box; height: 280px; min-width: 0; width: 100%; }
    </style></head><body><div id="host" data-tool-panel></div></body></html>`)
  await page.addScriptTag({ content: bundle.js })
  await page.waitForFunction(() => document.querySelectorAll('.worktree-tree [data-worktree-id]').length === 5)
  await page.waitForSelector('.orchestration-rows')
  await settle(page)
  return page
}

async function resize(page: Page, width: number): Promise<void> {
  await page.locator('#host').evaluate((element, nextWidth) => {
    ;(element as HTMLElement).style.width = `${nextWidth}px`
  }, width)
  await settle(page)
}

async function measureLayout(page: Page): Promise<LayoutMeasurement> {
  return page.evaluate(() => {
    const box = (element: Pick<Element, 'getBoundingClientRect'>): Rect => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const worktreeList = document.querySelector<HTMLElement>('.worktree-list')
    if (!worktreeList) throw new Error('Missing production worktree list.')
    const checkoutRows = [...document.querySelectorAll<HTMLElement>('.worktree-row')].map((row) => {
      const item = row.closest<HTMLElement>('[data-worktree-id]')
      if (!item) throw new Error('Missing worktree id for checkout row.')
      return { id: item.dataset.worktreeId!, rect: box(row) }
    })
    const orchestrationRows = [...document.querySelectorAll<HTMLElement>('.orchestration-rows .ui-list-row')].map((row) => {
      const title = row.querySelector<HTMLElement>('.ui-list-row__title')
      const description = row.querySelector<HTMLElement>('.ui-list-row__description')
      if (!title || !description) throw new Error('Orchestration ListRow is missing its title or description.')
      return {
        className: row.className,
        title: title.textContent?.trim() ?? '',
        titleScrollWidth: title.scrollWidth,
        titleClientWidth: title.clientWidth,
        description: description.textContent?.trim() ?? '',
        row: box(row),
        descriptionRect: box(description)
      }
    })
    return { checkoutRows, checkoutRowGap: getComputedStyle(worktreeList).rowGap, orchestrationRows }
  })
}

function expectNear(actual: number, expected: number, tolerance = 0.5): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function expectContained(inner: Rect, outer: Rect): void {
  expect(inner.width).toBeGreaterThan(0)
  expect(inner.height).toBeGreaterThan(0)
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
  expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
}

function expectCheckoutAndOrchestrationRows(layout: LayoutMeasurement, width: number): void {
  expect(layout.checkoutRows).toHaveLength(5)
  for (const row of layout.checkoutRows) expectNear(row.rect.height, 26)
  expect(layout.checkoutRowGap).toBe('4px')

  expect(layout.orchestrationRows).toHaveLength(2)
  for (const row of layout.orchestrationRows) {
    expect(row.className.split(/\s+/)).toContain('ui-list-row--double')
  }
  expect(layout.orchestrationRows.map((row) => [row.title, row.description])).toEqual([
    ['Coordinator · UI review coordinator', 'claude · terminal · running'],
    ['Worker assignment unverified', 'Assignment unverified']
  ])
  for (const row of layout.orchestrationRows) expectContained(row.descriptionRect, row.row)

  if (width === 320) {
    for (const row of layout.orchestrationRows) expectNear(row.row.height, 34)
  } else {
    const [coordinator, worker] = layout.orchestrationRows
    expect(coordinator!.row.height).toBeGreaterThan(34.5)
    expect(coordinator!.titleScrollWidth).toBeLessThanOrEqual(coordinator!.titleClientWidth)
    expectNear(worker!.row.height, 34)
  }
}

for (const theme of THEMES) {
  test(`keeps checkout and orchestration row anatomy at 320px and 240px (${theme})`, async () => {
    const page = await mount(320, theme)
    const at320 = await measureLayout(page)
    expectCheckoutAndOrchestrationRows(at320, 320)

    await resize(page, 240)
    const at240 = await measureLayout(page)
    expectCheckoutAndOrchestrationRows(at240, 240)

    const checkoutHeight = Math.round(at320.checkoutRows[0]!.rect.height)
    const orchestrationMinHeight = Math.round(Math.min(...at320.orchestrationRows.map((row) => row.row.height)))
    const rule = hostContractContext(CONTRACT_TARGET, theme).rules.find(({ id }) => id === 'worktrees-approved-redesign')
    expect(rule).toBeDefined()
    const text = rule!.text
    const requiredPhrases = [
      `single-line ${checkoutHeight}px`,
      `${orchestrationMinHeight}px minimum`,
      'wrap their full text'
    ]
    expect(requiredPhrases.filter((phrase) => !text.includes(phrase))).toEqual([])
  }, 60_000)
}
