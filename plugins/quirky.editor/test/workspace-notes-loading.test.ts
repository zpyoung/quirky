import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { runProcess } from '../src/markdown/pdf'

const roots: string[] = []
const runners: OwnedProcessRunner[] = []
const originalQuirkyHome = process.env.QUIRKY_HOME

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-workspace-notes-loading-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  try {
    for (const runner of runners.splice(0)) await runner.dispose()
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    if (originalQuirkyHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = originalQuirkyHome
  }
})

test('activated workspaceNotes lists persisted notes without loading the Markdown rendering stack', async () => {
  const root = temporaryRoot()
  const resultPath = join(root, 'workspace-notes-result.json')
  const pluginRoot = resolve(import.meta.dir, '..')
  const mainPath = join(pluginRoot, 'main.ts')
  const note = {
    id: 'note-workspace-loading-1',
    bufferId: 'buffer-workspace-loading-1',
    worktreeId: 'worktree-workspace-loading-1',
    filePath: 'docs/readme.md',
    source: 'markdown',
    selectedText: 'reviewed line',
    startLine: 1,
    endLine: 1,
    lineNumber: 1,
    body: 'Please review this line.',
    createdAt: 1234,
    side: 'modified'
  }
  const fixturePath = join(root, 'workspace-notes-loading.fixture.ts')
  writeFileSync(fixturePath, `
import { mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
const note = ${JSON.stringify(note)}
const persisted = { id: note.id, buffer_id: note.bufferId, payload: JSON.stringify(note) }
class FakeCore {
  methods = {}
  services
  constructor(context) {
    this.services = {
      context,
      store: {
        all: () => [persisted],
        get: () => persisted,
        transaction: (action) => action(),
        run: () => ({ changes: 0 })
      },
      resolve: async () => ({ id: note.worktreeId, path: '/workspace' }),
      path: async (_worktreeId, relativePath) => '/workspace/' + relativePath,
      emit() {}
    }
  }
  projectPublic(_method, value) { return value }
  async restore() {}
  async dispose() {}
}
mock.module(${JSON.stringify(join(pluginRoot, 'src/daemon/service.ts'))}, () => ({ EditorDaemon: FakeCore }))
mock.module(${JSON.stringify(join(pluginRoot, 'src/notebook/service.ts'))}, () => ({
  createNotebookMethods: () => ({ methods: {}, dispose() {} })
}))
mock.module(${JSON.stringify(join(pluginRoot, 'src/viewers/service.ts'))}, () => ({
  createViewerMethods: () => ({ methods: {}, dispose() {} })
}))
test('workspace notes use the real handler during activation', async () => {
  // Importing the activation module dynamically lets this process inspect its fresh module cache.
  const main = await import(${JSON.stringify(mainPath)})
  const handlers = new Map()
  const context = {
    pluginId: 'quirky.editor',
    subscribe: () => () => {},
    provide: (name, handler) => handlers.set(name, handler)
  }
  await main.activate(context)
  const handler = handlers.get('method:quirky.editor/workspaceNotes')
  const result = await handler({ action: 'list', worktree: 'id:' + note.worktreeId }, {})
  const excluded = [
    '/src/markdown/service',
    '/src/markdown/tiptap',
    'isomorphic-dompurify',
    'jsdom',
    'tiptap',
    'react-markdown'
  ]
  const loaded = Object.keys(require.cache).filter((key) => excluded.some((part) => key.includes(part)))
  await main.deactivate()
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result, loaded }))
})
`)
  const runner = createProcessRunner({ owner: 'workspace-notes-loading-regression' })
  runners.push(runner)
  const previousHome = process.env.QUIRKY_HOME
  process.env.QUIRKY_HOME = root
  try {
    const result = await runProcess(runner, process.execPath, ['test', fixturePath], {
      timeoutMs: 15_000,
      home: root
    })
    expect(result.code).toBe(0)
    const output = JSON.parse(readFileSync(resultPath, 'utf8')) as { result: unknown; loaded: string[] }
    expect(output.result).toEqual({ notes: [note] })
    expect(output.loaded).toEqual([])
  } finally {
    if (previousHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousHome
  }
})
