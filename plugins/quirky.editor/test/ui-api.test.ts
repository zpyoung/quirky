import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'

type Worktree = { id: string; path: string }
type EditorBuffer = {
  id: string
  worktreeId: string
  path: string
  relativePath: string
  content?: string
  draft?: string | null
  contentLength: number
  draftLength: number | null
  contentBytes: number
  draftBytes: number | null
  diskContent?: string | null
  diskContentLength: number | null
  diskContentBytes: number | null
  diskSignature: string | null
  revision: number
  contentRevision: number
  dirty: boolean
  preview: boolean
  tabId: string | null
  external?: 'changed' | 'deleted' | null
  view: Record<string, unknown>
}
type EditorState = {
  buffers: EditorBuffer[]
  tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }[]
}
type EditorCloseResult = { closed: true } | { closed: false; needsDecision?: boolean }
type EditorFixture = { harness: Harness; client: QuirkyClient; worktree: Worktree; root: string }
type WindowedFixture = {
  harness: Harness
  client: QuirkyClient
  worktreeA: Worktree
  worktreeB: Worktree
  rootB: string
  ui1: QuirkyClient
  ui2: QuirkyClient
  c1: number
  c2: number
  sentinelTabId: string
  roots: string[]
}
type TerminalGroup = {
  id?: string
  activeTab?: string | null
  tabs?: { id: string }[]
  first?: TerminalGroup
  second?: TerminalGroup
}
type TerminalWorkspace = { activeGroup: string; root: TerminalGroup }
type OpenedEditorBuffer = EditorBuffer & { openedTabId: string }
type WindowHookPlugin = 'quirky.editor' | 'quirky.worktree'
type WindowCallHook = (method: string, params: Record<string, unknown>) => void | Promise<void>
type WindowHookGlobals = typeof globalThis & {
  __g118Hooks?: Partial<Record<WindowHookPlugin, WindowCallHook>>
}

const windowFixtures = new Set<WindowedFixture>()
const pluginsRoot = resolve(import.meta.dir, '..', '..')

afterEach(async () => {
  const pending = [...windowFixtures]
  windowFixtures.clear()
  const failures: unknown[] = []
  delete (globalThis as WindowHookGlobals).__g118Hooks
  for (const fixture of pending) {
    try {
      await fixture.harness.cleanup()
    } catch (error) {
      failures.push(error)
    } finally {
      for (const root of fixture.roots) rmSync(root, { recursive: true, force: true })
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Editor window fixture cleanup failed')
})


function wrapperMain(pluginId: WindowHookPlugin): string {
  const actualMain = pathToFileURL(join(pluginsRoot, pluginId, 'main.ts')).href
  return [
    `import { activate as activateReal } from ${JSON.stringify(actualMain)}`,
    `export function activate(context) {`,
    `  const originalCall = context.call.bind(context)`,
    `  const wrapped = new Proxy(context, {`,
    `    get(target, property) {`,
    `      if (property !== 'call') return Reflect.get(target, property, target)`,
    `      return async (method, params) => {`,
    `        await globalThis.__g118Hooks?.[${JSON.stringify(pluginId)}]?.(method, params)`,
    `        return originalCall(method, params)`,
    `      }`,
    `    }`,
    `  })`,
    `  return activateReal(wrapped)`,
    `}`
  ].join('\n')
}

function installWindowWrapper(builtinPluginsDir: string, pluginId: WindowHookPlugin): void {
  const sourceDir = join(pluginsRoot, pluginId)
  const pluginDir = join(builtinPluginsDir, pluginId)
  mkdirSync(pluginDir, { recursive: true })
  for (const name of readdirSync(sourceDir)) {
    if (name === 'main.ts' || name === 'test') continue
    symlinkSync(join(sourceDir, name), join(pluginDir, name))
  }
  writeFileSync(join(pluginDir, 'main.ts'), wrapperMain(pluginId))
}

function wrappedBuiltinsDir(home: string): string {
  const builtinPluginsDir = join(home, 'builtin-plugins')
  mkdirSync(builtinPluginsDir, { recursive: true })
  for (const name of readdirSync(builtinsDir())) {
    if (name === 'quirky.editor' || name === 'quirky.worktree') continue
    symlinkSync(join(builtinsDir(), name), join(builtinPluginsDir, name))
  }
  installWindowWrapper(builtinPluginsDir, 'quirky.editor')
  installWindowWrapper(builtinPluginsDir, 'quirky.worktree')
  return builtinPluginsDir
}

function createWindowRepo(home: string, name: string, files: Record<string, string>, roots: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `quirky-editor-window-${name}-`)))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, text)
  }
  const env = {
    ...process.env,
    HOME: home,
    QUIRKY_HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0'
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env })
  execFileSync('git', ['add', '.'], { cwd: root, env })
  execFileSync('git', ['-c', 'user.email=editor@test', '-c', 'user.name=Editor Test', 'commit', '-q', '-m', 'initial'], { cwd: root, env })
  return root
}

