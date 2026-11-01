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
import { ConfirmHost, confirmForPlugin } from '../../../packages/ui/src/components/ConfirmHost'
import { registerIsolatedEditorFixtures } from './isolated-environment'

type Worktree = { id: string; path: string }
type ExplorerEntry = { path: string; name: string; isDirectory: boolean }
type ExplorerListing = { root: string; entries: ExplorerEntry[] }
type DocumentRoot = { id: string; path: string }
type ExplorerReport = { loading: boolean; error: string | null; expandedCount: number }
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

function interceptExplorerChanged(context: UiPluginContext, fixture: Fixture): () => void {
  const listeners = new Set<Parameters<UiPluginContext['subscribe']>[0]>()
  const subscribe = context.subscribe
  context.subscribe = (next) => {
    listeners.add(next)
    const unsubscribe = subscribe((event) => {
      if (event.type !== 'quirky.editor/explorerChanged') void next(event)
    })
    return () => {
      listeners.delete(next)
      unsubscribe()
    }
  }
  return () => {
    for (const listener of listeners) {
      void listener({
        type: 'quirky.editor/explorerChanged',
        data: { worktreeId: fixture.worktree.id }
      })
    }
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
  check: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  return await waitForAsync(async () => {
    await flushReact()
    return await check()
  }, timeoutMs)
}

async function waitForNextAnimationFrame(): Promise<void> {
  const frame = Promise.withResolvers<void>()
  requestAnimationFrame(() => frame.resolve())
  await frame.promise
}

async function renderExplorer(fixture: Fixture, context = makeContext(fixture), includeConfirmHost = false): Promise<Mounted> {
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
    root.render(
      <>
        <ExplorerPanel context={context} report={(value) => {
          if (typeof value !== 'object' || value === null || !('loading' in value) || typeof value.loading !== 'boolean') return
          fixture.reports.push({
            loading: value.loading,
            error: 'error' in value && typeof value.error === 'string' ? value.error : null,
            expandedCount: 'expandedCount' in value && typeof value.expandedCount === 'number' ? value.expandedCount : 0
          })
        }} />
        {includeConfirmHost && <ConfirmHost />}
      </>
    )
  })
  await waitForUi(() => fixture.listing.entries.some((entry) => findRow(element, entry.path)))
  return surface
}

async function renderStandaloneExplorer(context: UiPluginContext, includeConfirmHost = false): Promise<Mounted> {
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
    root.render(
      <>
        <ExplorerPanel context={context} />
        {includeConfirmHost && <ConfirmHost />}
      </>
    )
  })
  return surface
}

function rowActionTrigger(row: HTMLElement): HTMLButtonElement {
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-label^="Actions for "]')
  if (!trigger) throw new Error(`Missing row actions for ${row.dataset.path}`)
  return trigger
}

function rowActionMenu(row: HTMLElement): HTMLElement | null {
  const name = rowActionTrigger(row).getAttribute('aria-label')
  return name === null
    ? null
    : Array.from(document.querySelectorAll<HTMLElement>('[role="menu"][aria-label]'))
      .find((menu) => menu.getAttribute('aria-label') === name) ?? null
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
  const menu = rowActionMenu(row)
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

function expectTreeFocus(element: HTMLElement, path: string | null): void {
  const tree = element.querySelector<HTMLElement>('[role="tree"]')
  if (!tree) throw new Error('Missing Explorer tree')
  expect(document.activeElement === tree).toBe(true)
  if (path === null) {
    expect(tree.getAttribute('aria-activedescendant')).toBeNull()
    return
  }
  const row = findRow(element, path)
  if (!row) throw new Error(`Missing focused Explorer row ${path}`)
  expect(tree.getAttribute('aria-activedescendant')).toBe(row.id)
}

async function waitForTreeFocus(element: HTMLElement, path: string | null): Promise<void> {
  await waitForUi(() => {
    const tree = element.querySelector<HTMLElement>('[role="tree"]')
    if (tree === null || document.activeElement !== tree) return false
    if (path === null) {
      return tree.getAttribute('aria-activedescendant') === null &&
        element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]').length === 0
    }
    const row = findRow(element, path)
    return row !== null && tree.getAttribute('aria-activedescendant') === row.id &&
      row.getAttribute('aria-selected') === 'true'
  })
  expectTreeFocus(element, path)
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
test.each([
  { action: 'New File', dismissal: 'Escape' },
  { action: 'New File', dismissal: 'Cancel' },
  { action: 'New Folder', dismissal: 'Escape' },
  { action: 'New Folder', dismissal: 'Cancel' },
  { action: 'Rename', dismissal: 'Escape' },
  { action: 'Rename', dismissal: 'Cancel' }
] as const)('Explorer clears failed $action error after $dismissal', async ({ action, dismissal }) => {
  const { context, filePath } = makeDeleteConfirmationFixture()
  const mutationAction = action === 'New File' ? 'createFile' : action === 'New Folder' ? 'createFolder' : 'rename'
  const errorMessage = `injected ${action} failure`
  const originalCall = context.call
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && params.action === mutationAction) throw new Error(errorMessage)
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderStandaloneExplorer(context)

  try {
    await waitForUi(() => findRow(panel.element, filePath) ?? false)
    let input: HTMLInputElement
    let failurePath: string
    let submit: HTMLButtonElement

    if (action === 'New File' || action === 'New Folder') {
      const createAction = panel.element.querySelector<HTMLButtonElement>(`button[title="${action}"]`)
      if (!createAction) throw new Error(`Missing ${action} action`)
      await act(async () => createAction.click())
      input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input') ?? false)
      failurePath = action === 'New File' ? 'failed-create.txt' : 'failed-create-folder'
      const inlineRow = input.closest<HTMLElement>('.qe-explorer-inline-row')
      if (!inlineRow) throw new Error(`Missing inline form for ${action}`)
      const createButton = Array.from(inlineRow.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Create')
      if (!createButton) throw new Error(`Missing Create action for ${action}`)
      submit = createButton
    } else {
      const sourceRow = findRow(panel.element, filePath)
      if (!sourceRow) throw new Error('Missing rename source row')
      const renameAction = await actionButton(sourceRow, 'Rename')
      await act(async () => renameAction.click())
      input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
      failurePath = 'failed-rename.txt'
      const inlineRow = input.closest<HTMLElement>('.qe-explorer-inline-row')
      if (!inlineRow) throw new Error('Missing inline Rename form')
      const renameButton = Array.from(inlineRow.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Rename')
      if (!renameButton) throw new Error('Missing Rename action')
      submit = renameButton
    }

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, failurePath)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => submit.click())
    const errorText = await waitForUi(() => panel.element.querySelector<HTMLElement>('[role="alert"]')?.textContent?.trim() || false)
    expect(errorText).toBe(errorMessage)
    expect(input.isConnected).toBe(true)

    if (dismissal === 'Escape') {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
    } else {
      const inlineRow = input.closest<HTMLElement>('.qe-explorer-inline-row')
      if (!inlineRow) throw new Error('Missing inline form before Cancel')
      const cancel = Array.from(inlineRow.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Cancel')
      if (!cancel) throw new Error(`Missing Cancel action for ${action}`)
      if (action !== 'Rename') {
        const blurDelay = Promise.withResolvers<void>()
        setTimeout(blurDelay.resolve, 210)
        await blurDelay.promise
        await act(async () => {
          input.focus()
          input.blur()
          cancel.click()
        })
      } else {
        await act(async () => cancel.click())
      }
    }

    await waitForUi(() => !input.isConnected || false)
    if (dismissal === 'Cancel' && action !== 'Rename') {
      const delay = Promise.withResolvers<void>()
      setTimeout(delay.resolve, 200)
      await delay.promise
    }
    expect(panel.element.querySelector('[role="alert"]')).toBeNull()
  } finally {
    await panel.unmount()
  }
}, 60_000)

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
  { kind: 'file', path: 'created-during-watcher.txt', nested: false },
  { kind: 'folder', path: 'created-during-watcher-folder', nested: false },
  { kind: 'file', path: 'nested/created-during-watcher.txt', nested: true },
  { kind: 'folder', path: 'nested/created-during-watcher-folder', nested: true }
] as const)('Explorer keeps a new $kind at $path selected when a watcher overlaps its listing', async ({ kind, path, nested }) => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  const emitExplorerChanged = interceptExplorerChanged(context, fixture)
  const originalCall = context.call
  const makeListingGate = () => ({ started: false, released: Promise.withResolvers<void>() })
  const createListingGate = makeListingGate()
  const watcherListingGate = makeListingGate()
  const rootListingGates: (typeof createListingGate)[] = []
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined) {
      const gate = rootListingGates.shift()
      if (gate !== undefined) {
        gate.started = true
        await gate.released.promise
      }
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)

  try {
    const parent = join(fixture.root, 'nested')
    if (nested) {
      await act(async () => findRow(panel.element, parent)!.click())
      await waitForUi(() => findRow(panel.element, join(fixture.root, FILE_A)) || false)
      await selectRow(panel.element, join(fixture.root, FILE_A))
    } else {
      await selectRow(panel.element, parent)
    }

    const newButton = panel.element.querySelector<HTMLButtonElement>(`button[title="New ${kind === 'file' ? 'File' : 'Folder'}"]`)
    if (!newButton) throw new Error(`Missing New ${kind} action`)
    await act(async () => newButton.click())
    const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input') ?? false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const create = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-inline-row button'))
      .find((button) => button.textContent === 'Create')
    if (!create) throw new Error(`Missing Create action for new ${kind}`)

    rootListingGates.push(createListingGate, watcherListingGate)
    await act(async () => create.click())
    await waitForUi(() => createListingGate.started || false)
    emitExplorerChanged()
    const debounce = Promise.withResolvers<void>()
    setTimeout(debounce.resolve, 150)
    await act(async () => { await debounce.promise })
    createListingGate.released.resolve()
    await waitForUi(() => watcherListingGate.started || false)
    await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)

    const created = join(fixture.root, path)
    const row = findRow(panel.element, created)
    expect(row).not.toBeNull()
    expect(row!.getAttribute('aria-selected')).toBe('true')
  } finally {
    createListingGate.released.resolve()
    watcherListingGate.released.resolve()
    await panel.unmount()
  }
}, 60_000)
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

