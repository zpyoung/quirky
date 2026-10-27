import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { EditorBufferInfo, EditorOpenResult } from '../src/types'

type Fixture = {
  harness: Harness
  client: QuirkyClient
  home: string
  root: string
  worktreeId: string
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
}
type EditorBuffer = EditorBufferInfo & { content?: string; draft?: string | null; diskContent?: string | null }
type EditorSnapshot = {
  buffers: EditorBuffer[]
  tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }[]
}
type TerminalTab = { id: string; input?: { bufferId?: string }; viewId?: string }
type TerminalGroup = {
  id?: string
  activeTab?: string | null
  tabs?: TerminalTab[]
  first?: TerminalGroup
  second?: TerminalGroup
}
type TerminalWorkspace = { activeGroup: string; root: TerminalGroup }
type CliResult = { code: number; stdout: string; stderr: string }

const CLI_ENTRY = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url))
const fixtures = new Set<Fixture>()

afterEach(async () => {
  const pending = [...fixtures]
  fixtures.clear()
  const failures: unknown[] = []
  for (const fixture of pending) {
    try {
      await fixture.harness.cleanup()
    } catch (error) {
      failures.push(error)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Editor acceptance fixture cleanup failed')
})

async function boot(): Promise<Fixture> {
  const home = makeHomeWithoutAutoHooks('quirky-editor-acceptance-')
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-acceptance-repo-'))
  let harness: Harness | undefined
  try {
    const git = spawnSync('git', ['init', '-q'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        QUIRKY_HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`)
    harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    const client = await harness.connect('cli', 'editor-core-acceptance-test')
    const call = <T>(method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>
    await call('quirky.repo/add', { path: root })
    const worktree = await call<{ id: string }>('quirky.worktree/resolve', { selector: `path:${root}` })
    const fixture: Fixture = { harness, client, home, root, worktreeId: worktree.id, call }
    fixtures.add(fixture)
    return fixture
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

function writeFixture(fixture: Fixture, path: string, text: string): string {
  const absolute = join(fixture.root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
  return absolute
}

const open = (fixture: Fixture, path: string, options: Record<string, unknown> = {}) =>
  fixture.call<EditorOpenResult>('quirky.editor/open', { worktree: fixture.worktreeId, path, ...options })
const state = (fixture: Fixture) => fixture.call<EditorSnapshot>('quirky.editor/state', { worktree: fixture.worktreeId })

async function bufferOf(fixture: Fixture, bufferId: string): Promise<EditorBuffer> {
  const result = await fixture.call<{ buffer?: EditorBuffer }>('quirky.editor/read', { bufferId, action: 'buffer' })
  if (!result.buffer) throw new Error(`Editor buffer ${bufferId} was not returned`)
  return result.buffer
}

async function runCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, '--json', ...args], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH ?? '', HOME: fixture.home, QUIRKY_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  // Process watchdog only; normal CLI completion clears it without adding test latency.
  const { promise: deadline, reject } = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error(`CLI command timed out: ${args.join(' ')}`))
  }, 15_000)
  try {
    const completed = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }))
    const result = await Promise.race([completed, deadline])
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}
function runEditorCli(fixture: Fixture, method: string, params: Record<string, unknown>): Promise<CliResult> {
  const positionals = method === 'open' && typeof params.path === 'string' ? [params.path] : []
  const flags = Object.entries(params)
    .filter(([name]) => !(method === 'open' && name === 'path'))
    .map(([name, value]) => {
      const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      const encoded = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
      return `--${flag}=${encoded}`
    })
  return runCli(fixture, ['editor', method, ...positionals, ...flags])
}

function cliJson<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`CLI exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function waitFor(description: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function groupsIn(root: TerminalGroup): TerminalGroup[] {
  return [
    ...(root.tabs === undefined ? [] : [root]),
    ...(root.first === undefined ? [] : groupsIn(root.first)),
    ...(root.second === undefined ? [] : groupsIn(root.second))
  ]
}

async function activeTab(fixture: Fixture): Promise<string | null> {
  const { workspace } = await fixture.call<{ workspace: TerminalWorkspace }>('quirky.terminal/workspace', {
    workspace: `id:${fixture.worktreeId}`
  })
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

test('SC-22: the editor CLI opens, reads, searches and saves a file, and refuses an escaped path', async () => {
  const fixture = await boot()
  const original = "export const token = 'needle';\n"
  const absolute = writeFixture(fixture, 'src/engine.ts', original)

  const opened = cliJson<EditorOpenResult>(await runEditorCli(fixture, 'open', {
    worktree: fixture.worktreeId,
    path: 'src/engine.ts',
    mode: 'source',
    focus: false
  }))
  expect(opened).toMatchObject({ relativePath: 'src/engine.ts', content: original })

  const read = cliJson<{ text: string }>(await runEditorCli(fixture, 'read', {
    bufferId: opened.id,
    action: 'text',
    kind: 'content',
    offset: 0,
    contentRevision: opened.contentRevision
  }))
  expect(read.text).toBe(original)

  const search = cliJson<{ files: { relativePath: string; matches: { lineContent: string }[] }[] }>(await runEditorCli(fixture, 'search', {
    worktree: fixture.worktreeId,
    action: 'run',
    query: 'needle',
    caseSensitive: true,
    useRegex: false,
    includePattern: 'src/**',
    maxResults: 20
  }))
  expect(search.files).toContainEqual(expect.objectContaining({
    relativePath: 'src/engine.ts',
    matches: [expect.objectContaining({ lineContent: original.trimEnd() })]
  }))

  const edited = "export const token = 'saved';\n"
  const draft = cliJson<EditorBufferInfo>(await runEditorCli(fixture, 'draft', {
    bufferId: opened.id,
    content: edited,
    expectedRevision: opened.contentRevision
  }))
  expect(draft.dirty).toBe(true)
  const saved = cliJson<EditorBufferInfo>(await runEditorCli(fixture, 'save', { bufferId: opened.id, trigger: 'user' }))
  expect(saved).toMatchObject({ dirty: false, draft: null })
  expect(readFileSync(absolute, 'utf8')).toBe(edited)

  const outsidePath = join(dirname(fixture.root), `${basename(fixture.root)}-protected.txt`)
  writeFileSync(outsidePath, 'protected\n')
  try {
    const refused = await runEditorCli(fixture, 'open', {
      worktree: fixture.worktreeId,
      path: `../${basename(outsidePath)}`
    })
    expect(refused.code).not.toBe(0)
    expect(JSON.parse(refused.stdout)).toMatchObject({ error: { code: expect.any(String) } })
    expect(readFileSync(outsidePath, 'utf8')).toBe('protected\n')
    expect(readFileSync(absolute, 'utf8')).toBe(edited)
  } finally {
    rmSync(outsidePath, { force: true })
  }
})

test('SC-5/6: reveal refreshes an inactive dirty buffer after atomic replacement without changing the active tab', async () => {
  const fixture = await boot()
  writeFixture(fixture, 'inactive.ts', 'baseline\n')
  writeFixture(fixture, 'active.ts', 'active\n')
  const inactive = await open(fixture, 'inactive.ts', { mode: 'source', focus: false })
  const active = await open(fixture, 'active.ts', { mode: 'source', focus: false })
  await fixture.call('quirky.terminal/activateTab', { tab: active.openedTabId })
  expect(await activeTab(fixture)).toBe(active.openedTabId)

  await fixture.call('quirky.editor/draft', {
    bufferId: inactive.id,
    content: 'my draft\n',
    expectedRevision: inactive.contentRevision
  })
  const path = join(fixture.root, 'inactive.ts')
  const replacement = join(fixture.root, 'inactive.ts.replacement')
  writeFileSync(replacement, 'external version\n')
  renameSync(replacement, path)

  const refreshed = await fixture.call<EditorBufferInfo>('quirky.editor/view', { bufferId: inactive.id, action: 'reveal' })
  expect(refreshed).toMatchObject({
    id: inactive.id,
    relativePath: 'inactive.ts',
    content: 'baseline\n',
    draft: 'my draft\n',
    dirty: true,
    external: 'changed',
    diskContent: 'external version\n'
  })
  expect(readFileSync(path, 'utf8')).toBe('external version\n')
  expect(await activeTab(fixture)).toBe(active.openedTabId)
})

test('SC-6/8: renaming a directory rekeys an open descendant without changing its buffer, tab or draft', async () => {
  const fixture = await boot()
  const original = 'base text\n'
  const oldPath = writeFixture(fixture, 'src/nested/child.ts', original)
  const opened = await open(fixture, 'src/nested/child.ts', { mode: 'source', focus: false })
  await fixture.call('quirky.editor/draft', {
    bufferId: opened.id,
    content: 'unsaved descendant draft\n',
    expectedRevision: opened.contentRevision
  })

  const before = await state(fixture)
  expect(before.tabs).toContainEqual(expect.objectContaining({ tabId: opened.openedTabId, bufferId: opened.id, mode: 'edit' }))
  const renamed = await fixture.call<{ path: string }>('quirky.editor/mutate', {
    worktree: fixture.worktreeId,
    action: 'rename',
    path: 'src',
    newPath: 'renamed-src'
  })
  const newPath = join(fixture.root, 'renamed-src/nested/child.ts')
  expect(renamed.path).toBe('renamed-src')
  expect(existsSync(oldPath)).toBe(false)
  expect(readFileSync(newPath, 'utf8')).toBe(original)

  const after = await state(fixture)
  expect(after.buffers.find((buffer) => buffer.id === opened.id)).toMatchObject({
    id: opened.id,
    path: newPath,
    relativePath: 'renamed-src/nested/child.ts',
    dirty: true
  })
  expect(await bufferOf(fixture, opened.id)).toMatchObject({
    draft: 'unsaved descendant draft\n',
    dirty: true
  })
  expect(after.tabs).toContainEqual(expect.objectContaining({ tabId: opened.openedTabId, bufferId: opened.id, mode: 'edit' }))
})

test('SC-4/6: quiet autosave saves ordinary drafts but never recreates a deleted dirty file', async () => {
  const fixture = await boot()
  await fixture.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSave', value: true })
  await fixture.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSaveDelayMs', value: 250 })

  writeFixture(fixture, 'quiet.ts', 'before\n')
  const quiet = await open(fixture, 'quiet.ts', { mode: 'source', focus: false })
  await fixture.call('quirky.editor/draft', {
    bufferId: quiet.id,
    content: 'saved after quiet delay\n',
    expectedRevision: quiet.contentRevision
  })
  const quietPath = join(fixture.root, 'quiet.ts')
  // Autosave runs in the daemon process, so client-side fake timers cannot drive it; poll real disk state with a bound.
  await waitFor('quiet autosave to update disk', () => existsSync(quietPath) && readFileSync(quietPath, 'utf8') === 'saved after quiet delay\n')
  expect(await bufferOf(fixture, quiet.id)).toMatchObject({ draft: null, dirty: false })

  writeFixture(fixture, 'deleted.ts', 'before deletion\n')
  const deleted = await open(fixture, 'deleted.ts', { mode: 'source', focus: false })
  const dirty = await fixture.call<EditorBuffer>('quirky.editor/draft', {
    bufferId: deleted.id,
    content: 'keep this draft\n',
    expectedRevision: deleted.contentRevision
  })
  const deletedPath = join(fixture.root, 'deleted.ts')
  rmSync(deletedPath)
  const markedDeleted = await fixture.call<EditorBuffer>('quirky.editor/view', { bufferId: dirty.id, action: 'reveal' })
  expect(markedDeleted).toMatchObject({ external: 'deleted', draft: 'keep this draft\n', dirty: true })

  for (let attempt = 0; attempt < 40; attempt++) {
    expect(existsSync(deletedPath)).toBe(false)
    await Bun.sleep(25)
  }
  expect(existsSync(deletedPath)).toBe(false)

  const explicitlySaved = await fixture.call<EditorBuffer>('quirky.editor/save', { bufferId: deleted.id, trigger: 'user' })
  expect(explicitlySaved).toMatchObject({ draft: null, dirty: false })
  expect(readFileSync(deletedPath, 'utf8')).toBe('keep this draft\n')
})

test('SC-3: save-close closes a saved tab but preserves a conflicted draft and its tab', async () => {
  const fixture = await boot()
  const goodPath = writeFixture(fixture, 'good.ts', 'original\n')
  const conflictPath = writeFixture(fixture, 'conflict.ts', 'original\n')
  const good = await open(fixture, 'good.ts', { mode: 'source', focus: false })
  const conflict = await open(fixture, 'conflict.ts', { mode: 'source', focus: false })
  await fixture.call('quirky.editor/draft', {
    bufferId: good.id,
    content: 'saved before close\n',
    expectedRevision: good.contentRevision
  })
  await fixture.call('quirky.editor/draft', {
    bufferId: conflict.id,
    content: 'preserve this draft\n',
    expectedRevision: conflict.contentRevision
  })

  expect(await fixture.call<{ closed: boolean }>('quirky.editor/close', {
    bufferId: good.id,
    tabId: good.openedTabId,
    choice: 'save'
  })).toEqual({ closed: true })
  expect(readFileSync(goodPath, 'utf8')).toBe('saved before close\n')
  expect((await state(fixture)).tabs.some((tab) => tab.tabId === good.openedTabId)).toBe(false)

  writeFileSync(conflictPath, 'external version\n')
  await expect(fixture.call('quirky.editor/close', {
    bufferId: conflict.id,
    tabId: conflict.openedTabId,
    choice: 'save'
  })).rejects.toThrow()
  expect(readFileSync(conflictPath, 'utf8')).toBe('external version\n')
  expect((await state(fixture)).tabs).toContainEqual(expect.objectContaining({
    tabId: conflict.openedTabId,
    bufferId: conflict.id,
    mode: 'edit'
  }))
  expect(await bufferOf(fixture, conflict.id)).toMatchObject({
    draft: 'preserve this draft\n',
    dirty: true,
    external: 'changed',
    diskContent: 'external version\n'
  })
})
