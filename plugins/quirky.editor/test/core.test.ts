import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness, waitForAsync } from '../../../packages/daemon/test/helpers'
import type { EditorBufferInfo, EditorOpenResult, EditorSearchState } from '../src/types'
type EditorBuffer = EditorBufferInfo

type CoreTestHarness = {
  h: Harness
  client: QuirkyClient
  home: string
  root: string
  worktreeId: string
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
  restart(): Promise<void>
  cleanup(): Promise<void>
}
type JsonSchemaNode = {
  type?: string
  description?: string
  enum?: unknown[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  default?: unknown
}
type ApiDescription = {
  methods: { name: string; params: JsonSchemaNode; result: JsonSchemaNode }[]
  cli: { commands: { words: string; aliasWords: string[] }[] }
}


let current: CoreTestHarness | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

async function boot(): Promise<CoreTestHarness> {
  const home = makeHomeWithoutAutoHooks('quirky-editor-core-')
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-repo-'))
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`)
  let h = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  let client = await h.connect('cli', 'editor-core-test')
  const call = <T>(method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<T>
  await call('quirky.repo/add', { path: root })
  const worktree = await call<{ id: string }>('quirky.worktree/resolve', { selector: `path:${root}` })

  const fixture: CoreTestHarness = {
    get h() { return h },
    get client() { return client },
    home,
    root,
    worktreeId: worktree.id,
    call,
    async restart() {
      for (const c of h.clients) c.close()
      await h.daemon.stop()
      h.pty.stop()
      h = await startHarness({ home, builtinPluginsDir: builtinsDir() })
      client = await h.connect('cli', 'editor-core-test-restarted')
    },
    async cleanup() {
      await h.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  }
  current = fixture
  return fixture
}
async function connectUnix(t: CoreTestHarness): Promise<QuirkyClient> {
  return await connectDaemon({ role: 'cli', name: 'editor-transfer-test', home: t.home, autostart: false, transport: 'socket' })
}

const open = (t: CoreTestHarness, path: string, options: Record<string, unknown> = {}) =>
  t.call<EditorOpenResult>('quirky.editor/open', { worktree: t.worktreeId, path, ...options })
const state = (t: CoreTestHarness, params: Record<string, unknown> = {}) =>
  t.call<{ buffers: EditorBuffer[]; tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }[] }>('quirky.editor/state', params)

async function readText(t: CoreTestHarness, bufferId: string, kind: 'content' | 'draft' | 'disk', contentRevision: number, length: number, diskSignature?: string | null): Promise<string> {
  const chunks: string[] = []
  let offset = 0
  while (offset < length) {
    const chunk = await t.call<{ text: string; nextOffset: number }>('quirky.editor/read', {
      bufferId,
      action: 'text',
      kind,
      offset,
      length: 64 * 1024,
      contentRevision,
      ...(kind === 'disk' ? { diskSignature } : {})
    })
    chunks.push(chunk.text)
    offset = chunk.nextOffset
  }
  return chunks.join('')
}

async function write(t: CoreTestHarness, path: string, text: string): Promise<void> {
  const absolute = join(t.root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text)
}
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('Expected operation to reject')
}

function controlledRg(queries: string[], ignoreTermQueries: string[] = []) {
  const realRg = spawnSync('which', ['rg'], { encoding: 'utf8' })
  if (realRg.status !== 0) throw new Error(`could not locate rg: ${realRg.stderr}`)
  const directory = mkdtempSync(join(tmpdir(), 'quirky-editor-search-rg-'))
  const control = join(directory, 'control')
  mkdirSync(control)
  const wrapper = join(directory, 'rg')
  const branches = queries.map((query) => {
    const ignoreTerm = ignoreTermQueries.includes(query) ? "trap '' TERM; " : ''
    return `  ${query}) ${ignoreTerm}marker="${query}.started"; gate="${query}.release" ;;`
  }).join('\n')
  writeFileSync(wrapper, `#!/bin/sh
set -eu
previous=''
last=''
for arg do
  previous=$last
  last=$arg
done
query=$previous
case "$query" in
${branches}
  *) exec "$QUIRKY_EDITOR_SEARCH_REAL_RG" "$@" ;;