test('Explorer Duplicate selects and opens the copy and targets it in footer actions', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  context.confirm = async () => true
  const panel = await renderExplorer(fixture, context)
  const source = join(fixture.root, ARCHIVE_FILE)
  const copyRelativePath = 'nested/archive/keep copy.txt'
  const copy = join(fixture.root, copyRelativePath)
  const archive = join(fixture.root, 'nested/archive')

  await act(async () => findRow(panel.element, archive)!.click())
  await waitForUi(() => findRow(panel.element, source) || false)
  const sourceRow = findRow(panel.element, source)
  if (!sourceRow) throw new Error('Missing expanded source row for Duplicate')
  await act(async () => sourceRow.click())
  await waitForUi(() =>
    findRow(panel.element, source)?.getAttribute('aria-selected') === 'true' &&
    panel.element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]').length === 1 || false
  )

  const selectedSourceRow = findRow(panel.element, source)
  if (!selectedSourceRow) throw new Error('Missing selected source row for Duplicate')
  const duplicate = await actionButton(selectedSourceRow, 'Duplicate')
  await act(async () => duplicate.click())
  const openedCopy = await waitForUi(async () => {
    const state = await call<{
      explorer: { selectedPaths: string[] }
      buffers: { id: string; relativePath: string; tabId: string | null }[]
      tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview' }[]
    }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
    const buffer = state.buffers.find((entry) => entry.relativePath === copyRelativePath)
    return buffer && state.tabs.some((tab) => tab.bufferId === buffer.id) ? { state, buffer } : false
  }, 30_000)
  expect(openedCopy.state.explorer.selectedPaths).toEqual([copy])
  expect(openedCopy.state.tabs).toContainEqual(expect.objectContaining({ bufferId: openedCopy.buffer.id }))
  await waitForUi(() => findRow(panel.element, copy) || false)
  expect(findRow(panel.element, copy)?.getAttribute('aria-selected')).toBe('true')
  expect(panel.element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]')).toHaveLength(1)

  await act(async () => footerButton(panel.element, 'Copy Path').click())
  expect(await navigator.clipboard.readText()).toBe(copy)
  await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
  expect(await navigator.clipboard.readText()).toBe(copyRelativePath)
  await act(async () => footerButton(panel.element, 'Delete').click())
  await waitForUi(() => !existsSync(copy))
  expect(existsSync(source)).toBe(true)
}, 60_000)

test('Explorer Rename closes row actions, then focuses the renamed tree row after Enter', async () => {
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
  await waitForTreeFocus(panel.element, renamedPath)
})

test('Explorer renaming to a hidden file selects the next visible neighbor when dotfiles are hidden', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  await call(fixture.client, 'quirky.editor/explorer', {
    worktree: fixture.worktree.id,
    action: 'preferences',
    showDotfiles: false
  })
  const panel = await renderExplorer(fixture)
  const source = join(fixture.root, FILE_A)
  const hiddenTarget = join(fixture.root, 'nested/.hidden.txt')
  const visibleRowsBefore = Array.from(panel.element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    .map((item) => item.dataset.path)
    .filter((path): path is string => path !== undefined)
  const sourceIndex = visibleRowsBefore.indexOf(source)
  expect(sourceIndex).toBeGreaterThanOrEqual(0)
  const neighbor = visibleRowsBefore.slice(sourceIndex + 1)[0] ??
    visibleRowsBefore.slice(0, sourceIndex).reverse()[0]
  if (!neighbor) throw new Error('Expected a visible neighbor for the renamed row')

  const row = findRow(panel.element, source)
  if (!row) throw new Error('Missing source row for hidden rename')
  const rename = await actionButton(row, 'Rename')
  await act(async () => rename.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, basename(hiddenTarget))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })

  await waitForUi(() => existsSync(hiddenTarget) && !existsSync(source) || false)
  await waitForUi(() => findRow(panel.element, source) === null && findRow(panel.element, neighbor) !== null || false)
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  if (!tree) throw new Error('Missing Explorer tree')
  await waitForUi(() => {
    const alert = panel.element.querySelector('[role="alert"]')
    const focusedNeighbor = findRow(panel.element, neighbor)
    return alert !== null || (
      document.activeElement === tree &&
      tree.getAttribute('aria-activedescendant') === focusedNeighbor?.id &&
      focusedNeighbor?.getAttribute('aria-selected') === 'true'
    ) || false
  })
  expect(panel.element.querySelector('[role="alert"]') === null).toBe(true)
  await waitForTreeFocus(panel.element, neighbor)
  expect(findRow(panel.element, hiddenTarget)).toBeNull()
  const state = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(state.explorer).toMatchObject({
    selectedPaths: [neighbor],
    focusedPath: neighbor,
    selectionAnchor: neighbor
  })
}, 60_000)