async function windowFixture(options: { wrapped?: boolean; includeThird?: boolean } = {}): Promise<WindowedFixture> {
  const home = makeHomeWithoutAutoHooks('q-editor-window-')
  const roots: string[] = []
  let harness: Harness | undefined
  try {
    harness = await startHarness({
      home,
      builtinPluginsDir: options.wrapped ? wrappedBuiltinsDir(home) : builtinsDir()
    })
    const rootA = createWindowRepo(home, 'a-', {
      'src/app.ts': 'first A\nsecond A\n',
      'docs/sentinel.md': '# A\n'
    }, roots)
    const filesB: Record<string, string> = {
      'src/app.ts': 'first\nsecond λ\n',
      'docs/sentinel.md': '# B\n',
      'docs/other.md': '# other\n'
    }
    if (options.includeThird) filesB['docs/third.md'] = '# third\n'
    const rootB = createWindowRepo(home, 'b-', filesB, roots)
    const client = await harness.connect('cli')
    await call(client, 'quirky.repo/add', { path: rootA })
    await call(client, 'quirky.repo/add', { path: rootB })
    const worktreeA = await call<Worktree>(client, 'quirky.worktree/resolve', { selector: `path:${rootA}` })
    const worktreeB = await call<Worktree>(client, 'quirky.worktree/resolve', { selector: `path:${rootB}` })
    const ui1 = await harness.connect('ui')
    const ui2 = await harness.connect('ui')
    const { connId: c1 } = await call<{ connId: number }>(ui1, 'ui.window.self')
    const { connId: c2 } = await call<{ connId: number }>(ui2, 'ui.window.self')
    await showWindow(ui1, c1, worktreeA.id)
    await showWindow(ui2, c2, worktreeA.id)
    const sentinel = await call<OpenedEditorBuffer>(client, 'quirky.editor/open', {
      worktree: worktreeB.id,
      path: 'docs/sentinel.md',
      focus: true
    })
    const fixture = {
      harness,
      client,
      worktreeA,
      worktreeB,
      rootB,
      ui1,
      ui2,
      c1,
      c2,
      sentinelTabId: sentinel.openedTabId,
      roots
    }
    windowFixtures.add(fixture)
    return fixture
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(home, { recursive: true, force: true })
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

function groupsIn(node: TerminalGroup): TerminalGroup[] {
  return [
    ...(node.tabs === undefined ? [] : [node]),
    ...(node.first === undefined ? [] : groupsIn(node.first)),
    ...(node.second === undefined ? [] : groupsIn(node.second))
  ]
}

async function activeTerminalTab(fixture: WindowedFixture, worktree: string): Promise<string | null> {
  const { workspace } = await call<{ workspace: TerminalWorkspace }>(fixture.client, 'quirky.terminal/workspace', {
    workspace: `id:${worktree}`
  })
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

async function showWindow(client: QuirkyClient, connId: number, worktree: string): Promise<void> {
  await call(client, 'ui.window.view.open', {
    connId,
    id: 'view:quirky.session/worktree',
    input: { worktree }
  })
}

async function windowLayout(fixture: WindowedFixture, connId: number): Promise<Record<string, unknown>> {
  const state = await call<{ layout: Record<string, unknown> }>(fixture.client, 'ui.window.state', { connId })
  return state.layout
}

async function navigationState(fixture: WindowedFixture, connId: number): Promise<unknown> {
  return call(fixture.client, 'quirky.worktree/navigationState', { window: connId })
}

async function waitForWindowGone(fixture: WindowedFixture, connId: number): Promise<void> {
  await waitForAsync(async () => {
    const state = await call<{ windows: { connId: number }[] }>(fixture.client, 'ui.state')
    return !state.windows.some((window) => window.connId === connId)
  }, 5_000)
}

async function rejectedCall(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<{ code: unknown; message: string }> {
  try {
    await call(client, method, params)
  } catch (error) {
    const rpc = error as { code?: unknown; message?: unknown }
    return { code: rpc.code, message: String(rpc.message) }
  }
  throw new Error(`Expected ${method} to fail`)
}

async function windowSnapshot(fixture: WindowedFixture, connIds: number[] = [fixture.c1, fixture.c2]): Promise<unknown> {
  const [stateA, stateB, workspaceA, workspaceB] = await Promise.all([
    stateOf(fixture.client, fixture.worktreeA.id),
    stateOf(fixture.client, fixture.worktreeB.id),
    call<{ workspace: TerminalWorkspace }>(fixture.client, 'quirky.terminal/workspace', { workspace: `id:${fixture.worktreeA.id}` }),
    call<{ workspace: TerminalWorkspace }>(fixture.client, 'quirky.terminal/workspace', { workspace: `id:${fixture.worktreeB.id}` })
  ])
  const editors = (state: EditorState) => ({
    buffers: state.buffers.map(({ id, revision }) => ({ id, revision })),
    tabs: state.tabs
  })
  const windows = await Promise.all(connIds.map(async (connId) => ({
    connId,
    layout: await windowLayout(fixture, connId),
    history: await navigationState(fixture, connId)
  })))
  return {
    editors: { a: editors(stateA), b: editors(stateB) },
    workspaces: { a: workspaceA.workspace, b: workspaceB.workspace },
    windows
  }
}

const fixtures = new Set<EditorFixture>()
afterEach(async () => {
  for (const fixture of fixtures) {
    fixtures.delete(fixture)
    try {
      await fixture.harness.cleanup()
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

async function fixture(files: Record<string, string>): Promise<EditorFixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-ui-'))
  const home = makeHomeWithoutAutoHooks('q-editor-ui-')
  let harness: Harness | undefined
  try {
    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    for (const [path, text] of Object.entries(files)) {
      const absolute = join(root, path)
      const parent = absolute.slice(0, absolute.lastIndexOf('/'))
      if (parent !== root) mkdirSync(parent, { recursive: true })
      writeFileSync(absolute, text)
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['-c', 'user.email=editor@test', '-c', 'user.name=Editor Test', 'add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.email=editor@test', '-c', 'user.name=Editor Test', 'commit', '-q', '-m', 'initial'], { cwd: root })
    const client = await harness.connect('cli')
    const repo = await client.callAny('quirky.repo/add', { path: root }) as { id: string }
    const worktrees = await client.callAny('quirky.worktree/list', { repo: repo.id }) as Worktree[]
    const main = worktrees.find((entry) => entry.path === root) ?? worktrees[0]
    if (!main) throw new Error('repo add returned no main worktree')
    const value = { harness, client, worktree: main, root }
    fixtures.add(value)
    return value
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

const call = <T>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>

async function stateOf(client: QuirkyClient, worktree: string): Promise<EditorState> {
  return call(client, 'quirky.editor/state', { worktree })
}
async function bufferOf(client: QuirkyClient, bufferId: string): Promise<EditorBuffer> {
  const result = await call<{ buffer?: EditorBuffer }>(client, 'quirky.editor/read', { bufferId, action: 'buffer' })
  if (!result.buffer) throw new Error(`Buffer ${bufferId} was not returned by editor.read.`)
  return result.buffer
}

test('opening a file creates a reusable hosted editor tab without stealing background focus', async () => {
  const { client, worktree } = await fixture({ 'src/a.ts': 'export const answer = 42\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', {
    worktree: worktree.id,
    path: 'src/a.ts',
    focus: false,
    preview: true
  })
  expect(opened).toMatchObject({ worktreeId: worktree.id, relativePath: 'src/a.ts', content: 'export const answer = 42\n', preview: true })

  const state = await stateOf(client, worktree.id)
  expect(state.buffers.some((buffer) => buffer.id === opened.id)).toBe(true)
  expect(state.tabs).toContainEqual(expect.objectContaining({ bufferId: opened.id, mode: 'edit' }))

  const reused = await call<EditorBuffer>(client, 'quirky.editor/open', {
    worktree: worktree.id,
    path: 'src/a.ts',
    focus: false,
    preview: true
  })
  expect(reused.id).toBe(opened.id)
  expect((await stateOf(client, worktree.id)).tabs.filter((tab) => tab.bufferId === opened.id)).toHaveLength(1)
})

test('draft compare-and-swap preserves the acknowledged draft and save writes it to disk', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'const value = 1\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  const accepted = await call<EditorBuffer>(client, 'quirky.editor/draft', {
    bufferId: opened.id,
    content: 'const value = 2\n',
    expectedRevision: opened.contentRevision
  })
  expect(accepted).toMatchObject({ draft: 'const value = 2\n', dirty: true })

  await expect(call(client, 'quirky.editor/draft', {
    bufferId: opened.id,
    content: 'const value = 3\n',
    expectedRevision: opened.contentRevision
  })).rejects.toThrow()
  const current = await bufferOf(client, opened.id)
  expect(current).toMatchObject({ draft: 'const value = 2\n', dirty: true })

  const saved = await call<EditorBuffer>(client, 'quirky.editor/save', { bufferId: opened.id, trigger: 'user' })
  expect(saved).toMatchObject({ content: 'const value = 2\n', draft: null, dirty: false })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const value = 2\n')
})
test('revision-guarded save cannot persist a newer draft with a stale acknowledgement', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'original\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  const newerDraft = await call<EditorBuffer>(client, 'quirky.editor/draft', {
    bufferId: opened.id,
    content: 'newer draft\n',
    expectedRevision: opened.contentRevision
  })

  await expect(call(client, 'quirky.editor/save', {
    bufferId: opened.id, trigger: 'user', expectedRevision: opened.contentRevision
  })).rejects.toThrow()
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('original\n')
  expect(await bufferOf(client, opened.id)).toMatchObject({ draft: 'newer draft\n', dirty: true })

  const saved = await call<EditorBuffer>(client, 'quirky.editor/save', {
    bufferId: opened.id, trigger: 'user', expectedRevision: newerDraft.contentRevision
  })
  expect(saved).toMatchObject({ content: 'newer draft\n', draft: null, dirty: false })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('newer draft\n')
})


test('a save race reports the external version and never overwrites it implicitly', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'original\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  await call(client, 'quirky.editor/draft', {
    bufferId: opened.id,
    content: 'my edit\n',
    expectedRevision: opened.contentRevision
  })
  writeFileSync(join(root, 'a.ts'), 'external edit\n')

  await expect(call(client, 'quirky.editor/save', { bufferId: opened.id, trigger: 'user' })).rejects.toThrow()
  const conflicted = await bufferOf(client, opened.id)
  expect(conflicted).toMatchObject({ draft: 'my edit\n', dirty: true, external: 'changed', diskContent: 'external edit\n' })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external edit\n')
})

test('explorer file mutations are visible through state and preserve collision safety', async () => {
  const { client, worktree, root } = await fixture({ 'existing.txt': 'kept\n' })
  const created = await call<{ path: string; buffer?: EditorBuffer }>(client, 'quirky.editor/mutate', {
    worktree: worktree.id,
    action: 'createFile',
    path: 'notes.txt',
    content: 'drafted\n'
  })
  expect(created.path).toBe('notes.txt')
  expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('drafted\n')

  const renamed = await call<{ path: string }>(client, 'quirky.editor/mutate', {
    worktree: worktree.id,
    action: 'rename',
    path: 'notes.txt',
    newPath: 'renamed.txt'
  })
  expect(renamed.path).toBe('renamed.txt')
  await expect(call(client, 'quirky.editor/mutate', {
    worktree: worktree.id,
    action: 'rename',
    path: 'renamed.txt',
    newPath: 'existing.txt'
  })).rejects.toThrow()
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('kept\n')
})
test('closing a Markdown preview never closes or discards its dirty edit tab', async () => {
  const { client, worktree } = await fixture({ 'README.md': '# Original\n' })
  const edit = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'README.md', mode: 'source' })
  await call(client, 'quirky.editor/draft', { bufferId: edit.id, content: '# Draft\n', expectedRevision: edit.contentRevision })
  await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'README.md', mode: 'preview' })
  const before = await stateOf(client, worktree.id)
  const editTab = before.tabs.find((tab) => tab.bufferId === edit.id && tab.mode === 'edit')
  const previewTab = before.tabs.find((tab) => tab.bufferId === edit.id && tab.mode === 'preview')
  expect(editTab).toBeDefined()
  expect(previewTab).toBeDefined()
  if (!editTab || !previewTab) throw new Error('The open Markdown buffer must have both edit and preview tabs.')

  expect(await call<EditorCloseResult>(client, 'quirky.editor/close', { bufferId: edit.id, tabId: previewTab.tabId })).toEqual({ closed: true })
  const after = await stateOf(client, worktree.id)
  expect(after.tabs).toContainEqual(editTab)
  expect(after.tabs.some((tab) => tab.tabId === previewTab.tabId)).toBe(false)
  expect(await bufferOf(client, edit.id)).toMatchObject({ draft: '# Draft\n', dirty: true })
})

