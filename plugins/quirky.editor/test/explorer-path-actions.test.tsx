import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyClient, Session, SettingInfo, UiLayout, UiPluginContext } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../../quirky.terminal/src/layout/tree'
import type { Workspace } from '../../quirky.terminal/src/layout/types'
import { shellEscapePaths } from '../../quirky.terminal/src/shell-escape'
import { readWorktreePathsDrop, resolveWorktreeDropPaths, type DropData } from '../../quirky.terminal/src/window/pane/drop'
import type { ExplorerPanel as ExplorerPanelComponent } from '../src/window/ExplorerPanel'
import { registerIsolatedEditorFixtures } from './isolated-environment'

type Worktree = { id: string; path: string }
type ExplorerEntry = { path: string; name: string; isDirectory: boolean }
type ExplorerListing = { root: string; entries: ExplorerEntry[] }
type DocumentRoot = { id: string; path: string }
type ExplorerReport = { loading: boolean; error: string | null }
type Fixture = {
  harness: Harness
  client: QuirkyClient
  uiClient: QuirkyClient
  root: string
  worktree: Worktree
  documentRoot: DocumentRoot
  listing: ExplorerListing
  reports: ExplorerReport[]
  settings: Map<string, unknown>
}
type Mounted = { element: HTMLElement; unmount(): Promise<void> }
type FixtureOptions = { displayRoot?: string; extraFiles?: Record<string, string> }
type Transfer = DropData & {
  readonly types: string[]
  effectAllowed: DataTransfer['effectAllowed']
  setData(type: string, value: string): void
}

const FILE_A = "nested/A O'Brien café #1? report.txt"
const FILE_B = 'nested/B résumé #2.txt'
const ARCHIVE_FILE = 'nested/archive/keep.txt'
const MARKDOWN_FILE = 'nested/menu-preview.md'
const FILES: Record<string, string> = {
  [FILE_A]: 'alpha\n',
  [FILE_B]: 'beta\n',
  [ARCHIVE_FILE]: 'keep\n',
  [MARKDOWN_FILE]: '# Menu preview\n'
}

let createRoot: (container: HTMLElement) => Root
let ExplorerPanel: typeof ExplorerPanelComponent
let mounted: Mounted[] = []
let fixtures: Set<Fixture>
let clipboardWrites: string[] = []
let restoreClipboard: (() => void) | undefined