function makeDeleteConfirmationFixture() {
  const root = '/test'
  const worktree = 'delete-confirmation-test'
  const filePath = join(root, FILE_A)
  const folderPath = join(root, 'nested/archive')
  const listing = {
    root: join(root, 'nested'),
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

  return { context, filePath, folderPath, confirmations, deleteOperations }
}

async function selectDeleteFixturePath(panel: Mounted, path: string): Promise<void> {
  const row = findRow(panel.element, path)
  if (!row) throw new Error(`Missing Explorer row ${path}`)
  await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await waitForUi(() => findRow(panel.element, path)?.getAttribute('aria-selected') === 'true' || false)
}
test('Explorer identifies row and footer deletion targets without mutating after cancellation', async () => {
  const { context, filePath, folderPath, confirmations, deleteOperations } = makeDeleteConfirmationFixture()
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

    const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
    if (!tree) throw new Error('Missing Explorer tree')
    await act(async () => {
      tree.focus()
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    await waitForUi(() => confirmations.length === actions.length + 1 || false)
    await waitForTreeFocus(panel.element, folderPath)
    expect(deleteOperations).toEqual([])
  } finally {
    await panel.unmount()
  }
}, 60_000)

for (const dismissal of ['Cancel', 'Escape'] as const) {
  test(`Explorer footer Delete restores trigger focus when confirmation closes by ${dismissal}`, async () => {
    const { context, filePath, deleteOperations } = makeDeleteConfirmationFixture()
    context.confirm = confirmForPlugin
    const panel = await renderStandaloneExplorer(context, true)

    try {
      await selectDeleteFixturePath(panel, filePath)
      const trigger = footerButton(panel.element, 'Delete')
      await act(async () => trigger.focus())
      expect(document.activeElement).toBe(trigger)
      await act(async () => trigger.click())

      const dialog = await waitForUi(() => panel.element.querySelector<HTMLElement>('[role="dialog"]') ?? false)
      expect(dialog.getAttribute('aria-label')).toContain(basename(filePath))
      const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Cancel')
      if (!cancel) throw new Error('Missing Cancel action in confirmation dialog')
      await act(async () => cancel.focus())
      expect(document.activeElement).toBe(cancel)

      if (dismissal === 'Cancel') {
        await act(async () => cancel.click())
      } else {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
      }

      await waitForUi(() => panel.element.querySelector('[role="dialog"]') === null || false)
      await waitForNextAnimationFrame()
      expect(document.activeElement).toBe(trigger)
      expect(findRow(panel.element, filePath)?.getAttribute('aria-selected')).toBe('true')
      expect(deleteOperations).toEqual([])
    } finally {
      await panel.unmount()
    }
  }, 60_000)
}

test('Explorer footer cancellation preserves focus in a queued confirmation', async () => {
  const { context, filePath, deleteOperations } = makeDeleteConfirmationFixture()
  context.confirm = confirmForPlugin
  const panel = await renderStandaloneExplorer(context, true)
  let queuedConfirmation: Promise<boolean> | undefined

  try {
    await selectDeleteFixturePath(panel, filePath)
    const trigger = footerButton(panel.element, 'Delete')
    await act(async () => trigger.focus())
    await act(async () => trigger.click())

    const deleteDialog = await waitForUi(() => panel.element.querySelector<HTMLElement>('[role="dialog"]') ?? false)
    const deleteCancel = Array.from(deleteDialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Cancel')
    if (!deleteCancel) throw new Error('Missing Cancel action in deletion confirmation')
    await act(async () => deleteCancel.focus())

    await act(async () => {
      queuedConfirmation = confirmForPlugin({ title: 'Queued confirmation', body: 'The next request stays open.' })
    })
    await act(async () => deleteCancel.click())

    const queuedDialog = await waitForUi(() => {
      const dialog = panel.element.querySelector<HTMLElement>('[role="dialog"]')
      return dialog?.getAttribute('aria-label') === 'Queued confirmation' ? dialog : false
    })
    await waitForNextAnimationFrame()
    expect(document.activeElement).not.toBe(trigger)
    expect(queuedDialog.contains(document.activeElement)).toBe(true)
    expect(findRow(panel.element, filePath)?.getAttribute('aria-selected')).toBe('true')
    expect(deleteOperations).toEqual([])

    const queuedCancel = Array.from(queuedDialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Cancel')
    if (!queuedCancel) throw new Error('Missing Cancel action in queued confirmation')
    await act(async () => queuedCancel.click())
    if (!queuedConfirmation) throw new Error('Queued confirmation was not created')
    expect(await queuedConfirmation).toBe(false)
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer selects the renamed row and previous neighbor after successful mutations', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  context.confirm = async () => true
  const panel = await renderExplorer(fixture, context)
  const originalPath = join(fixture.root, FILE_A)
  const renamedPath = join(fixture.root, 'nested/zz-renamed-selected.txt')
  const footerActions = ['Copy Path', 'Copy Relative Path', 'Delete'] as const
  const uiHasSelection = (path: string) =>
    findRow(panel.element, path)?.getAttribute('aria-selected') === 'true' &&
    panel.element.querySelectorAll<HTMLElement>('[data-path][aria-selected="true"]').length === 1 &&
    footerActions.every((label) => !footerButton(panel.element, label).disabled)

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
  await waitForUi(() => uiHasSelection(renamedPath) || false)
  await waitForTreeFocus(panel.element, renamedPath)
  const stateAfterRename = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(stateAfterRename.explorer).toMatchObject({
    selectedPaths: [renamedPath],
    focusedPath: renamedPath,
    selectionAnchor: renamedPath
  })

  const renamedRow = findRow(panel.element, renamedPath)
  if (!renamedRow) throw new Error('Missing renamed row for Delete')

  const rowsBeforeDelete = Array.from(panel.element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    .map((item) => item.dataset.path)
    .filter((path): path is string => path !== undefined)
  const lastRowPath = rowsBeforeDelete[rowsBeforeDelete.length - 1]
  expect(lastRowPath).toBe(renamedPath)
  const previousPath = rowsBeforeDelete[rowsBeforeDelete.length - 2] ?? null
  if (previousPath === null) throw new Error('Expected a previous row for the last-item deletion')
  const deleteAction = await actionButton(renamedRow, 'Delete')
  await act(async () => deleteAction.click())
  await waitForUi(() => !existsSync(renamedPath) && findRow(panel.element, renamedPath) === null || false)
  await waitForUi(() => uiHasSelection(previousPath) || false)
  await waitForTreeFocus(panel.element, previousPath)
  const stateAfterDelete = await call<{
    explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
  }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
  expect(stateAfterDelete.explorer).toMatchObject({
    selectedPaths: [previousPath],
    focusedPath: previousPath,
    selectionAnchor: previousPath
  })
})

test('Explorer confirmed deletion focuses the next survivor, skips descendants, then falls back to previous or empty tree', async () => {
  const fixture = await makeFixture({
    displayRoot: 'nested',
    extraFiles: { 'nested/archive/second.txt': 'second archive entry\n' }
  })
  const fileA = join(fixture.root, FILE_A)
  const context = makeContext(fixture)
  context.confirm = async () => true
  const terminalControl = document.createElement('textarea')
  terminalControl.setAttribute('aria-label', 'Terminal input')
  document.body.append(terminalControl)
  let terminalFocusedDuringDelete = false
  const originalCall = context.call
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    const result = await originalCall(method, params)
    if (
      !terminalFocusedDuringDelete &&
      method === 'quirky.editor/mutate' &&
      params.action === 'delete' &&
      params.path === fileA
    ) {
      terminalControl.focus()
      terminalFocusedDuringDelete = document.activeElement === terminalControl
    }
    return result
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const fileB = join(fixture.root, FILE_B)
  const archive = join(fixture.root, 'nested/archive')
  const archiveFile = join(fixture.root, ARCHIVE_FILE)
  const lastFile = join(fixture.root, MARKDOWN_FILE)
  const treePaths = () => Array.from(panel.element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    .map((row) => row.dataset.path)
    .filter((path): path is string => path !== undefined)

  const focusTransitions: { focused: boolean; path: string | null }[] = []
  const removeAndCaptureFocus = async (path: string) => {
    const before = treePaths()
    const index = before.indexOf(path)
    expect(index).toBeGreaterThanOrEqual(0)
    const next = before.slice(index + 1).find((candidate) => !candidate.startsWith(`${path}/`))
    const previous = before.slice(0, index).reverse().find((candidate) => !candidate.startsWith(`${path}/`))
    const expected = next ?? previous ?? null
    const row = findRow(panel.element, path)
    if (!row) throw new Error(`Missing Explorer row ${path}`)
    const button = await actionButton(row, 'Delete')
    await act(async () => button.click())
    await waitForUi(() => !existsSync(path) && findRow(panel.element, path) === null || false)
    await waitForTreeFocus(panel.element, expected)
    const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
    const activeId = tree?.getAttribute('aria-activedescendant')
    const activeRow = activeId === null || activeId === undefined
      ? null
      : Array.from(panel.element.querySelectorAll<HTMLElement>('[role="treeitem"]'))
        .find((candidate) => candidate.id === activeId)
    focusTransitions.push({
      focused: tree !== null && document.activeElement === tree,
      path: activeRow?.dataset.path ?? null
    })
    return { before, expected }
  }

  const archiveRow = findRow(panel.element, archive)
  if (!archiveRow) throw new Error('Missing archive folder row')
  await selectRow(panel.element, archive)
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  if (!tree) throw new Error('Missing Explorer tree')
  await act(async () => {
    tree.focus()
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => findRow(panel.element, archiveFile) || false)
  expect(treePaths().filter((path) => path.startsWith(`${archive}/`))).toHaveLength(2)

  const fileDeletion = await removeAndCaptureFocus(fileA)
  expect(fileDeletion.expected).toBe(fileB)
  expect(terminalFocusedDuringDelete).toBe(true)

  const folderDeletion = await removeAndCaptureFocus(archive)
  expect(folderDeletion.expected).toBe(fileB)

  expect(treePaths()[treePaths().length - 1]).toBe(lastFile)
  const lastDeletion = await removeAndCaptureFocus(lastFile)
  expect(lastDeletion.expected).toBe(fileB)
  expect(treePaths()).toEqual([fileB])

  const emptyDeletion = await removeAndCaptureFocus(fileB)
  expect(emptyDeletion.expected).toBeNull()
  expect(treePaths()).toEqual([])
  expect(focusTransitions).toEqual([
    { focused: true, path: fileB },
    { focused: true, path: fileB },
    { focused: true, path: fileB },
    { focused: true, path: null }
  ])
}, 60_000)

test('Explorer failed rename keeps focus in the inline editor', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  const originalCall = context.call
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && params.action === 'rename') throw new Error('injected rename failure')
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const source = join(fixture.root, FILE_A)
  const row = findRow(panel.element, source)
  if (!row) throw new Error('Missing rename source row')
  const rename = await actionButton(row, 'Rename')
  await act(async () => rename.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'failed-rename.txt')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => panel.element.querySelector('[role="alert"]')?.textContent?.includes('injected rename failure') || false)
  expect(input.isConnected).toBe(true)
  expect(document.activeElement).toBe(input)
  expect(findRow(panel.element, source)).not.toBeNull()
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  expect(tree?.getAttribute('aria-activedescendant')).toBe(row.id)
  expect(existsSync(join(dirname(source), 'failed-rename.txt'))).toBe(false)
}, 60_000)
test('Explorer cancelling a New File form preserves a failed Rename error', async () => {
  const { context, filePath } = makeDeleteConfirmationFixture()
  const originalCall = context.call
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && params.action === 'rename') throw new Error('injected rename failure')
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderStandaloneExplorer(context)

  try {
    const row = await waitForUi(() => findRow(panel.element, filePath) ?? false)
    const rename = await actionButton(row, 'Rename')
    await act(async () => rename.click())
    const renameInput = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(renameInput, 'failed-rename.txt')
      renameInput.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await waitForUi(() => panel.element.querySelector('[role="alert"]')?.textContent?.includes('injected rename failure') || false)

    const newFile = panel.element.querySelector<HTMLButtonElement>('button[title="New File"]')
    if (!newFile) throw new Error('Missing New File action')
    await act(async () => newFile.click())
    const createForm = await waitForUi(() => Array.from(panel.element.querySelectorAll<HTMLElement>('.qe-explorer-inline-row'))
      .find((form) => Array.from(form.querySelectorAll('label')).some((label) => label.textContent?.trim() === 'New file name')) ?? false)
    const createCancel = Array.from(createForm.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Cancel')
    if (!createCancel) throw new Error('Missing Cancel action for New File')
    await act(async () => createCancel.click())
    await waitForUi(() => !createForm.isConnected || false)
    expect(renameInput.isConnected).toBe(true)
    expect(panel.element.querySelector('[role="alert"]')?.textContent).toContain('injected rename failure')

    const renameForm = renameInput.closest<HTMLElement>('.qe-explorer-inline-row')
    if (!renameForm) throw new Error('Missing inline Rename form')
    const renameCancel = Array.from(renameForm.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Cancel')
    if (!renameCancel) throw new Error('Missing Cancel action for Rename')
    await act(async () => renameCancel.click())
    await waitForUi(() => !renameInput.isConnected || false)
    expect(panel.element.querySelector('[role="alert"]')).toBeNull()
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer failed confirmed deletion preserves tree focus', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  const originalCall = context.call
  context.confirm = async () => true
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && params.action === 'delete') throw new Error('injected delete failure')
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const source = join(fixture.root, FILE_A)
  await selectRow(panel.element, source)
  const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
  if (!tree) throw new Error('Missing Explorer tree')
  await act(async () => {
    tree.focus()
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  })
  await waitForUi(() => panel.element.querySelector('[role="alert"]')?.textContent?.includes('injected delete failure') || false)
  await waitForTreeFocus(panel.element, source)
  expect(existsSync(source)).toBe(true)
}, 60_000)

test('Explorer rename and deletion preserve tree navigation made during refresh', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  context.confirm = async () => true
  const originalCall = context.call
  const makeRefreshGate = () => ({
    started: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>()
  })
  let activeGate = makeRefreshGate()
  let holdNextRootList = false
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && (params.action === 'rename' || params.action === 'delete')) {
      const result = await originalCall(method, params)
      holdNextRootList = true
      return result
    }
    if (holdNextRootList && method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined) {
      holdNextRootList = false
      activeGate.started.resolve()
      await activeGate.released.promise
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const source = join(fixture.root, FILE_A)
  const other = join(fixture.root, FILE_B)
  const renamed = join(fixture.root, 'nested/renamed-during-refresh.txt')

  try {
    const sourceRow = findRow(panel.element, source)
    if (!sourceRow) throw new Error('Missing rename source row')
    const rename = await actionButton(sourceRow, 'Rename')
    await act(async () => rename.click())
    const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, basename(renamed))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    const renameGate = activeGate
    await renameGate.started.promise
    await waitForUi(() => panel.element.querySelector('input[aria-label="Rename file"]') === null || false)
    await selectRow(panel.element, other)
    renameGate.released.resolve()
    await waitForUi(() => findRow(panel.element, renamed) || false)
    await waitForTreeFocus(panel.element, other)
    const stateAfterRenameNavigation = await call<{
      explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
    }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
    expect(stateAfterRenameNavigation.explorer).toMatchObject({
      selectedPaths: [other],
      focusedPath: other,
      selectionAnchor: other
    })

    activeGate = makeRefreshGate()
    const deleteGate = activeGate
    const renamedRow = findRow(panel.element, renamed)
    if (!renamedRow) throw new Error('Missing renamed row for Delete')
    const deleteAction = await actionButton(renamedRow, 'Delete')
    await act(async () => deleteAction.click())
    await deleteGate.started.promise
    await selectRow(panel.element, other)
    deleteGate.released.resolve()
    await waitForUi(() => findRow(panel.element, renamed) === null || false)
    await waitForTreeFocus(panel.element, other)
    const stateAfterDeleteNavigation = await call<{
      explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
    }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
    expect(stateAfterDeleteNavigation.explorer).toMatchObject({
      selectedPaths: [other],
      focusedPath: other,
      selectionAnchor: other
    })
  } finally {
    activeGate.released.resolve()
  }
}, 60_000)

test('Explorer watcher refreshes do not cancel rename or delete focus restoration', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  context.confirm = async () => true
  const emitExplorerChanged = interceptExplorerChanged(context, fixture)
  const originalCall = context.call
  const makeRefreshGate = () => ({ started: false, released: Promise.withResolvers<void>() })
  let activeGate = makeRefreshGate()
  let holdNextRootList = false
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/mutate' && (params.action === 'rename' || params.action === 'delete')) {
      const result = await originalCall(method, params)
      holdNextRootList = true
      return result
    }
    if (holdNextRootList && method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined) {
      holdNextRootList = false
      const gate = activeGate
      gate.started = true
      await gate.released.promise
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const source = join(fixture.root, FILE_A)
  const other = join(fixture.root, FILE_B)
  const renamed = join(fixture.root, 'nested/A renamed-after-watcher.txt')

  try {
    const sourceRow = findRow(panel.element, source)
    if (!sourceRow) throw new Error('Missing rename source row')
    const rename = await actionButton(sourceRow, 'Rename')
    await act(async () => rename.click())
    const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, basename(renamed))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    const renameGate = activeGate
    await waitForUi(() => renameGate.started || false, 15_000)
    await waitForUi(() => panel.element.querySelector('input[aria-label="Rename file"]') === null || false)
    emitExplorerChanged()
    const renameDebounce = Promise.withResolvers<void>()
    setTimeout(renameDebounce.resolve, 150)
    await act(async () => { await renameDebounce.promise })
    renameGate.released.resolve()
    await waitForTreeFocus(panel.element, renamed)
    expect(findRow(panel.element, renamed)?.getAttribute('aria-selected')).toBe('true')
    const stateAfterRename = await waitForUi(async () => {
      const state = await call<{
        explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
      }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
      return state.explorer.focusedPath === renamed ? state : false
    }, 15_000)
    expect(stateAfterRename.explorer).toMatchObject({
      selectedPaths: [renamed],
      focusedPath: renamed,
      selectionAnchor: renamed
    })

    activeGate = makeRefreshGate()
    const deleteGate = activeGate
    const renamedRow = findRow(panel.element, renamed)
    if (!renamedRow) throw new Error('Missing renamed row for Delete')
    const deleteAction = await actionButton(renamedRow, 'Delete')
    await act(async () => deleteAction.click())
    await waitForUi(() => deleteGate.started || false, 15_000)
    emitExplorerChanged()
    const deleteDebounce = Promise.withResolvers<void>()
    setTimeout(deleteDebounce.resolve, 150)
    await act(async () => { await deleteDebounce.promise })
    deleteGate.released.resolve()
    await waitForTreeFocus(panel.element, other)
    expect(findRow(panel.element, other)?.getAttribute('aria-selected')).toBe('true')
    const stateAfterDelete = await waitForUi(async () => {
      const state = await call<{
        explorer: { selectedPaths: string[]; focusedPath: string | null; selectionAnchor: string | null }
      }>(fixture.client, 'quirky.editor/state', { worktree: fixture.worktree.id })
      return state.explorer.focusedPath === other ? state : false
    }, 15_000)
    expect(stateAfterDelete.explorer).toMatchObject({
      selectedPaths: [other],
      focusedPath: other,
      selectionAnchor: other
    })
  } finally {
    activeGate.released.resolve()
  }
}, 60_000)


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

test('Explorer lower row actions escape the scroll tree, fit the viewport, and still rename', async () => {
  const root = '/test'
  const worktree = 'popup-position-test'
  const filePath = join(root, 'README.md')
  const listing = {
    root,
    entries: [{ path: filePath, name: basename(filePath), isDirectory: false, isSymlink: false }],
    showDotfiles: true,
    showIgnored: false,
    followSymlinkedDirectories: false
  }
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
          explorer: { worktreeId: worktree, showDotfiles: true, expanded: [], selectedPaths: [...selectedPaths], focusedPath, selectionAnchor: focusedPath },
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
    confirm: async () => false,
    toast() {}
  } as unknown as UiPluginContext
  const panel = await renderStandaloneExplorer(context)

  try {
    const row = await waitForUi(() => findRow(panel.element, filePath) ?? false)
    const trigger = rowActionTrigger(row)
    const tree = panel.element.querySelector<HTMLElement>('.qe-explorer-tree')
    const footer = panel.element.querySelector<HTMLElement>('.qe-explorer-footer')
    expect(tree).not.toBeNull()
    expect(footer).not.toBeNull()

    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const ownGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    const rectangle = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect
    const triggerBounds = rectangle(1244, 646, 28, 28)
    const treeBounds = rectangle(0, 120, 1280, 560)
    const footerBounds = rectangle(0, 680, 1280, 40)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLElement): DOMRect {
        if (this === trigger) return triggerBounds
        if (this === tree) return treeBounds
        if (this === footer) return footerBounds
        if (this.classList.contains('ui-popup')) {
          const left = Number.parseFloat(this.style.left)
          const top = Number.parseFloat(this.style.top)
          return rectangle(Number.isNaN(left) ? 0 : left, Number.isNaN(top) ? 0 : top, 240, 190)
        }
        if (this.getAttribute('role') === 'menu') {
          const popup = this.parentElement
          if (popup?.classList.contains('ui-popup')) return popup.getBoundingClientRect()
          return rectangle(triggerBounds.left, triggerBounds.bottom, 240, 190)
        }
        return originalGetBoundingClientRect.call(this)
      }
    })

    try {
      expect(treeBounds.bottom).toBe(footerBounds.top)
      const rename = await actionButton(row, 'Rename')
      const menu = rowActionMenu(row)
      expect(menu).not.toBeNull()
      expect(tree!.contains(menu)).toBe(false)
      const bounds = menu!.getBoundingClientRect()
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
      expect(bounds.top).toBeGreaterThanOrEqual(0)
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight)
      expect(bounds.bottom).toBeLessThanOrEqual(triggerBounds.top)

      await act(async () => rename.click())
      const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[aria-label="Rename file"]') ?? false)
      expect(document.activeElement).toBe(input)
      expect(rowActionMenuOpen(row)).toBe(false)
      expect(row.getAttribute('aria-selected')).toBe('true')
    } finally {
      if (ownGetBoundingClientRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownGetBoundingClientRect)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
      else Reflect.deleteProperty(window, 'innerWidth')
      if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
      else Reflect.deleteProperty(window, 'innerHeight')
    }
  } finally {
    await panel.unmount()
  }
}, 30_000)

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

