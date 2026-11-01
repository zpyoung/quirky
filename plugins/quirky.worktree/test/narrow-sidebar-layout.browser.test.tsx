import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'

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
  name: 'worktree-narrow-sidebar-browser-dependencies',
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
  'packages/ui/src/design-system/worktree-tree.css'
]
const HEIGHT = 768
const GUTTER = 42
const CENTER_WIDTH = 330

let browser: Browser | null = null
let browserBundle = ''
let panelHeaderRegressionBundle = ''

function browserEntry(): string {
  const uiModule = join(ROOT, 'packages/ui/src/design-system/index.ts')
  const treeModule = join(ROOT, 'plugins/quirky.worktree/src/Tree.tsx')
  const controlTypesModule = join(ROOT, 'plugins/quirky.worktree/src/control-types.ts')
  const worktreeBoardModule = join(ROOT, 'plugins/quirky.worktree/src/WorktreeBoard.tsx')
  const activityFiltersModule = join(ROOT, 'plugins/quirky.worktree/src/ActivityFilters.tsx')
  const activityTypesModule = join(ROOT, 'plugins/quirky.worktree/src/useSidebarActivity.ts')
  return `
    import { createElement as h, useRef, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Tree } from ${JSON.stringify(treeModule)}
    import { WorktreeBoard } from ${JSON.stringify(worktreeBoardModule)}
    import { DEFAULT_STOCK_OPTIONS } from ${JSON.stringify(controlTypesModule)}
    import { ActivityFilters } from ${JSON.stringify(activityFiltersModule)}
    import type { ActivityPreferencePatch, ActivityPreferences, SidebarProjection } from ${JSON.stringify(activityTypesModule)}
    import { Badge, ExpandingIconButton, IconButton, ListRow, Popover, Tabs, ToolPanelFrame } from ${JSON.stringify(uiModule)}

    function ActivityFiltersRegressionFixture() {
      const [open, setOpen] = useState(false)
      const [preferences, setPreferenceState] = useState<ActivityPreferences>({
        workspaceActivityWindow: 'week',
        workspaceActivityCustomDays: 14,
        alwaysShowDefaultBranchWorkspace: false,
        workspaceActivityWindowBeforeLiveOnly: 'week',
        hideCompletedReviewWorkspaces: false,
        hidePassingCheckWorkspaces: false,
        hideAutomationCreated: false
      })
      const anchor = useRef<HTMLButtonElement | null>(null)
      const projection = {
        preferences,
        filterCount: 0,
        hiddenCount: 0,
        automationHiddenCount: 0
      } as SidebarProjection
      const setPreferences = async (patch: ActivityPreferencePatch): Promise<boolean> => {
        setPreferenceState((current) => ({ ...current, ...patch }))
        return true
      }
      return h('div', null,
        h(IconButton, {
          ref: anchor,
          label: 'Worktrees options',
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          onClick: () => setOpen((value) => !value)
        }, '⋯'),
        h(Popover, { open, label: 'Worktrees options', anchor, onClose: () => setOpen(false) },
          h(ActivityFilters, { projection, error: null, setPreferences })
        )
      )
    }

    const projectName = 'QuirkyWorktreeProject'
    const boardRegressionEnabled = document.documentElement.dataset.worktreeBoardRegression === 'true'
    const projectActionResult = document.createElement('output')
    projectActionResult.id = 'project-action-result'
    projectActionResult.setAttribute('role', 'status')
    projectActionResult.setAttribute('aria-live', 'polite')
    projectActionResult.hidden = true
    projectActionResult.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:10;padding:4px;background:white;color:black'
    document.body.append(projectActionResult)
    const treeContext = {
      call: async () => [],
      toast: () => {},
      log: () => {},
      subscribe: () => () => {},
      onConnection: () => () => {}
    }
    const tree = h(Tree, {
      context: treeContext,
      model: {
        pinned: [],
        groups: [],
        projects: [{
          repo: {
            id: 'r1',
            name: projectName,
            path: '/repo/' + projectName,
            addedAt: 1,
            kind: 'git',
            displayName: null,
            groupId: null
          },
          rows: [],
          pending: []
        }]
      },
      groups: [],
      sessions: [],
      selectedId: null,
      automationExpandedId: null,
      automationAvailability: null,
      onToggleAutomationDetails() {},
      now: 1,
      separatorEnabled: false,
      options: { ...DEFAULT_STOCK_OPTIONS, groupBy: document.documentElement.dataset.groupBy ?? DEFAULT_STOCK_OPTIONS.groupBy },
      canShowSleeping: (worktree) => DEFAULT_STOCK_OPTIONS.showSleeping || worktree.isMain,
      statusDefinitions: [],
      projectIdentities: document.documentElement.dataset.trackerProject === 'true'
        ? { r1: { displayName: null, icon: null, color: null, trackerProject: 'QA-16' } }
        : {},
      openDialog(dialog) {
        projectActionResult.textContent = 'Opened ' + dialog.kind + ' dialog for ' + dialog.repoId
        projectActionResult.hidden = false
      },
      requestDelete() {},
      onDropPreviewChange() {},
      onSeparatorStateChange() {}
    })
    const worktreeDescription = 'Primary worktree located in the local project folder with a deliberately long description that must truncate instead of wrapping onto another line.'
    const makeWorktreeRow = (worktree) => h('li', {
      className: 'worktree',
      'data-worktree-id': worktree.id
    }, h(ListRow, {
      title: h('span', { className: 'ui-cluster' },
        h('span', { className: 'worktree-name ui-text-ellipsis', title: worktree.name }, worktree.name)
      ),
      description: h('span', { className: 'ui-text-ellipsis', title: worktreeDescription }, worktreeDescription),
      status: 'working',
      statusLabel: 'Status: Active',
      compact: worktree.compact,
      mainTitle: '/workspace/' + worktree.name,
      mainLabel: 'Open ' + worktree.name,
      onClick() {},
      trailing: h('span', { className: 'ui-cluster' },
        worktree.needsYou ? h(Badge, { tone: 'needs-you', label: 'Needs attention' }, '2') : null,
        h('span', { className: 'ui-cluster worktree-reveal' },
          worktree.primary ? h(Badge, null, 'Primary') : null,
          h(IconButton, {
            className: 'worktree-menu',
            label: 'Actions for ' + worktree.name,
            'aria-haspopup': 'menu'
          }, '⋯')
        )
      )
    }))
    const worktreeRows = [
      { id: 'primary', name: 'main', primary: true, compact: false },
      { id: 'ordinary', name: 'feature-qa-new-features-3', primary: false, compact: false, needsYou: true },
      { id: 'primary-needs-you', name: 'main-needs-you', primary: true, compact: false, needsYou: true },
      { id: 'compact-primary', name: 'compact-main', primary: true, compact: true },
      ...(boardRegressionEnabled ? Array.from({ length: 20 }, (_, index) => ({
        id: 'tree-worktree-' + index,
        name: 'tree-workspace-' + index,
        primary: false,
        compact: false
      })) : [])
    ]
    const worktreeList = h('ul', { className: 'worktree-list ui-tree' }, worktreeRows.map(makeWorktreeRow))
    const boardStatuses = [
      { id: 'todo', label: 'To do' },
      { id: 'in-progress', label: 'In progress' },
      { id: 'in-review', label: 'In review' },
      { id: 'done', label: 'Done' }
    ]
    const boardWorktrees = [
      ...Array.from({ length: 16 }, (_, index) => ({
        id: 'board-progress-' + index,
        repoId: 'r1',
        name: 'Progress ' + index,
        status: 'in-progress'
      })),
      { id: 'board-done', repoId: 'r2', name: 'Completed card', status: 'done' }
    ]
    function BoardRegressionFixture() {
      const [worktrees, setWorktrees] = useState(boardWorktrees)
      return h('div', { className: 'worktree-tree-board-scroll ui-scroll', 'data-board-scroll': '' },
        h(WorktreeBoard, {
          worktrees,
          statuses: boardStatuses,
          repos: [
            { id: 'r1', name: projectName, displayName: null },
            { id: 'r2', name: 'OtherProject', displayName: null }
          ],
          open() {},
          setStatus(worktree, status) {
            setWorktrees((current) => current.map((item) => item.id === worktree.id ? { ...item, status } : item))
          }
        })
      )
    }
    const tabs = h(Tabs, {
      label: 'Worktree views',
      items: [{ id: 'tree', label: 'Tree' }],
      value: 'tree',
      onChange() {}
    })
    const panelContent = h('div', {
      className: boardRegressionEnabled ? 'ui-stack ui-panel-content worktree-tree-section' : 'ui-stack ui-panel-content'
    },
      boardRegressionEnabled ? h(BoardRegressionFixture) : null,
      h('div', { className: 'ui-scroll ui-grow', 'data-tree-scroll': '' },
        h('div', { className: 'worktree-tree ui-stack' },
          tree,
          worktreeList
        )
      )
    )
    const panelSlot = boardRegressionEnabled
      ? h('div', { className: 'plugin-slot' },
        h('div', { className: 'plugin-slot-body' }, panelContent))
      : panelContent
    const worktreeFrame = h(ToolPanelFrame, {
      title: 'Worktrees',
      tabs,
      actions: h('div', { className: 'ui-cluster' },
        h(ExpandingIconButton, { label: 'New worktree', title: 'New worktree' }, '+'),
        h(IconButton, { label: 'Filter worktrees', title: 'Filter worktrees' }, '⌕')
      ),
      onMinimize() {}
    }, panelSlot)
    const changesFrame = h(ToolPanelFrame, {
      title: 'Changes',
      actions: h('div', { className: 'ui-cluster' },
        h(IconButton, { label: 'Stage changes', title: 'Stage changes' }, '+'),
        h(IconButton, { label: 'Commit changes', title: 'Commit changes' }, '✓')
      ),
      onMinimize() {}
    }, h('div', null, 'Workspace changes'))
    const layout = h('div', { id: 'layout', style: { '--sidebar-width': '116px' } },
      h('div', { className: 'gutter' }),
      h('aside', { className: 'panel', id: 'worktrees-panel' }, worktreeFrame),
      h('main', { id: 'center' }),
      h('aside', { className: 'panel', id: 'changes-panel' }, changesFrame),
      h('div', { className: 'gutter' })
    )

    createRoot(document.getElementById('root')).render(
      document.documentElement.dataset.activityFiltersRegression === 'true'
        ? h(ActivityFiltersRegressionFixture)
        : layout
    )
  `
}