registerIsolatedEditorFixtures(async () => {
  const errors: unknown[] = []
  for (const surface of mounted) {
    try {
      await surface.unmount()
    } catch (error) {
      errors.push(error)
    }
  }
  mounted = []

  for (const fixture of fixtures) {
    fixtures.delete(fixture)
    try {
      await fixture.harness.cleanup()
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        rmSync(fixture.root, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
  }

  try {
    restoreClipboard?.()
  } catch (error) {
    errors.push(error)
  } finally {
    restoreClipboard = undefined
    clipboardWrites = []
    document.body.replaceChildren()
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Explorer test fixture cleanup failed')
})

beforeAll(async () => {
  // These modules inspect browser globals during initialization, so load them after HappyDOM.
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ExplorerPanel } = await import('../src/window/ExplorerPanel'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  mounted = []
  fixtures = new Set()
  clipboardWrites = []
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  let currentText = ''
  const clipboard = {
    async readText() { return currentText },
    async writeText(value: string) {
      currentText = value
      clipboardWrites.push(value)
    }
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  restoreClipboard = () => {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

function git(root: string, home: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, env: { ...process.env, HOME: home, QUIRKY_HOME: home } })
}

const call = <T,>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params) as Promise<T>

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-explorer-paths-'))
  let home: string | undefined
  let harness: Harness | undefined
  try {
    home = makeHomeWithoutAutoHooks('q-editor-explorer-paths-')
    for (const [path, text] of Object.entries({ ...FILES, ...(options.extraFiles ?? {}) })) {
      const absolute = join(root, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, text)
    }
    git(root, home, ['init', '-q', '-b', 'main'])
    git(root, home, ['-c', 'user.email=editor-paths@test', '-c', 'user.name=Editor Paths Test', 'add', '.'])
    git(root, home, ['-c', 'user.email=editor-paths@test', '-c', 'user.name=Editor Paths Test', 'commit', '-q', '-m', 'initial'])

    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    const client = await harness.connect('cli')
    const { client: uiClient } = await harness.connectWithEvents('ui')
    const repo = await call<{ id: string }>(client, 'quirky.repo/add', { path: root })
    const worktrees = await call<Worktree[]>(client, 'quirky.worktree/list', { repo: repo.id })
    const worktree = worktrees.find((entry) => entry.path === root) ?? worktrees[0]
    if (!worktree) throw new Error('repo add returned no worktree')

    const documentRoot = await call<DocumentRoot>(client, 'quirky.editor/documentRoot', { worktree: worktree.id })
    const settings = new Map<string, unknown>(
      (await call<SettingInfo[]>(client, 'setting.list', { pluginId: 'quirky.editor' }))
        .map(({ id, value }) => [id.replace(/^setting:quirky\.editor\//, ''), value] as const)
    )
    if (options.displayRoot !== undefined) {
      await call(client, 'quirky.editor/explorer', {
        worktree: worktree.id,
        action: 'preferences',
        displayRoot: options.displayRoot
      })
    }
    const listing = await call<ExplorerListing>(client, 'quirky.editor/explorer', { worktree: worktree.id, action: 'list' })
    const fixture: Fixture = { harness, client, uiClient, root: documentRoot.path, worktree, documentRoot, listing, reports: [], settings }
    fixtures.add(fixture)
    return fixture
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
      if (home) rmSync(home, { recursive: true, force: true })
    }
    throw error
  }
}

function makeContext(fixture: Fixture): UiPluginContext {
  return {
    nativeBrowser: {} as UiPluginContext['nativeBrowser'],
    pluginId: 'quirky.editor',
    log() {},
    nativeDropPaths: async () => null,
    readClipboardText: async () => '',
    provide() {},
    call: (method, params = {}) => fixture.uiClient.callAny(method, params),
    subscribe: (listener) => fixture.uiClient.onEvent((event) => { void listener(event) }),
    getSetting: (name) => fixture.settings.get(name),
    async executeCommand() {},
    createCommandDrag: () => 'unused-command-drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    getLayout: () => ({
      worktree: fixture.worktree.id,
      view: { id: 'test-view', input: { worktree: fixture.worktree.id } },
      panel: null,
      sidebar: true,
      focus: 'view'
    }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: (listener) => fixture.uiClient.onClose(() => listener('reconnecting')),
    async confirm() { return false },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  }
}

function findRow(element: HTMLElement, path: string): HTMLElement | null {
  return Array.from(element.querySelectorAll<HTMLElement>('[data-path]')).find((row) => row.dataset.path === path) ?? null
}

async function flushReact(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

async function waitForUi<T>(
  check: () => T | false | null | undefined | Promise<T | false | null | undefined>
): Promise<T> {
  return await waitForAsync(async () => {
    await flushReact()
    return await check()
  })
}

async function renderExplorer(fixture: Fixture, context = makeContext(fixture)): Promise<Mounted> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let unmounted = false
  const surface: Mounted = {
    element,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(surface)
  await act(async () => {
    root.render(<ExplorerPanel context={context} report={(value) => {
      if (typeof value !== 'object' || value === null || !('loading' in value) || typeof value.loading !== 'boolean') return
      fixture.reports.push({
        loading: value.loading,
        error: 'error' in value && typeof value.error === 'string' ? value.error : null
      })
    }} />)
  })
  await waitForUi(() => fixture.listing.entries.some((entry) => findRow(element, entry.path)))
  return surface
}

async function renderStandaloneExplorer(context: UiPluginContext): Promise<Mounted> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let unmounted = false
  const surface: Mounted = {
    element,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(surface)
  await act(async () => {
    root.render(<ExplorerPanel context={context} />)
  })
  return surface
}

function rowActionTrigger(row: HTMLElement): HTMLButtonElement {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-label^="Actions for "]')
  if (!trigger) throw new Error(`Missing row actions for ${row.dataset.path}`)
  return trigger
}

function rowActionMenuOpen(row: HTMLElement): boolean {
  return rowActionTrigger(row).getAttribute('aria-expanded') === 'true'
}

async function actionButton(row: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const trigger = rowActionTrigger(row)
  if (!rowActionMenuOpen(row)) {
    await act(async () => trigger.click())
    await waitForUi(() => rowActionMenuOpen(row) && row.getAttribute('aria-selected') === 'true' || false)
  }
  const menu = row.querySelector<HTMLElement>('[role="menu"]')
  const button = menu && Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((entry) => entry.textContent?.trim() === label)
  if (!button) throw new Error(`Missing ${label} action for ${row.dataset.path}`)
  return button
}


function footerButton(element: HTMLElement, label: string): HTMLButtonElement {
  const footer = element.querySelector('footer.qe-explorer-footer')
  const button = footer && Array.from(footer.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent === label)
  if (!button) throw new Error(`Missing Explorer footer action ${label}`)
  return button
}

async function selectRow(element: HTMLElement, path: string): Promise<void> {
  const row = findRow(element, path)
  if (!row) throw new Error(`Missing Explorer row ${path}`)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
  })
  await waitForUi(() => findRow(element, path)?.getAttribute('aria-selected') === 'true' || false)
}

function makeTransfer(): Transfer {
  const values = new Map<string, string>()
  const transfer = {
    get types() { return [...values.keys()] },
    effectAllowed: 'all' as DataTransfer['effectAllowed'],
    files: [],
    getData(type: string) { return values.get(type) ?? '' },
    setData(type: string, value: string) { values.set(type, value) }
  }
  return transfer as Transfer
}

function dispatchDrag(target: HTMLElement, type: 'dragstart' | 'dragover' | 'drop', transfer: Transfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { configurable: true, value: transfer })
  target.dispatchEvent(event)
  return event
}

function decodeFileUris(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#')).map((line) => {
    const url = new URL(line)
    if (url.protocol !== 'file:') throw new Error(`Expected a file URI, got ${line}`)
    return decodeURIComponent(url.pathname)
  })
}

async function waitForExplorerRefresh(fixture: Fixture, start: number): Promise<void> {
  await waitForUi(() => {
    const reports = fixture.reports.slice(start)
    const loadingIndex = reports.findIndex((report) => report.loading)
    return loadingIndex >= 0 && reports.slice(loadingIndex + 1).some((report) => !report.loading) || false
  })
}