test('Explorer selection actions use visible Names results and restore hidden selections after clearing the filter', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const panel = await renderExplorer(fixture)
  const path = join(fixture.root, FILE_A)
  const unmatchedQuery = 'no-visible-explorer-results'
  try {
    await selectRow(panel.element, path)
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
    if (!query) throw new Error('Missing Explorer Names query')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, unmatchedQuery)
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitForUi(() => panel.element.querySelector('.qe-explorer-filter-empty') || false)

    const contents = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
      .find((button) => button.textContent === 'Contents')
    if (!contents) throw new Error('Missing Explorer Contents mode')
    await act(async () => contents.click())
    expect(panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]')?.value).toBe(unmatchedQuery)

    const names = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
      .find((button) => button.textContent === 'Names')
    if (!names) throw new Error('Missing Explorer Names mode')
    await act(async () => names.click())
    await waitForUi(() => panel.element.querySelector('.qe-explorer-filter-empty') || false)
    expect(panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')?.value).toBe(unmatchedQuery)

    for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) {
      expect(footerButton(panel.element, label).disabled).toBe(true)
    }

    const moreActions = panel.element.querySelector<HTMLDetailsElement>('.qe-explorer-more-actions')
    const summary = moreActions?.querySelector<HTMLElement>('summary[aria-label="More Explorer Actions"]')
    if (!moreActions || !summary) throw new Error('Missing Explorer overflow actions')
    await act(async () => summary.click())
    const overflowButtons = Array.from(moreActions.querySelectorAll<HTMLButtonElement>('button'))
    for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) {
      const button = overflowButtons.find((entry) => entry.textContent?.trim() === label)
      expect(button?.disabled).toBe(true)
    }

    const clear = panel.element.querySelector<HTMLButtonElement>('.qe-explorer-filter-empty button')
    if (!clear) throw new Error('Missing Explorer filter clear action')
    await act(async () => clear.click())
    await waitForUi(() => findRow(panel.element, path)?.getAttribute('aria-selected') === 'true' || false)
    for (const label of ['Copy Path', 'Copy Relative Path', 'Delete']) {
      expect(footerButton(panel.element, label).disabled).toBe(false)
    }
    await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
    expect(await navigator.clipboard.readText()).toBe(FILE_A)
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer keyboard deletion cannot confirm or delete a selection hidden by the Names filter', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  const confirmations: string[] = []
  context.confirm = async ({ title }) => {
    confirmations.push(title)
    return true
  }
  const panel = await renderExplorer(fixture, context)
  const path = join(fixture.root, FILE_A)
  try {
    await selectRow(panel.element, path)
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
    if (!query) throw new Error('Missing Explorer Names query')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'no-visible-explorer-results')
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitForUi(() => panel.element.querySelector('.qe-explorer-filter-empty') || false)

    const tree = panel.element.querySelector<HTMLElement>('[role="tree"]')
    if (!tree) throw new Error('Missing Explorer tree')
    await act(async () => {
      tree.focus()
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    await flushReact()

    expect(confirmations).toEqual([])
    expect(existsSync(path)).toBe(true)
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer footer copies and deletes only visible files from a partial Names result', async () => {
  const fixture = await makeFixture({ displayRoot: 'nested' })
  const context = makeContext(fixture)
  const confirmations: string[] = []
  context.confirm = async ({ title }) => {
    confirmations.push(title)
    return true
  }
  const panel = await renderExplorer(fixture, context)
  const visiblePath = join(fixture.root, FILE_A)
  const hiddenPath = join(fixture.root, FILE_B)
  try {
    await selectRow(panel.element, visiblePath)
    await selectRow(panel.element, hiddenPath)
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
    if (!query) throw new Error('Missing Explorer Names query')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, "O'Brien café")
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitForUi(() =>
      findRow(panel.element, visiblePath)?.getAttribute('aria-selected') === 'true' &&
      findRow(panel.element, hiddenPath) === null || false
    )

    await act(async () => footerButton(panel.element, 'Copy Path').click())
    expect(await navigator.clipboard.readText()).toBe(visiblePath)
    await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
    expect(await navigator.clipboard.readText()).toBe(FILE_A)

    await act(async () => footerButton(panel.element, 'Delete').click())
    await waitForUi(() => !existsSync(visiblePath) || false, 15_000)
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]).toContain(basename(visiblePath))
    expect(confirmations[0]).not.toContain(basename(hiddenPath))
    expect(existsSync(hiddenPath)).toBe(true)
    await waitForTreeFocus(panel.element, null)
  } finally {
    await panel.unmount()
  }
}, 60_000)


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