function panelHeaderRegressionBrowserEntry(): string {
  const uiModule = join(ROOT, 'packages/ui/src/design-system/index.ts')
  return `
    import { createElement as h, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ExpandingIconButton, IconButton, Tabs, ToolPanelFrame } from ${JSON.stringify(uiModule)}

    function PanelHeaderRegressionFixtures() {
      const [selectedVaultTab, setSelectedVaultTab] = useState('workspace')
      const [createdWorktrees, setCreatedWorktrees] = useState(0)
      const [worktreeFilterRequests, setWorktreeFilterRequests] = useState(0)
      const [worktreeMinimizeRequests, setWorktreeMinimizeRequests] = useState(0)
      const [filesMinimizeRequests, setFilesMinimizeRequests] = useState(0)
      const vaultTabs = h(Tabs, {
        label: 'Vault views',
        items: [
          { id: 'workspace', label: 'Workspace' },
          { id: 'project', label: 'Project' },
          { id: 'all', label: 'All' }
        ],
        value: selectedVaultTab,
        onChange: setSelectedVaultTab
      })
      return h('div', { id: 'panel-header-regression-fixtures' },
        h('div', { id: 'worktrees-frame-host', className: 'panel-header-regression-frame', 'data-tool-panel': '' },
          h(ToolPanelFrame, {
            title: 'Worktrees',
            actions: h('div', { className: 'ui-cluster' },
              h(ExpandingIconButton, {
                label: 'New worktree',
                title: 'New worktree',
                onClick: () => setCreatedWorktrees((count) => count + 1)
              }, '+'),
              h(IconButton, {
                label: 'Filter worktrees',
                title: 'Filter worktrees',
                onClick: () => setWorktreeFilterRequests((count) => count + 1)
              }, '⌕')
            ),
            onMinimize: () => setWorktreeMinimizeRequests((count) => count + 1)
          }, h('div', null,
            h('p', null, 'Worktrees created: ', h('output', { 'data-action-counter': 'worktrees-created' }, String(createdWorktrees))),
            h('p', null, 'Filter requests: ', h('output', { 'data-action-counter': 'worktrees-filter' }, String(worktreeFilterRequests))),
            h('p', null, 'Minimize requests: ', h('output', { 'data-action-counter': 'worktrees-minimize' }, String(worktreeMinimizeRequests)))
          ))
        ),
        h('div', { id: 'files-frame-host', className: 'panel-header-regression-frame', 'data-tool-panel': '' },
          h(ToolPanelFrame, {
            title: 'Files',
            onMinimize: () => setFilesMinimizeRequests((count) => count + 1)
          }, h('p', null, 'Minimize requests: ', h('output', { 'data-action-counter': 'files-minimize' }, String(filesMinimizeRequests))))
        ),
        h('div', { id: 'remote-frame-host', className: 'panel-header-regression-frame' },
          h(ToolPanelFrame, {
            title: 'Remote workspaces',
            actions: h('div', { className: 'ui-cluster' },
              h(IconButton, { label: 'Remote workspaces settings', title: 'Remote workspaces settings' }, '⚙'),
              h(IconButton, { label: 'Refresh Remote workspaces', title: 'Refresh Remote workspaces' }, '↻')
            ),
            onMinimize() {}
          }, h('div', null, 'Remote workspace list'))
        ),
        h('div', { id: 'vault-frame-host', className: 'panel-header-regression-frame' },
          h(ToolPanelFrame, {
            title: 'Vault',
            tabs: vaultTabs,
            tools: h('div', { className: 'ui-cluster' },
              h(IconButton, { label: 'Vault settings', title: 'Vault settings' }, '⚙'),
              h(IconButton, { label: 'Refresh Vault', title: 'Refresh Vault' }, '↻')
            ),
            onMinimize() {}
          }, h('div', null, 'Vault files'))
        ),
        h('div', { id: 'add-project-frame-host', className: 'panel-header-regression-frame' },
          h(ToolPanelFrame, {
            title: 'Worktrees',
            actions: h('div', { className: 'ui-cluster' },
              h(ExpandingIconButton, { label: 'Add project', title: 'Add project' }, '+'),
              h(IconButton, { label: 'Filter worktrees', title: 'Filter worktrees' }, '⌕')
            ),
            onMinimize() {}
          }, h('div', null, 'Worktree list'))
        )
      )
    }

    createRoot(document.getElementById('root')).render(h(PanelHeaderRegressionFixtures))
  `
}

