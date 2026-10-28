import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
type FixtureOptions = { displayRoot?: string }
type Transfer = DropData & {
  readonly types: string[]
  effectAllowed: DataTransfer['effectAllowed']
  setData(type: string, value: string): void
}

const FILE_A = "nested/A O'Brien café #1? report.txt"
const FILE_B = 'nested/B résumé #2.txt'
const ARCHIVE_FILE = 'nested/archive/keep.txt'
const FILES: Record<string, string> = {
  [FILE_A]: 'alpha\n',
  [FILE_B]: 'beta\n',
  [ARCHIVE_FILE]: 'keep\n'
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
    for (const [path, text] of Object.entries(FILES)) {
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

async function renderExplorer(fixture: Fixture): Promise<Mounted> {
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
    root.render(<ExplorerPanel context={makeContext(fixture)} report={(value) => {
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

async function actionButton(row: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const actions = row.querySelector<HTMLDetailsElement>('details.qe-explorer-row-actions')
  if (!actions) throw new Error(`Missing row actions for ${row.dataset.path}`)
  const summary = actions.querySelector('summary')
  if (!summary) throw new Error(`Missing row action menu for ${row.dataset.path}`)
  if (!actions.open) {
    await act(async () => summary.click())
    await waitForUi(() => row.getAttribute('aria-selected') === 'true' || false)
  }
  const button = Array.from(actions.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent === label)
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

function dispatchDrag(target: HTMLElement, type: 'dragstart' | 'drop', transfer: Transfer): Event {
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