test('Explorer Contents summary waits until the search completes', async () => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  const originalCall = context.call
  const search = Promise.withResolvers<{
    files: []
    totalMatches: number
    truncated: boolean
    error: null
    loading: boolean
  }>()
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/search' && params.action === 'run') return await search.promise
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  try {
    await act(async () => footerButton(panel.element, 'Search in Files').click())
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'qa-summary-needle')
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => panel.element.querySelector<HTMLButtonElement>('.qe-explorer-query button')!.click())

    const status = panel.element.querySelector('.qe-explorer-content-results [role="status"]')
    expect(status?.textContent).toMatch(/searching files/i)
    expect(panel.element.querySelector('.qe-explorer-content-results > p:not([role="status"])')).toBeNull()

    await act(async () => {
      search.resolve({ files: [], totalMatches: 0, truncated: false, error: null, loading: false })
    })
    expect(panel.element.querySelector('.qe-explorer-content-results [role="status"]')).toBeNull()
    expect(panel.element.querySelector('.qe-explorer-content-results > p')?.textContent).toMatch(/\bno results\b/i)
  } finally {
    search.resolve({ files: [], totalMatches: 0, truncated: false, error: null, loading: false })
    await panel.unmount()
  }
}, 30_000)

for (const { label, extraFiles, results, files } of [
  { label: 'no matches', extraFiles: {}, results: 0, files: 0 },
  { label: 'one match', extraFiles: { 'search.txt': 'qa-summary-needle\n' }, results: 1, files: 1 },
  { label: 'multiple matches in one file', extraFiles: { 'search.txt': 'qa-summary-needle\nqa-summary-needle\n' }, results: 2, files: 1 },
  { label: 'multiple matching files', extraFiles: { 'search.txt': 'qa-summary-needle\n', 'other.txt': 'qa-summary-needle\n' }, results: 2, files: 2 }
]) {
  test(`Explorer Contents summary uses natural counts for ${label}`, async () => {
    const fixture = await makeFixture({ extraFiles })
    const panel = await renderExplorer(fixture)
    await act(async () => footerButton(panel.element, 'Search in Files').click())
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'qa-summary-needle')
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => panel.element.querySelector<HTMLButtonElement>('.qe-explorer-query button')!.click())
    const summary = await waitForUi(() => {
      const text = panel.element.querySelector('.qe-explorer-content-results > p')?.textContent ?? ''
      return /result/i.test(text) ? text : false
    }, 15_000)
    if (results === 0) {
      expect(summary).toMatch(/\bno results\b/i)
      expect(summary).not.toMatch(/\b0\b/)
    } else {
      expect(summary).toMatch(new RegExp(`\\b${results} ${results === 1 ? 'result' : 'results'}\\b(?!\\(s\\))`))
      expect(summary).toMatch(new RegExp(`\\b${files} ${files === 1 ? 'file' : 'files'}\\b(?!\\(s\\))`))
    }
    expect(panel.element.querySelectorAll('.qe-search-file').length).toBe(files)
  }, 30_000)
}