test('dirty close requires an explicit choice and cancel preserves the tab and draft', async () => {
  const { client, worktree } = await fixture({ 'a.ts': 'let value = 1\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  await call(client, 'quirky.editor/draft', { bufferId: opened.id, content: 'let value = 2\n', expectedRevision: opened.contentRevision })

  expect(await call<boolean>(client, 'quirky.editor/canClose', { bufferId: opened.id, tabId: opened.tabId! })).toBe(false)
  expect(await call<EditorCloseResult>(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId! })).toEqual({ closed: false, needsDecision: true })
  expect(await call<EditorCloseResult>(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId!, choice: 'cancel' })).toMatchObject({ closed: false })
  const state = await stateOf(client, worktree.id)
  expect(state.tabs.some((tab) => tab.tabId === opened.tabId)).toBe(true)
  expect(await bufferOf(client, opened.id)).toMatchObject({ draft: 'let value = 2\n', dirty: true })

  expect(await call<EditorCloseResult>(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId!, choice: 'discard' })).toEqual({ closed: true })
  expect((await stateOf(client, worktree.id)).tabs.some((tab) => tab.tabId === opened.tabId)).toBe(false)
})

test('Keep My Edits holds autosave through later typing, while explicit save releases the hold', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'original\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  const first = await call<EditorBuffer>(client, 'quirky.editor/draft', { bufferId: opened.id, content: 'mine\n', expectedRevision: opened.contentRevision })
  writeFileSync(join(root, 'a.ts'), 'theirs\n')
  const kept = await call<EditorBuffer>(client, 'quirky.editor/view', { bufferId: opened.id, action: 'keep' })
  expect(kept).toMatchObject({ draft: 'mine\n', external: null })

  const later = await call<EditorBuffer>(client, 'quirky.editor/draft', { bufferId: opened.id, content: 'mine again\n', expectedRevision: kept.contentRevision })
  const autosaved = await call<EditorBuffer>(client, 'quirky.editor/save', { bufferId: opened.id, trigger: 'autosave' })
  expect(autosaved).toMatchObject({ draft: 'mine again\n', dirty: true })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('theirs\n')

  const saved = await call<EditorBuffer>(client, 'quirky.editor/save', { bufferId: opened.id, trigger: 'user' })
  expect(saved).toMatchObject({ content: 'mine again\n', draft: null, dirty: false })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('mine again\n')
  expect(later.contentRevision).toBeGreaterThan(first.contentRevision)
})