function pageMarkup(): string {
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body, #root { height: 100%; margin: 0; }
          body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
          #layout { display: grid; grid-template-columns: ${GUTTER}px var(--worktree-sidebar-width, var(--sidebar-width)) minmax(0, 1fr) var(--sidebar-width) ${GUTTER}px; height: 100%; min-width: 0; }
          .panel { height: 100%; min-width: 0; }
          #worktrees-panel:has(.plugin-slot) { min-height: 0; }
          .ui-tool-panel-frame { height: 100%; min-width: 0; }
          #worktrees-panel .ui-tool-panel-frame__body:has(.plugin-slot) { display: flex; min-height: 0; }
          .plugin-slot { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; min-width: 0; overflow: auto; }
          .plugin-slot-body { display: block; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; width: 100%; }
          #center { min-width: 0; }
        </style>
      </head>
      <body><div id="root"></div></body>
    </html>`
}

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const tempDir = mkdtempSync(join(tmpdir(), 'quirky-worktree-narrow-sidebar-'))
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
    if (!output) throw new Error('The worktree narrow-sidebar browser bundle was empty.')
    browserBundle = await output.text()

    const panelRegressionEntrypoint = join(tempDir, 'panel-header-regression-entry.ts')
    writeFileSync(panelRegressionEntrypoint, panelHeaderRegressionBrowserEntry())
    const panelRegressionResult = await Bun.build({
      entrypoints: [panelRegressionEntrypoint],
      target: 'browser',
      format: 'iife',
      plugins: [browserDependencyResolver],
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!panelRegressionResult.success) throw new Error(panelRegressionResult.logs.map((log) => log.message).join('\n'))
    const panelRegressionOutput = panelRegressionResult.outputs[0]
    if (!panelRegressionOutput) throw new Error('The panel-header regression browser bundle was empty.')
    panelHeaderRegressionBundle = await panelRegressionOutput.text()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  browser = await chromium.launch({
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps tool and project headers readable in two narrow side panels', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    await page.getByRole('heading', { name: 'Worktrees', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Tree', exact: true }).waitFor()
    await page.getByRole('heading', { name: /QuirkyWorktreeProject/ }).waitFor()
    await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor()

    const metrics = async () => page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const frame = document.querySelector('#worktrees-panel .ui-tool-panel-frame')!
      const toolTitle = frame.querySelector('.ui-tool-panel-frame__title')!
      const toolActions = frame.querySelector('.ui-tool-panel-frame__actions')!
      const tab = frame.querySelector('[role="tab"]')!
      const projectHeader = frame.querySelector('.project-header')!
      const firstWorktreeRow = frame.querySelector('[data-worktree-id="primary"] .ui-list-row')!
      const firstWorktreeName = firstWorktreeRow.querySelector('.worktree-name')!
      const changesFrame = document.querySelector('#changes-panel .ui-tool-panel-frame')!
      const changesTitle = changesFrame.querySelector('.ui-tool-panel-frame__title')!
      const changesActions = changesFrame.querySelector('.ui-tool-panel-frame__actions')!
      const changesLeadingRange = document.createRange()
      changesLeadingRange.selectNodeContents(changesTitle)
      changesLeadingRange.setEnd(changesTitle.firstChild!, 1)
      const changesWordRange = document.createRange()
      changesWordRange.selectNodeContents(changesTitle)
      const changesLeading = changesLeadingRange.getBoundingClientRect()
      const changesWord = changesWordRange.getBoundingClientRect()
      const projectTitle = projectHeader.querySelector('.ui-section-header__title')!
      const projectTile = projectTitle.querySelector('.ui-project-tile')!
      const projectName = projectTitle.querySelector<HTMLElement>('.project-name')!
      const projectActions = projectHeader.querySelector('.ui-section-header__actions')!
      const projectReveal = projectActions.querySelector('.project-reveal')!
      const projectCount = projectTitle.querySelector('.project-count')!
      const projectNameRange = document.createRange()
      projectNameRange.selectNodeContents(projectName)
      projectNameRange.setEnd(projectName.firstChild!, 1)
      const toolLeadingRange = document.createRange()
      toolLeadingRange.selectNodeContents(toolTitle)
      toolLeadingRange.setEnd(toolTitle.firstChild!, 1)
      const toolLeading = toolLeadingRange.getBoundingClientRect()
      const projectLeading = projectNameRange.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        worktreesPanel: box(document.querySelector('#worktrees-panel')!),
        changesPanel: box(document.querySelector('#changes-panel')!),
        changesFrame: box(changesFrame),
        changesTitle: box(changesTitle),
        changesLeading: { left: changesLeading.left, right: changesLeading.right, width: changesLeading.width },
        changesWord: { left: changesWord.left, right: changesWord.right, width: changesWord.width },
        changesActions: box(changesActions),
        changesButtons: [...changesActions.querySelectorAll('button')].map(box),
        frame: box(frame),
        toolTitle: box(toolTitle),
        toolLeading: { left: toolLeading.left, right: toolLeading.right, width: toolLeading.width },
        toolActions: box(toolActions),
        tab: box(tab),
        projectHeader: box(projectHeader),
        projectTitle: box(projectTitle),
        projectTile: box(projectTile),
        projectLeading: { left: projectLeading.left, right: projectLeading.right, width: projectLeading.width },
        projectName: box(projectName),
        projectNameOverflow: projectName.scrollWidth > projectName.clientWidth,
        projectNameTextOverflow: getComputedStyle(projectName).textOverflow,
        projectRevealOpacity: getComputedStyle(projectReveal).opacity,
        projectActions: box(projectActions),
        projectButtons: [...projectActions.querySelectorAll('button')].map(box),
        firstWorktreeRow: box(firstWorktreeRow),
        firstWorktreeName: box(firstWorktreeName),
        projectCount: box(projectCount),
        expandingLabelDisplay: getComputedStyle(frame.querySelector('.ui-expanding-icon-button__label')!).display,
      }
    })
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const expectContained = (
      inner: { left: number; top: number; right: number; bottom: number },
      outer: { left: number; top: number; right: number; bottom: number }
    ) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }
    const expectSameBounds = (
      actual: { left: number; top: number; right: number; bottom: number },
      expected: { left: number; top: number; right: number; bottom: number }
    ) => {
      for (const coordinate of ['left', 'top', 'right', 'bottom'] as const) {
        expect(actual[coordinate]).toBeCloseTo(expected[coordinate], 0)
      }
    }

    let wideProjectHeaderHeight: number | null = null
    for (const sidebarWidth of [240, 116, 160, 200]) {
      const viewportWidth = GUTTER * 2 + CENTER_WIDTH + sidebarWidth * 2
      await page.setViewportSize({ width: viewportWidth, height: HEIGHT })
      await page.locator('#layout').evaluate((element, width) => {
        ;(element as HTMLElement).style.setProperty('--sidebar-width', `${width}px`)
      }, sidebarWidth)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const layout = await metrics()
      if (sidebarWidth === 240) wideProjectHeaderHeight = layout.projectHeader.height
      if (sidebarWidth === 160) {
        expect(wideProjectHeaderHeight).not.toBeNull()
        expect(layout.projectHeader.height).toBeCloseTo(wideProjectHeaderHeight!, 0)
      }
      expect(layout.viewportWidth).toBe(viewportWidth)
      expect(layout.worktreesPanel.left).toBeCloseTo(GUTTER, 0)
      expect(layout.worktreesPanel.width).toBeCloseTo(sidebarWidth, 0)
      expect(layout.changesPanel.width).toBeCloseTo(sidebarWidth, 0)
      expect(layout.changesFrame.width).toBeCloseTo(sidebarWidth, 0)
      expectContained(layout.changesTitle, layout.changesFrame)
      expect(layout.changesLeading.width).toBeGreaterThan(0)
      expect(layout.changesLeading.left).toBeGreaterThanOrEqual(layout.changesFrame.left - 0.5)
      expect(layout.changesLeading.right).toBeLessThanOrEqual(layout.changesTitle.right + 0.5)
      expect(layout.changesWord.left).toBeGreaterThanOrEqual(layout.changesTitle.left - 0.5)
      expect(layout.changesWord.right).toBeLessThanOrEqual(layout.changesTitle.right + 0.5)
      expectContained(layout.changesActions, layout.changesFrame)
      for (const button of layout.changesButtons) expectContained(button, layout.changesFrame)
      expect(overlaps(layout.changesTitle, layout.changesActions)).toBe(false)
      expectContained(layout.toolTitle, layout.frame)
      expect(layout.toolLeading.width).toBeGreaterThan(0)
      expect(layout.toolLeading.left).toBeGreaterThanOrEqual(layout.frame.left - 0.5)
      expect(layout.toolLeading.right).toBeLessThanOrEqual(layout.toolTitle.right + 0.5)
      expectContained(layout.toolActions, layout.frame)
      expectContained(layout.tab, layout.frame)
      expect(overlaps(layout.toolTitle, layout.toolActions)).toBe(false)
      expectContained(layout.projectHeader, layout.frame)
      expectContained(layout.projectTitle, layout.projectHeader)
      expectContained(layout.projectName, layout.projectTitle)
      expectContained(layout.projectTile, layout.projectTitle)
      expect(layout.projectTitle.right - layout.projectTile.right).toBeGreaterThan(1)
      expect(layout.projectLeading.width).toBeGreaterThan(0)
      expect(layout.projectLeading.left).toBeGreaterThanOrEqual(layout.projectTile.right - 0.5)
      expect(layout.projectLeading.right).toBeLessThanOrEqual(layout.projectTitle.right + 0.5)
      expect(layout.projectNameTextOverflow).toBe('ellipsis')
      expectContained(layout.projectActions, layout.projectHeader)
      expectContained(layout.projectCount, layout.projectHeader)
      expectContained(layout.projectCount, layout.projectTitle)
      expect(Math.abs(
        layout.projectCount.top + layout.projectCount.height / 2 -
        (layout.projectName.top + layout.projectName.height / 2)
      )).toBeLessThanOrEqual(3)
      if (sidebarWidth <= 160) expect(layout.projectNameOverflow).toBe(true)
      for (const button of layout.projectButtons) expectContained(button, layout.projectHeader)
      if (sidebarWidth <= 160) expect(layout.expandingLabelDisplay).toBe('none')
      else expect(layout.expandingLabelDisplay).not.toBe('none')

      if (sidebarWidth <= 220) {
        expect(layout.toolActions.top).toBeGreaterThan(layout.toolTitle.bottom)
        expect(layout.projectTitle.top).toBeLessThan(layout.projectActions.bottom)
        expect(layout.projectActions.top).toBeLessThan(layout.projectTitle.bottom)
        expect(layout.changesActions.top).toBeGreaterThan(layout.changesTitle.bottom)
      } else {
        expect(layout.toolTitle.top).toBeLessThan(layout.toolActions.bottom)
        expect(layout.toolActions.top).toBeLessThan(layout.toolTitle.bottom)
        expect(layout.projectTitle.top).toBeLessThan(layout.projectActions.bottom)
        expect(layout.projectActions.top).toBeLessThan(layout.projectTitle.bottom)
        expect(layout.changesTitle.top).toBeLessThan(layout.changesActions.bottom)
        expect(layout.changesActions.top).toBeLessThan(layout.changesTitle.bottom)
      }

      if (sidebarWidth === 116 || sidebarWidth === 160) {
        expect(layout.projectRevealOpacity).toBe('0')
        const projectHeader = page.locator('.project-header')
        await projectHeader.hover()
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.project-header .project-reveal')!).opacity === '1')
        const hoveredLayout = await metrics()
        expectSameBounds(hoveredLayout.projectHeader, layout.projectHeader)
        expectSameBounds(hoveredLayout.firstWorktreeRow, layout.firstWorktreeRow)
        expectSameBounds(hoveredLayout.firstWorktreeName, layout.firstWorktreeName)
        expectSameBounds(hoveredLayout.projectCount, layout.projectCount)
        expectSameBounds(hoveredLayout.projectTitle, layout.projectTitle)
        expectSameBounds(hoveredLayout.projectName, layout.projectName)
        const revealedActions = await projectHeader.locator('.ui-section-header__actions').boundingBox()
        expect(revealedActions).not.toBeNull()
        expect(revealedActions!.x).toBeCloseTo(layout.projectActions.left, 0)
        expect(revealedActions!.y).toBeCloseTo(layout.projectActions.top, 0)
        await page.mouse.move(0, 0)
        const projectAction = page.getByRole('button', { name: 'New worktree in QuirkyWorktreeProject', exact: true })
        await projectAction.focus()
        expect(await projectAction.evaluate((element) => document.activeElement === element)).toBe(true)
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.project-header:focus-within .project-reveal')!).opacity === '1')
        const focusedLayout = await metrics()
        expectSameBounds(focusedLayout.projectHeader, layout.projectHeader)
        expectSameBounds(focusedLayout.firstWorktreeRow, layout.firstWorktreeRow)
        expectSameBounds(focusedLayout.firstWorktreeName, layout.firstWorktreeName)
        if (sidebarWidth === 160) {
          expect(layout.projectButtons).toHaveLength(2)
          const projectHeaderButtons = projectHeader.locator('.repo-actions button')
          expect(await projectHeaderButtons.count()).toBe(layout.projectButtons.length)
          for (let index = 0; index < layout.projectButtons.length; index++) {
            expect(await projectHeaderButtons.nth(index).isEnabled()).toBe(true)
          }

          await projectAction.click()
          const actionResult = page.locator('#project-action-result')
          await actionResult.waitFor({ state: 'visible' })
          expect(await actionResult.textContent()).toBe('Opened create dialog for r1')

          const projectMenuButton = page.getByRole('button', { name: 'Actions for QuirkyWorktreeProject', exact: true })
          await projectMenuButton.click()
          const projectMenu = page.getByRole('menu', { name: 'Actions for QuirkyWorktreeProject', exact: true })
          await projectMenu.waitFor({ state: 'visible' })
          await page.keyboard.press('Escape')
        }
        expectSameBounds(focusedLayout.projectTitle, layout.projectTitle)
        expectSameBounds(focusedLayout.projectName, layout.projectName)
        expectSameBounds(focusedLayout.projectCount, layout.projectCount)
      }

      if (sidebarWidth === 200) {
        const addButton = page.locator('#worktrees-panel .ui-expanding-icon-button')
        const compact = await addButton.boundingBox()
        expect(compact).not.toBeNull()
        await addButton.hover()
        await page.waitForTimeout(160)
        const hovered = await addButton.boundingBox()
        expect(hovered).not.toBeNull()
        expect(hovered!.width).toBeGreaterThan(compact!.width)
        expect(hovered!.x + hovered!.width).toBeCloseTo(compact!.x + compact!.width, 0)
        const hoveredLayout = await metrics()
        expectContained({ left: hovered!.x, top: hovered!.y, right: hovered!.x + hovered!.width, bottom: hovered!.y + hovered!.height }, hoveredLayout.frame)
        expect(overlaps(hoveredLayout.toolTitle, hoveredLayout.toolActions)).toBe(false)
        await page.mouse.move(0, 0)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.locator('#worktrees-panel [role="tab"]').focus()
        await page.keyboard.press('Tab')
        expect(await addButton.evaluate((element) => document.activeElement === element && element.matches(':focus-visible'))).toBe(true)
        await page.waitForTimeout(160)
        const focused = await addButton.boundingBox()
        expect(focused).not.toBeNull()
        expect(focused!.width).toBeGreaterThan(compact!.width)
        expect(focused!.x + focused!.width).toBeCloseTo(compact!.x + compact!.width, 0)
        const focusedLayout = await metrics()
        expect(overlaps(focusedLayout.toolTitle, focusedLayout.toolActions)).toBe(false)
        expectContained({ left: focused!.x, top: focused!.y, right: focused!.x + focused!.width, bottom: focused!.y + focused!.height }, focusedLayout.frame)
      }

      if (sidebarWidth === 240) {
        const addButton = page.locator('#worktrees-panel .ui-expanding-icon-button')
        const compact = await addButton.boundingBox()
        expect(compact).not.toBeNull()
        await addButton.hover()
        await page.waitForTimeout(160)
        const hovered = await addButton.boundingBox()
        expect(hovered).not.toBeNull()
        expect(hovered!.width).toBeGreaterThan(compact!.width)
        expect(hovered!.x + hovered!.width).toBeCloseTo(compact!.x + compact!.width, 0)
        const hoveredLayout = await metrics()
        expectContained({ left: hovered!.x, top: hovered!.y, right: hovered!.x + hovered!.width, bottom: hovered!.y + hovered!.height }, hoveredLayout.frame)
        expect(overlaps(hoveredLayout.toolTitle, hoveredLayout.toolActions)).toBe(false)
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps tracker project badges readable on a separate row in a narrow sidebar', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.evaluate(() => {
      document.documentElement.dataset.trackerProject = 'true'
    })
    await page.addScriptTag({ content: browserBundle })
    await page.getByText('QA-16', { exact: true }).waitFor()
    await page.setViewportSize({ width: GUTTER * 2 + CENTER_WIDTH + 160 * 2, height: HEIGHT })
    await page.locator('#layout').evaluate((element) => {
      ;(element as HTMLElement).style.setProperty('--sidebar-width', '160px')
      ;(element as HTMLElement).style.setProperty('--worktree-sidebar-width', '160px')
    })

    const trackerBadge = await page.locator('.project-header').evaluate((header) => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const title = header.querySelector<HTMLElement>('.ui-section-header__title')!
      const badge = header.querySelector<HTMLElement>('.repo-actions > .ui-badge')!
      const textRange = document.createRange()
      textRange.selectNodeContents(badge)
      return {
        header: box(header),
        title: box(title),
        badge: box(badge),
        text: badge.textContent?.trim(),
        textWidth: textRange.getBoundingClientRect().width,
        textClipped: badge.scrollWidth > badge.clientWidth
      }
    })
    const expectContained = (
      inner: { left: number; top: number; right: number; bottom: number },
      outer: { left: number; top: number; right: number; bottom: number }
    ) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }

    expect(await page.getByText('QA-16', { exact: true }).isVisible()).toBe(true)
    expect(trackerBadge.badge.height).toBeGreaterThan(0)
    expect(trackerBadge.text).toBe('QA-16')
    expect(trackerBadge.textWidth).toBeGreaterThan(0)
    expect(trackerBadge.textClipped).toBe(false)
    expect(trackerBadge.badge.top).toBeGreaterThanOrEqual(trackerBadge.title.bottom - 0.5)
    expectContained(trackerBadge.badge, trackerBadge.header)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps Tree project headers hidden outside project grouping in a 160px sidebar', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  try {
    for (const groupBy of ['status', 'pr', 'none'] as const) {
      const page = await context.newPage()
      await page.setContent(pageMarkup())
      for (const stylesheet of STYLESHEETS) {
        await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
      }
      await page.evaluate((value) => {
        document.documentElement.dataset.groupBy = value
      }, groupBy)
      await page.addScriptTag({ content: browserBundle })
      await page.getByRole('tab', { name: 'Tree', exact: true }).waitFor()
      await page.setViewportSize({ width: GUTTER * 2 + CENTER_WIDTH + 160 * 2, height: HEIGHT })
      await page.locator('#layout').evaluate((element) => {
        ;(element as HTMLElement).style.setProperty('--sidebar-width', '160px')
        ;(element as HTMLElement).style.setProperty('--worktree-sidebar-width', '160px')
      })

      const panel = page.locator('#worktrees-panel')
      expect(await panel.evaluate((element) => element.getBoundingClientRect().width)).toBe(160)
      const projectHeader = panel.locator('.project-header')
      expect(await projectHeader.count()).toBe(1)
      expect(await projectHeader.isVisible()).toBe(false)
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps worktree rows compact and their menus usable in a narrow sidebar', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    await page.getByRole('button', { name: 'Actions for main', exact: true }).waitFor()
    await page.locator('#layout').evaluate((element) => {
      ;(element as HTMLElement).style.setProperty('--sidebar-width', '280px')
      ;(element as HTMLElement).style.setProperty('--worktree-sidebar-width', '240px')
    })

    const measure = async () => page.evaluate(() => {
      const bounds = (element: { getBoundingClientRect(): DOMRect }) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height }
      }
      const panel = document.querySelector('#worktrees-panel')!
      return {
        viewportWidth: window.innerWidth,
        panelWidth: panel.getBoundingClientRect().width,
        rows: [...panel.querySelectorAll<HTMLElement>('.worktree-tree .worktree')].map((item) => {
          const row = item.querySelector<HTMLElement>('.ui-list-row')!
          const main = row.querySelector<HTMLElement>('.ui-list-row__main')!
          const title = row.querySelector<HTMLElement>('.worktree-name')!
          const firstCharacter = document.createRange()
          firstCharacter.setStart(title.firstChild!, 0)
          firstCharacter.setEnd(title.firstChild!, 1)
          const firstCharacterRect = firstCharacter.getBoundingClientRect()
          const titleTarget = document.elementFromPoint(
            firstCharacterRect.left + firstCharacterRect.width / 2,
            firstCharacterRect.top + firstCharacterRect.height / 2
          )
          const description = row.querySelector<HTMLElement>('.ui-list-row__description .ui-text-ellipsis')!
          const descriptionText = document.createRange()
          descriptionText.selectNodeContents(description)
          const menu = row.querySelector<HTMLButtonElement>('.worktree-menu')!
          const attention = row.querySelector<HTMLElement>('.ui-badge--needs-you')
          return {
            id: item.dataset.worktreeId,
            itemHeight: item.getBoundingClientRect().height,
            row: bounds(row),
            titleVisible: firstCharacterRect.width > 0 && titleTarget !== null && main.contains(titleTarget),
            descriptionLines: new Set(Array.from(descriptionText.getClientRects(), (rect) => Math.round(rect.top))).size,
            descriptionTruncated: description.scrollWidth > description.clientWidth,
            attention: attention ? bounds(attention) : null,
            menu: bounds(menu)
          }
        })
      }
    })
    const expectContained = (
      inner: { left: number; top: number; right: number; bottom: number },
      outer: { left: number; top: number; right: number; bottom: number }
    ) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }
    function rowFor<T extends { id?: string }>(rows: T[], id: string): T {
      return rows.find((row) => row.id === id)!
    }
    const rowsToTest = [
      { id: 'primary', name: 'main' },
      { id: 'ordinary', name: 'feature-qa-new-features-3' },
      { id: 'primary-needs-you', name: 'main-needs-you' },
      { id: 'compact-primary', name: 'compact-main' }
    ]

    await page.mouse.move(0, 0)
    const wide = await measure()
    expect(wide.viewportWidth).toBe(646)
    expect(wide.panelWidth).toBeCloseTo(240, 0)
    for (const { id } of rowsToTest) {
      const row = rowFor(wide.rows, id)
      expect(row.titleVisible).toBe(true)
      expect(row.descriptionLines).toBe(1)
      expect(row.descriptionTruncated).toBe(true)
      expect(row.itemHeight).toBeCloseTo(row.row.height, 0)
      if (id === 'ordinary' || id === 'primary-needs-you') {
        expect(row.attention?.height).toBeGreaterThan(0)
        expectContained(row.attention!, row.row)
      }
      expectContained(row.menu, row.row)
    }

    for (const sidebarWidth of [160, 116, 84]) {
      await page.locator('#layout').evaluate((element, width) => {
        ;(element as HTMLElement).style.setProperty('--worktree-sidebar-width', `${width}px`)
      }, sidebarWidth)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.move(0, 0)
      const narrow = await measure()
      expect(narrow.viewportWidth).toBe(646)
      expect(narrow.panelWidth).toBeCloseTo(sidebarWidth, 0)

      for (const { id, name } of rowsToTest) {
        const wideRow = rowFor(wide.rows, id)
        const row = rowFor(narrow.rows, id)
        expect(row.row.height).toBeCloseTo(wideRow.row.height, 0)
        expect(row.itemHeight).toBeCloseTo(row.row.height, 0)
        expect(row.titleVisible).toBe(true)
        expect(row.descriptionLines).toBe(1)
        expect(row.descriptionTruncated).toBe(true)
        if (id === 'ordinary' || id === 'primary-needs-you') {
          expect(row.attention?.height).toBeGreaterThan(0)
          expectContained(row.attention!, row.row)
        }

        const menu = page.getByRole('button', { name: `Actions for ${name}`, exact: true })
        expect(await menu.getAttribute('aria-haspopup')).toBe('menu')
        expect(await menu.isEnabled()).toBe(true)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.locator(`[data-worktree-id="${id}"]`).hover()
        await menu.hover()
        const hoveredRow = rowFor((await measure()).rows, id)
        expect(hoveredRow.row.height).toBeCloseTo(wideRow.row.height, 0)
        expectContained(hoveredRow.menu, hoveredRow.row)
        if ((sidebarWidth === 160 || sidebarWidth === 116) && (id === 'primary' || id === 'primary-needs-you')) expect(hoveredRow.titleVisible).toBe(true)
        if (id === 'ordinary' || id === 'primary-needs-you') {
          expect(hoveredRow.attention?.height).toBeGreaterThan(0)
          expectContained(hoveredRow.attention!, hoveredRow.row)
        }

        await page.mouse.move(0, 0)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.getByRole('button', { name: `Open ${name}`, exact: true }).focus()
        await page.keyboard.press('Tab')
        expect(await menu.evaluate((element) => document.activeElement === element)).toBe(true)
        expect(await menu.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
        const focusRingVisible = await menu.evaluate((element) => {
          const outline = getComputedStyle(element)
          const outlineWidth = Number.parseFloat(outline.outlineWidth)
          const outlineExtent = Math.max(0, outlineWidth + Number.parseFloat(outline.outlineOffset))
          if (outline.outlineStyle === 'none' || outlineWidth === 0) return 'missing focus outline'
          const rect = element.getBoundingClientRect()
          const ring = {
            left: rect.left - outlineExtent,
            top: rect.top - outlineExtent,
            right: rect.right + outlineExtent,
            bottom: rect.bottom + outlineExtent
          }
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor)
            const bounds = ancestor.getBoundingClientRect()
            const clipLeft = bounds.left + ancestor.clientLeft
            const clipTop = bounds.top + ancestor.clientTop
            const clipRight = clipLeft + ancestor.clientWidth
            const clipBottom = clipTop + ancestor.clientHeight
            if (style.overflowX !== 'visible' && (ring.left < clipLeft - 0.5 || ring.right > clipRight + 0.5)) return `${ancestor.className}: horizontal clip`
            if (style.overflowY !== 'visible' && (ring.top < clipTop - 0.5 || ring.bottom > clipBottom + 0.5)) return `${ancestor.className}: vertical clip`
          }
          return null
        })
        expect(focusRingVisible).toBeNull()
        const focusedRow = rowFor((await measure()).rows, id)
        expect(focusedRow.row.height).toBeCloseTo(wideRow.row.height, 0)
        expectContained(focusedRow.menu, focusedRow.row)
        if ((sidebarWidth === 160 || sidebarWidth === 116) && (id === 'primary' || id === 'primary-needs-you')) expect(focusedRow.titleVisible).toBe(true)
        if (id === 'ordinary' || id === 'primary-needs-you') {
          expect(focusedRow.attention?.height).toBeGreaterThan(0)
          expectContained(focusedRow.attention!, focusedRow.row)
        }
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps host panel headers compact and actions usable without tabs at narrow widths', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addStyleTag({
      content: `
        #panel-header-regression-fixtures { display: flex; gap: 16px; }
        .panel-header-regression-frame { height: 360px; min-width: 0; width: 116px; }
        #remote-frame-host, #vault-frame-host, #add-project-frame-host { display: none; }
      `
    })
    await page.addScriptTag({ content: panelHeaderRegressionBundle })
    await page.locator('#worktrees-frame-host .ui-tool-panel-frame').waitFor()
    await page.locator('#files-frame-host .ui-tool-panel-frame').waitFor()

    type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
    type PanelMetrics = { header: Rect; body: Rect; actionsOpacity: string; buttons: Rect[] }
    const hostIds = ['worktrees-frame-host', 'files-frame-host']
    const measure = async (hostId: string): Promise<PanelMetrics> => page.locator(`#${hostId}`).evaluate((host) => {
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const frame = host.querySelector('.ui-tool-panel-frame')!
      const header = frame.querySelector('.ui-tool-panel-frame__header')!
      const actions = header.querySelector('.ui-tool-panel-frame__actions')!
      return {
        header: bounds(header),
        body: bounds(frame.querySelector('.ui-tool-panel-frame__body')!),
        actionsOpacity: getComputedStyle(actions).opacity,
        buttons: [...actions.querySelectorAll('button')].map(bounds)
      }
    })
    const expectContained = (inner: Rect, outer: Rect) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }
    const expectStableHeader = (current: PanelMetrics, resting: PanelMetrics) => {
      expect(current.header.height).toBeCloseTo(resting.header.height, 0)
      expect(current.body.top).toBeCloseTo(resting.body.top, 0)
    }
    const setWidth = async (width: number) => {
      for (const hostId of hostIds) {
        await page.locator(`#${hostId}`).evaluate((host, nextWidth) => {
          ;(host as HTMLElement).style.width = `${nextWidth}px`
        }, width)
      }
    }
    const counters: Record<string, string[]> = {
      'worktrees-frame-host': ['worktrees-created', 'worktrees-filter', 'worktrees-minimize'],
      'files-frame-host': ['files-minimize']
    }
    const wide: Record<string, PanelMetrics> = {}
    await setWidth(240)
    await page.mouse.move(1, HEIGHT - 1)
    for (const hostId of hostIds) wide[hostId] = await measure(hostId)

    await setWidth(160)
    await page.mouse.move(1, HEIGHT - 1)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const resting: Record<string, PanelMetrics> = {}
    for (const hostId of hostIds) {
      resting[hostId] = await measure(hostId)
      expect(resting[hostId].actionsOpacity).toBe('0')
      expect(resting[hostId].buttons.length).toBe(counters[hostId].length)
      expectStableHeader(resting[hostId], wide[hostId])
    }

    for (const hostId of hostIds) {
      await page.locator(`#${hostId}`).hover()
      await page.waitForFunction((id) =>
        getComputedStyle(document.querySelector(`#${id} .ui-tool-panel-frame__actions`)!).opacity === '1', hostId)
      let hovered = await measure(hostId)
      expect(hovered.actionsOpacity).toBe('1')
      expectStableHeader(hovered, resting[hostId])
      for (const button of hovered.buttons) expectContained(button, hovered.header)

      const buttons = page.locator(`#${hostId} .ui-tool-panel-frame__actions button`)
      for (let index = 0; index < counters[hostId].length; index++) {
        const action = hostId === 'worktrees-frame-host' && index === 0
          ? page.locator('#worktrees-frame-host .ui-expanding-icon-button')
          : buttons.nth(index)
        await action.hover()
        hovered = await measure(hostId)
        expectStableHeader(hovered, resting[hostId])
        for (const button of hovered.buttons) expectContained(button, hovered.header)

        const counter = page.locator(`#${hostId} [data-action-counter="${counters[hostId][index]}"]`)
        const previousCount = Number(await counter.textContent())
        await action.click()
        expect(Number(await counter.textContent())).toBe(previousCount + 1)
        const activated = await measure(hostId)
        expectStableHeader(activated, resting[hostId])
        for (const button of activated.buttons) expectContained(button, activated.header)
      }
      await page.mouse.move(1, HEIGHT - 1)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const returnedToRest = await measure(hostId)
      expect(returnedToRest.actionsOpacity).toBe('0')
      expectStableHeader(returnedToRest, resting[hostId])
    }

    await page.keyboard.press('Tab')
    const newWorktreeButton = page.locator('#worktrees-frame-host .ui-expanding-icon-button')
    expect(await newWorktreeButton.evaluate((element) =>
      document.activeElement === element && element.matches(':focus-visible'))).toBe(true)
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('#worktrees-frame-host .ui-tool-panel-frame__actions')!).opacity === '1')
    const focusedWorktrees = await measure('worktrees-frame-host')
    expectStableHeader(focusedWorktrees, resting['worktrees-frame-host'])
    for (const button of focusedWorktrees.buttons) expectContained(button, focusedWorktrees.header)
    const createdCounter = page.locator('#worktrees-frame-host [data-action-counter="worktrees-created"]')
    const createdBeforeKeyboard = Number(await createdCounter.textContent())
    await page.keyboard.press('Enter')
    expect(Number(await createdCounter.textContent())).toBe(createdBeforeKeyboard + 1)
    const activatedWorktrees = await measure('worktrees-frame-host')
    expectStableHeader(activatedWorktrees, resting['worktrees-frame-host'])
    for (const button of activatedWorktrees.buttons) expectContained(button, activatedWorktrees.header)

    for (let index = 0; index < 3; index++) await page.keyboard.press('Tab')
    const fileMinimize = page.locator('#files-frame-host .ui-tool-panel-frame__actions button')
    expect(await fileMinimize.evaluate((element) =>
      document.activeElement === element && element.matches(':focus-visible'))).toBe(true)
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('#files-frame-host .ui-tool-panel-frame__actions')!).opacity === '1')
    const focusedFiles = await measure('files-frame-host')
    expectStableHeader(focusedFiles, resting['files-frame-host'])
    for (const button of focusedFiles.buttons) expectContained(button, focusedFiles.header)
    const filesCounter = page.locator('#files-frame-host [data-action-counter="files-minimize"]')
    const filesBeforeKeyboard = Number(await filesCounter.textContent())
    await page.keyboard.press('Space')
    expect(Number(await filesCounter.textContent())).toBe(filesBeforeKeyboard + 1)
    const activatedFiles = await measure('files-frame-host')
    expectStableHeader(activatedFiles, resting['files-frame-host'])
    for (const button of activatedFiles.buttons) expectContained(button, activatedFiles.header)
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps remote and vault panel headers readable at narrow widths', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addStyleTag({
      content: `
        #panel-header-regression-fixtures { display: flex; gap: 16px; }
        .panel-header-regression-frame { height: 360px; min-width: 0; width: 116px; }
        #worktrees-frame-host, #files-frame-host { display: none; }
      `
    })
    await page.addScriptTag({ content: panelHeaderRegressionBundle })
    await page.getByRole('heading', { name: 'Remote workspaces', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Workspace', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Vault settings', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Refresh Vault', exact: true }).waitFor()

    type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
    const metrics = async () => page.evaluate(() => {
      const bounds = (rect: DOMRect): Rect => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      })
      const box = (element: Element) => bounds(element.getBoundingClientRect())
      const remoteFrame = document.querySelector('#remote-frame-host .ui-tool-panel-frame')!
      const remoteTitle = remoteFrame.querySelector('.ui-tool-panel-frame__title') as HTMLElement
      const remoteActions = remoteFrame.querySelector('.ui-tool-panel-frame__actions')!
      const vaultFrame = document.querySelector('#vault-frame-host .ui-tool-panel-frame')!
      const vaultTabs = vaultFrame.querySelector('.ui-tool-panel-frame__tabs') as HTMLElement
      const vaultTabList = vaultTabs.querySelector('[role="tablist"]') as HTMLElement
      const vaultTools = vaultFrame.querySelector('.ui-tool-panel-frame__rail')!
      const tabs = [...vaultTabList.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
        const range = document.createRange()
        range.selectNodeContents(tab)
        return {
          label: tab.textContent?.trim() ?? '',
          button: box(tab),
          text: bounds(range.getBoundingClientRect())
        }
      })
      return {
        viewportWidth: window.innerWidth,
        remoteFrame: box(remoteFrame),
        remoteTitle: box(remoteTitle),
        remoteTitleText: remoteTitle.textContent?.trim() ?? '',
        remoteTitleClientWidth: remoteTitle.clientWidth,
        remoteTitleScrollWidth: remoteTitle.scrollWidth,
        remoteTitleTextOverflow: getComputedStyle(remoteTitle).textOverflow,
        remoteActions: box(remoteActions),
        remoteButtons: [...remoteActions.querySelectorAll<HTMLElement>('button')].map(box),
        vaultFrame: box(vaultFrame),
        vaultTabs: box(vaultTabs),
        vaultTabsClientWidth: vaultTabs.clientWidth,
        vaultTabsScrollWidth: vaultTabs.scrollWidth,
        vaultTabsScrollLeft: vaultTabs.scrollLeft,
        vaultTabList: box(vaultTabList),
        vaultTabListClientWidth: vaultTabList.clientWidth,
        vaultTabListScrollWidth: vaultTabList.scrollWidth,
        vaultTabListScrollLeft: vaultTabList.scrollLeft,
        vaultTools: box(vaultTools),
        vaultButtons: [...vaultTools.querySelectorAll<HTMLElement>('button')].map(box),
        tabs
      }
    })
    const expectContained = (inner: Rect, outer: Rect) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }

    for (const panelWidth of [116, 200, 240]) {
      for (const frameHost of ['#remote-frame-host', '#vault-frame-host']) {
        await page.locator(frameHost).evaluate((element, width) => {
          ;(element as HTMLElement).style.width = `${width}px`
        }, panelWidth)
      }

      const layout = await metrics()
      expect(layout.viewportWidth).toBe(646)
      expect(layout.remoteFrame.width).toBeCloseTo(panelWidth, 0)
      expect(layout.vaultFrame.width).toBeCloseTo(panelWidth, 0)
      expect(layout.remoteTitleText).toBe('Remote workspaces')
      expectContained(layout.remoteTitle, layout.remoteFrame)
      expectContained(layout.remoteActions, layout.remoteFrame)
      for (const button of layout.remoteButtons) expectContained(button, layout.remoteFrame)
      if (panelWidth === 116) {
        expect(layout.remoteTitleScrollWidth).toBeGreaterThan(layout.remoteTitleClientWidth)
      }
      if (layout.remoteTitleScrollWidth > layout.remoteTitleClientWidth) {
        expect(layout.remoteTitleTextOverflow).toBe('ellipsis')
      }

      expectContained(layout.vaultTabs, layout.vaultFrame)
      expectContained(layout.vaultTabList, layout.vaultTabs)
      expect(layout.vaultTabsScrollWidth).toBeLessThanOrEqual(layout.vaultTabsClientWidth)
      expect(layout.vaultTabsScrollLeft).toBe(0)
      expect(layout.vaultTabListScrollWidth).toBeLessThanOrEqual(layout.vaultTabListClientWidth)
      expect(layout.vaultTabListScrollLeft).toBe(0)
      expectContained(layout.vaultTools, layout.vaultFrame)
      for (const button of layout.vaultButtons) expectContained(button, layout.vaultFrame)
      expect(layout.tabs.map((tab) => tab.label)).toEqual(['Workspace', 'Project', 'All'])
      for (const tab of layout.tabs) {
        expectContained(tab.text, tab.button)
        expectContained(tab.text, layout.vaultTabs)
        expectContained(tab.text, layout.vaultFrame)
      }
      if (panelWidth === 116) {
        expect(new Set(layout.tabs.map((tab) => Math.round(tab.button.top))).size).toBeGreaterThan(1)
        const projectTab = page.getByRole('tab', { name: 'Project', exact: true })
        await projectTab.click()
        expect(await projectTab.evaluate((element) => document.activeElement === element)).toBe(true)
        await page.keyboard.press('ArrowRight')
        const allTab = page.getByRole('tab', { name: 'All', exact: true })
        expect(await allTab.evaluate((element) => document.activeElement === element)).toBe(true)
        await page.keyboard.press('Home')
        const workspaceTab = page.getByRole('tab', { name: 'Workspace', exact: true })
        expect(await workspaceTab.evaluate((element) => document.activeElement === element)).toBe(true)
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)
test.skipIf(!existsSync(chromium.executablePath()))('keeps Add project controls fixed when its label expands', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addStyleTag({
      content: `
        #panel-header-regression-fixtures { display: block; }
        #remote-frame-host, #vault-frame-host, #worktrees-frame-host, #files-frame-host { display: none; }
        #add-project-frame-host { height: 360px; min-width: 0; width: 160px; }
      `
    })
    await page.addScriptTag({ content: panelHeaderRegressionBundle })
    await page.getByRole('heading', { name: 'Worktrees', exact: true }).waitFor()

    const addProject = page.getByRole('button', { name: 'Add project', exact: true })
    await addProject.waitFor()
    await page.getByRole('button', { name: 'Filter worktrees', exact: true }).waitFor()
    const minimizeButton = page.getByRole('button', { name: 'Minimize Worktrees', exact: true })
    await minimizeButton.waitFor()

    type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
    const metrics = async () => page.evaluate(() => {
      const bounds = (rect: DOMRect): Rect => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      })
      const box = (element: Element) => bounds(element.getBoundingClientRect())
      const frame = document.querySelector('#add-project-frame-host .ui-tool-panel-frame')!
      return {
        frame: box(frame),
        addProject: box(frame.querySelector('[aria-label="Add project"]')!),
        filter: box(frame.querySelector('[aria-label="Filter worktrees"]')!),
        minimize: box(frame.querySelector('[aria-label="Minimize Worktrees"]')!)
      }
    })
    const expectContained = (inner: Rect, outer: Rect) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }
    const expectFixed = (before: Rect, after: Rect) => {
      for (const coordinate of ['left', 'top', 'right', 'bottom'] as const) {
        expect(Math.abs(after[coordinate] - before[coordinate])).toBeLessThanOrEqual(0.5)
      }
    }

    for (const panelWidth of [160, 174, 175, 320]) {
      await page.mouse.move(620, HEIGHT - 10)
      await page.locator('#add-project-frame-host').evaluate((element, width) => {
        ;(element as HTMLElement).style.width = `${width}px`
      }, panelWidth)
      const resting = await metrics()
      expect(resting.frame.width).toBeCloseTo(panelWidth, 0)

      for (const interaction of ['hover', 'focus'] as const) {
        if (interaction === 'hover') {
          await addProject.hover()
        } else {
          await minimizeButton.focus()
          await page.keyboard.press('Shift+Tab')
          await page.keyboard.press('Shift+Tab')
          expect(await addProject.evaluate((element) => document.activeElement === element)).toBe(true)
        }
        await page.waitForTimeout(150)

        const active = await metrics()
        expectFixed(resting.filter, active.filter)
        expectFixed(resting.minimize, active.minimize)
        for (const button of [active.addProject, active.filter, active.minimize]) {
          expectContained(button, active.frame)
        }
        if (panelWidth > 174) {
          expect(active.addProject.width).toBeGreaterThan(resting.addProject.width)
        } else {
          expect(active.addProject.width).toBe(resting.addProject.width)
        }

        await page.mouse.move(620, HEIGHT - 10)
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await page.waitForTimeout(150)
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('ellipsizes the Worktrees heading before revealed Add project controls', async () => {
  const context = await browser!.newContext({ viewport: { width: 646, height: HEIGHT }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addStyleTag({
      content: `
        #panel-header-regression-fixtures > :not(#add-project-frame-host) { display: none; }
        #add-project-frame-host { height: 360px; width: 160px; }
      `
    })
    await page.addScriptTag({ content: panelHeaderRegressionBundle })
    const host = page.locator('#add-project-frame-host')
    await host.waitFor()
    await host.evaluate((element) => element.setAttribute('data-tool-panel', ''))
    const title = host.getByRole('heading', { name: 'Worktrees', exact: true })
    const addProject = host.getByRole('button', { name: 'Add project', exact: true })
    const measure = () => title.evaluate((element) => {
      const actions = element.parentElement!.querySelector('.ui-tool-panel-frame__actions')!
      const style = getComputedStyle(element)
      return {
        titleRight: element.getBoundingClientRect().right,
        actionsLeft: actions.getBoundingClientRect().left,
        actionsOpacity: getComputedStyle(actions).opacity,
        truncated: element.scrollWidth > element.clientWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow
      }
    })
    await page.mouse.move(620, HEIGHT - 10)
    const resting = await measure()
    expect(resting.actionsOpacity).toBe('0')
    expect(resting.truncated).toBe(false)

    for (const interaction of ['hover', 'focus', 'panel-focused'] as const) {
      if (interaction === 'hover') await addProject.hover()
      if (interaction === 'focus') await addProject.focus()
      if (interaction === 'panel-focused') {
        await host.evaluate((element) => element.setAttribute('data-panel-focused', ''))
      }
      const active = await measure()
      expect(active.actionsOpacity).toBe('1')
      expect(active.titleRight).toBeLessThanOrEqual(active.actionsLeft)
      expect(active.truncated).toBe(true)
      expect(active.overflow).toBe('hidden')
      expect(active.textOverflow).toBe('ellipsis')

      await page.mouse.move(620, HEIGHT - 10)
      await addProject.evaluate((element) => (element as HTMLElement).blur())
      await host.evaluate((element) => element.removeAttribute('data-panel-focused'))
      expect(await measure()).toEqual(resting)
    }
  } finally {
    await context.close()
  }
}, 60_000)
test.skipIf(!existsSync(chromium.executablePath()))('keeps the workspace board in a horizontally scrollable row without displacing the tree', async () => {
  const context = await browser!.newContext({ viewport: { width: GUTTER * 2 + CENTER_WIDTH + 280 * 2, height: HEIGHT } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.evaluate(() => { document.documentElement.dataset.worktreeBoardRegression = 'true' })
    await page.addScriptTag({ content: browserBundle })
    await page.locator('#layout').waitFor()
    await page.locator('#layout').evaluate((element) => {
      ;(element as HTMLElement).style.setProperty('--sidebar-width', '280px')
      ;(element as HTMLElement).style.setProperty('--worktree-sidebar-width', '280px')
    })
    const board = page.getByRole('region', { name: 'Workspace board', exact: true })
    await board.waitFor()

    const measure = () => page.evaluate(() => {
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      }
      const panel = document.querySelector<HTMLElement>('#worktrees-panel')!
      const content = panel.querySelector<HTMLElement>('.ui-panel-content')!
      const boardViewport = panel.querySelector<HTMLElement>('[data-board-scroll]')!
      const board = boardViewport.querySelector<HTMLElement>('.worktree-tree-board')!
      const columns = [...board.querySelectorAll<HTMLElement>('.worktree-tree-board-column')]
      const treeViewport = panel.querySelector<HTMLElement>('[data-tree-scroll]')!
      const laneCount = (label: string) => board.querySelectorAll(
        `.worktree-tree-board-column[aria-label="${label} workspaces"] .worktree-board-card`
      ).length
      return {
        panel: bounds(panel),
        viewportHeight: window.innerHeight,
        content: bounds(content),
        boardViewport: bounds(boardViewport),
        boardClientWidth: boardViewport.clientWidth,
        boardScrollWidth: boardViewport.scrollWidth,
        boardScrollHeight: boardViewport.scrollHeight,
        boardScrollLeft: boardViewport.scrollLeft,
        boardScrollTop: boardViewport.scrollTop,
        columns: columns.map((column) => ({
          bounds: bounds(column),
          heading: bounds(column.querySelector('.ui-section-header__title')!)
        })),
        lastColumn: bounds(columns.at(-1)!),
        treeViewport: bounds(treeViewport),
        treeScrollHeight: treeViewport.scrollHeight,
        treeScrollTop: treeViewport.scrollTop,
        lanes: {
          todo: laneCount('To do'),
          inProgress: laneCount('In progress'),
          review: laneCount('In review'),
          done: laneCount('Done')
        }
      }
    })

    const initial = await measure()
    expect(initial.panel.bottom).toBeLessThanOrEqual(initial.viewportHeight + 1)
    expect(initial.panel.width).toBeCloseTo(280, 0)
    expect(initial.columns).toHaveLength(4)
    expect(initial.boardScrollWidth).toBeGreaterThan(initial.boardClientWidth)
    expect(initial.boardViewport.height).toBeLessThanOrEqual(initial.content.height / 2 + 2)
    expect(initial.treeViewport.height).toBeGreaterThan(180)
    expect(initial.treeViewport.bottom).toBeLessThanOrEqual(initial.content.bottom + 1)
    expect(initial.content.bottom).toBeLessThanOrEqual(initial.panel.bottom + 1)
    expect(initial.boardViewport.bottom).toBeLessThanOrEqual(initial.treeViewport.top + 1)
    expect(initial.boardScrollHeight).toBeGreaterThan(initial.boardViewport.height)
    expect(initial.treeScrollHeight).toBeGreaterThan(initial.treeViewport.height)
    expect(initial.lanes).toEqual({ todo: 0, inProgress: 16, review: 0, done: 1 })

    const top = initial.columns[0]!.heading.top
    const laneWidth = initial.columns[0]!.bounds.width
    for (const [index, column] of initial.columns.entries()) {
      expect(column.heading.top).toBeCloseTo(top, 0)
      expect(column.bounds.width).toBeCloseTo(laneWidth, 0)
      expect(column.bounds.width).toBeGreaterThanOrEqual(200)
      if (index > 0) expect(column.bounds.left).toBeGreaterThan(initial.columns[index - 1]!.bounds.left)
    }

    await page.locator('[data-board-scroll]').evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      element.scrollTop = element.scrollHeight
    })
    const boardScrolled = await measure()
    expect(boardScrolled.boardScrollLeft).toBeGreaterThan(0)
    expect(boardScrolled.boardScrollTop).toBeGreaterThan(0)
    expect(boardScrolled.treeScrollTop).toBe(0)
    expect(boardScrolled.lastColumn.right).toBeLessThanOrEqual(boardScrolled.boardViewport.right + 1)
    await page.locator('[data-tree-scroll]').evaluate((element) => { element.scrollTop = element.scrollHeight })
    const bothScrolled = await measure()
    expect(bothScrolled.treeScrollTop).toBeGreaterThan(0)
    expect(bothScrolled.boardScrollTop).toBe(boardScrolled.boardScrollTop)

    await page.locator('[data-board-scroll]').evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0 })
    await page.locator('.worktree-tree-board-column[aria-label="In progress workspaces"] select').first().selectOption('done')
    const moved = await measure()
    expect(moved.lanes).toEqual({ todo: 0, inProgress: 15, review: 0, done: 2 })
    for (const column of moved.columns) expect(column.heading.top).toBeCloseTo(top, 0)
    expect(moved.columns.map((column) => column.bounds.width)).toEqual(
      initial.columns.map((column) => column.bounds.width)
    )
  } finally {
    await context.close()
  }
}, 60_000)