test('Explorer keeps inline create and rename controls outside the tree ownership', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const scrollContainer = panel.element.querySelector<HTMLElement>('.qe-explorer-tree')
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  expect(scrollContainer).not.toBeNull()
  expect(tree).not.toBeNull()

  const treeItems = Array.from(tree!.children) as HTMLElement[]
  expect(treeItems.length).toBeGreaterThan(1)
  expect(treeItems.every((item) => item.getAttribute('role') === 'treeitem')).toBe(true)
  await act(async () => {
    tree!.focus()
    tree!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => tree!.getAttribute('aria-activedescendant') === treeItems[0]!.id || false)
  await act(async () => {
    tree!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => tree!.getAttribute('aria-activedescendant') === treeItems[1]!.id || false)

  const assertInlineFormOwnership = (input: HTMLInputElement, accessibleName: string, usesAriaLabel = false) => {
    const inlineRow = input.closest<HTMLElement>('.qe-explorer-inline-row')
    expect(inlineRow).not.toBeNull()
    expect(scrollContainer!.contains(inlineRow)).toBe(true)
    expect(tree!.contains(inlineRow)).toBe(false)
    expect(Array.from(tree!.children).every((item) => item.getAttribute('role') === 'treeitem')).toBe(true)
    if (usesAriaLabel) {
      expect(input.getAttribute('aria-label')).toBe(accessibleName)
    } else {
      const label = Array.from(inlineRow!.querySelectorAll('label')).find((candidate) => candidate.htmlFor === input.id)
      expect(label?.textContent?.trim()).toBe(accessibleName)
    }
    const controls = Array.from(inlineRow!.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
    expect(controls).toContain(input)
    expect(controls.filter((control) => control instanceof HTMLButtonElement).map((button) => button.textContent?.trim()))
      .toEqual(usesAriaLabel ? ['Rename', 'Cancel'] : ['Create', 'Cancel'])
    expect(controls.every((control) => !tree!.contains(control))).toBe(true)
    return inlineRow!
  }

  const newFile = panel.element.querySelector<HTMLButtonElement>('button[title="New File"]')
  if (!newFile) throw new Error('Missing New File action')
  await act(async () => newFile.click())
  const newFileInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input') ?? false)
  const newFileRow = assertInlineFormOwnership(newFileInput, 'New file name')
  const cancelNewFile = Array.from(newFileRow.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Cancel')
  if (!cancelNewFile) throw new Error('Missing Cancel action for New File')
  await act(async () => cancelNewFile.click())
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)

  const newFolder = panel.element.querySelector<HTMLButtonElement>('button[title="New Folder"]')
  if (!newFolder) throw new Error('Missing New Folder action')
  await act(async () => newFolder.click())
  const newFolderInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input') ?? false)
  const newFolderRow = assertInlineFormOwnership(newFolderInput, 'New folder name')
  const cancelNewFolder = Array.from(newFolderRow.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Cancel')
  if (!cancelNewFolder) throw new Error('Missing Cancel action for New Folder')
  await act(async () => cancelNewFolder.click())
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)

  const sourceRow = findRow(panel.element, join(fixture.root, FILE_A))
  if (!sourceRow) throw new Error('Missing source row for Rename')
  const rename = await actionButton(sourceRow, 'Rename')
  await act(async () => rename.click())
  const renameInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  const renameRow = assertInlineFormOwnership(renameInput, 'Rename file', true)
  const cancelRename = Array.from(renameRow.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Cancel')
  if (!cancelRename) throw new Error('Missing Cancel action for Rename')
  await act(async () => cancelRename.click())
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)
})

test('Explorer row actions copy canonical absolute and worktree-relative paths and open the real directory in Terminal', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  expect(fixture.documentRoot.path).toBe(fixture.worktree.path)
  expect(fixture.listing.root).toBe(join(fixture.root, 'nested'))
  expect(fixture.listing.entries.map((entry) => entry.path)).toContain(join(fixture.root, FILE_A))

  const panel = await renderExplorer(fixture)
  const file = join(fixture.root, FILE_A)
  const fileRow = findRow(panel.element, file)
  expect(fileRow).not.toBeNull()
  const absoluteAction = await actionButton(fileRow!, 'Copy Path')
  await act(async () => absoluteAction.click())
  expect(await navigator.clipboard.readText()).toBe(file)

  const relativeAction = await actionButton(fileRow!, 'Copy Relative Path')
  await act(async () => relativeAction.click())
  expect(await navigator.clipboard.readText()).toBe(FILE_A)
  expect(clipboardWrites).toEqual([file, FILE_A])

  const directory = join(fixture.root, 'nested/archive')
  const directoryRow = findRow(panel.element, directory)
  expect(directoryRow).not.toBeNull()
  const previousSessionIds = new Set((await call<Session[]>(fixture.client, 'quirky.session/list', {})).map((session) => session.id))
  const terminalAction = await actionButton(directoryRow!, 'Open in Terminal')
  await act(async () => terminalAction.click())
  const terminalSession = await waitForUi(async () => {
    const sessions = await call<Session[]>(fixture.client, 'quirky.session/list', {})
    return sessions.find((session) => !previousSessionIds.has(session.id) && session.worktreeId === fixture.worktree.id) ?? false
  })
  expect(terminalSession.cwd).toBe(directory)
  expect(terminalSession.worktreeId).toBe(fixture.worktree.id)

  const { workspace } = await call<{ workspace: Workspace }>(fixture.client, 'quirky.terminal/workspace', { workspace: fixture.worktree.id })
  expect(workspace.id).toBe(fixture.worktree.id)
  const sessionIds = groupsInOrder(workspace.root).flatMap((group) => group.tabs).flatMap((tab) =>
    tab.kind === 'view' ? [] : paneLeaves(tab.root).map((pane) => pane.session)
  )
  expect(sessionIds).toContain(terminalSession.id)
})
test.each([
  { kind: 'file', path: 'created.md', expandedParent: false },
  { kind: 'folder', path: 'created-folder', expandedParent: false },
  { kind: 'file', path: 'nested/created.md', expandedParent: true },
  { kind: 'folder', path: 'nested/created-folder', expandedParent: false }
] as const)('Explorer selects a new $kind at $path and targets it in footer actions', async ({ kind, path, expandedParent }) => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  context.confirm = async () => true
  const panel = await renderExplorer(fixture, context)
  const parent = join(fixture.root, 'nested')
  if (expandedParent) {
    await act(async () => findRow(panel.element, parent)!.click())
    await waitForUi(() => findRow(panel.element, join(fixture.root, FILE_A)) || false)
    await selectRow(panel.element, join(fixture.root, FILE_A))
  } else {
    await selectRow(panel.element, parent)
  }
  const previouslySelected = Array.from(panel.element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]'))
    .map((row) => row.dataset.path!)
  expect(previouslySelected).toContain(expandedParent ? join(fixture.root, FILE_A) : parent)

  const newButton = panel.element.querySelector<HTMLButtonElement>(`button[title="New ${kind === 'file' ? 'File' : 'Folder'}"]`)!
  await act(async () => newButton.click())
  const input = panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-inline-row button'))
    .find((button) => button.textContent === 'Create')!
  await act(async () => create.click())
  const created = join(fixture.root, path)
  await waitForUi(() => existsSync(created) && !panel.element.querySelector('.qe-explorer-inline-row') || false)
  await waitForUi(() => !fixture.reports.at(-1)?.loading)
  expect(findRow(panel.element, created)?.getAttribute('aria-selected')).toBe('true')
  for (const previous of previouslySelected) {
    expect(findRow(panel.element, previous)?.getAttribute('aria-selected')).not.toBe('true')
  }
  const state = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string }
    buffers: { id: string; relativePath: string }[]
    tabs: { bufferId: string }[]
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(state.explorer.selectedPaths).toEqual([created])
  expect(state.explorer.focusedPath).toBe(created)
  if (kind === 'file') {
    const buffer = state.buffers.find((entry) => entry.relativePath === path)
    expect(buffer).toBeDefined()
    expect(state.tabs.some((tab) => tab.bufferId === buffer!.id)).toBe(true)
  }
  await act(async () => footerButton(panel.element, 'Copy Path').click())
  expect(await navigator.clipboard.readText()).toBe(created)
  await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
  expect(await navigator.clipboard.readText()).toBe(path)
  await act(async () => footerButton(panel.element, 'Delete').click())
  await waitForUi(() => !existsSync(created))
  expect(existsSync(join(fixture.root, FILE_A))).toBe(true)
  expect(existsSync(parent)).toBe(true)
})