test('Reload exposes an eight-second undo that restores the prior draft without changing disk', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'original\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  await call(client, 'quirky.editor/draft', { bufferId: opened.id, content: 'mine\n', expectedRevision: opened.contentRevision })
  writeFileSync(join(root, 'a.ts'), 'theirs\n')
  await call(client, 'quirky.editor/view', { bufferId: opened.id, action: 'compare' })
  const reloaded = await call<EditorBuffer>(client, 'quirky.editor/view', { bufferId: opened.id, action: 'reload' })
  expect(reloaded).toMatchObject({ content: 'theirs\n', draft: null, dirty: false })
  const restored = await call<EditorBuffer>(client, 'quirky.editor/view', { bufferId: opened.id, action: 'undoReload' })
  expect(restored).toMatchObject({ draft: 'mine\n', dirty: true })
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('theirs\n')
})

test('explorer, quick open and contents search return scriptable results for a worktree', async () => {
  const { client, worktree } = await fixture({ 'README.md': '# Read me\n', 'src/parser.ts': 'export const token = "needle"\n', 'src/peer.ts': 'export const peer = true\n' })
  const tree = await call<{ entries: { path: string; name: string; isDirectory: boolean }[] }>(client, 'quirky.editor/explorer', {
    worktree: worktree.id,
    action: 'list'
  })
  expect(tree.entries.some((entry) => entry.path === join(worktree.path, 'README.md'))).toBe(true)
  expect(tree.entries.some((entry) => entry.path === join(worktree.path, 'src') && entry.isDirectory)).toBe(true)

  const quick = await call<{ results: { path: string; name: string }[] }>(client, 'quirky.editor/quickOpen', {
    worktree: worktree.id,
    action: 'search',
    query: 'pars'
  })
  expect(quick.results.some((result) => result.path === 'src/parser.ts')).toBe(true)

  const search = await call<{ files: { path: string; relativePath: string; matches: { line: number; column: number; matchLength: number; lineContent: string }[] }[] }>(client, 'quirky.editor/search', {
    worktree: worktree.id,
    action: 'run',
    query: 'needle',
    caseSensitive: true,
    wholeWord: true,
    useRegex: false,
    maxResults: 50
  })
  expect(search.files).toContainEqual(expect.objectContaining({
    relativePath: 'src/parser.ts',
    matches: [expect.objectContaining({ line: 1, column: 'export const token = "needle"'.indexOf('needle') + 1, matchLength: 6, lineContent: 'export const token = "needle"' })]
  }))
})

