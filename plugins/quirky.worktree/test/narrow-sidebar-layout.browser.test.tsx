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
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}
const browserDependencyResolver: Bun.BunPlugin = {
  name: 'worktree-narrow-sidebar-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|@quirky\/ui)$/ },
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

function browserEntry(): string {
  const uiModule = join(ROOT, 'packages/ui/src/design-system/index.ts')
  return `
    import { createElement as h, Fragment } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ExpandingIconButton, IconButton, ProjectTile, SectionHeader, Tabs, ToolPanelFrame } from ${JSON.stringify(uiModule)}

    const projectName = 'QuirkyWorktreeProject'
    const projectActions = h('span', { className: 'ui-cluster repo-actions' },
      h('span', { className: 'ui-cluster project-reveal' },
        h(IconButton, { label: 'New worktree in ' + projectName, title: 'New worktree' }, '+'),
        h(IconButton, { label: 'Actions for ' + projectName, title: 'Project actions' }, '⋯')
      ),
      h('span', { className: 'project-count', title: '2 worktrees' }, '2')
    )
    const projectHeader = h(SectionHeader, {
      className: 'repo-header project-header',
      title: h(Fragment, null, h(ProjectTile, { name: projectName }), ' ' + projectName),
      actions: projectActions
    })
    const tabs = h(Tabs, {
      label: 'Worktree views',
      items: [{ id: 'tree', label: 'Tree' }],
      value: 'tree',
      onChange() {}
    })
    const worktreeFrame = h(ToolPanelFrame, {
      title: 'Worktrees',
      tabs,
      actions: h('div', { className: 'ui-cluster' },
        h(ExpandingIconButton, { label: 'New worktree', title: 'New worktree' }, '+'),
        h(IconButton, { label: 'Filter worktrees', title: 'Filter worktrees' }, '⌕')
      ),
      onMinimize() {}
    }, h('div', { className: 'worktree-tree ui-stack' },
      h('section', { className: 'repo ui-stack' },
        projectHeader,
        h('ul', { className: 'worktree-list ui-tree' }, h('li', null, 'main'))
      )
    ))
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

    createRoot(document.getElementById('root')).render(layout)
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
          #layout { display: grid; grid-template-columns: ${GUTTER}px var(--sidebar-width) minmax(0, ${CENTER_WIDTH}px) var(--sidebar-width) ${GUTTER}px; height: 100%; min-width: 0; }
          .panel { height: 100%; min-width: 0; }
          .ui-tool-panel-frame { height: 100%; min-width: 0; }
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
      const projectActions = projectHeader.querySelector('.ui-section-header__actions')!
      const projectReveal = projectActions.querySelector('.project-reveal')!
      const projectCount = projectActions.querySelector('.project-count')!
      const projectNameNode = [...projectTitle.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!
      const projectNameOffset = projectNameNode.textContent!.search(/\S/)
      const projectNameRange = document.createRange()
      projectNameRange.setStart(projectNameNode, projectNameOffset)
      projectNameRange.setEnd(projectNameNode, projectNameOffset + 1)
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
        projectActions: box(projectActions),
        projectButtons: [...projectActions.querySelectorAll('button')].map(box),
        projectCount: box(projectCount),
        projectRevealOpacity: getComputedStyle(projectReveal).opacity,
        projectTitleOverflow: getComputedStyle(projectTitle).textOverflow,
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

    for (const sidebarWidth of [116, 200, 240]) {
      const viewportWidth = GUTTER * 2 + CENTER_WIDTH + sidebarWidth * 2
      await page.setViewportSize({ width: viewportWidth, height: HEIGHT })
      await page.locator('#layout').evaluate((element, width) => {
        ;(element as HTMLElement).style.setProperty('--sidebar-width', `${width}px`)
      }, sidebarWidth)
      await page.mouse.move(0, 0)
      if (sidebarWidth === 240) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const layout = await metrics()
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
      expectContained(layout.projectTile, layout.projectTitle)
      expect(layout.projectTitle.right - layout.projectTile.right).toBeGreaterThan(1)
      expect(layout.projectLeading.width).toBeGreaterThan(0)
      expect(layout.projectLeading.left).toBeGreaterThanOrEqual(layout.projectTile.right - 0.5)
      expect(layout.projectLeading.right).toBeLessThanOrEqual(layout.projectTitle.right + 0.5)
      expect(layout.projectTitleOverflow).toBe('ellipsis')
      expectContained(layout.projectActions, layout.projectHeader)
      expectContained(layout.projectCount, layout.projectActions)
      for (const button of layout.projectButtons) expectContained(button, layout.projectHeader)
      if (sidebarWidth <= 140) expect(layout.expandingLabelDisplay).toBe('none')
      else expect(layout.expandingLabelDisplay).not.toBe('none')

      if (sidebarWidth <= 220) {
        expect(layout.toolActions.top).toBeGreaterThan(layout.toolTitle.bottom)
        expect(layout.projectActions.top).toBeGreaterThan(layout.projectTitle.bottom)
        expect(layout.changesActions.top).toBeGreaterThan(layout.changesTitle.bottom)
      } else {
        expect(layout.toolTitle.top).toBeLessThan(layout.toolActions.bottom)
        expect(layout.toolActions.top).toBeLessThan(layout.toolTitle.bottom)
        expect(layout.projectTitle.top).toBeLessThan(layout.projectActions.bottom)
        expect(layout.projectActions.top).toBeLessThan(layout.projectTitle.bottom)
        expect(layout.changesTitle.top).toBeLessThan(layout.changesActions.bottom)
        expect(layout.changesActions.top).toBeLessThan(layout.changesTitle.bottom)
      }

      if (sidebarWidth === 116) {
        expect(layout.projectRevealOpacity).toBe('0')
        const projectHeader = page.locator('.project-header')
        await projectHeader.hover()
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.project-header .project-reveal')!).opacity === '1')
        const revealedActions = await projectHeader.locator('.ui-section-header__actions').boundingBox()
        expect(revealedActions).not.toBeNull()
        expect(revealedActions!.x).toBeCloseTo(layout.projectActions.left, 0)
        expect(revealedActions!.y).toBeCloseTo(layout.projectActions.top, 0)
        await page.mouse.move(0, 0)
        const projectAction = page.getByRole('button', { name: 'New worktree in QuirkyWorktreeProject', exact: true })
        await projectAction.focus()
        expect(await projectAction.evaluate((element) => document.activeElement === element)).toBe(true)
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.project-header:focus-within .project-reveal')!).opacity === '1')
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