esac
: > "$QUIRKY_EDITOR_SEARCH_CONTROL/$marker"
while [ ! -f "$QUIRKY_EDITOR_SEARCH_CONTROL/$gate" ]; do sleep 0.01; done
exec "$QUIRKY_EDITOR_SEARCH_REAL_RG" "$@"
`)
  chmodSync(wrapper, 0o755)
  const requests: Promise<EditorSearchState>[] = []
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return {
    async start(t: CoreTestHarness, query: string, requestId: string): Promise<{ result: Promise<EditorSearchState> }> {
      const previousEnvironment = {
        PATH: process.env.PATH,
        control: process.env.QUIRKY_EDITOR_SEARCH_CONTROL,
        realRg: process.env.QUIRKY_EDITOR_SEARCH_REAL_RG
      }
      try {
        process.env.PATH = `${directory}:${process.env.PATH ?? ''}`
        process.env.QUIRKY_EDITOR_SEARCH_CONTROL = control
        process.env.QUIRKY_EDITOR_SEARCH_REAL_RG = realRg.stdout.trim()
        const result = t.call<EditorSearchState>('quirky.editor/search', {
          worktree: t.worktreeId,
          action: 'run',
          query,
          requestId
        })
        requests.push(result)
        void result.catch(() => {})
        await waitForAsync(() => existsSync(join(control, `${query}.started`)), 10_000)
        return { result }
      } finally {
        restore('PATH', previousEnvironment.PATH)
        restore('QUIRKY_EDITOR_SEARCH_CONTROL', previousEnvironment.control)
        restore('QUIRKY_EDITOR_SEARCH_REAL_RG', previousEnvironment.realRg)
      }
    },
    release(query: string) {
      writeFileSync(join(control, `${query}.release`), 'release')
    },
    async cleanup() {
      for (const query of queries) this.release(query)
      await Promise.allSettled(requests)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

async function cancelSearch(t: CoreTestHarness, requestId?: string): Promise<EditorSearchState> {
  return await t.call<EditorSearchState>('quirky.editor/search', {
    worktree: t.worktreeId,
    action: 'cancel',
    ...(requestId === undefined ? {} : { requestId })
  })
}

describe('editor core through the daemon API', () => {
  test('SC-1: resolves worktree-scoped files, reuses buffers and replaces only the replaceable preview tab', async () => {
    const t = await boot()
    await write(t, 'a.ts', 'const a = 1;\n')
    await write(t, 'b.ts', 'const b = 2;\n')
    const a = await open(t, 'a.ts', { preview: true })
    const b = await open(t, 'b.ts', { preview: true })
    const again = await open(t, 'b.ts', { preview: true })
    const currentState = await state(t, { worktree: t.worktreeId })
    expect(b.openedTabId).toBe(a.openedTabId)
    expect(again.openedTabId).toBe(b.openedTabId)
    expect(a.id).not.toBe(b.id)
    expect(again.id).toBe(b.id)
    expect(currentState.tabs.map(({ tabId, bufferId, mode }) => ({ tabId, bufferId, mode }))).toEqual([
      { tabId: b.openedTabId, bufferId: b.id, mode: 'edit' }
    ])
    expect(b.preview).toBe(true)
    const otherRoot = mkdtempSync(join(tmpdir(), 'quirky-editor-second-repo-'))
    try {
      const otherGit = spawnSync('git', ['init', '-q'], { cwd: otherRoot, encoding: 'utf8' })
      if (otherGit.status !== 0) throw new Error(`git init failed: ${otherGit.stderr}`)
      writeFileSync(join(otherRoot, 'a.ts'), 'const a = 9;\n')
      await t.call('quirky.repo/add', { path: otherRoot })
      const otherWorktree = await t.call<{ id: string }>('quirky.worktree/resolve', { selector: `path:${otherRoot}` })
      const distinct = await open(t, 'a.ts', { worktree: otherWorktree.id })
      expect(distinct.id).not.toBe(a.id)
      expect(distinct.worktreeId).toBe(otherWorktree.id)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  }, 20_000)

  test('opens its tab with the file path as the tab icon', async () => {
    const t = await boot()
    await write(t, 'src/App.tsx', 'export {}\n')
    const buffer = await open(t, 'src/App.tsx', { focus: true })
    const icon = await t.call<{ icon: unknown }>('quirky.terminal/activeTabIcon', { workspace: `id:${t.worktreeId}` })
    expect(icon).toEqual({ icon: { kind: 'file', path: buffer.path } })
    expect(buffer.path.endsWith('/src/App.tsx')).toBe(true)
  })

  test('SC-2: rejects stale draft revisions without losing either client version and saves against the loaded baseline', async () => {
    const t = await boot()
    await write(t, 'answer.ts', 'const answer = 1;\n')
    const buffer = await open(t, 'answer.ts')
    const acknowledged = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: buffer.id,
      content: 'const answer = 2;\n',
      expectedRevision: buffer.contentRevision
    })
    await expect(t.call('quirky.editor/draft', {
      bufferId: buffer.id,
      content: 'const answer = 3;\n',
      expectedRevision: buffer.contentRevision
    })).rejects.toThrow()
    await expect(t.call('quirky.editor/read', {
      bufferId: buffer.id, action: 'text', kind: 'content', offset: 0, contentRevision: buffer.contentRevision
    })).rejects.toThrow()
    const publicBuffer = (await state(t)).buffers.find((item) => item.id === buffer.id)!
    expect(publicBuffer.draft).toBeUndefined()
    const expectedDraft = acknowledged.draft
    if (expectedDraft === undefined || expectedDraft === null) throw new Error('small draft was not returned inline')
    const draftLength = publicBuffer.draftLength
    if (draftLength === null) throw new Error('draft length is missing')
    expect(draftLength).toBe(expectedDraft.length)
    expect(await readText(t, buffer.id, 'draft', publicBuffer.contentRevision, draftLength)).toBe(expectedDraft)
    const saved = await t.call<EditorBuffer>('quirky.editor/save', { bufferId: buffer.id })
    expect(readFileSync(join(t.root, 'answer.ts'), 'utf8')).toBe('const answer = 2;\n')
    expect(saved.draft).toBeNull()
    expect(saved.dirty).toBe(false)
  })

  test('requires an explicit offset for text reads', async () => {
    const t = await boot()
    await write(t, 'offset.txt', 'content\n')
    const buffer = await open(t, 'offset.txt')
    await expect(t.call('quirky.editor/read', {
      bufferId: buffer.id,
      action: 'text',
      kind: 'content',
      contentRevision: buffer.contentRevision
    })).rejects.toThrow(/offset/)
  })

  test('preserves a leading UTF-8 BOM through open and guarded save', async () => {
    const t = await boot()
    const original = '\uFEFFconst answer = 1;\n'
    await write(t, 'bom.ts', original)
    const opened = await open(t, 'bom.ts')
    expect(opened.content).toBe(original)
    const content = '\uFEFFconst answer = 2;\n'
    await t.call('quirky.editor/draft', {
      bufferId: opened.id, content, expectedRevision: opened.contentRevision
    })
    const saved = await t.call<EditorBuffer>('quirky.editor/save', { bufferId: opened.id })
    expect(saved.content).toBe(content)
    expect(readFileSync(join(t.root, 'bom.ts'))).toEqual(Buffer.from(content, 'utf8'))
  })
  test('keeps Markdown anchors, frontmatter visibility and search-match lengths in presentation state', async () => {
    const t = await boot()
    await write(t, 'guide.md', '# Install\nbody\n')
    const opened = await open(t, 'guide.md', { focus: false })
    const anchored = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: opened.id, tabId: opened.openedTabId, action: 'update', patch: { markdownAnchor: 'install' }
    })
    expect(anchored.view).toMatchObject({ byTabId: { [opened.openedTabId]: { markdownAnchor: 'install' } } })
    const positioned = await open(t, 'guide.md', { mode: 'source', line: 1, column: 2, matchLength: 7, focus: false })
    expect(positioned.id).toBe(opened.id)
    expect(positioned.openedTabId).toBe(opened.openedTabId)
    expect(positioned.view).toMatchObject({ byTabId: { [opened.openedTabId]: { line: 1, column: 2, matchLength: 7, focused: false } } })
    const consumed = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: opened.id, tabId: opened.openedTabId, action: 'update',
      patch: { line: null, column: null, matchLength: null, focused: false }
    })
    expect(consumed.view).toMatchObject({
      byTabId: { [opened.openedTabId]: { line: null, column: null, matchLength: null, focused: false } }
    })
    const repeated = await open(t, 'guide.md', { mode: 'source', line: 1, column: 2, matchLength: 7, focus: true })
    expect(repeated.view).toMatchObject({
      byTabId: { [opened.openedTabId]: { line: 1, column: 2, matchLength: 7, focused: true } }
    })
    const cleared = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: opened.id, tabId: opened.openedTabId, action: 'update', patch: { markdownAnchor: null }
    })
    expect(cleared.view).toMatchObject({ byTabId: { [opened.openedTabId]: { markdownAnchor: null } } })
    const frontmatter = await t.call<{ visible: boolean }>('quirky.editor/markdown', {
      bufferId: opened.id, action: 'frontmatter', visible: true
    })
    expect(frontmatter.visible).toBe(true)
    expect((await state(t)).buffers.find((item) => item.id === opened.id)?.view).toMatchObject({ markdownFrontmatterVisible: true })
    await expect(t.call('quirky.editor/view', {
      bufferId: opened.id, tabId: opened.openedTabId, action: 'update', patch: { markdownAnchor: '../outside' }
    })).rejects.toThrow()
    await write(t, 'plain.txt', 'plain\n')
    const plain = await open(t, 'plain.txt')
    await expect(t.call('quirky.editor/view', {
      bufferId: plain.id, tabId: plain.openedTabId, action: 'update', patch: { markdownAnchor: 'section' }
    })).rejects.toThrow()
  })

  test('stale navigation acknowledgments preserve the newest source location', async () => {
    const t = await boot()
    await write(t, 'navigation.txt', 'first\nsecond\nthird\n')
    const first = await open(t, 'navigation.txt', { line: 2, column: 1, focus: true })
    const second = await open(t, 'navigation.txt', { line: 3, column: 2, focus: true })
    const tabId = second.openedTabId
    const tabView = (buffer: EditorBuffer) =>
      (buffer.view.byTabId as Record<string, Record<string, unknown>>)[tabId]!
    const firstId = tabView(first).navigationId
    const secondId = tabView(second).navigationId
    expect(typeof firstId).toBe('string')
    expect(secondId).not.toBe(firstId)
    const stale = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: second.id, tabId, action: 'update',
      patch: {
        navigationId: firstId, line: null, column: null, matchLength: null, focused: false,
        selection: { anchor: 6, head: 6 }, cursor: { line: 2, column: 1 }
      }
    })
    expect(tabView(stale)).toEqual(tabView(second))
    const consumed = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: second.id, tabId, action: 'update',
      patch: { navigationId: secondId, line: null, column: null, matchLength: null, focused: false }
    })
    expect(tabView(consumed)).toMatchObject({ line: null, column: null, focused: false })
    const repeated = await open(t, 'navigation.txt', { line: 3, focus: true })
    expect(tabView(repeated).navigationId).not.toBe(secondId)
    expect(tabView(repeated)).toMatchObject({ line: 3, column: 1, matchLength: 0 })
  })



  test('SC-3: a preview close is neutral, dirty edit close requires a decision, discard and reopen preserve the contract', async () => {
    const t = await boot()
    await write(t, 'README.md', '# before\n')
    const edit = await open(t, 'README.md')
    const dirty = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: edit.id,
      content: '# mine\n',
      expectedRevision: edit.contentRevision
    })
    const preview = await open(t, 'README.md', { mode: 'preview' })
    expect(preview.id).toBe(edit.id)
    const previewTab = (await state(t)).tabs.find((tab) => tab.bufferId === edit.id && tab.mode === 'preview')
    expect(previewTab).toBeDefined()
    const previewClose = await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: edit.id,
      tabId: previewTab!.tabId
    })
    expect(previewClose.closed).toBe(true)
    const publicBuffer = (await state(t)).buffers.find((item) => item.id === dirty.id)!
    expect(publicBuffer.draft).toBeUndefined()
    expect(await readText(t, dirty.id, 'draft', publicBuffer.contentRevision, publicBuffer.draftLength!)).toBe('# mine\n')
    const needsDecision = await t.call<{ closed: boolean; needsDecision?: boolean }>('quirky.editor/close', {
      bufferId: edit.id,
      tabId: edit.tabId
    })
    expect(needsDecision).toMatchObject({ closed: false, needsDecision: true })
    expect((await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: edit.id,
      tabId: edit.tabId,
      choice: 'cancel'
    })).closed).toBe(false)
    expect((await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: edit.id,
      tabId: edit.tabId,
      choice: 'discard'
    })).closed).toBe(true)
    const reopened = await t.call<EditorBuffer | null>('quirky.editor/reopen', { worktree: t.worktreeId })
    expect(reopened?.path).toBe(join(t.root, 'README.md'))
    expect(readFileSync(join(t.root, 'README.md'), 'utf8')).toBe('# before\n')
  })
  test('keeps a dirty edit guarded when its terminal tab is marked replaceable', async () => {
    const t = await boot()
    await write(t, 'guard.ts', 'before\n')
    const edit = await open(t, 'guard.ts', { mode: 'source' })
    const dirty = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: edit.id,
      content: 'after\n',
      expectedRevision: edit.contentRevision
    })
    await t.call('quirky.terminal/rekeyViewTabs', {
      workspace: `id:${t.worktreeId}`,
      viewId: 'view:quirky.editor/document',
      changes: [{ tab: edit.openedTabId, key: dirty.id, input: { bufferId: dirty.id, mode: 'source' }, preview: true }]
    })
    const refreshed = await open(t, 'guard.ts', { mode: 'source', preview: true })
    expect(refreshed.openedTabId).toBe(edit.openedTabId)

    expect(await t.call<boolean>('quirky.editor/canClose', { bufferId: dirty.id, tabId: edit.openedTabId })).toBe(false)
    expect(await t.call<{ closed: boolean; needsDecision?: boolean }>('quirky.editor/close', {
      bufferId: dirty.id,
      tabId: edit.openedTabId
    })).toMatchObject({ closed: false, needsDecision: true })
    expect((await state(t)).tabs).toHaveLength(1)
  })

  test('retains an API-created dirty draft after closing its only rendered Markdown preview', async () => {
    const t = await boot()
    await write(t, 'README.md', '# before\n')
    const preview = await open(t, 'README.md', { mode: 'preview' })
    const dirty = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: preview.id,
      content: '# API draft\n',
      expectedRevision: preview.contentRevision
    })

    expect((await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: dirty.id,
      tabId: preview.openedTabId
    })).closed).toBe(true)
    let retained = (await state(t)).buffers.find((buffer) => buffer.id === dirty.id)
    expect(retained?.dirty).toBe(true)
    expect(await readText(t, dirty.id, 'draft', retained!.contentRevision, retained!.draftLength!)).toBe('# API draft\n')

    const edit = await open(t, 'README.md', { mode: 'source' })
    expect(edit.id).toBe(dirty.id)
    expect(await t.call<boolean>('quirky.editor/canClose', { bufferId: dirty.id, tabId: edit.openedTabId })).toBe(false)
    expect(await t.call<{ closed: boolean; needsDecision?: boolean }>('quirky.editor/close', {
      bufferId: dirty.id,
      tabId: edit.openedTabId
    })).toMatchObject({ closed: false, needsDecision: true })
    expect((await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: dirty.id,
      tabId: edit.openedTabId,
      choice: 'discard'
    })).closed).toBe(true)
    retained = (await state(t)).buffers.find((buffer) => buffer.id === dirty.id)
    expect(retained).toBeUndefined()
  })


  test('SC-4: dirty drafts and autosave holds survive daemon restart; autosave never clears a newer draft snapshot', async () => {
    const t = await boot()
    await write(t, 'recover.ts', 'old\n')
    await t.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSave', value: true })
    await t.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSaveDelayMs', value: 250 })
    const initial = await open(t, 'recover.ts')
    const draft = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: initial.id,
      content: 'draft before restart\n',
      expectedRevision: initial.contentRevision
    })
    await t.call('quirky.editor/view', { bufferId: draft.id, action: 'keep' })
    await t.restart()
    let restored = (await state(t, { worktree: t.worktreeId })).buffers.find((item) => item.path.endsWith('recover.ts'))
    expect(restored?.draft).toBeUndefined()
    expect(await readText(t, restored!.id, 'draft', restored!.contentRevision, restored!.draftLength!)).toBe('draft before restart\n')
    expect(restored?.baseline).toBe(draft.baseline)
    const edited = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: restored!.id,
      content: 'later draft\n',
      expectedRevision: restored!.contentRevision
    })
    // The daemon autosave timer is the behavior under test; fake timers in this client process cannot advance it.
    await Bun.sleep(400)
    restored = (await state(t, { worktree: t.worktreeId })).buffers.find((item) => item.id === edited.id)
    expect(readFileSync(join(t.root, 'recover.ts'), 'utf8')).toBe('old\n')
    expect(restored?.draft).toBeUndefined()
    expect(await readText(t, edited.id, 'draft', restored!.contentRevision, restored!.draftLength!)).toBe('later draft\n')
    const explicitlySaved = await t.call<EditorBuffer>('quirky.editor/save', { bufferId: edited.id, trigger: 'user' })
    expect(readFileSync(join(t.root, 'recover.ts'), 'utf8')).toBe('later draft\n')
    expect(explicitlySaved.draft).toBeNull()
  })

  test('SC-5: compare, Keep My Edits hold, Reload undo and explicit overwrite are content-hash guarded', async () => {
    const t = await boot()
    await write(t, 'race.ts', 'old\n')
    const opened = await open(t, 'race.ts')
    const draft = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: opened.id,
      content: 'mine\n',
      expectedRevision: opened.contentRevision
    })
    const mtime = new Date(1_600_000_000_000)
    writeFileSync(join(t.root, 'race.ts'), 'theirs\n')
    utimesSync(join(t.root, 'race.ts'), mtime, mtime)
    const compare = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: draft.id, action: 'compare' })
    expect(compare.diskContent).toBe('theirs\n')
    expect(compare.diskSignature).toBeTruthy()
    expect(await readText(t, draft.id, 'disk', compare.contentRevision, compare.diskContentLength!, compare.diskSignature)).toBe('theirs\n')
    await expect(t.call('quirky.editor/read', {
      bufferId: draft.id, action: 'text', kind: 'disk', offset: 0, length: 16,
      contentRevision: compare.contentRevision, diskSignature: 'stale-signature'
    })).rejects.toThrow()
    await expect(t.call('quirky.editor/save', { bufferId: draft.id })).rejects.toThrow()
    const kept = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: draft.id, action: 'keep' })
    expect(kept.draft).toBe('mine\n')
    
    const reloaded = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: draft.id, action: 'reload' })
    expect(reloaded.content).toBe('theirs\n')
    expect(reloaded.draft).toBeNull()
    const undo = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: draft.id, action: 'undoReload' })
    expect(undo.draft).toBe('mine\n')
    const overwritten = await t.call<EditorBuffer>('quirky.editor/save', { bufferId: draft.id, trigger: 'overwrite' })
    expect(readFileSync(join(t.root, 'race.ts'), 'utf8')).toBe('mine\n')
    expect(overwritten.draft).toBeNull()
  })

  test('SC-6: deletion preserves buffer content, explicit save recreates it, and reveal rescans ignored paths', async () => {
    const t = await boot()
    await write(t, 'target.txt', 'keep me\n')
    const buffer = await open(t, 'target.txt')
    rmSync(join(t.root, 'target.txt'))
    const deleted = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: buffer.id, action: 'reveal' })
    expect(deleted.external).toBe('deleted')
    expect(deleted.content).toBe('keep me\n')
    await t.call('quirky.editor/save', { bufferId: buffer.id, trigger: 'user' })
    expect(readFileSync(join(t.root, 'target.txt'), 'utf8')).toBe('keep me\n')
    await write(t, 'node_modules/hidden-but-open.txt', 'visible to explicit reveal\n')
    const ignored = await open(t, 'node_modules/hidden-but-open.txt')
    const rescanned = await t.call<EditorBuffer>('quirky.editor/view', { bufferId: ignored.id, action: 'reveal' })
    expect(rescanned.content).toBe('visible to explicit reveal\n')
  })

  test('SC-7: explorer inventory sorts naturally, always hides heavy folders, defaults to dotfiles and honors per-worktree preferences', async () => {
    const t = await boot()
    await write(t, 'file10.ts', '10\n')
    await write(t, 'file2.ts', '2\n')
    await write(t, 'folder/z.ts', 'z\n')
    await write(t, '.private', 'secret\n')
    await write(t, '.git/internal', 'git\n')
    await write(t, 'node_modules/pkg/index.js', 'pkg\n')
    const listed = await t.call<{ entries: { name: string; isDirectory: boolean }[] }>('quirky.editor/explorer', {
      worktree: t.worktreeId,
      action: 'list',
      path: '.'
    })
    expect(listed.entries.map((entry) => entry.name)).toContain('.private')
    expect(listed.entries.map((entry) => entry.name)).not.toContain('.git')
    expect(listed.entries.map((entry) => entry.name)).not.toContain('node_modules')
    expect(listed.entries[0]?.name).toBe('folder')
    expect(listed.entries.map((entry) => entry.name)).toContain('.private')
    await t.call('quirky.editor/explorer', {
      worktree: t.worktreeId,
      action: 'preferences',
      showDotfiles: false
    })
    const hidden = await t.call<{ entries: { name: string }[] }>('quirky.editor/explorer', {
      worktree: t.worktreeId,
      action: 'list',
      path: '.'
    })
    expect(hidden.entries.map((entry) => entry.name)).not.toContain('.private')
    await t.call('quirky.editor/explorer', {
      worktree: t.worktreeId,
      action: 'preferences',
      showDotfiles: true
    })
    const withDotfiles = await t.call<{ entries: { name: string }[] }>('quirky.editor/explorer', {
      worktree: t.worktreeId,
      action: 'list',
      path: '.'
    })
    expect(withDotfiles.entries.map((entry) => entry.name)).toContain('.private')
  })

  test('SC-8: create, rename, duplicate, move and history preserve file contents and enforce owner preconditions', async () => {
    const t = await boot()
    await write(t, 'source.txt', 'payload\n')
    const opened = await open(t, 'source.txt')
    const created = await t.call<{ path: string }>('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'createFolder',
      path: 'out'
    })
    expect(created.path).toBe('out')
    const renamed = await t.call<{ path: string }>('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'rename',
      path: 'source.txt',
      newPath: 'renamed.txt'
    })
    expect(renamed.path).toBe('renamed.txt')
    expect((await state(t)).buffers.find((item) => item.id === opened.id)?.relativePath).toBe('renamed.txt')
    const duplicate = await t.call<{ path: string }>('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'duplicate',
      path: 'renamed.txt'
    })
    expect(duplicate.path).toBe('renamed copy.txt')
    expect(readFileSync(join(t.root, duplicate.path), 'utf8')).toBe('payload\n')
    await t.call('quirky.editor/mutate', { worktree: t.worktreeId, action: 'move', path: duplicate.path, newPath: 'out/renamed copy.txt' })
    expect(existsSync(join(t.root, 'out/renamed copy.txt'))).toBe(true)
    const undone = await t.call<{ canRedo: boolean }>('quirky.editor/history', { worktree: t.worktreeId, action: 'undo' })
    expect(undone.canRedo).toBe(true)
    await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'redo' })
    expect(existsSync(join(t.root, 'out/renamed copy.txt'))).toBe(true)
    await t.call('quirky.editor/mutate', { worktree: t.worktreeId, action: 'delete', path: 'renamed.txt' })
    expect(existsSync(join(t.root, 'renamed.txt'))).toBe(false)
    expect((await t.call<{ canRedo: boolean }>('quirky.editor/history', { worktree: t.worktreeId, action: 'undo' })).canRedo).toBe(true)
    expect(readFileSync(join(t.root, 'renamed.txt'), 'utf8')).toBe('payload\n')
    await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'redo' })
    expect(existsSync(join(t.root, 'renamed.txt'))).toBe(false)
  })

  test('qa-files-50: createFile reports a duplicate relative destination and preserves its contents', async () => {
    const t = await boot()
    await write(t, 'README.md', '# Existing\n')

    const message = await rejectionMessage(t.call('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'createFile',
      path: 'README.md',
      content: '# Replacement\n'
    }))
    expect(message.toLowerCase()).toContain('destination already exists')
    expect(message).toContain('README.md')
    expect(message).not.toContain(t.root)
    expect(message).not.toContain('EEXIST')
    expect(readFileSync(join(t.root, 'README.md'), 'utf8')).toBe('# Existing\n')
  }, 20_000)

  test('qa-files-50: rename into an open existing file reports a destination conflict and preserves both buffers', async () => {
    const t = await boot()
    await write(t, 'source.txt', 'source content\n')
    await write(t, 'README.md', 'destination content\n')
    const source = await open(t, 'source.txt')
    const destination = await open(t, 'README.md')

    const message = await rejectionMessage(t.call('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'rename',
      path: 'source.txt',
      newPath: 'README.md'
    }))
    expect(message.toLowerCase()).toContain('destination already exists')
    expect(message).toContain('README.md')
    expect(message).not.toMatch(/buffer/i)
    expect(readFileSync(join(t.root, 'source.txt'), 'utf8')).toBe('source content\n')
    expect(readFileSync(join(t.root, 'README.md'), 'utf8')).toBe('destination content\n')
    const buffers = (await state(t)).buffers
    expect(buffers.find((buffer) => buffer.id === source.id)).toMatchObject({ relativePath: 'source.txt' })
    expect(buffers.find((buffer) => buffer.id === destination.id)).toMatchObject({ relativePath: 'README.md' })
  }, 20_000)

  test('qa-files-50: rename into a deleted but open destination keeps its buffer reservation', async () => {
    const t = await boot()
    await write(t, 'source.txt', 'source content\n')
    await write(t, 'README.md', 'destination content\n')
    const source = await open(t, 'source.txt')
    const destination = await open(t, 'README.md')
    rmSync(join(t.root, 'README.md'))

    const message = await rejectionMessage(t.call('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'rename',
      path: 'source.txt',
      newPath: 'README.md'
    }))
    expect(message.toLowerCase()).toContain('destination already exists')
    expect(message).toContain('README.md')
    expect(message).not.toMatch(/buffer/i)
    expect(readFileSync(join(t.root, 'source.txt'), 'utf8')).toBe('source content\n')
    expect(existsSync(join(t.root, 'README.md'))).toBe(false)
    const buffers = (await state(t)).buffers
    expect(buffers.find((buffer) => buffer.id === source.id)).toMatchObject({ relativePath: 'source.txt' })
    expect(buffers.find((buffer) => buffer.id === destination.id)).toMatchObject({ relativePath: 'README.md' })
  }, 20_000)

  test('qa-files-50: createFile rejects an outside-worktree path without exposing internals or creating it', async () => {
    const t = await boot()
    const outsidePath = join(t.root, '..', 'zqaescape.txt')
    expect(existsSync(outsidePath)).toBe(false)

    const message = await rejectionMessage(t.call('quirky.editor/mutate', {
      worktree: t.worktreeId,
      action: 'createFile',
      path: '../zqaescape.txt',
      content: 'not authorized'
    }))
    expect(message.toLowerCase()).toMatch(/worktree/)
    expect(message.toLowerCase()).toMatch(/within|inside|remain|stay/)
    expect(message).not.toContain(t.worktreeId)
    expect(message).not.toContain(t.root)
    expect(message).not.toMatch(/EEXIST|ENOENT|errno|syscall|lstat|realpath/i)
    expect(existsSync(outsidePath)).toBe(false)
  }, 20_000)

  test('SC-9: path and browser uploads import collision-safely into the authorized worktree', async () => {
    const t = await boot()
    const sourceDir = mkdtempSync(join(tmpdir(), 'quirky-editor-import-'))
    try {
      writeFileSync(join(sourceDir, 'report.txt'), 'external\n')
      mkdirSync(join(sourceDir, 'bundle'))
      writeFileSync(join(sourceDir, 'bundle', 'nested.txt'), 'nested external\n')
      await write(t, 'report.txt', 'existing\n')
      const imported = await t.call<{ path: string; paths: string[] }>('quirky.editor/mutate', {
        worktree: t.worktreeId,
        action: 'import',
        path: '.',
        sourcePaths: [join(sourceDir, 'report.txt'), join(sourceDir, 'bundle')]
      })
      expect(imported).toMatchObject({ path: '.', paths: ['report copy.txt', 'bundle'] })
      expect(readFileSync(join(t.root, imported.paths[0]!), 'utf8')).toBe('external\n')
      expect(readFileSync(join(t.root, imported.paths[1]!, 'nested.txt'), 'utf8')).toBe('nested external\n')
      const upload = await t.call<{ paths: string[] }>('quirky.editor/mutate', {
        worktree: t.worktreeId,
        action: 'import',
        path: '.',
        files: [{ name: 'report.txt', data: Buffer.from('browser upload\n').toString('base64') }]
      })
      expect(upload.paths).toEqual(['report copy 2.txt'])
      expect(readFileSync(join(t.root, upload.paths[0]!), 'utf8')).toBe('browser upload\n')
      await expect(t.call('quirky.editor/mutate', {
        worktree: t.worktreeId,
        action: 'import',
        path: '.',
        files: [{ name: '../escape.txt', data: Buffer.from('unsafe').toString('base64') }]
      })).rejects.toThrow()
    } finally {
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test.each([
    { trigger: 'user', dirty: false },
    { trigger: 'user', dirty: true },
    { trigger: 'overwrite', dirty: true }
  ])('saving a deleted file uses umask-derived permissions ($trigger, dirty=$dirty)', async ({ trigger, dirty }) => {
    const t = await boot()
    const originalUmask = process.umask()
    try {
      for (const { mask, expected } of [
        { mask: 0o022, expected: 0o644 },
        { mask: 0o077, expected: 0o600 }
      ]) {
        process.umask(mask)
        const relativePath = `deleted-${mask.toString(8)}.txt`
        const path = join(t.root, relativePath)
        writeFileSync(path, 'original\n')
        const opened = await open(t, relativePath, { focus: false })
        const content = dirty ? 'unsaved draft\n' : 'original\n'
        if (dirty) {
          await t.call('quirky.editor/draft', {
            bufferId: opened.id,
            content,
            expectedRevision: opened.contentRevision
          })
        }
        rmSync(path)
        const saved = await t.call<EditorBuffer>('quirky.editor/save', { bufferId: opened.id, trigger })
        expect(saved).toMatchObject({ dirty: false, external: null })
        expect(readFileSync(path, 'utf8')).toBe(content)
        expect(statSync(path).mode & 0o777).toBe(expected)
      }
    } finally {
      process.umask(originalUmask)
    }
  })

  test('file creation and imports use umask-derived permissions across create, duplicate, and redo', async () => {
    const t = await boot()
    const originalUmask = process.umask()
    let client: QuirkyClient | undefined
    let sourceDir: string | undefined
    try {
      client = await connectUnix(t)
      sourceDir = mkdtempSync(join(tmpdir(), 'quirky-editor-permissions-'))
      const mode = (path: string) => statSync(join(t.root, path)).mode & 0o777
      for (const { mask, expected } of [
        { mask: 0o022, expected: 0o644 },
        { mask: 0o077, expected: 0o600 }
      ]) {
        const label = mask.toString(8)
        process.umask(mask)
        const createdPath = `created-${label}.txt`
        await t.call('quirky.editor/mutate', {
          worktree: t.worktreeId,
          action: 'createFile',
          path: createdPath,
          content: 'created\n'
        })
        expect(mode(createdPath)).toBe(expected)
        await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'undo' })
        expect(existsSync(join(t.root, createdPath))).toBe(false)
        await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'redo' })
        expect(mode(createdPath)).toBe(expected)

        for (const sourceMode of [0o644, 0o600]) {
          process.umask(0o022)
          const duplicateSource = `duplicate-${label}-${sourceMode.toString(8)}.txt`
          writeFileSync(join(t.root, duplicateSource), 'duplicate source\n', { mode: sourceMode })
          process.umask(mask)
          const duplicate = await t.call<{ path: string }>('quirky.editor/mutate', {
            worktree: t.worktreeId,
            action: 'duplicate',
            path: duplicateSource
          })
          const duplicatedMode = mode(duplicate.path)
          expect(duplicatedMode).toBe(sourceMode)
          await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'undo' })
          expect(existsSync(join(t.root, duplicate.path))).toBe(false)
          await t.call('quirky.editor/history', { worktree: t.worktreeId, action: 'redo' })
          expect(mode(duplicate.path)).toBe(sourceMode & ~mask)
        }

        const browserPath = `browser-${label}.txt`
        const browser = await t.call<{ paths: string[] }>('quirky.editor/mutate', {
          worktree: t.worktreeId,
          action: 'import',
          path: '.',
          files: [{ name: browserPath, data: Buffer.from('browser import\n').toString('base64') }]
        })
        expect(browser.paths).toEqual([browserPath])
        expect(mode(browserPath)).toBe(expected)

        for (const sourceMode of [0o644, 0o600]) {
          process.umask(0o022)
          const externalPath = `external-${label}-${sourceMode.toString(8)}.txt`
          writeFileSync(join(sourceDir, externalPath), 'external import\n', { mode: sourceMode })
          process.umask(mask)
          const external = await t.call<{ paths: string[] }>('quirky.editor/mutate', {
            worktree: t.worktreeId,
            action: 'import',
            path: '.',
            sourcePaths: [join(sourceDir, externalPath)]
          })
          expect(external.paths).toEqual([externalPath])
          expect(mode(externalPath)).toBe(sourceMode & ~mask)
        }

        const chunkedPath = `chunked-${label}.txt`
        const bytes = Buffer.alloc(65_537, 0x61)
        const transfer = await client.callAny('quirky.editor/transfer', {
          action: 'begin',
          kind: 'import',
          worktree: t.worktreeId,
          path: '.',
          name: chunkedPath,
          totalBytes: bytes.byteLength
        }) as { transferId: string; maxChunkBytes: number }
        for (let offset = 0; offset < bytes.byteLength; offset += transfer.maxChunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + transfer.maxChunkBytes))
          await client.callAny('quirky.editor/transfer', {
            action: 'chunk',
            transferId: transfer.transferId,
            offset,
            data: chunk.toString('base64')
          })
        }
        const imported = await client.callAny('quirky.editor/transfer', {
          action: 'commit',
          transferId: transfer.transferId
        }) as { paths: string[] }
        expect(imported.paths).toEqual([chunkedPath])
        expect(mode(chunkedPath)).toBe(expected)
      }
    } finally {
      process.umask(originalUmask)
      client?.close()
      if (sourceDir !== undefined) rmSync(sourceDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('SC-10: quick-open ranks recent paths, parses line targets, authorizes absolute paths and bounds queries/results', async () => {
    const t = await boot()
    await write(t, 'src/README.md', 'one\ntwo\nthree\n')
    await write(t, 'src/readme-old.md', 'old\n')
    const result = await t.call<{ results: { path: string; name: string; score: number }[]; truncated: boolean }>('quirky.editor/quickOpen', {
      worktree: t.worktreeId,
      action: 'search',
      query: 'readme'
    })
    expect(result.results.map(({ path }) => path)).toEqual(['src/README.md', 'src/readme-old.md'])
    expect(result.truncated).toBe(false)
    await t.call('quirky.editor/quickOpen', { worktree: t.worktreeId, action: 'record', path: 'src/readme-old.md' })
    const recent = await t.call<{ results: { path: string }[] }>('quirky.editor/quickOpen', {
      worktree: t.worktreeId,
      action: 'search',
      query: 'readme'
    })
    expect(recent.results.map(({ path }) => path)).toEqual(['src/readme-old.md', 'src/README.md'])
    const limited = await t.call<{ results: { path: string }[]; truncated: boolean }>('quirky.editor/quickOpen', {
      worktree: t.worktreeId,
      action: 'search',
      query: 'readme',
      limit: 1
    })
    expect(limited.results.map(({ path }) => path)).toEqual(['src/readme-old.md'])
    expect(limited.results).toHaveLength(1)
    expect(limited.truncated).toBe(false)
    const positionedTarget = await t.call<{ results: { path: string; line?: number; column?: number }[] }>('quirky.editor/quickOpen', {
      worktree: t.worktreeId,
      action: 'search',
      query: 'src/README.md:3:2'
    })
    expect(positionedTarget.results).toMatchObject([{ path: 'src/README.md', line: 3, column: 2 }])
    const positioned = await open(t, 'src/README.md', { line: 3, column: 2, focus: false })
    expect(positioned.view).toMatchObject({ line: 3, column: 2 })
    const tooLong = await t.call<{ results: unknown[] }>('quirky.editor/quickOpen', {
      worktree: t.worktreeId,
      action: 'search',
      query: 'x'.repeat(2049)
    })
    expect(tooLong.results).toEqual([])
    await expect(open(t, '../outside.txt')).rejects.toThrow()
  })

  test('SC-11: bounded rg search supports filters and regex, rejects invalid patterns, and cancels superseded work', async () => {
    const t = await boot()
    await write(t, 'src/a.ts', 'Needle alpha\nneedle beta\n')
    await write(t, 'dist/a.ts', 'needle excluded\n')
    const result = await t.call<{ totalMatches: number; files: { relativePath: string; matches: { line: number; lineContent: string }[] }[]; truncated: boolean }>('quirky.editor/search', {
      worktree: t.worktreeId,
      action: 'run',
      query: 'needle',
      useRegex: false,
      includePattern: 'src/**',
      excludePattern: '*.min.js',
      caseSensitive: false,
      maxResults: 2000
    })
    expect(result.totalMatches).toBe(2)
    expect(result.files[0]?.relativePath).toBe('src/a.ts')
    const prefix = '💡'.repeat(2000)
    const needle = 'anchor-target'
    await write(t, 'src/long.ts', `${prefix}${needle} tail\n`)
    const longLine = await t.call<{ files: { relativePath: string; matches: { column: number; matchLength: number; lineContent: string; displayColumn?: number; displayMatchLength?: number }[] }[] }>('quirky.editor/search', {
      worktree: t.worktreeId, action: 'run', query: needle, includePattern: 'src/**', useRegex: false, maxResults: 20
    })
    const match = longLine.files.find((file) => file.relativePath === 'src/long.ts')?.matches[0]!
    expect(match.column).toBe(prefix.length + 1)
    expect(match.matchLength).toBe(needle.length)
    expect(match.displayColumn).toBeDefined()
    expect(match.displayMatchLength).toBe(needle.length)
    expect(match.lineContent.slice(match.displayColumn! - 1, match.displayColumn! - 1 + match.displayMatchLength!)).toBe(needle)
    const invalidRegex = await t.call<{ error: string | null }>('quirky.editor/search', { worktree: t.worktreeId, action: 'run', query: '[', useRegex: true })
    expect(invalidRegex.error).toBeTruthy()
    const tooLong = await t.call<{ files: unknown[] }>('quirky.editor/search', {
      worktree: t.worktreeId,
      action: 'run',
      query: 'x'.repeat(8193)
    })
    expect(tooLong.files).toEqual([])
    await t.call('quirky.editor/search', { worktree: t.worktreeId, action: 'cancel' })
    expect((await t.call<{ loading: boolean }>('quirky.editor/search', { worktree: t.worktreeId, action: 'state' })).loading).toBe(false)
  })

  test('SC-37: late cancellation is scoped to its request and old output cannot replace newer state', async () => {
    const t = await boot()
    await write(t, 'src/old.ts', 'oldneedle\n')
    await write(t, 'src/new.ts', 'newneedle\n')
    const rg = controlledRg(['oldneedle', 'newneedle'], ['oldneedle'])
    try {
      const { result: oldRun } = await rg.start(t, 'oldneedle', 'old-request')
      const { result: newRun } = await rg.start(t, 'newneedle', 'new-request')
      const staleCancel = await cancelSearch(t, 'old-request')
      expect(staleCancel).toMatchObject({ query: 'newneedle', requestId: 'new-request', loading: true, error: null })

      rg.release('newneedle')
      const replacement = await newRun
      expect(replacement).toMatchObject({
        query: 'newneedle',
        requestId: 'new-request',
        loading: false,
        error: null,
        totalMatches: 1,
        files: [{ relativePath: 'src/new.ts', matches: [{ lineContent: 'newneedle' }] }]
      })
      rg.release('oldneedle')
      await oldRun
      expect(await t.call<EditorSearchState>('quirky.editor/search', { worktree: t.worktreeId, action: 'state' })).toMatchObject({
        query: 'newneedle',
        requestId: 'new-request',
        loading: false,
        error: null,
        totalMatches: 1,
        files: [{ relativePath: 'src/new.ts', matches: [{ lineContent: 'newneedle' }] }]
      })
    } finally {
      await rg.cleanup()
    }
  }, 30_000)

  test('SC-37: matching and ID-less cancellation finish without reporting an error', async () => {
    const t = await boot()
    await write(t, 'src/cancel.ts', 'cancelneedle\n')
    const rg = controlledRg(['matching-cancel', 'idless-cancel'])
    try {
      const { result: matchingRun } = await rg.start(t, 'matching-cancel', 'matching-request')
      await cancelSearch(t, 'matching-request')
      expect(await matchingRun).toMatchObject({ requestId: 'matching-request', loading: false, error: null })

      const { result: idlessRun } = await rg.start(t, 'idless-cancel', 'idless-request')
      await cancelSearch(t)
      expect(await idlessRun).toMatchObject({ requestId: 'idless-request', loading: false, error: null })
    } finally {
      await rg.cleanup()
    }
  }, 30_000)

  test('SC-1/21: explicit terminal groups share a buffer, retain per-tab state and keep preview identity separate', async () => {
    const t = await boot()
    await write(t, 'a.ts', 'one\ntwo\nthree\n')
    await write(t, 'b.ts', 'another file\n')
    const left = await open(t, 'a.ts', { mode: 'source', focus: false })
    const moved = await open(t, 'b.ts', { mode: 'source', focus: false })

    type TerminalTab = { viewId?: string; key?: string; input?: { bufferId?: string; mode?: string } }
    type TerminalGroup = { id?: string; tabs?: TerminalTab[]; first?: TerminalGroup; second?: TerminalGroup }
    const collectGroups = (root: TerminalGroup): string[] => {
      const ids: string[] = []
      const visit = (group: TerminalGroup): void => {
        if (group.id !== undefined && group.tabs !== undefined) ids.push(group.id)
        if (group.first !== undefined) visit(group.first)
        if (group.second !== undefined) visit(group.second)
      }
      visit(root)
      return ids
    }
    const initial = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/workspace', { workspace: `id:${t.worktreeId}` })
    const initialGroups = collectGroups(initial.workspace.root)
    expect(initialGroups).toHaveLength(1)
    const sourceGroupId = initialGroups[0]!
    const split = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/moveTab', {
      tab: moved.tabId!, split: 'right', of: sourceGroupId
    })
    const splitGroupIds = collectGroups(split.workspace.root)
    expect(splitGroupIds).toHaveLength(2)
    const targetGroupId = splitGroupIds.find((groupId) => groupId !== sourceGroupId)!

    const second = await open(t, 'a.ts', { group: targetGroupId, mode: 'source', focus: false })
    expect(second.id).toBe(left.id)
    let tabs = (await state(t, { bufferId: left.id })).tabs
    const leftTab = tabs.find((tab) => tab.group === sourceGroupId)
    const rightTab = tabs.find((tab) => tab.group === targetGroupId)
    expect(leftTab).toBeDefined()
    expect(rightTab).toBeDefined()
    expect(leftTab?.tabId).not.toBe(rightTab?.tabId)

    await t.call('quirky.editor/view', { bufferId: left.id, tabId: leftTab!.tabId, action: 'update', patch: { line: 2, column: 3 } })
    await t.call('quirky.editor/view', { bufferId: left.id, tabId: rightTab!.tabId, action: 'update', patch: { line: 3, column: 4 } })
    const changedMode = await t.call<EditorBuffer>('quirky.editor/view', {
      bufferId: left.id, tabId: leftTab!.tabId, action: 'update', patch: { mode: 'rich' }
    })
    expect(changedMode.mode).toBe('rich')
    expect(changedMode.view).toMatchObject({
      byTabId: {
        [leftTab!.tabId]: { line: 2, column: 3 },
        [rightTab!.tabId]: { line: 3, column: 4 }
      }
    })
    await expect(t.call('quirky.editor/view', {
      bufferId: left.id, tabId: leftTab!.tabId, action: 'update', patch: { mode: 'preview' }
    })).rejects.toThrow()

    const preview = await open(t, 'a.ts', { mode: 'preview', group: targetGroupId, focus: false })
    expect(preview.mode).toBe('preview')
    tabs = (await state(t, { bufferId: left.id })).tabs
    expect(tabs.filter((tab) => tab.mode === 'edit')).toHaveLength(2)
    expect(tabs.filter((tab) => tab.mode === 'preview')).toHaveLength(1)

    const terminalWorkspace = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/workspace', { workspace: `id:${t.worktreeId}` })
    const terminalTabs: TerminalTab[] = []
    const visitTabs = (group: TerminalGroup): void => {
      for (const tab of group.tabs ?? []) if (tab.viewId === 'view:quirky.editor/document') terminalTabs.push(tab)
      if (group.first !== undefined) visitTabs(group.first)
      if (group.second !== undefined) visitTabs(group.second)
    }
    visitTabs(terminalWorkspace.workspace.root)
    const editorTabs = terminalTabs.filter((tab) => tab.input?.bufferId === left.id)
    const richKeys = editorTabs.filter((tab) => tab.input?.mode === 'rich').map((tab) => tab.key)
    expect(richKeys).toHaveLength(2)
    expect(new Set(richKeys).size).toBe(2)
    expect(richKeys).toContain(left.id)
    expect(editorTabs.find((tab) => tab.input?.mode === 'preview')?.key).toBe(`preview:${left.id}`)
  })

  test('Markdown Preview titles stay distinct through mode updates, pinning, rename, Save As and reopen', async () => {
    const t = await boot()
    await write(t, 'notes.md', '# Notes\n')
    const edit = await open(t, 'notes.md', { mode: 'source', focus: false })
    const preview = await open(t, 'notes.md', { mode: 'preview', focus: false })
    expect(preview.id).toBe(edit.id)
    expect(preview.openedTabId).not.toBe(edit.openedTabId)

    type TerminalTab = {
      id?: string
      viewId?: string
      title?: string
      input?: { bufferId?: string; mode?: string }
      pinned?: boolean
      preview?: boolean
    }
    type TerminalGroup = { tabs?: TerminalTab[]; first?: TerminalGroup; second?: TerminalGroup }
    const editorTabs = async (bufferId = edit.id): Promise<TerminalTab[]> => {
      const result = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/workspace', {
        workspace: `id:${t.worktreeId}`
      })
      const tabs: TerminalTab[] = []
      const visit = (group: TerminalGroup): void => {
        for (const tab of group.tabs ?? []) {
          if (tab.viewId === 'view:quirky.editor/document') tabs.push(tab)
        }
        if (group.first !== undefined) visit(group.first)
        if (group.second !== undefined) visit(group.second)
      }
      visit(result.workspace.root)
      return tabs.filter((tab) => tab.input?.bufferId === bufferId)
    }
    const expectTitles = async (editTabId: string, previewTabId: string, name: string): Promise<void> => {
      const tabs = await editorTabs(edit.id)
      expect(tabs.find((tab) => tab.id === editTabId)?.title).toBe(name)
      expect(tabs.find((tab) => tab.id === previewTabId)?.title).toBe(`${name} (Preview)`)
    }

    await expectTitles(edit.openedTabId, preview.openedTabId, 'notes.md')
    await t.call('quirky.editor/view', {
      bufferId: edit.id, tabId: edit.openedTabId, action: 'update', patch: { mode: 'rich' }
    })
    await expectTitles(edit.openedTabId, preview.openedTabId, 'notes.md')
    await t.call('quirky.editor/view', { bufferId: edit.id, tabId: preview.openedTabId, action: 'pin' })
    expect((await editorTabs()).find((tab) => tab.id === preview.openedTabId)?.pinned).toBe(true)
    await expectTitles(edit.openedTabId, preview.openedTabId, 'notes.md')

    await t.call('quirky.editor/mutate', {
      worktree: t.worktreeId, action: 'rename', path: 'notes.md', newPath: 'renamed.md'
    })
    await expectTitles(edit.openedTabId, preview.openedTabId, 'renamed.md')
    expect((await t.call<{ closed: boolean }>('quirky.editor/close', {
      bufferId: edit.id, tabId: edit.openedTabId
    })).closed).toBe(true)
    const reopened = await t.call<EditorBuffer | null>('quirky.editor/reopen', { worktree: t.worktreeId, focus: false })
    expect(reopened?.id).toBe(edit.id)
    const reopenedState = await state(t, { bufferId: edit.id })
    const reopenedEditTab = reopenedState.tabs.find((tab) => tab.mode === 'edit')
    expect(reopenedEditTab).toBeDefined()
    await expectTitles(reopenedEditTab!.tabId, preview.openedTabId, 'renamed.md')
    await t.call('quirky.editor/view', {
      bufferId: edit.id, tabId: preview.openedTabId, action: 'returnToEdit', patch: { mode: 'source' }
    })
    expect((await editorTabs()).find((tab) => tab.id === preview.openedTabId)?.title).toBe('renamed.md')

    const created = await t.call<{ buffer: EditorBuffer; path: string }>('quirky.editor/markdown', {
      worktree: t.worktreeId, action: 'new'
    })
    const saveAsEdit = await open(t, created.path, { mode: 'source', focus: false })
    const saveAsPreview = await open(t, created.path, { mode: 'preview', focus: false })
    const draft = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: created.buffer.id, content: '# Saved\n', expectedRevision: created.buffer.contentRevision
    })
    await t.call('quirky.editor/saveAs', {
      bufferId: created.buffer.id, path: 'saved.md', expectedRevision: draft.contentRevision
    })
    const saveAsTabs = await editorTabs(created.buffer.id)
    expect(saveAsTabs.find((tab) => tab.id === saveAsEdit.openedTabId)?.title).toBe('saved.md')
    expect(saveAsTabs.find((tab) => tab.id === saveAsPreview.openedTabId)?.title).toBe('saved.md (Preview)')

    await write(t, 'replaceable.md', '# Replaceable\n')
    const replaceablePreview = await open(t, 'replaceable.md', { mode: 'preview', preview: true, focus: false })
    const replaceableTab = (await t.call<{ tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview' }[] }>(
      'quirky.editor/state', { bufferId: replaceablePreview.id }
    )).tabs.find((tab) => tab.mode === 'preview')!
    await t.call('quirky.editor/view', {
      bufferId: replaceablePreview.id, tabId: replaceableTab.tabId, action: 'promote'
    })
    const promoted = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/workspace', {
      workspace: `id:${t.worktreeId}`
    })
    const promotedTabs: TerminalTab[] = []
    const collectPromoted = (group: TerminalGroup): void => {
      for (const tab of group.tabs ?? []) {
        if (tab.viewId === 'view:quirky.editor/document' && tab.input?.bufferId === replaceablePreview.id) promotedTabs.push(tab)
      }
      if (group.first !== undefined) collectPromoted(group.first)
      if (group.second !== undefined) collectPromoted(group.second)
    }
    collectPromoted(promoted.workspace.root)
    expect(promotedTabs.find((tab) => tab.id === replaceableTab.tabId)).toMatchObject({
      title: 'replaceable.md (Preview)', preview: false
    })
  })

  test('200-character Markdown Preview titles fit terminal bounds through rename and Save As', async () => {
    const t = await boot()
    const originalName = `${'n'.repeat(197)}.md`
    const renamedName = `${'r'.repeat(197)}.md`
    expect(originalName.length).toBe(200)
    await write(t, originalName, '# Long name\n')
    const edit = await open(t, originalName, { mode: 'source', focus: false })
    const preview = await open(t, originalName, { mode: 'preview', focus: false })

    type TerminalTab = {
      id?: string
      viewId?: string
      title?: string
      input?: { bufferId?: string }
    }
    type TerminalGroup = { tabs?: TerminalTab[]; first?: TerminalGroup; second?: TerminalGroup }
    const editorTabs = async (bufferId: string): Promise<TerminalTab[]> => {
      const result = await t.call<{ workspace: { root: TerminalGroup } }>('quirky.terminal/workspace', {
        workspace: `id:${t.worktreeId}`
      })
      const tabs: TerminalTab[] = []
      const visit = (group: TerminalGroup): void => {
        for (const tab of group.tabs ?? []) {
          if (tab.viewId === 'view:quirky.editor/document' && tab.input?.bufferId === bufferId) tabs.push(tab)
        }
        if (group.first !== undefined) visit(group.first)
        if (group.second !== undefined) visit(group.second)
      }
      visit(result.workspace.root)
      return tabs
    }
    const expectTitles = async (bufferId: string, editTabId: string, previewTabId: string, name: string): Promise<void> => {
      const tabs = await editorTabs(bufferId)
      const editTitle = tabs.find((tab) => tab.id === editTabId)?.title
      const previewTitle = tabs.find((tab) => tab.id === previewTabId)?.title
      expect(editTitle).toBe(name)
      expect(editTitle?.length).toBeLessThanOrEqual(200)
      expect(previewTitle).toBe(`${name.slice(0, 190)} (Preview)`)
      expect(previewTitle?.length).toBeLessThanOrEqual(200)
    }

    await expectTitles(edit.id, edit.openedTabId, preview.openedTabId, originalName)
    await t.call('quirky.editor/mutate', {
      worktree: t.worktreeId, action: 'rename', path: originalName, newPath: renamedName
    })
    await expectTitles(edit.id, edit.openedTabId, preview.openedTabId, renamedName)

    const created = await t.call<{ buffer: EditorBuffer; path: string }>('quirky.editor/markdown', {
      worktree: t.worktreeId, action: 'new'
    })
    const saveAsEdit = await open(t, created.path, { mode: 'source', focus: false })
    const saveAsPreview = await open(t, created.path, { mode: 'preview', focus: false })
    const draft = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: created.buffer.id, content: '# Saved long name\n', expectedRevision: created.buffer.contentRevision
    })
    const saveAsName = `${'s'.repeat(197)}.md`
    expect(saveAsName.length).toBe(200)
    await t.call('quirky.editor/saveAs', {
      bufferId: created.buffer.id, path: saveAsName, expectedRevision: draft.contentRevision
    })
    await expectTitles(created.buffer.id, saveAsEdit.openedTabId, saveAsPreview.openedTabId, saveAsName)
  })

  test('SC-21/22: settings and generated commands are public, every method has schema, and disable disposes the editor lifecycle', async () => {
    const t = await boot()
    const api = await t.call<ApiDescription>('api.describe')
    const methods = new Map(api.methods.map((method) => [method.name, method]))
    for (const name of ['open', 'state', 'draft', 'save', 'close', 'canClose', 'reopen', 'view', 'explorer', 'mutate', 'history', 'quickOpen', 'search', 'read', 'transfer', 'markdown', 'notes', 'notebook', 'viewer', 'setupConfirmation']) {
      expect(methods.get(`quirky.editor/${name}`)?.params).toBeDefined()
      expect(methods.get(`quirky.editor/${name}`)?.result).toBeDefined()
    }
    const readSchema = methods.get('quirky.editor/read')?.params
    expect(readSchema?.properties?.action?.enum).toContain('text')
    expect(readSchema?.properties?.kind?.enum).toEqual(['content', 'draft', 'disk'])
    const openSchema = methods.get('quirky.editor/open')
    expect(openSchema?.params.properties?.matchLength?.type).toBe('integer')
    expect(openSchema?.result.properties?.openedTabId?.type).toBe('string')
    const viewPatchSchema = methods.get('quirky.editor/view')?.params.properties?.patch
    expect(viewPatchSchema?.properties?.markdownAnchor?.type).toBeUndefined()
    expect(viewPatchSchema?.properties?.markdownAnchor?.description).toContain('512 UTF-8 bytes')
    expect(viewPatchSchema?.properties?.matchLength?.description).toContain('null')
    const notebookSchema = methods.get('quirky.editor/notebook')?.params
    expect(notebookSchema?.properties?.browse?.type).toBe('boolean')
    const transferSchema = methods.get('quirky.editor/transfer')?.params
    expect(transferSchema?.properties?.action?.enum).toEqual(['begin', 'chunk', 'commit', 'cancel', 'state'])
    expect(notebookSchema?.properties?.yes?.type).toBe('boolean')
    expect(notebookSchema?.properties?.confirmed).toBeUndefined()
    for (const name of ['open', 'draft', 'save', 'view']) {
      const properties = methods.get(`quirky.editor/${name}`)?.result.properties
      for (const field of ['contentLength', 'contentBytes', 'draftLength', 'draftBytes', 'diskContentLength', 'diskContentBytes', 'diskSignature']) {
        expect(properties?.[field]).toBeDefined()
      }
    }
    const stateBufferProperties = methods.get('quirky.editor/state')?.result.properties?.buffers?.items?.properties
    expect(stateBufferProperties?.content).toBeUndefined()
    expect(stateBufferProperties?.draft).toBeUndefined()
    expect(stateBufferProperties?.diskContent).toBeUndefined()
    expect(stateBufferProperties?.contentLength).toBeDefined()
    expect(stateBufferProperties?.diskSignature).toBeDefined()
    expect(api.cli.commands.some((command) => command.words === 'editor transfer')).toBe(true)
    expect(api.cli.commands.some((command) => command.words === 'editor open' || command.aliasWords.includes('file open'))).toBe(true)
    const contributions = await t.call<{ id: string; kind: string }[]>('plugin.contributions', { pluginId: 'quirky.editor' })
    expect(contributions.some((item) => item.id === 'view:quirky.editor/document')).toBe(true)
    expect(contributions.some((item) => item.id === 'panel:quirky.editor/explorer')).toBe(true)
    const settings = await t.call<{ id: string }[]>('setting.list')
    expect(settings.some((setting) => setting.id === 'setting:quirky.editor/editorAutoSave')).toBe(true)
    await t.call('plugin.disable', { id: 'quirky.editor' })
    const plugins = await t.call<{ id: string; state: string }[]>('plugin.list')
    expect(plugins.find((plugin) => plugin.id === 'quirky.editor')?.state).toBe('disabled')
  })

  test('canonical authorization and file operations fail closed on escapes and in-root symlink races', async () => {
    const t = await boot()
    const outside = mkdtempSync(join(tmpdir(), 'quirky-editor-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret\n')
      symlinkSync(outside, join(t.root, 'escape'), 'dir')
      await expect(open(t, 'escape/secret.txt')).rejects.toThrow()
      await expect(t.call('quirky.editor/mutate', {
        worktree: t.worktreeId,
        action: 'createFile',
        path: 'escape/new.txt',
        content: 'not authorized'
      })).rejects.toThrow()
      await write(t, 'safe.txt', 'original\n')
      const buffer = await open(t, 'safe.txt')
      const draft = await t.call<EditorBuffer>('quirky.editor/draft', {
        bufferId: buffer.id,
        content: 'mine\n',
        expectedRevision: buffer.contentRevision
      })
      writeFileSync(join(t.root, 'safe.txt'), 'raced\n')
      await expect(t.call('quirky.editor/save', { bufferId: draft.id })).rejects.toThrow()
      expect(readFileSync(join(t.root, 'safe.txt'), 'utf8')).toBe('raced\n')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('close and restart leave no stale watcher updates or autosave generation writes', async () => {
    const t = await boot()
    await write(t, 'close.ts', 'disk\n')
    await t.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSave', value: true })
    const opened = await open(t, 'close.ts')
    const dirty = await t.call<EditorBuffer>('quirky.editor/draft', {
      bufferId: opened.id,
      content: 'stale timer\n',
      expectedRevision: opened.contentRevision
    })
    await t.call('quirky.editor/close', { bufferId: dirty.id, tabId: dirty.tabId, choice: 'discard' })
    await Bun.sleep(350)
    expect(readFileSync(join(t.root, 'close.ts'), 'utf8')).toBe('disk\n')
    await t.restart()
    expect((await state(t, { worktree: t.worktreeId })).buffers).toEqual([])
  })
})

describe('editor bounded transfers over the Unix socket', () => {
  test('returns text chunks at UTF-16 boundaries without splitting surrogate pairs', async () => {
    const t = await boot()
    const text = `${'a'.repeat(65535)}😀tail`
    await write(t, 'unicode.txt', text)
    const opened = await open(t, 'unicode.txt')
    const first = await t.call<{ text: string; offset: number; nextOffset: number }>('quirky.editor/read', {
      bufferId: opened.id, action: 'text', kind: 'content', offset: 0, length: 64 * 1024, contentRevision: opened.contentRevision
    })
    expect(first.text.length).toBe(65535)
    expect(first.nextOffset).toBe(65535)
    const second = await t.call<{ text: string; offset: number; nextOffset: number }>('quirky.editor/read', {
      bufferId: opened.id, action: 'text', kind: 'content', offset: first.nextOffset, length: 64 * 1024, contentRevision: opened.contentRevision
    })
    expect(second.text.startsWith('😀')).toBe(true)
    expect(first.text + second.text).toBe(text)
  })

  test('opens and reads a file larger than the socket line cap without sending whole-buffer JSON', async () => {
    const t = await boot()
    const largeText = 'x'.repeat(17 * 1024 * 1024)
    const expectedHash = createHash('sha256').update(largeText, 'utf8').digest('hex')
    await write(t, 'large.txt', largeText)
    const client = await connectUnix(t)
    try {
      const opened = await client.callAny('quirky.editor/open', { worktree: t.worktreeId, path: 'large.txt' }) as EditorBufferInfo
      expect(opened.content).toBeUndefined()
      expect(opened.contentLength).toBe(largeText.length)
      expect(opened.contentBytes).toBe(Buffer.byteLength(largeText, 'utf8'))
      const publicState = await client.callAny('quirky.editor/state', { worktree: t.worktreeId }) as { buffers: EditorBufferInfo[] }
      expect(publicState.buffers.find((buffer) => buffer.id === opened.id)?.content).toBeUndefined()
      let offset = 0
      let reconstructed = ''
      while (offset < opened.contentLength) {
        const chunk = await client.callAny('quirky.editor/read', {
          bufferId: opened.id,
          action: 'text',
          kind: 'content',
          offset,
          length: 64 * 1024,
          contentRevision: opened.contentRevision
        }) as { text: string; offset: number; nextOffset: number; eof: boolean; contentRevision: number }
        expect(chunk.offset).toBe(offset)
        expect(chunk.text.length).toBeLessThanOrEqual(64 * 1024)
        expect(chunk.contentRevision).toBe(opened.contentRevision)
        reconstructed += chunk.text
        offset = chunk.nextOffset
        expect(chunk.eof).toBe(offset === opened.contentLength)
      }
      expect(createHash('sha256').update(reconstructed, 'utf8').digest('hex')).toBe(expectedHash)
    } finally {
      client.close()
    }
  })

  test('stages a >16 MiB draft in bounded chunks, blocks save and close, then commits and guarded-saves exact text', async () => {
    const t = await boot()
    await write(t, 'draft.txt', 'before\n')
    const largeDraft = `\uFEFF${'y'.repeat(17 * 1024 * 1024)}`
    const bytes = Buffer.from(largeDraft, 'utf8')
    const client = await connectUnix(t)
    try {
      const opened = await client.callAny('quirky.editor/open', { worktree: t.worktreeId, path: 'draft.txt' }) as EditorBufferInfo
      await t.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSave', value: true })
      await t.client.call('setting.set', { id: 'setting:quirky.editor/editorAutoSaveDelayMs', value: 250 })
      const initialDraft = await client.callAny('quirky.editor/draft', {
        bufferId: opened.id, content: 'autosave waits for transfer\n', expectedRevision: opened.contentRevision
      }) as EditorBufferInfo
      const begin = await client.callAny('quirky.editor/transfer', {
        action: 'begin',
        kind: 'draft',
        bufferId: opened.id,
        expectedRevision: initialDraft.contentRevision,
        totalBytes: bytes.byteLength
      }) as { transferId: string; offset: number; maxChunkBytes: number }
      expect(begin.offset).toBe(0)
      expect(begin.maxChunkBytes).toBe(65536)
      expect(await client.callAny('quirky.editor/canClose', { bufferId: opened.id, tabId: opened.tabId })).toBe(false)
      await expect(client.callAny('quirky.editor/save', { bufferId: opened.id })).rejects.toThrow()
      const close = await client.callAny('quirky.editor/close', { bufferId: opened.id, tabId: opened.tabId }) as { closed: boolean; needsDecision?: boolean }
      expect(close).toMatchObject({ closed: false, needsDecision: true })
      // Autosave runs in the daemon process; fake timers in this client cannot advance it.
      await Bun.sleep(350)
      expect(readFileSync(join(t.root, 'draft.txt'), 'utf8')).toBe('before\n')
      const pendingDraft = await client.callAny('quirky.editor/read', {
        bufferId: opened.id, action: 'text', kind: 'draft', offset: 0, length: 64 * 1024,
        contentRevision: initialDraft.contentRevision
      }) as { text: string }
      expect(pendingDraft.text).toBe('autosave waits for transfer\n')
      for (let offset = 0; offset < bytes.byteLength; offset += begin.maxChunkBytes) {
        const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + begin.maxChunkBytes))
        await client.callAny('quirky.editor/transfer', {
          action: 'chunk',
          transferId: begin.transferId,
          offset,
          data: part.toString('base64')
        })
      }
      const committed = await client.callAny('quirky.editor/transfer', { action: 'commit', transferId: begin.transferId }) as EditorBufferInfo
      expect(committed.draft).toBeUndefined()
      expect(committed.draftLength).toBe(largeDraft.length)
      expect(committed.draftBytes).toBe(bytes.byteLength)
      await client.callAny('quirky.editor/save', { bufferId: opened.id, trigger: 'user' })
      expect(createHash('sha256').update(readFileSync(join(t.root, 'draft.txt'))).digest('hex'))
        .toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(await client.callAny('quirky.editor/canClose', { bufferId: opened.id, tabId: opened.tabId })).toBe(true)
    } finally {
      client.close()
    }
  })

  test('rejects partial and stale transfers, cancels isolated staging, and imports binary bytes collision-safely', async () => {
    const t = await boot()
    await write(t, 'existing.txt', 'original\n')
    const client = await connectUnix(t)
    try {
      const opened = await client.callAny('quirky.editor/open', { worktree: t.worktreeId, path: 'existing.txt' }) as EditorBufferInfo
      const partial = await client.callAny('quirky.editor/transfer', {
        action: 'begin', kind: 'draft', bufferId: opened.id, expectedRevision: opened.contentRevision, totalBytes: 8
      }) as { transferId: string }
      await expect(client.callAny('quirky.editor/transfer', {
        action: 'chunk', transferId: partial.transferId, offset: 1, data: Buffer.from('changed\n').toString('base64')
      })).rejects.toThrow()
      await expect(client.callAny('quirky.editor/transfer', { action: 'commit', transferId: partial.transferId })).rejects.toThrow()
      const partialState = await client.callAny('quirky.editor/transfer', { action: 'state', transferId: partial.transferId }) as { offset: number }
      expect(partialState.offset).toBe(0)
      await client.callAny('quirky.editor/transfer', { action: 'cancel', transferId: partial.transferId })
      const stale = await client.callAny('quirky.editor/transfer', {
        action: 'begin', kind: 'draft', bufferId: opened.id, expectedRevision: opened.contentRevision, totalBytes: 8
      }) as { transferId: string }
      const draftBytes = Buffer.from('changed\n')
      await client.callAny('quirky.editor/transfer', { action: 'chunk', transferId: stale.transferId, offset: 0, data: draftBytes.toString('base64') })
      await client.callAny('quirky.editor/view', { bufferId: opened.id, action: 'reload' })
      await expect(client.callAny('quirky.editor/transfer', { action: 'commit', transferId: stale.transferId })).rejects.toThrow()
      expect(readFileSync(join(t.root, 'existing.txt'), 'utf8')).toBe('original\n')
      await expect(client.callAny('quirky.editor/transfer', {
        action: 'begin', kind: 'import', worktree: t.worktreeId, path: '.', name: '../escape.bin', totalBytes: 1
      })).rejects.toThrow()
      const binary = Buffer.from([0, 255, 1, 2, 3])
      const upload = await client.callAny('quirky.editor/transfer', {
        action: 'begin', kind: 'import', worktree: t.worktreeId, path: '.', name: 'binary.dat', totalBytes: binary.byteLength
      }) as { transferId: string }
      await client.callAny('quirky.editor/transfer', { action: 'chunk', transferId: upload.transferId, offset: 0, data: binary.toString('base64') })
      const imported = await client.callAny('quirky.editor/transfer', { action: 'commit', transferId: upload.transferId }) as { path: string; paths: string[] }
      expect(imported).toMatchObject({ path: '.', paths: ['binary.dat'] })
      expect(readFileSync(join(t.root, 'binary.dat'))).toEqual(binary)
    } finally {
      client.close()
    }
  })

  test('expires idle transfers and removes only their pending draft gate', async () => {
    const t = await boot()
    await write(t, 'expiry.txt', 'disk\n')
    const client = await connectUnix(t)
    try {
      const opened = await client.callAny('quirky.editor/open', { worktree: t.worktreeId, path: 'expiry.txt' }) as EditorBufferInfo
      const transfer = await client.callAny('quirky.editor/transfer', {
        action: 'begin', kind: 'draft', bufferId: opened.id, expectedRevision: opened.contentRevision, totalBytes: 12
      }) as { transferId: string }
      setSystemTime(new Date(Date.now() + 5 * 60 * 1000 + 1))
      // Looking up the expired capability awaits removal of its staging and draft gate.
      await expect(client.callAny('quirky.editor/transfer', { action: 'state', transferId: transfer.transferId })).rejects.toThrow()
      expect(await client.callAny('quirky.editor/canClose', { bufferId: opened.id, tabId: opened.tabId })).toBe(true)
    } finally {
      setSystemTime()
      client.close()
    }
  })
})