test('Explorer Rename closes row actions, focuses the inline field, and renames the file', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const originalPath = join(fixture.root, FILE_A)
  const renamedPath = join(fixture.root, 'nested/renamed-from-menu.txt')
  const row = findRow(panel.element, originalPath)
  expect(row).not.toBeNull()

  const rename = await actionButton(row!, 'Rename')
  await act(async () => rename.click())

  const input = panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]')
  expect(rowActionMenuOpen(row!)).toBe(false)
  expect(input).not.toBeNull()
  expect(document.activeElement).toBe(input)

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, basename(renamedPath))
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await waitForUi(() => existsSync(renamedPath) && !existsSync(originalPath) || false)
  await waitForUi(() => findRow(panel.element, renamedPath) || false)
  expect(readFileSync(renamedPath, 'utf8')).toBe('alpha\n')
  expect(findRow(panel.element, originalPath)).toBeNull()
})

test('Explorer identifies row and footer deletion targets without mutating after cancellation', async () => {
  const root = '/test'
  const worktree = 'delete-confirmation-test'
  const displayRoot = join(root, 'nested')
  const filePath = join(root, FILE_A)
  const folderPath = join(root, 'nested/archive')
  const listing = {
    root: displayRoot,
    entries: [
      { path: filePath, name: basename(filePath), isDirectory: false, isSymlink: false },
      { path: folderPath, name: basename(folderPath), isDirectory: true, isSymlink: false }
    ],
    showDotfiles: true,
    showIgnored: false,
    followSymlinkedDirectories: false
  }
  const confirmations: Parameters<UiPluginContext['confirm']>[0][] = []
  const deleteOperations: Record<string, unknown>[] = []
  let selectedPaths: string[] = []
  let focusedPath: string | null = null
  const context = {
    pluginId: 'quirky.editor',
    log() {},
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'quirky.editor/state') {
        return {
          buffers: [],
          tabs: [],
          explorer: {
            worktreeId: worktree,
            showDotfiles: true,
            expanded: [],
            selectedPaths: [...selectedPaths],
            focusedPath,
            selectionAnchor: focusedPath
          },
          search: null,
          quickOpenHistory: [],
          closeRequests: []
        }
      }
      if (method === 'quirky.editor/documentRoot') return { id: worktree, path: root }
      if (method === 'quirky.git/status') return { files: [] }
      if (method === 'quirky.editor/explorer') {
        if (params.action === 'select' && typeof params.path === 'string') {
          selectedPaths = [params.path]
          focusedPath = params.path
          return {
            ...listing,
            interaction: { selectedPaths: [...selectedPaths], focusedPath, selectionAnchor: focusedPath }
          }
        }
        return listing
      }
      if (method === 'quirky.editor/mutate' && params.action === 'delete') deleteOperations.push(params)
      return {}
    },
    subscribe: () => () => {},
    getSetting: (name: string) => {
      if (name === 'editorFontFamily') return 'monospace'
      if (name === 'editorAutoSaveDelayMs') return 1000
      if (name === 'editorSidebarWidth') return 320
      if (name === 'editorFontZoomLevel') return 0
      return false
    },
    getLayout: () => ({ worktree, view: null, panel: null, sidebar: true, focus: 'view' }),
    onLayout: () => () => {},
    onConnection: () => () => {},
    confirm: async (options: Parameters<UiPluginContext['confirm']>[0]) => {
      confirmations.push(options)
      return false
    },
    toast() {}
  } as unknown as UiPluginContext

  const panel = await renderStandaloneExplorer(context)
  try {
    await waitForUi(() => findRow(panel.element, filePath) && findRow(panel.element, folderPath) || false)

    const actions = [
      { targetPath: filePath, action: 'row' },
      { targetPath: folderPath, action: 'row' },
      { targetPath: filePath, action: 'footer' },
      { targetPath: folderPath, action: 'footer' }
    ] as const
    for (const { targetPath, action } of actions) {
      const confirmationIndex = confirmations.length
      if (action === 'row') {
        const row = findRow(panel.element, targetPath)
        if (!row) throw new Error(`Missing Explorer row ${targetPath}`)
        const button = await actionButton(row, 'Delete')
        await act(async () => button.click())
      } else {
        const row = findRow(panel.element, targetPath)
        if (!row) throw new Error(`Missing Explorer row ${targetPath}`)
        await act(async () => {
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        })
        await waitForUi(() => findRow(panel.element, targetPath)?.getAttribute('aria-selected') === 'true' || false)
        await act(async () => footerButton(panel.element, 'Delete').click())
      }

      const confirmation = await waitForUi(() => confirmations[confirmationIndex] ?? false)
      expect(confirmation.title).toContain(basename(targetPath))
      expect(deleteOperations).toEqual([])
    }
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer rename clears stale selection before row Delete and keeps footer state authoritative', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  context.confirm = async () => true
  const panel = await renderExplorer(fixture, context)
  const originalPath = join(fixture.root, FILE_A)
  const renamedPath = join(fixture.root, 'nested/renamed-selected.txt')
  const footerActions = ['Copy Path', 'Copy Relative Path', 'Delete'] as const
  const uiHasNoSelection = () =>
    panel.element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]').length === 0 &&
    footerActions.every((label) => footerButton(panel.element, label).disabled)

  await selectRow(panel.element, originalPath)
  const row = findRow(panel.element, originalPath)
  if (!row) throw new Error('Missing selected row for Rename')
  const rename = await actionButton(row, 'Rename')
  await act(async () => rename.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, basename(renamedPath))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await waitForUi(() => existsSync(renamedPath) && !existsSync(originalPath) && findRow(panel.element, renamedPath) || false)
  await waitForUi(() => uiHasNoSelection() || false)
  const stateAfterRename = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(stateAfterRename.explorer).toMatchObject({ selectedPaths: [], focusedPath: null, selectionAnchor: null })

  const renamedRow = findRow(panel.element, renamedPath)
  if (!renamedRow) throw new Error('Missing renamed row for Delete')
  const deleteAction = await actionButton(renamedRow, 'Delete')
  await act(async () => deleteAction.click())
  await waitForUi(() => !existsSync(renamedPath) && findRow(panel.element, renamedPath) === null || false)
  await waitForUi(() => uiHasNoSelection() || false)
  const stateAfterDelete = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(stateAfterDelete.explorer).toMatchObject({ selectedPaths: [], focusedPath: null, selectionAnchor: null })
})