for (const { field, pattern } of [
  { field: 'include', pattern: '*.txt' },
  { field: 'exclude', pattern: '*.md' }
]) {
  test(`Explorer Enter in Files to ${field} searches the current query and filters`, async () => {
    const fixture = await makeFixture({ extraFiles: { 'search-notes.md': 'alpha\nbeta\n' } })
    const panel = await renderExplorer(fixture)
    await act(async () => footerButton(panel.element, 'Search in Files').click())
    const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]')!
    const filter = panel.element.querySelector<HTMLInputElement>(`input[placeholder^="files to ${field}"]`)!
    const resultPaths = () => Array.from(panel.element.querySelectorAll('.qe-search-file h4'))
      .map((heading) => heading.textContent).sort()
    const setInput = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const pressEnter = async (input: HTMLInputElement) => {
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    }

    await setInput(query, 'alpha')
    await pressEnter(query)
    await waitForUi(() => resultPaths().includes('search-notes.md'), 15_000)
    expect(resultPaths()).toEqual([FILE_A, 'search-notes.md'].sort())

    await setInput(query, 'beta')
    await setInput(filter, pattern)
    await pressEnter(filter)
    await waitForUi(() => resultPaths().includes(FILE_B), 15_000)
    expect(resultPaths()).toEqual([FILE_B])
    expect(panel.element.querySelector('.qe-search-file code')?.textContent).toContain('beta')

    await setInput(filter, field === 'include' ? '*.md' : '*.txt')
    await pressEnter(filter)
    await waitForUi(() => resultPaths().includes('search-notes.md'), 15_000)
    expect(resultPaths()).toEqual(['search-notes.md'])
  }, 60_000)
}

