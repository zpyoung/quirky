import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

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
type EditorFixture = { harness: Harness; client: QuirkyClient; worktree: Worktree; root: string }

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

  expect(await call(client, 'quirky.editor/close', { bufferId: edit.id, tabId: previewTab!.tabId })).toEqual({ closed: true })
  const after = await stateOf(client, worktree.id)
  expect(after.tabs).toContainEqual(editTab)
  expect(after.tabs.some((tab) => tab.tabId === previewTab!.tabId)).toBe(false)
  expect(await bufferOf(client, edit.id)).toMatchObject({ draft: '# Draft\n', dirty: true })
})

test('dirty close requires an explicit choice and cancel preserves the tab and draft', async () => {
  const { client, worktree } = await fixture({ 'a.ts': 'let value = 1\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts' })
  await call(client, 'quirky.editor/draft', { bufferId: opened.id, content: 'let value = 2\n', expectedRevision: opened.contentRevision })

  expect(await call(client, 'quirky.editor/canClose', { bufferId: opened.id, tabId: opened.tabId! })).toBe(false)
  expect(await call(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId! })).toEqual({ closed: false, needsDecision: true })
  expect(await call(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId!, choice: 'cancel' })).toMatchObject({ closed: false })
  const state = await stateOf(client, worktree.id)
  expect(state.tabs.some((tab) => tab.tabId === opened.tabId)).toBe(true)
  expect(await bufferOf(client, opened.id)).toMatchObject({ draft: 'let value = 2\n', dirty: true })

  expect(await call(client, 'quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId!, choice: 'discard' })).toEqual({ closed: true })
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
  expect(tree.entries.some((entry) => entry.path === 'README.md')).toBe(true)
  expect(tree.entries.some((entry) => entry.path === 'src' && entry.isDirectory)).toBe(true)

  const quick = await call<{ results: { path: string; name: string }[] }>(client, 'quirky.editor/quickOpen', {
    worktree: worktree.id,
    action: 'search',
    query: 'pars'
  })
  expect(quick.results.some((result) => result.path === 'src/parser.ts')).toBe(true)

  const search = await call<{ files: { path: string; matches: { line: number; column: number; matchLength: number; lineContent: string }[] }[] }>(client, 'quirky.editor/search', {
    worktree: worktree.id,
    action: 'run',
    query: 'needle',
    caseSensitive: true,
    wholeWord: true,
    useRegex: false,
    maxResults: 50
  })
  expect(search.files).toContainEqual(expect.objectContaining({
    path: 'src/parser.ts',
    matches: [expect.objectContaining({ line: 1, column: 24, matchLength: 6, lineContent: 'export const token = \"needle\"' })]
  }))
})

test('view state selection survives re-fetch and operation history undoes and redoes a create', async () => {
  const { client, worktree, root } = await fixture({ 'a.ts': 'const answer = 42\n' })
  const opened = await call<EditorBuffer>(client, 'quirky.editor/open', { worktree: worktree.id, path: 'a.ts', line: 1, column: 7 })
  const updated = await call<EditorBuffer>(client, 'quirky.editor/view', {
    bufferId: opened.id,
    action: 'update',
    patch: { selection: { anchor: 6, head: 6 }, cursor: { line: 1, column: 7 }, scrollTop: 24, wordWrap: true, fontSize: 18 }
  })
  expect(updated.view).toMatchObject({ selection: { anchor: 6, head: 6 }, cursor: { line: 1, column: 7 }, scrollTop: 24, wordWrap: true, fontSize: 18 })
  expect((await stateOf(client, worktree.id)).buffers.find((buffer) => buffer.id === opened.id)?.view).toEqual(updated.view)

  await call(client, 'quirky.editor/mutate', { worktree: worktree.id, action: 'createFile', path: 'created.txt', content: 'created\n' })
  expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created\n')
  expect(await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'state' })).toMatchObject({ canUndo: true, redo: 0 })
  await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'undo' })
  expect(() => readFileSync(join(root, 'created.txt'), 'utf8')).toThrow()
  await call(client, 'quirky.editor/history', { worktree: worktree.id, action: 'redo' })
  expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created\n')
})