test('Explorer Markdown Preview closes row actions and opens a real preview tab', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const path = join(fixture.root, MARKDOWN_FILE)
  const row = findRow(panel.element, path)
  expect(row).not.toBeNull()

  const preview = await actionButton(row!, 'Open Markdown Preview')
  await act(async () => preview.click())

  const opened = await waitForUi(async () => {
    const state = await call<{
      buffers: { id: string; relativePath: string }[]
      tabs: { bufferId: string; mode: string }[]
    }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
    const buffer = state.buffers.find((entry) => entry.relativePath === MARKDOWN_FILE)
    return buffer && state.tabs.some((tab) => tab.bufferId === buffer.id && tab.mode === 'preview')
      ? buffer
      : false
  })
  expect(opened.relativePath).toBe(MARKDOWN_FILE)
  expect(rowActionMenuOpen(row!)).toBe(false)
})

test('Explorer row action menus close on Escape and restore focus to the trigger', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const row = findRow(panel.element, join(fixture.root, FILE_A))
  expect(row).not.toBeNull()
  const trigger = rowActionTrigger(row!)
  const copyPath = await actionButton(row!, 'Copy Path')

  await act(async () => {
    copyPath.focus()
    copyPath.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })

  expect(rowActionMenuOpen(row!)).toBe(false)
  expect(document.activeElement).toBe(trigger)
})

test('Explorer row action menus dismiss on outside pointer interaction without running a menu action', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const row = findRow(panel.element, join(fixture.root, FILE_A))
  expect(row).not.toBeNull()
  await actionButton(row!, 'Copy Path')
  const outside = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
  expect(outside).not.toBeNull()

  await act(async () => {
    outside!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    outside!.click()
  })
  expect(rowActionMenuOpen(row!)).toBe(false)
  expect(clipboardWrites).toEqual([])
  expect(existsSync(join(fixture.root, FILE_A))).toBe(true)

  await actionButton(row!, 'Copy Path')
  await act(async () => outside!.focus())
  expect(rowActionMenuOpen(row!)).toBe(false)
  expect(clipboardWrites).toEqual([])
})

test('Explorer footer path actions are disabled until something is selected', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) expect(footerButton(panel.element, label).disabled).toBe(true)
  expect(footerButton(panel.element, 'Search in Files').disabled).toBe(false)
  await selectRow(panel.element, join(fixture.root, FILE_A))
  for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) expect(footerButton(panel.element, label).disabled).toBe(false)
})

for (const entryPoint of ['Contents', 'Search in Files']) {
  test(`Explorer footer cannot act on a hidden tree selection after ${entryPoint}`, async () => {
    const fixture = await makeFixture({ displayRoot: 'nested' })
    const context = makeContext(fixture)
    let confirmations = 0
    context.confirm = async () => { confirmations++; return true }
    const panel = await renderExplorer(fixture, context)
    const path = join(fixture.root, FILE_A)
    await selectRow(panel.element, path)

    const contentsButton = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
      .find((button) => button.textContent === 'Contents')!
    await act(async () => {
      if (entryPoint === 'Contents') contentsButton.click()
      else footerButton(panel.element, 'Search in Files').click()
    })

    expect(panel.element.querySelector('[role="tree"]')).toBeNull()
    for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) {
      const button = footerButton(panel.element, label)
      expect(button.disabled).toBe(true)
      await act(async () => button.click())
    }
    expect(confirmations).toBe(0)
    expect(clipboardWrites).toEqual([])
    expect(existsSync(path)).toBe(true)

    const namesButton = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
      .find((button) => button.textContent === 'Names')!
    await act(async () => namesButton.click())
    expect(findRow(panel.element, path)?.getAttribute('aria-selected')).toBe('true')
    for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) {
      expect(footerButton(panel.element, label).disabled).toBe(false)
    }
  })
}