test('Explorer follows external creates and deletes in root and expanded directories without an editor buffer', async () => {
  const fixture = await makeFixture()
  const panel = await renderExplorer(fixture)
  const rootFile = join(fixture.root, 'external-root.txt')
  const childDirectory = join(fixture.root, 'nested')
  const childFile = join(childDirectory, 'external-child.txt')
  try {
    writeFileSync(rootFile, 'external root\n')
    await waitForUi(() => findRow(panel.element, rootFile) || false, 15_000)

    await act(async () => findRow(panel.element, childDirectory)!.click())
    await waitForUi(() => findRow(panel.element, join(fixture.root, FILE_A)) || false)
    writeFileSync(childFile, 'external child\n')
    await waitForUi(() => findRow(panel.element, childFile) || false, 15_000)

    rmSync(rootFile)
    rmSync(childFile)
    await waitForUi(() => !findRow(panel.element, rootFile) && !findRow(panel.element, childFile) || false, 15_000)
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer refreshes an active Names filter after external filesystem changes', async () => {
  const fixture = await makeFixture()
  const panel = await renderExplorer(fixture)
  const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]')
  if (!query) throw new Error('Missing Explorer Names query')
  const createdFile = join(fixture.root, 'external-filter-created.txt')
  try {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'external-filter-created')
      query.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitForUi(() => panel.element.querySelector('.qe-explorer-filter-empty') || false, 15_000)

    writeFileSync(createdFile, 'external filtered result\n')
    await waitForUi(() => findRow(panel.element, createdFile) || false, 15_000)
    rmSync(createdFile)
    await waitForUi(() => findRow(panel.element, createdFile) === null &&
      panel.element.querySelector('.qe-explorer-filter-empty') !== null || false, 15_000)
  } finally {
    await panel.unmount()
  }
}, 60_000)

test('Explorer background watcher refresh keeps rows visible without a loading status', async () => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  const emitExplorerChanged = interceptExplorerChanged(context, fixture)
  const originalCall = context.call
  const makeRefreshGate = () => ({ started: false, released: Promise.withResolvers<void>() })
  const firstGate = makeRefreshGate()
  const gates = [firstGate]
  let activeGate = firstGate
  let holdNextRootList = false
  let holdNextNestedList = false
  const nested = join(fixture.root, 'nested')
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    const isRootList = method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined
    const isNestedList = method === 'quirky.editor/explorer' && params.action === 'list' && params.path === nested
    if ((holdNextRootList && isRootList) || (holdNextNestedList && isNestedList)) {
      holdNextRootList = false
      holdNextNestedList = false
      const gate = activeGate
      gate.started = true
      await gate.released.promise
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const existing = join(fixture.root, FILE_A)
  const external = join(nested, 'external-watcher-created.txt')
  const loadingFiles = () => Array.from(panel.element.querySelectorAll<HTMLElement>('[role="status"]'))
    .some((status) => status.textContent?.trim() === 'Loading files…')

  try {
    holdNextRootList = true
    const userGate = activeGate
    const refresh = panel.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh Explorer"]')
    if (!refresh) throw new Error('Missing Refresh Explorer action')
    await act(async () => refresh.click())
    await waitForUi(() => userGate.started || false, 15_000)
    expect(findRow(panel.element, nested)).not.toBeNull()
    expect(loadingFiles()).toBe(true)
    userGate.released.resolve()
    await waitForUi(() => !loadingFiles() || false)

    const nestedRow = findRow(panel.element, nested)
    if (!nestedRow) throw new Error('Missing nested directory row')
    await act(async () => nestedRow.click())
    await waitForUi(() => findRow(panel.element, existing) || false, 15_000)
    await waitForUi(() => !loadingFiles() || false)

    activeGate = makeRefreshGate()
    gates.push(activeGate)
    holdNextRootList = true
    const backgroundGate = activeGate
    writeFileSync(external, 'external\n')
    emitExplorerChanged()
    await waitForUi(() => backgroundGate.started || false, 15_000)
    expect(findRow(panel.element, existing)).not.toBeNull()
    expect(loadingFiles()).toBe(false)
    activeGate = makeRefreshGate()
    gates.push(activeGate)
    holdNextNestedList = true
    const expandedGate = activeGate
    backgroundGate.released.resolve()
    await waitForUi(() => expandedGate.started || false, 15_000)
    expect(findRow(panel.element, existing)).not.toBeNull()
    expect(loadingFiles()).toBe(false)
    expandedGate.released.resolve()
    await waitForUi(() => findRow(panel.element, external) || false, 15_000)
    expect(findRow(panel.element, external)).not.toBeNull()
    expect(loadingFiles()).toBe(false)
  } finally {
    for (const gate of gates) gate.released.resolve()
  }
}, 60_000)

test('Explorer keeps user loading visible until its listing resolves during watcher refresh', async () => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  const emitExplorerChanged = interceptExplorerChanged(context, fixture)
  const originalCall = context.call
  const makeRefreshGate = () => ({ started: false, released: Promise.withResolvers<void>() })
  const userGate = makeRefreshGate()
  const backgroundGate = makeRefreshGate()
  const gates = [userGate, backgroundGate]
  const queuedRootListGates: typeof gates = []
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined) {
      const gate = queuedRootListGates.shift()
      if (gate !== undefined) {
        gate.started = true
        await gate.released.promise
      }
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const external = join(fixture.root, 'external-user-overlap.txt')
  const loadingFiles = () => Array.from(panel.element.querySelectorAll<HTMLElement>('[role="status"]'))
    .some((status) => status.textContent?.trim() === 'Loading files…')

  try {
    queuedRootListGates.push(userGate)
    const refresh = panel.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh Explorer"]')
    if (!refresh) throw new Error('Missing Refresh Explorer action')
    await act(async () => refresh.click())
    await waitForUi(() => userGate.started || false, 15_000)
    expect(loadingFiles()).toBe(true)

    writeFileSync(external, 'external\n')
    queuedRootListGates.push(backgroundGate)
    emitExplorerChanged()
    await waitForUi(() => backgroundGate.started || false, 15_000)
    expect(loadingFiles()).toBe(true)

    backgroundGate.released.resolve()
    await waitForUi(() => findRow(panel.element, external) || false, 15_000)
    expect(loadingFiles()).toBe(true)
    userGate.released.resolve()
    await waitForUi(() => !loadingFiles() || false)
  } finally {
    for (const gate of gates) gate.released.resolve()
  }
}, 60_000)