test('view state selection survives re-fetch and operation history undoes and redoes a create', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'const answer = 42\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts', line: 1, column: 7 })
  const updated = await call<EditorBuffer>(client, 'quirky.editor/view', {
    bufferId: opened.id,
    action: 'update',
    patch: { selection: { anchor: 6, head: 6 }, cursor: { line: 1, column: 7 }, scrollTop: 24, wordWrap: true }
  })
  expect(updated.view).toMatchObject({ selection: { anchor: 6, head: 6 }, cursor: { line: 1, column: 7 }, scrollTop: 24, wordWrap: true })
  expect((await stateOf(client, worktree.id)).buffers.find((buffer) => buffer.id === opened.id)?.view).toEqual(updated.view)

  await call(client, 'quirky.editor/mutate', { worktree: worktree.id, action: 'createFile', path: 'created.txt', content: 'created\n' })
  expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created\n')
  expect(await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'state' })).toMatchObject({ canUndo: true, redo: 0 })
  await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'undo' })
  expect(() => readFileSync(join(root, 'created.txt'), 'utf8')).toThrow()
  await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'redo' })
  expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created\n')
})
test('a focused open with a window navigates only that window', async () => {
  const fixture = await windowFixture()
  const c2LayoutBefore = await windowLayout(fixture, fixture.c2)
  expect(c2LayoutBefore).toMatchObject({ worktree: fixture.worktreeA.id })
  const c2HistoryBefore = await navigationState(fixture, fixture.c2)
  const opened = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    mode: 'source',
    line: 2,
    column: 3,
    focus: true,
    window: fixture.c1
  })
  expect(opened).toMatchObject({
    worktreeId: fixture.worktreeB.id,
    path: join(fixture.rootB, 'src/app.ts'),
    relativePath: 'src/app.ts'
  })
  expect(opened.openedTabId).toEqual(expect.any(String))
  expect(await activeTerminalTab(fixture, fixture.worktreeB.id)).toBe(opened.openedTabId)
  expect(await windowLayout(fixture, fixture.c1)).toMatchObject({
    worktree: fixture.worktreeB.id,
    view: { id: 'view:quirky.session/worktree', input: { worktree: fixture.worktreeB.id } }
  })
  expect(await windowLayout(fixture, fixture.c2)).toEqual(c2LayoutBefore)
  expect(await navigationState(fixture, fixture.c1)).toEqual({
    worktrees: [fixture.worktreeA.id, fixture.worktreeB.id],
    index: 1
  })
  expect(c2HistoryBefore).toEqual({ worktrees: [], index: -1 })
  expect(await navigationState(fixture, fixture.c2)).toEqual(c2HistoryBefore)
  const buffer = await bufferOf(fixture.client, opened.id)
  const position = (buffer.view.byTabId as Record<string, Record<string, unknown>>)[opened.openedTabId]
  expect(position).toMatchObject({ line: 2, column: 3, matchLength: 0, focused: true })
  expect(position?.navigationId).toEqual(expect.any(String))
}, 30_000)