test('Explorer footer Search in Files focuses the contents query', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const queryInput = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
  expect(queryInput).not.toBeNull()
  const contentsButton = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
    .find((button) => button.textContent === 'Contents')
  expect(contentsButton).not.toBeUndefined()
  const searchInFiles = footerButton(panel.element, 'Search in Files')

  await act(async () => {
    searchInFiles.focus()
    expect(document.activeElement).toBe(searchInFiles)
    searchInFiles.click()
  })

  expect(contentsButton?.getAttribute('aria-pressed')).toBe('true')
  expect(panel.element.querySelector('input[placeholder="Search"]')).toBe(queryInput)
  expect(document.activeElement).toBe(queryInput)

  await act(async () => {
    searchInFiles.focus()
    searchInFiles.click()
  })
  expect(queryInput!.value).toBe('')
  expect(document.activeElement).toBe(queryInput)
})


test('Explorer footer copies multi-selection paths and row drags satisfy the Terminal worktree-path contract', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  expect(fixture.listing.root).toBe(join(fixture.root, 'nested'))
  const panel = await renderExplorer(fixture)
  const absoluteA = join(fixture.root, FILE_A)
  const absoluteB = join(fixture.root, FILE_B)
  await selectRow(panel.element, absoluteA)
  await selectRow(panel.element, absoluteB)

  await act(async () => footerButton(panel.element, 'Copy Path').click())
  expect(await navigator.clipboard.readText()).toBe(`${absoluteA}\n${absoluteB}`)
  await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
  expect(await navigator.clipboard.readText()).toBe(`${FILE_A}\n${FILE_B}`)
  expect(clipboardWrites).toEqual([`${absoluteA}\n${absoluteB}`, `${FILE_A}\n${FILE_B}`])

  const row = findRow(panel.element, absoluteA)
  expect(row).not.toBeNull()
  const transfer = makeTransfer()
  await act(async () => { dispatchDrag(row!, 'dragstart', transfer) })
  const serialized = transfer.getData('application/x-quirky-worktree-paths')
  expect(JSON.parse(serialized)).toEqual({ worktreeId: fixture.worktree.id, paths: [FILE_A, FILE_B] })
  expect(decodeFileUris(transfer.getData('text/uri-list'))).toEqual([absoluteA, absoluteB])

  const terminalDrop = readWorktreePathsDrop(transfer)
  expect(terminalDrop).toEqual({ kind: 'valid', worktreeId: fixture.worktree.id, paths: [FILE_A, FILE_B] })
  if (terminalDrop.kind !== 'valid') throw new Error('Explorer drag did not produce a valid Terminal worktree-path payload')
  const resolved = resolveWorktreeDropPaths(fixture.documentRoot.path, terminalDrop.paths)
  expect(resolved).toEqual([absoluteA, absoluteB])
  if (resolved === null) throw new Error('Terminal rejected the Explorer worktree-relative path payload')
  expect(shellEscapePaths(resolved)).toBe(`'${fixture.root}/nested/A O'\\''Brien café #1? report.txt' '${fixture.root}/nested/B résumé #2.txt'`)
})

test('Explorer root drops use the full scroll-container hitbox', async () => {
  const fixture = await makeFixture()
  const panel = await renderExplorer(fixture)
  const scrollContainer = panel.element.querySelector<HTMLElement>('.qe-explorer-tree')
  if (!scrollContainer) throw new Error('Missing Explorer scroll container')

  const source = join(fixture.root, FILE_A)
  const destination = join(fixture.root, basename(FILE_A))
  const nestedRow = findRow(panel.element, join(fixture.root, 'nested'))
  if (!nestedRow) throw new Error('Missing nested directory row for root drop')
  await act(async () => nestedRow.click())
  await waitForUi(() => findRow(panel.element, source) || false)
  const sourceRow = findRow(panel.element, source)
  if (!sourceRow) throw new Error('Missing source row for root drop')
  const transfer = makeTransfer()
  await act(async () => { dispatchDrag(sourceRow, 'dragstart', transfer) })

  let dragOver: Event | undefined
  await act(async () => { dragOver = dispatchDrag(scrollContainer, 'dragover', transfer) })
  expect(dragOver?.defaultPrevented).toBe(true)

  const reportStart = fixture.reports.length
  let drop: Event | undefined
  await act(async () => { drop = dispatchDrag(scrollContainer, 'drop', transfer) })
  expect(drop?.defaultPrevented).toBe(true)
  const result = await waitForUi(() => {
    if (existsSync(destination) && !existsSync(source)) return 'moved'
    const alert = panel.element.querySelector('[role="alert"]')
    return alert?.textContent ? `error: ${alert.textContent}` : false
  })
  expect(result).toBe('moved')
  await waitForExplorerRefresh(fixture, reportStart)
  expect(existsSync(source)).toBe(false)
  expect(readFileSync(destination, 'utf8')).toBe('alpha\n')
  expect(panel.element.querySelector('[role="alert"]')).toBeNull()
}, 30_000)