test('Explorer user refresh promotes a joined background listing to visible loading', async () => {
  const fixture = await makeFixture()
  const context = makeContext(fixture)
  const emitExplorerChanged = interceptExplorerChanged(context, fixture)
  const originalCall = context.call
  const backgroundGate = { started: false, released: Promise.withResolvers<void>() }
  const gates = [backgroundGate]
  const queuedRootListGates: typeof gates = []
  context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'quirky.editor/explorer' && params.action === 'list' && params.path === undefined) {
      const gate = queuedRootListGates.shift()
      if (gate !== undefined) {
        gate.started = true
        await gate.released.promise
      }
    }
    return await originalCall(method, params)
  }) as typeof context.call
  const panel = await renderExplorer(fixture, context)
  const external = join(fixture.root, 'external-background-overlap.txt')
  const loadingFiles = () => Array.from(panel.element.querySelectorAll<HTMLElement>('[role="status"]'))
    .some((status) => status.textContent?.trim() === 'Loading files…')

  try {
    writeFileSync(external, 'external\n')
    queuedRootListGates.push(backgroundGate)
    emitExplorerChanged()
    await waitForUi(() => backgroundGate.started || false, 15_000)
    expect(loadingFiles()).toBe(false)

    const refresh = panel.element.querySelector<HTMLButtonElement>('button[aria-label="Refresh Explorer"]')
    if (!refresh) throw new Error('Missing Refresh Explorer action')
    await act(async () => refresh.click())
    await waitForUi(() => loadingFiles() || false, 15_000)
    expect(loadingFiles()).toBe(true)

    backgroundGate.released.resolve()
    await waitForUi(() => Boolean(findRow(panel.element, external)) && !loadingFiles() || false, 15_000)
    expect(findRow(panel.element, external)).not.toBeNull()
    expect(loadingFiles()).toBe(false)
  } finally {
    for (const gate of gates) gate.released.resolve()
  }
}, 60_000)

test('Explorer removes an externally deleted expanded directory without a stale-path error', async () => {
  const fixture = await makeFixture()
  await call(fixture.client, 'quirky.editor/explorer', {
    worktree: fixture.worktree.id,
    action: 'preferences',
    expanded: ['nested', 'nested/archive']
  })
  const panel = await renderExplorer(fixture)
  const archiveDirectory = join(fixture.root, 'nested/archive')
  const archiveFile = join(archiveDirectory, 'keep.txt')
  try {
    await waitForUi(() => findRow(panel.element, archiveFile) || false)
    rmSync(archiveDirectory, { recursive: true })
    await waitForUi(() => findRow(panel.element, archiveDirectory) === null &&
      findRow(panel.element, archiveFile) === null &&
      fixture.reports.at(-1)?.expandedCount === 1 &&
      fixture.reports.at(-1)?.loading === false || false, 15_000)
    expect(panel.element.querySelector('[role="alert"]')).toBeNull()
  } finally {
    await panel.unmount()
  }
}, 60_000)


test('Explorer explains an unmatched Contents query in Names and clears it to reveal a newly created file', async () => {
  const fixture = await makeFixture()
  const panel = await renderExplorer(fixture)
  await act(async () => footerButton(panel.element, 'Search in Files').click())
  const query = panel.element.querySelector<HTMLInputElement>('input[placeholder="Search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, 'alpha')
    query.dispatchEvent(new Event('input', { bubbles: true }))
    query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await waitForUi(() => panel.element.querySelector('.qe-search-file code')?.textContent?.includes('alpha'), 15_000)
  const names = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-search-mode button'))
    .find((button) => button.textContent === 'Names')!
  await act(async () => names.click())
  await waitForUi(() => panel.element.querySelector('[role="tree"]')?.children.length === 0, 15_000)
  const emptyMessage = Array.from(panel.element.querySelectorAll<HTMLElement>('[role="status"]'))
    .find((element) => /no files match/i.test(element.textContent ?? ''))
  expect(emptyMessage).toBeDefined()
  expect(emptyMessage!.textContent).toContain('alpha')
  expect(query.value).toBe('alpha')
  const clear = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => /clear filter/i.test(button.textContent ?? ''))
  expect(clear).toBeDefined()

  await act(async () => panel.element.querySelector<HTMLButtonElement>('button[title="New File"]')!.click())
  const input = panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'qa-focus.txt')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-inline-row button'))
    .find((button) => button.textContent === 'Create')!
  await act(async () => create.click())
  const created = join(fixture.root, 'qa-focus.txt')
  await waitForUi(() => existsSync(created) && !panel.element.querySelector('.qe-explorer-inline-row'), 15_000)
  expect(findRow(panel.element, created)).toBeNull()
  expect(emptyMessage!.isConnected).toBe(true)

  await act(async () => clear!.click())
  await waitForUi(() => findRow(panel.element, created)?.getAttribute('aria-selected') === 'true', 15_000)
  expect(query.value).toBe('')
  expect(document.activeElement).toBe(query)
  expect(emptyMessage!.isConnected).toBe(false)
  await act(async () => footerButton(panel.element, 'Copy Relative Path').click())
  expect(await navigator.clipboard.readText()).toBe('qa-focus.txt')
}, 60_000)

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

test('Explorer header actions copy all selected paths', async () => {
  const root = '/test'
  const worktree = 'copy-selection-test'
  const absoluteA = join(root, FILE_A)
  const absoluteB = join(root, FILE_B)
  const listing = {
    root: join(root, 'nested'),
    entries: [
      { path: absoluteA, name: basename(absoluteA), isDirectory: false, isSymlink: false },
      { path: absoluteB, name: basename(absoluteB), isDirectory: false, isSymlink: false }
    ],
    showDotfiles: true,
    showIgnored: false,
    followSymlinkedDirectories: false
  }
  const context = {
    pluginId: 'quirky.editor',
    log() {},
    call: async (method: string) => {
      if (method === 'quirky.editor/state') {
        return {
          buffers: [],
          tabs: [],
          explorer: { worktreeId: worktree, showDotfiles: true, expanded: [], selectedPaths: [absoluteA, absoluteB], focusedPath: absoluteA }
        }
      }
      if (method === 'quirky.editor/documentRoot') return { id: worktree, path: root }
      if (method === 'quirky.editor/explorer') return listing
      if (method === 'quirky.git/status') return { files: [] }
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
    confirm: async () => false,
    toast() {}
  } as unknown as UiPluginContext
  const panel = await renderStandaloneExplorer(context)
  try {
    await waitForUi(() => {
      const rowA = findRow(panel.element, absoluteA)
      const rowB = findRow(panel.element, absoluteB)
      return rowA?.getAttribute('aria-selected') === 'true' && rowB?.getAttribute('aria-selected') === 'true' || false
    })

    const details = panel.element.querySelector<HTMLDetailsElement>('.qe-explorer-more-actions')
    const summary = details?.querySelector<HTMLElement>('summary[aria-label="More Explorer Actions"]')
    expect(summary).not.toBeNull()
    await act(async () => summary!.click())

    const buttons = Array.from(details!.querySelectorAll<HTMLButtonElement>('button'))
    const copyPath = buttons.find((button) => button.textContent?.trim() === 'Copy Path')
    expect(copyPath).toBeDefined()
    await act(async () => copyPath!.click())
    expect(await navigator.clipboard.readText()).toBe(`${absoluteA}\n${absoluteB}`)

    const copyRelativePath = buttons.find((button) => button.textContent?.trim() === 'Copy Relative Path')
    expect(copyRelativePath).toBeDefined()
    await act(async () => copyRelativePath!.click())
    expect(await navigator.clipboard.readText()).toBe(`${FILE_A}\n${FILE_B}`)
  } finally {
    await panel.unmount()
  }
}, 60_000)

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
  const menu = rowActionMenu(row!)
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