test('window implies focus and a repeat reuses the buffer, tab, and draft', async () => {
  const fixture = await windowFixture()
  const c2LayoutBefore = await windowLayout(fixture, fixture.c2)
  expect(c2LayoutBefore).toMatchObject({ worktree: fixture.worktreeA.id })
  const first = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    mode: 'source',
    line: 2,
    column: 3,
    focus: true,
    window: fixture.c1
  })
  await call(fixture.client, 'quirky.editor/draft', {
    bufferId: first.id,
    content: 'first\nsecond λ edited\n',
    expectedRevision: first.contentRevision
  })
  await showWindow(fixture.ui1, fixture.c1, fixture.worktreeA.id)
  await call(fixture.client, 'quirky.terminal/activateTab', { tab: fixture.sentinelTabId })
  expect(await activeTerminalTab(fixture, fixture.worktreeB.id)).toBe(fixture.sentinelTabId)
  const repeated = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    line: 1,
    column: 1,
    window: fixture.c1
  })
  expect(repeated.id).toBe(first.id)
  expect(repeated.openedTabId).toBe(first.openedTabId)
  const state = await stateOf(fixture.client, fixture.worktreeB.id)
  expect(state.tabs.filter((tab) => tab.bufferId === first.id)).toHaveLength(1)
  expect(await activeTerminalTab(fixture, fixture.worktreeB.id)).toBe(first.openedTabId)
  expect(await windowLayout(fixture, fixture.c1)).toMatchObject({ worktree: fixture.worktreeB.id })
  expect(await windowLayout(fixture, fixture.c2)).toEqual(c2LayoutBefore)
  const buffer = await bufferOf(fixture.client, first.id)
  expect(buffer).toMatchObject({ draft: 'first\nsecond λ edited\n', dirty: true })
  expect(buffer.view).toMatchObject({
    byTabId: { [first.openedTabId]: { line: 1, column: 1, focused: true } }
  })
}, 30_000)

