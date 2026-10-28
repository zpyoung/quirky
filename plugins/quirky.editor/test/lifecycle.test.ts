import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import type { EditorBufferInfo, EditorOpenResult, EditorStateData } from '../src/types'

type Api = <Result>(method: string, params?: Record<string, unknown>) => Promise<Result>
type Fixture = { harness: Harness; client: QuirkyClient; call: Api; root: string; worktreeId: string; restart(): Promise<void> }
type MarkdownNewResult = { buffer: EditorBufferInfo; path: string; template: string | null; templateCreated: boolean }
type CloseResult = { closed: boolean; needsDecision?: boolean }
type MutationResult = { path: string }
type MarkdownNoteAddResult = { note: { id: string } }
type MarkdownNoteListResult = { notes: { id: string; filePath: string; body: string }[] }
type ReadBufferResult = { buffer?: EditorBufferInfo }

let fixture: Fixture | null = null
let activeHarness: Harness | null = null

beforeEach(async () => {
  const home = makeHomeWithoutAutoHooks('editor-lifecycle-')
  let harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  activeHarness = harness
  let client = await harness.connect('cli', 'editor-lifecycle-test')
  const root = join(home, 'workspace')
  mkdirSync(root, { recursive: true })
  await client.callAny('quirky.repo/add', { path: root, folder: true })
  const worktree = await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` }) as { id: string }
  fixture = {
    get harness() { return harness },
    get client() { return client },
    root,
    worktreeId: worktree.id,
    call: <Result,>(method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<Result>,
    async restart() {
      for (const connection of harness.clients) connection.close()
      await harness.daemon.stop()
      harness.pty.stop()
      harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
      activeHarness = harness
      client = await harness.connect('cli', 'editor-lifecycle-restarted')
    }
  }
})

afterEach(async () => {
  await activeHarness?.cleanup()
  activeHarness = null
  fixture = null
})

function current(): Fixture {
  if (!fixture) throw new Error('Editor lifecycle fixture was not started')
  return fixture
}

function put(path: string, content: string): string {
  const absolute = join(current().root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

async function markdown<Result>(action: string, fields: Record<string, unknown> = {}): Promise<Result> {
  return current().call<Result>('quirky.editor/markdown', { action, worktree: current().worktreeId, ...fields })
}

async function readBuffer(bufferId: string): Promise<EditorBufferInfo> {
  const result = await current().call<ReadBufferResult>('quirky.editor/read', { bufferId, action: 'buffer' })
  if (!result.buffer) throw new Error(`Editor buffer ${bufferId} was not returned`)
  return result.buffer
}

describe('Markdown untitled lifecycle through public APIs', () => {
  test('a blank untitled document remains rich-eligible without a browser DOM in the daemon', async () => {
    const blank = await markdown<MarkdownNewResult>('new')
    const capabilities = await markdown<{ richEligible: boolean; canonicalText: string }>('capabilities', {
      bufferId: blank.buffer.id,
      includeCanonical: true
    })
    expect(capabilities.richEligible).toBe(true)
    expect(capabilities.canonicalText).toBe('')
  })

  test('blank clean placeholders are removed while template and ever-edited placeholders are retained', async () => {
    const occupied = put('untitled.md', 'unrelated text\n')
    put('.orca/templates/review.md', '# {{title}}\n')

    const blank = await markdown<MarkdownNewResult>('new')
    expect(blank).toMatchObject({ path: 'untitled-2.md', buffer: { untitled: true } })
    const blankPath = join(current().root, blank.path)
    expect(readFileSync(blankPath, 'utf8')).toBe('')
    expect(await current().call<CloseResult>('quirky.editor/close', { bufferId: blank.buffer.id })).toEqual({ closed: true })
    expect(existsSync(blankPath)).toBe(false)
    expect(readFileSync(occupied, 'utf8')).toBe('unrelated text\n')

    const template = await markdown<MarkdownNewResult>('new', { template: '.orca/templates/review.md', title: 'Release' })
    const templatePath = join(current().root, template.path)
    expect(template).toMatchObject({ templateCreated: true, buffer: { untitled: true } })
    const templateText = readFileSync(templatePath, 'utf8')
    expect(templateText).toBe('# Release\n')
    expect(await current().call<CloseResult>('quirky.editor/close', { bufferId: template.buffer.id })).toEqual({ closed: true })
    expect(readFileSync(templatePath, 'utf8')).toBe(templateText)

    const edited = await markdown<MarkdownNewResult>('new')
    const editedPath = join(current().root, edited.path)
    const draft = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: edited.buffer.id,
      content: '# Typed, then discarded\n',
      expectedRevision: edited.buffer.contentRevision
    })
    await current().call<CloseResult>('quirky.editor/close', { bufferId: edited.buffer.id, choice: 'discard' })
    expect(readFileSync(editedPath, 'utf8')).toBe('')
    expect(draft.dirty).toBe(true)
  })

  test('placeholder cleanup provenance survives a daemon restart', async () => {
    put('.orca/templates/persisted.md', '# {{title}}\\n')
    const blank = await markdown<MarkdownNewResult>('new')
    const template = await markdown<MarkdownNewResult>('new', { template: '.orca/templates/persisted.md', title: 'Durable' })
    const edited = await markdown<MarkdownNewResult>('new')
    const firstEdit = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: edited.buffer.id,
      content: 'temporary text\\n',
      expectedRevision: edited.buffer.contentRevision
    })
    await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: edited.buffer.id,
      content: '',
      expectedRevision: firstEdit.contentRevision
    })

    await current().restart()
    await current().call<CloseResult>('quirky.editor/close', { bufferId: blank.buffer.id })
    await current().call<CloseResult>('quirky.editor/close', { bufferId: template.buffer.id })
    await current().call<CloseResult>('quirky.editor/close', { bufferId: edited.buffer.id })

    expect(existsSync(join(current().root, blank.path))).toBe(false)
    expect(readFileSync(join(current().root, template.path), 'utf8')).toBe('# Durable\\n')
    expect(readFileSync(join(current().root, edited.path), 'utf8')).toBe('')
  })

  test('a user-renamed placeholder becomes a named file and survives a clean close', async () => {
    const created = await markdown<MarkdownNewResult>('new')
    const renamed = await current().call<MutationResult>('quirky.editor/mutate', {
      worktree: current().worktreeId,
      action: 'rename',
      path: created.path,
      newPath: 'named.md'
    })
    expect(renamed.path).toBe('named.md')
    expect(await readBuffer(created.buffer.id)).toMatchObject({ relativePath: 'named.md', untitled: false })
    await current().call<CloseResult>('quirky.editor/close', { bufferId: created.buffer.id })
    expect(existsSync(join(current().root, 'named.md'))).toBe(true)
    expect(readFileSync(join(current().root, 'named.md'), 'utf8')).toBe('')
  })

  test('Save As rejects stale, occupied and escaping targets without changing either side, then retargets one buffer and its notes', async () => {
    const created = await markdown<MarkdownNewResult>('new')
    const oldPath = join(current().root, created.path)
    const first = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: created.buffer.id,
      content: '# Plan v1\n',
      expectedRevision: created.buffer.contentRevision
    })
    const note = await current().call<MarkdownNoteAddResult>('quirky.editor/notes', {
      bufferId: created.buffer.id,
      action: 'add',
      selection: { from: 2, to: 6, mode: 'source' },
      text: 'Keep this review note'
    })

    await expect(current().call<unknown>('quirky.editor/save', { bufferId: created.buffer.id, trigger: 'user' })).rejects.toThrow()
    await expect(current().call<CloseResult>('quirky.editor/close', { bufferId: created.buffer.id, choice: 'save' })).rejects.toThrow()
    expect(await readBuffer(created.buffer.id)).toMatchObject({ draft: '# Plan v1\n', dirty: true, untitled: true })
    put('occupied.md', 'destination belongs to someone else\n')
    mkdirSync(join(current().root, 'notes'), { recursive: true })

    await expect(current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: created.buffer.id,
      path: 'notes/stale.md',
      expectedRevision: created.buffer.contentRevision
    })).rejects.toThrow()
    expect(existsSync(join(current().root, 'notes/stale.md'))).toBe(false)
    expect(readFileSync(oldPath, 'utf8')).toBe('')
    expect((await readBuffer(created.buffer.id)).draft).toBe('# Plan v1\n')

    await expect(current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: created.buffer.id,
      path: 'occupied.md',
      expectedRevision: first.contentRevision
    })).rejects.toThrow()
    await expect(current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: created.buffer.id,
      path: '../outside.md',
      expectedRevision: first.contentRevision
    })).rejects.toThrow()
    expect(readFileSync(join(current().root, 'occupied.md'), 'utf8')).toBe('destination belongs to someone else\n')
    expect(readFileSync(oldPath, 'utf8')).toBe('')

    const latest = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: created.buffer.id,
      content: '# Plan v2\n',
      expectedRevision: first.contentRevision
    })
    const saved = await current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: created.buffer.id,
      path: 'notes/plan.md',
      expectedRevision: latest.contentRevision
    })
    expect(saved).toMatchObject({
      id: created.buffer.id,
      relativePath: 'notes/plan.md',
      name: 'plan.md',
      untitled: false,
      tabId: created.buffer.tabId
    })
    expect(readFileSync(join(current().root, 'notes/plan.md'), 'utf8')).toBe('# Plan v2\n')
    expect(existsSync(oldPath)).toBe(false)
    const state = await current().call<EditorStateData>('quirky.editor/state', { bufferId: created.buffer.id })
    expect(state.tabs).toContainEqual(expect.objectContaining({ tabId: created.buffer.tabId, bufferId: created.buffer.id, mode: 'edit' }))
    const notes = await current().call<MarkdownNoteListResult>('quirky.editor/notes', { bufferId: created.buffer.id, action: 'list' })
    expect(notes.notes).toContainEqual(expect.objectContaining({ id: note.note.id, filePath: 'notes/plan.md', body: 'Keep this review note' }))
  })

  test('Save As leaves an externally changed old placeholder intact after successful retarget', async () => {
    const created = await markdown<MarkdownNewResult>('new')
    const oldPath = join(current().root, created.path)
    const draft = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: created.buffer.id,
      content: 'my saved text\n',
      expectedRevision: created.buffer.contentRevision
    })
    writeFileSync(oldPath, 'external edit must survive\n')

    const saved = await current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: created.buffer.id,
      path: 'kept.md',
      expectedRevision: draft.contentRevision
    })
    expect(saved.untitled).toBe(false)
    expect(readFileSync(join(current().root, 'kept.md'), 'utf8')).toBe('my saved text\n')
    expect(readFileSync(oldPath, 'utf8')).toBe('external edit must survive\n')
  })

  test('Save As is unavailable for ordinary named Markdown files', async () => {
    const namedPath = put('named.md', 'named document\n')
    const named = await current().call<EditorOpenResult>('quirky.editor/open', { worktree: current().worktreeId, path: 'named.md' })
    await expect(current().call<EditorBufferInfo>('quirky.editor/saveAs', {
      bufferId: named.id,
      path: 'copy.md',
      expectedRevision: named.contentRevision
    })).rejects.toThrow()
    expect(readFileSync(namedPath, 'utf8')).toBe('named document\n')
    expect(existsSync(join(current().root, 'copy.md'))).toBe(false)
  })

  test('returning from Preview changes the selected tab role and mode without replacing its buffer or draft', async () => {
    put('guide.md', '# Original\n')
    const preview = await current().call<EditorOpenResult>('quirky.editor/open', {
      worktree: current().worktreeId,
      path: 'guide.md',
      mode: 'preview',
      focus: true
    })
    const draft = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: preview.id,
      content: '# Dirty shared text\n',
      expectedRevision: preview.contentRevision
    })
    const before = await current().call<EditorStateData>('quirky.editor/state', { bufferId: preview.id })
    expect(before.tabs).toContainEqual(expect.objectContaining({ tabId: preview.openedTabId, mode: 'preview' }))

    const returned = await current().call<EditorBufferInfo>('quirky.editor/view', {
      bufferId: preview.id,
      tabId: preview.openedTabId,
      action: 'returnToEdit',
      patch: { mode: 'source' }
    })
    const after = await current().call<EditorStateData>('quirky.editor/state', { bufferId: preview.id })
    expect(returned).toMatchObject({ id: preview.id, mode: 'source', draft: '# Dirty shared text\n', contentRevision: draft.contentRevision })
    expect(after.tabs).toContainEqual(expect.objectContaining({ tabId: preview.openedTabId, bufferId: preview.id, mode: 'edit' }))
    expect(after.tabs.filter((tab: { tabId: string }) => tab.tabId === preview.openedTabId)).toHaveLength(1)
  })

  test('returning from Preview to Rich Editor preserves the preview tab and dirty buffer', async () => {
    put('rich.md', '# Original\\n')
    const preview = await current().call<EditorOpenResult>('quirky.editor/open', {
      worktree: current().worktreeId,
      path: 'rich.md',
      mode: 'preview',
      focus: true
    })
    const draft = await current().call<EditorBufferInfo>('quirky.editor/draft', {
      bufferId: preview.id,
      content: '# Rich draft\\n',
      expectedRevision: preview.contentRevision
    })
    const returned = await current().call<EditorBufferInfo>('quirky.editor/view', {
      bufferId: preview.id,
      tabId: preview.openedTabId,
      action: 'returnToEdit',
      patch: { mode: 'rich' }
    })
    const state = await current().call<EditorStateData>('quirky.editor/state', { bufferId: preview.id })
    expect(returned).toMatchObject({ id: preview.id, mode: 'rich', draft: '# Rich draft\\n', contentRevision: draft.contentRevision })
    expect(state.tabs).toContainEqual(expect.objectContaining({ tabId: preview.openedTabId, bufferId: preview.id, mode: 'edit' }))
  })
})