test('Explorer row drops keep same-folder paths unchanged and move to a different folder', async () => {
  const fixture = await makeFixture()
  expect(fixture.listing.root).toBe(fixture.documentRoot.path)
  const panel = await renderExplorer(fixture)
  const nested = join(fixture.root, 'nested')
  const nestedRow = findRow(panel.element, nested)
  expect(nestedRow).not.toBeNull()
  await act(async () => nestedRow!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await waitForUi(() => findRow(panel.element, join(fixture.root, FILE_A)))

  const source = join(fixture.root, FILE_A)
  const archive = join(fixture.root, 'nested/archive')
  const sourceRow = findRow(panel.element, source)
  const archiveRow = findRow(panel.element, archive)
  expect(sourceRow).not.toBeNull()
  expect(archiveRow).not.toBeNull()

  const firstTransfer = makeTransfer()
  await act(async () => { dispatchDrag(sourceRow!, 'dragstart', firstTransfer) })
  const sameFolderReportStart = fixture.reports.length
  let sameFolderDrop: Event | undefined
  await act(async () => { sameFolderDrop = dispatchDrag(nestedRow!, 'drop', firstTransfer) })
  await waitForExplorerRefresh(fixture, sameFolderReportStart)
  expect(sameFolderDrop?.defaultPrevented).toBe(true)
  expect(existsSync(source)).toBe(true)
  expect(panel.element.querySelector('[role="alert"]')).toBeNull()

  const movedPath = join(archive, "A O'Brien café #1? report.txt")
  const secondTransfer = makeTransfer()
  const currentSourceRow = findRow(panel.element, source)
  const currentArchiveRow = findRow(panel.element, archive)
  expect(currentSourceRow).not.toBeNull()
  expect(currentArchiveRow).not.toBeNull()
  await act(async () => { dispatchDrag(currentSourceRow!, 'dragstart', secondTransfer) })
  const moveReportStart = fixture.reports.length
  await act(async () => { dispatchDrag(currentArchiveRow!, 'drop', secondTransfer) })
  await waitForUi(() => existsSync(movedPath) && !existsSync(source))
  await waitForExplorerRefresh(fixture, moveReportStart)
  expect(existsSync(source)).toBe(false)
  expect(existsSync(movedPath)).toBe(true)
  expect(readFileSync(movedPath, 'utf8')).toBe('alpha\n')
})
function replaceSelectedInputText(input: HTMLInputElement, replacement: string): void {
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? start
  const value = input.value.slice(0, start) + replacement + input.value.slice(end)
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setValue) throw new Error('Input value setter is unavailable')
  setValue.call(input, value)
  input.setSelectionRange(start + replacement.length, start + replacement.length)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('Explorer rename starts with the filename, selects its stem, and keeps the source parent', async () => {
  const fixture = await makeFixture({
    displayRoot: 'nested',
    extraFiles: {
      'nested/NOTICE': 'notice\n',
      'nested/.env.local': 'environment\n',
      'nested/cache.v2/inside.txt': 'inside\n'
    }
  })
  const noExtension = join(fixture.root, 'nested/NOTICE')
  const dotfile = join(fixture.root, 'nested/.env.local')
  const dottedDirectory = join(fixture.root, 'nested/cache.v2')
  await call(fixture.client, 'quirky.editor/explorer', {
    worktree: fixture.worktree.id,
    action: 'preferences',
    showDotfiles: true
  })

  const panel = await renderExplorer(fixture)
  const source = join(fixture.root, FILE_A)
  const sourceRow = findRow(panel.element, source)
  expect(sourceRow).not.toBeNull()
  const sourceRename = await actionButton(sourceRow!, 'Rename')
  await act(async () => sourceRename.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  expect(input.value).toBe(basename(FILE_A))
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, basename(FILE_A).lastIndexOf('.')])

  await act(async () => replaceSelectedInputText(input, 'renamed'))
  await waitForUi(() => input.value === 'renamed.txt' || false)
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const renamed = join(dirname(source), 'renamed.txt')
  await waitForUi(() => existsSync(renamed) && !existsSync(source))
  expect(existsSync(source)).toBe(false)
  expect(existsSync(renamed)).toBe(true)
  expect(readFileSync(renamed, 'utf8')).toBe('alpha\n')

  const noExtensionRow = findRow(panel.element, noExtension)
  expect(noExtensionRow).not.toBeNull()
  await selectRow(panel.element, noExtension)
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  expect(tree).not.toBeNull()
  await act(async () => {
    tree!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const keyboardInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  expect(keyboardInput.value).toBe('NOTICE')
  expect([keyboardInput.selectionStart, keyboardInput.selectionEnd]).toEqual([0, 'NOTICE'.length])
  await act(async () => {
    keyboardInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => panel.element.querySelector('input[aria-label="Rename file"]') === null || false)
  expect(existsSync(noExtension)).toBe(true)

  const dotfileRow = findRow(panel.element, dotfile)
  expect(dotfileRow).not.toBeNull()
  const dotfileRename = await actionButton(dotfileRow!, 'Rename')
  await act(async () => dotfileRename.click())
  const dotfileInput = await waitForUi(() => {
    const candidate = panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]')
    return candidate?.value === '.env.local' ? candidate : false
  })
  expect([dotfileInput.selectionStart, dotfileInput.selectionEnd]).toEqual([0, '.env'.length])
  await act(async () => {
    dotfileInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => panel.element.querySelector('input[aria-label="Rename file"]') === null || false)

  const directoryRow = findRow(panel.element, dottedDirectory)
  expect(directoryRow).not.toBeNull()
  const directoryRename = await actionButton(directoryRow!, 'Rename')
  await act(async () => directoryRename.click())
  const directoryInput = await waitForUi(() => {
    const candidate = panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]')
    return candidate?.value === 'cache.v2' ? candidate : false
  })
  expect([directoryInput.selectionStart, directoryInput.selectionEnd]).toEqual([0, 'cache.v2'.length])
  await act(async () => {
    directoryInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}, 30_000)

test('Explorer rename preserves backslashes that are POSIX filename characters', async () => {
  const fixture = await makeFixture({
    displayRoot: 'nested',
    extraFiles: { 'nested/a\\b.txt': 'backslash filename\n' }
  })
  const source = join(fixture.root, 'nested/a\\b.txt')
  const panel = await renderExplorer(fixture)
  const row = findRow(panel.element, source)
  expect(row).not.toBeNull()
  await act(async () => rowActionTrigger(row!).click())
  await waitForUi(() => rowActionMenuOpen(row!) || false)
  const menu = row!.querySelector<HTMLElement>('[role="menu"]')
  const renameButton = menu && Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((button) => button.textContent?.trim() === 'Rename')
  if (!renameButton) throw new Error('Missing Rename action for the backslash filename')
  await act(async () => renameButton.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  expect(input.value).toBe('a\\b.txt')

  await act(async () => replaceSelectedInputText(input, 'renamed'))
  await waitForUi(() => input.value === 'renamed.txt' || false)
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })

  const destination = join(dirname(source), 'renamed.txt')
  await waitForUi(() => !existsSync(source))
  expect(existsSync(destination)).toBe(true)
  expect(readFileSync(destination, 'utf8')).toBe('backslash filename\n')
}, 30_000)

test('Explorer rename preserves leading spaces in a filename on submit', async () => {
  const filename = ' leading.txt'
  const fixture = await makeFixture({
    displayRoot: 'nested',
    extraFiles: { [`nested/${filename}`]: 'leading space filename\n' }
  })
  const source = join(fixture.root, 'nested', filename)
  const panel = await renderExplorer(fixture)
  const row = findRow(panel.element, source)
  expect(row).not.toBeNull()
  const renameButton = await actionButton(row!, 'Rename')
  await act(async () => renameButton.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  expect(input.value).toBe(filename)
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => panel.element.querySelector('input[aria-label="Rename file"]') === null || false)

  expect(existsSync(source)).toBe(true)
  expect(readFileSync(source, 'utf8')).toBe('leading space filename\n')
  expect(existsSync(join(dirname(source), 'leading.txt'))).toBe(false)
}, 30_000)

test('Explorer contents results open after normal tabs without changing their pin or order', async () => {
  const fixture = await makeFixture({ extraFiles: { 'README.md': 'needle in the README\n' } })
  const pinned = await call<{ id: string; openedTabId: string }>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktree.id,
    path: FILE_A,
    preview: false,
    pinned: true,
    focus: false
  })
  const current = await call<{ id: string; openedTabId: string }>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktree.id,
    path: FILE_B,
    preview: false,
    pinned: false,
    focus: true
  })
  const readEditorState = () => call<{
    buffers: { id: string; relativePath: string; pinned: boolean; preview: boolean; tabId: string | null; view: Record<string, unknown> }[]
    tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview' }[]
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  const readWorkspace = async () => (await call<{ workspace: Workspace }>(
    fixture.client,
    'quirky.terminal/workspace',
    { workspace: fixture.worktree.id }
  )).workspace
  const documentTabs = (workspace: Workspace, tabIds: string[]) => groupsInOrder(workspace.root)
    .flatMap((group) => group.tabs.flatMap((tab) =>
      tab.kind === 'view' && tabIds.includes(tab.id)
        ? [{ id: tab.id, bufferId: tab.input?.bufferId, pinned: tab.pinned, preview: tab.preview }]
        : []
    ))

  const beforeTabs = documentTabs(await readWorkspace(), [pinned.openedTabId, current.openedTabId])
  expect(beforeTabs).toEqual([
    { id: pinned.openedTabId, bufferId: pinned.id, pinned: true, preview: false },
    { id: current.openedTabId, bufferId: current.id, pinned: false, preview: false }
  ])

  const panel = await renderExplorer(fixture)
  const contentsMode = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
    .find((button) => button.textContent === 'Contents')
  expect(contentsMode).not.toBeUndefined()
  await act(async () => contentsMode!.click())
  const queryInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]') ?? false)
  await act(async () => replaceSelectedInputText(queryInput, 'needle'))
  const searchButton = panel.element.querySelector<HTMLButtonElement>('.qe-explorer-query button')
  expect(searchButton).not.toBeNull()
  await act(async () => searchButton!.click())
  const readmeResult = await waitForUi(() => {
    const section = Array.from(panel.element.querySelectorAll<HTMLElement>('.qe-search-file'))
      .find((entry) => entry.querySelector('h4')?.textContent === 'README.md')
    return section?.querySelector<HTMLButtonElement>('button') ?? false
  })
  await act(async () => readmeResult.click())

  const after = await waitForUi(async () => {
    const state = await readEditorState()
    const buffer = state.buffers.find((entry) => entry.relativePath === 'README.md')
    if (!buffer || buffer.tabId === null) return false
    return { state, buffer, tabId: buffer.tabId }
  })
  expect(after.buffer.view).toMatchObject({
    byTabId: { [after.tabId]: { line: 1, column: 1, matchLength: 6, focused: true } }
  })
  expect(after.buffer).toMatchObject({ pinned: false, preview: false })
  expect(after.state.tabs.map(({ tabId, bufferId, mode }) => ({ tabId, bufferId, mode }))).toEqual([
    { tabId: pinned.openedTabId, bufferId: pinned.id, mode: 'edit' },
    { tabId: current.openedTabId, bufferId: current.id, mode: 'edit' },
    { tabId: after.tabId, bufferId: after.buffer.id, mode: 'edit' }
  ])
  expect(documentTabs(await readWorkspace(), [pinned.openedTabId, current.openedTabId, after.tabId])).toEqual([
    ...beforeTabs,
    { id: after.tabId, bufferId: after.buffer.id, pinned: false, preview: false }
  ])
}, 30_000)