test('opens without a window never move a window', async () => {
  const fixture = await windowFixture()
  const first = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    mode: 'source',
    line: 2,
    column: 3,
    focus: true,
    window: fixture.c1
  })
  const layoutsBefore = {
    c1: await windowLayout(fixture, fixture.c1),
    c2: await windowLayout(fixture, fixture.c2)
  }
  const historiesBefore = {
    c1: await navigationState(fixture, fixture.c1),
    c2: await navigationState(fixture, fixture.c2)
  }
  const background = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'docs/other.md',
    focus: false
  })
  expect(await activeTerminalTab(fixture, fixture.worktreeB.id)).toBe(first.openedTabId)
  const openedA = await call<OpenedEditorBuffer>(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeA.id,
    path: 'src/app.ts',
    focus: true
  })
  expect(await activeTerminalTab(fixture, fixture.worktreeA.id)).toBe(openedA.openedTabId)
  expect(background.worktreeId).toBe(fixture.worktreeB.id)
  expect(await windowLayout(fixture, fixture.c1)).toEqual(layoutsBefore.c1)
  expect(await windowLayout(fixture, fixture.c2)).toEqual(layoutsBefore.c2)
  expect(await navigationState(fixture, fixture.c1)).toEqual(historiesBefore.c1)
  expect(await navigationState(fixture, fixture.c2)).toEqual(historiesBefore.c2)
}, 30_000)

test('window refusals preserve buffers, tabs, workspaces, layouts, and history', async () => {
  const fixture = await windowFixture()
  await call(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    mode: 'source',
    line: 2,
    column: 3,
    focus: true,
    window: fixture.c1
  })
  const before = await windowSnapshot(fixture)
  const rejectWithoutChanges = async (params: Record<string, unknown>) => {
    const error = await rejectedCall(fixture.client, 'quirky.editor/open', params)
    expect(await windowSnapshot(fixture)).toEqual(before)
    return error
  }
  expect(await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'docs/other.md',
    window: 999,
    focus: true
  })).toMatchObject({
    code: RpcErrorCode.Conflict,
    message: 'UI window connection 999 is not open'
  })
  expect(await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'docs/sentinel.md',
    window: 999
  })).toMatchObject({
    code: RpcErrorCode.Conflict,
    message: 'UI window connection 999 is not open'
  })
  const cliSelf = await rejectedCall(fixture.client, 'ui.window.self')
  expect(cliSelf.code).toBe(RpcErrorCode.InvalidParams)
  const cliIdMatch = cliSelf.message.match(/^connection (\d+) is not a UI window$/)
  if (!cliIdMatch) throw new Error(`Unexpected ui.window.self refusal: ${cliSelf.message}`)
  const cliConnId = Number(cliIdMatch[1])
  expect(await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    window: cliConnId
  })).toEqual({
    code: RpcErrorCode.InvalidParams,
    message: `connection ${cliConnId} is not a UI window`
  })
  expect(await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    window: fixture.c1,
    focus: false
  })).toEqual({
    code: RpcErrorCode.InvalidParams,
    message: 'window cannot be combined with focus: false'
  })
  for (const window of [0, 1.5, '2']) {
    expect(await rejectWithoutChanges({
      worktree: fixture.worktreeB.id,
      path: 'src/app.ts',
      window
    })).toMatchObject({ code: RpcErrorCode.InvalidParams })
  }
  const outsideWithWindow = await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: '../outside.txt',
    window: fixture.c1
  })
  const outsideWithoutWindow = await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: '../outside.txt'
  })
  expect(outsideWithWindow.code).toBe(outsideWithoutWindow.code)
  const missingWithWindow = await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'missing.ts',
    window: fixture.c1
  })
  const missingWithoutWindow = await rejectWithoutChanges({
    worktree: fixture.worktreeB.id,
    path: 'missing.ts'
  })
  expect(missingWithWindow.code).toBe(missingWithoutWindow.code)
  await fixture.ui2.close()
  await waitForWindowGone(fixture, fixture.c2)
  const beforeClosedWindowOpen = await windowSnapshot(fixture, [fixture.c1])
  expect(await rejectedCall(fixture.client, 'quirky.editor/open', {
    worktree: fixture.worktreeB.id,
    path: 'src/app.ts',
    window: fixture.c2
  })).toEqual({
    code: RpcErrorCode.Conflict,
    message: `UI window connection ${fixture.c2} is not open`
  })
  expect(await windowSnapshot(fixture, [fixture.c1])).toEqual(beforeClosedWindowOpen)
}, 30_000)