test.skipIf(!existsSync(chromium.executablePath()))('keeps all Worktrees activity window tabs visible without horizontal scrolling', async () => {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  try {
    await page.setContent(pageMarkup())
    await page.evaluate(() => {
      document.documentElement.dataset.activityFiltersRegression = 'true'
    })
    for (const stylesheet of STYLESHEETS) {
      await page.addStyleTag({ content: readFileSync(join(ROOT, stylesheet), 'utf8') })
    }
    await page.addScriptTag({ content: browserBundle })
    const optionsButton = page.getByRole('button', { name: 'Worktrees options', exact: true })
    await optionsButton.waitFor()
    const expectedTabs = ['All', 'Live only', 'Past 24 hours', 'Past 7 days', 'Past 30 days', 'Custom']

    const expectContained = (
      inner: { left: number; top: number; right: number; bottom: number },
      outer: { left: number; top: number; right: number; bottom: number }
    ) => {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.5)
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.5)
      expect(inner.right).toBeLessThanOrEqual(outer.right + 0.5)
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
    }

    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 720 })
      await optionsButton.click()
      const popover = page.getByRole('dialog', { name: 'Worktrees options' })
      await popover.waitFor({ state: 'visible' })
      await popover.getByRole('button', { name: /^Activity filters/ }).click()
      const tablist = popover.getByRole('tablist', { name: 'Workspace activity window' })
      await tablist.waitFor({ state: 'visible' })

      const geometry = await page.evaluate(() => {
        const tablist = document.querySelector<HTMLElement>('#workspace-activity-filter-options [role="tablist"]')!
        const popover = document.querySelector<HTMLElement>('.ui-popover')!
        const clientBounds = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect()
          return {
            left: rect.left + element.clientLeft,
            top: rect.top + element.clientTop,
            right: rect.left + element.clientLeft + element.clientWidth,
            bottom: rect.top + element.clientTop + element.clientHeight
          }
        }
        const rectBounds = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        }
        const popoverBounds = clientBounds(popover)
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          popover: rectBounds(popover),
          visiblePopover: {
            left: Math.max(0, popoverBounds.left),
            top: Math.max(0, popoverBounds.top),
            right: Math.min(window.innerWidth, popoverBounds.right),
            bottom: Math.min(window.innerHeight, popoverBounds.bottom)
          },
          tablist: {
            ...clientBounds(tablist),
            clientWidth: tablist.clientWidth,
            scrollWidth: tablist.scrollWidth
          },
          tabs: [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
            name: tab.textContent?.trim() ?? '',
            ...rectBounds(tab)
          }))
        }
      })

      expect(geometry.viewportWidth).toBe(width)
      expect(geometry.viewportHeight).toBe(720)
      expectContained(geometry.popover, {
        left: 0,
        top: 0,
        right: geometry.viewportWidth,
        bottom: geometry.viewportHeight
      })
      expect(geometry.tabs.map(({ name }) => name)).toEqual(expectedTabs)
      expect(geometry.tablist.scrollWidth).toBeLessThanOrEqual(geometry.tablist.clientWidth)
      for (const tab of geometry.tabs) {
        expectContained(tab, geometry.tablist)
        expectContained(tab, geometry.visiblePopover)
      }

      if (width === 360) {
        await tablist.getByRole('tab', { name: 'Custom', exact: true }).click()
        const customDays = popover.getByRole('textbox', { name: 'Custom days' })
        await customDays.waitFor({ state: 'visible' })
        expect(await customDays.inputValue()).toBe('14')
      } else {
        await optionsButton.click()
      }
    }
  } finally {
    await context.close()
  }
}, 60_000)