test('disconnects in flight preserve the opened tab and never navigate another window', async () => {
  const fixture = await windowFixture({ wrapped: true, includeThird: true })
  const hookGlobals = globalThis as WindowHookGlobals
  const cases: {
    plugin: WindowHookPlugin
    method: string
    kind: 'navigate' | 'state' | 'view'
    path: string
    code: number
    message: (connId: number) => string
  }[] = [
    {
      plugin: 'quirky.editor',
      method: 'quirky.worktree/navigate',
      kind: 'navigate',
      path: 'src/app.ts',
      code: RpcErrorCode.NotFound,
      message: (connId) => `UI window connection ${connId} is not live.`
    },
    {
      plugin: 'quirky.worktree',
      method: 'ui.window.state',
      kind: 'state',
      path: 'docs/other.md',
      code: RpcErrorCode.NotFound,
      message: (connId) => `UI window connection ${connId} is unavailable: UI window connection ${connId} is not open`
    },
    {
      plugin: 'quirky.worktree',
      method: 'ui.window.view.open',
      kind: 'view',
      path: 'docs/third.md',
      code: RpcErrorCode.Conflict,
      message: (connId) => `UI window connection ${connId} is not open`
    }
  ]
  try {
    for (const item of cases) {
      const ui = await fixture.harness.connect('ui')
      const { connId } = await call<{ connId: number }>(ui, 'ui.window.self')
      await showWindow(ui, connId, fixture.worktreeA.id)
      const c2Before = {
        layout: await windowLayout(fixture, fixture.c2),
        history: await navigationState(fixture, fixture.c2)
      }
      expect(c2Before.layout).toMatchObject({ worktree: fixture.worktreeA.id })
      expect(c2Before.history).toEqual({ worktrees: [], index: -1 })
      let fired = 0
      const hooks: Partial<Record<WindowHookPlugin, WindowCallHook>> = {}
      hooks[item.plugin] = async (method, params) => {
        if (fired > 0 || method !== item.method) return
        const target = item.kind === 'navigate' ? params.window : params.connId
        if (target !== connId) return
        fired += 1
        await ui.close()
        await waitForWindowGone(fixture, connId)
      }
      hookGlobals.__g118Hooks = hooks
      const error = await rejectedCall(fixture.client, 'quirky.editor/open', {
        worktree: fixture.worktreeB.id,
        path: item.path,
        mode: 'source',
        line: 2,
        column: 3,
        focus: true,
        window: connId
      })
      delete hookGlobals.__g118Hooks
      expect(fired).toBe(1)
      expect(error).toEqual({ code: item.code, message: item.message(connId) })
      const state = await stateOf(fixture.client, fixture.worktreeB.id)
      const buffers = state.buffers.filter((buffer) => buffer.relativePath === item.path)
      expect(buffers).toHaveLength(1)
      const buffer = buffers[0]!
      const tabs = state.tabs.filter((tab) => tab.bufferId === buffer.id)
      expect(tabs).toHaveLength(1)
      const tab = tabs[0]!
      expect(await activeTerminalTab(fixture, fixture.worktreeB.id)).toBe(tab.tabId)
      const opened = await bufferOf(fixture.client, buffer.id)
      const position = (opened.view.byTabId as Record<string, Record<string, unknown>>)[tab.tabId]
      expect(position).toMatchObject({ line: 2, column: 3, matchLength: 0, focused: true })
      expect(position?.navigationId).toEqual(expect.any(String))
      expect(await windowLayout(fixture, fixture.c2)).toEqual(c2Before.layout)
      expect(await navigationState(fixture, fixture.c2)).toEqual(c2Before.history)
      expect(await rejectedCall(fixture.client, 'ui.window.state', { connId })).toEqual({
        code: RpcErrorCode.Conflict,
        message: `UI window connection ${connId} is not open`
      })
    }
  } finally {
    delete hookGlobals.__g118Hooks
  }
}, 30_000)
