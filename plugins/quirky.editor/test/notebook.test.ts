import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'

setDefaultTimeout(120_000)

type ApiRecord = Record<string, unknown>
type NotebookWorld = {
  harness: Harness
  client: QuirkyClient
  root: string
  worktree: string
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  open(path: string): Promise<{ bufferId: string; tabId?: string; result: ApiRecord }>
}

function record(value: unknown, label = 'API result'): ApiRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as ApiRecord
}

function records(value: unknown, label = 'API result list'): ApiRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => record(entry, `${label}[${index}]`))
}

function requiredString(value: ApiRecord, key: string): string {
  const result = value[key]
  if (typeof result !== 'string') throw new Error(`API result has no string ${key}`)
  return result
}

function kernelPid(value: ApiRecord): number {
  const kernel = record(value.kernel, 'kernel state')
  const pid = kernel.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('kernel state has no process id')
  }
  return pid
}

function outputText(output: ApiRecord): string {
  if (typeof output.text === 'string') return output.text
  const data = output.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const plain = record(data, 'output data')['text/plain']
    if (typeof plain === 'string') return plain
  }
  return ''
}

function notebookCells(value: ApiRecord): ApiRecord[] {
  return records(value.cells, 'notebook cells')
}

function outputs(value: ApiRecord): ApiRecord[] {
  return records(value.outputs, 'cell outputs')
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const worlds: NotebookWorld[] = []

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function start(files: Record<string, string>): Promise<NotebookWorld> {
  const home = makeHomeWithoutAutoHooks('m2-notebook-')
  const root = join(home, 'repo')
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Notebook Tests')
  git(root, 'config', 'user.email', 'notebook-tests@example.invalid')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'test fixtures')

  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  const client = await harness.connect('cli')
  const repo = record(await client.callAny('quirky.repo/add', { path: root }), 'added repo')
  const worktrees = records(await client.callAny('quirky.worktree/list', { repo: requiredString(repo, 'id') }), 'worktree list')
  const worktree = worktrees.find((entry) => entry.path === root) ?? worktrees[0]
  if (!worktree) throw new Error('test worktree was not registered')

  const world: NotebookWorld = {
    harness,
    client,
    root,
    worktree: requiredString(worktree, 'id'),
    call: (method, params = {}) => client.callAny(`quirky.editor/${method}`, params),
    async open(path) {
      const result = record(await this.call('open', { worktree: this.worktree, path, focus: false }), 'editor.open result')
      const buffer = result.buffer ? record(result.buffer, 'editor.open buffer') : result
      const bufferId = typeof buffer.id === 'string' ? buffer.id : typeof result.bufferId === 'string' ? result.bufferId : undefined
      if (!bufferId) throw new Error(`editor.open did not return a buffer id: ${JSON.stringify(result)}`)
      const tab = result.tab ? record(result.tab, 'editor.open tab') : undefined
      const tabId = typeof tab?.id === 'string' ? tab.id : typeof result.tabId === 'string' ? result.tabId : undefined
      return { bufferId, tabId, result }
    }
  }
  worlds.push(world)
  return world
}

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.harness.cleanup()
})

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    const rpc = record(error, 'RPC error')
    const code = rpc.code
    return { code: typeof code === 'number' ? code : Number.NaN, message: requiredString(rpc, 'message') }
  }
  throw new Error('expected the editor API call to fail')
}

const notebook = (world: NotebookWorld, bufferId: string, action: string, fields: Record<string, unknown> = {}) =>
  world.call('notebook', { bufferId, action, ...fields })

const python = process.env.QUIRKY_TEST_NOTEBOOK_PYTHON ?? ''

describe('notebook API behavior', () => {
  test('SC-16: parsing and cell edits preserve root/cell metadata, output data, and source newlines', async () => {
    const rootMetadata = { custom: { retained: true }, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }
    const original = {
      cells: [
        { cell_type: 'markdown', metadata: { tags: ['keep'] }, source: ['Heading\r\n', 'text\n'] },
        { cell_type: 'code', execution_count: 7, metadata: { custom: 'cell' }, outputs: [{ output_type: 'stream', name: 'stdout', text: ['kept\n'] }], source: ['print(1)\n'] },
        { cell_type: 'raw', metadata: { raw: true }, source: ['raw'] }
      ],
      metadata: rootMetadata,
      nbformat: 4,
      nbformat_minor: 4
    }
    const world = await start({ 'notes.ipynb': JSON.stringify(original) + '\n' })
    const { bufferId } = await world.open('notes.ipynb')

    const parsed = record(await notebook(world, bufferId, 'parse'))
    expect(parsed).toMatchObject({ valid: true, cellCount: 3, language: 'python' })
    const parsedCells = notebookCells(parsed)
    expect(parsedCells[0]).toMatchObject({ cell_type: 'markdown', metadata: { tags: ['keep'] }, source: 'Heading\r\ntext\n' })
    expect(parsedCells[1]).toMatchObject({ execution_count: 7, outputs: original.cells[1]!.outputs, metadata: { custom: 'cell' } })

    await notebook(world, bufferId, 'edit', { index: 0, source: 'Changed\r\nsecond\n' })
    await notebook(world, bufferId, 'insert', { index: 1, position: 'above', cellType: 'code' })
    await notebook(world, bufferId, 'move', { index: 3, direction: 'up' })
    await notebook(world, bufferId, 'type', { index: 1, cellType: 'raw' })
    const edited = record(await notebook(world, bufferId, 'parse'))
    const editedCells = notebookCells(edited)
    expect(editedCells.map((cell) => cell.cell_type)).toEqual(['markdown', 'raw', 'code', 'raw'])
    expect(editedCells[0]!.source).toBe('Changed\r\nsecond\n')
    expect(editedCells[0]!.metadata).toEqual({ tags: ['keep'] })
    expect(editedCells[2]!.outputs).toEqual(original.cells[1]!.outputs)
    expect(editedCells[1]!.id).toMatch(/^[0-9a-f-]{36}$/i)

    await notebook(world, bufferId, 'delete', { index: 1 })
    await notebook(world, bufferId, 'save')
    const saved = record(JSON.parse(readFileSync(join(world.root, 'notes.ipynb'), 'utf8')), 'saved notebook')
    const savedCells = records(saved.cells, 'saved cells')
    expect(saved.metadata).toEqual(rootMetadata)
    expect(saved.nbformat_minor).toBe(4)
    expect(savedCells[0]!.source).toEqual(['Changed\r\n', 'second\n'])
    expect(savedCells[1]!.outputs).toEqual(original.cells[1]!.outputs)
    expect(readFileSync(join(world.root, 'notes.ipynb'), 'utf8')).toBe(`${JSON.stringify(saved, null, 1)}\n`)
  })

  test('SC-16: deleting the last cell leaves a valid empty code cell', async () => {
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', execution_count: 2, metadata: { tag: 1 }, outputs: [{ output_type: 'stream', name: 'stdout', text: 'x' }], source: ['x'] }],
      metadata: { root: 'keep' }, nbformat: 4, nbformat_minor: 5
    })
    const world = await start({ 'single.ipynb': source })
    const { bufferId } = await world.open('single.ipynb')

    await notebook(world, bufferId, 'delete', { index: 0 })
    const parsed = record(await notebook(world, bufferId, 'parse'))
    const parsedCells = notebookCells(parsed)
    expect(parsedCells).toHaveLength(1)
    expect(parsedCells[0]).toMatchObject({ cell_type: 'code', source: '', execution_count: null, outputs: [] })
    expect(parsedCells[0]!.id).toMatch(/^[0-9a-f-]{36}$/i)
    await notebook(world, bufferId, 'save')
    const saved = record(JSON.parse(readFileSync(join(world.root, 'single.ipynb'), 'utf8')), 'saved notebook')
    expect(saved.metadata).toEqual({ root: 'keep' })
  })

  test('SC-16: malformed notebooks report a useful error while keeping raw source readable', async () => {
    const world = await start({ 'broken.ipynb': '{"cells": [\nnot valid\n' })
    const { bufferId } = await world.open('broken.ipynb')
    const parsed = record(await notebook(world, bufferId, 'parse'))
    expect(parsed.valid).toBe(false)
    expect(parsed.error).toContain('JSON')
    expect(parsed.rawSource).toBe('{"cells": [\nnot valid\n')
    expect(parsed.rawSourceLength).toBe('{"cells": [\nnot valid\n'.length)
  })
  test('SC-16: bounded cell source pages can be edited and saved without losing an unseen suffix', async () => {
    const completeSource = `${'x'.repeat(70_000)}💡 tail`
    const world = await start({ 'long-source.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', source: [completeSource], metadata: {}, outputs: [], execution_count: null }], metadata: { keep: true }, nbformat: 4, nbformat_minor: 5 }) })
    const { bufferId } = await world.open('long-source.ipynb')

    const first = record(await notebook(world, bufferId, 'parse', { offset: 0, limit: 1, sourceLength: 1024 }))
    const firstCell = notebookCells(first)[0]!
    expect(firstCell.sourceTruncated).toBe(true)
    expect(firstCell.source).toBe('x'.repeat(1024))
    const rest = record(await notebook(world, bufferId, 'parse', { offset: 0, limit: 1, sourceOffset: 1024, sourceLength: 64 * 1024 }))
    const restCell = notebookCells(rest)[0]!
    expect(restCell.sourceNextOffset).toBe(66_560)
    const finalPage = record(await notebook(world, bufferId, 'parse', { offset: 0, limit: 1, sourceOffset: 66_560, sourceLength: 64 * 1024 }))
    const finalCell = notebookCells(finalPage)[0]!
    expect(finalCell.sourceNextOffset).toBeNull()
    expect(finalCell.source).toContain('💡 tail')

    const editedSource = `changed ${completeSource.slice('x'.length)}`
    await notebook(world, bufferId, 'edit', { index: 0, source: editedSource })
    await notebook(world, bufferId, 'save')
    const saved = record(JSON.parse(readFileSync(join(world.root, 'long-source.ipynb'), 'utf8')), 'saved large notebook')
    const savedCells = records(saved.cells, 'saved cells')
    expect(savedCells[0]!.source).toEqual([editedSource])
    expect(saved.metadata).toEqual({ keep: true })
  })

  test('SC-17: run/start require notebook trust; install and venv require central confirmation and trust', async () => {
    const world = await start({ 'untrusted.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }) })
    const { bufferId } = await world.open('untrusted.ipynb')

    const runRefusal = await failure(notebook(world, bufferId, 'run', { index: 0 }))
    expect(runRefusal).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(runRefusal.message).toMatch(/trust/i)
    const startRefusal = await failure(notebook(world, bufferId, 'start', { python: '/not-an-interpreter' }))
    expect(startRefusal).toMatchObject({ code: RpcErrorCode.Conflict })
    expect(startRefusal.message).toMatch(/trust/i)

    const installConfirmation = await failure(notebook(world, bufferId, 'install', { python: '/not-an-interpreter' }))
    expect(installConfirmation.code).toBe(RpcErrorCode.ConfirmationRequired)
    const venvConfirmation = await failure(notebook(world, bufferId, 'venv', { python: '/not-an-interpreter' }))
    expect(venvConfirmation.code).toBe(RpcErrorCode.ConfirmationRequired)
    const installTrust = await failure(notebook(world, bufferId, 'install', { python: '/not-an-interpreter', yes: true }))
    expect(installTrust).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringMatching(/trust/i) })
    const venvTrust = await failure(notebook(world, bufferId, 'venv', { python: '/not-an-interpreter', yes: true }))
    expect(venvTrust).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringMatching(/trust/i) })
    expect(existsSync(join(world.root, '.venv'))).toBe(false)
  })

  test.skipIf(!python)('SC-17/18: selected Python runs a persistent real kernel in the notebook directory with isolated Jupyter state and stdin disabled', async () => {
    expect(existsSync(python)).toBe(true)
    const world = await start({
      'notebooks/run.ipynb': JSON.stringify({
        cells: [
          { cell_type: 'code', source: ['value = 41\n'], metadata: {}, outputs: [], execution_count: null },
          { cell_type: 'code', source: ['import os\nprint(value + 1)\nprint(os.getcwd())\nprint(os.environ[\"HOME\"])\nprint(os.environ[\"JUPYTER_RUNTIME_DIR\"])\nfrom IPython.display import HTML, Javascript, JSON, display\ndisplay(HTML(\"<b>safe</b>\"), Javascript(\"window.pwned = true\"), JSON({\"answer\": 42}))\n'], metadata: {}, outputs: [], execution_count: null },
          { cell_type: 'code', source: ["input('no stdin')\n"], metadata: {}, outputs: [], execution_count: null }
        ], metadata: {}, nbformat: 4, nbformat_minor: 4
      })
    })
    mkdirSync(join(world.root, '.venv', 'bin'), { recursive: true })
    symlinkSync(python, join(world.root, '.venv', 'bin', 'python'))
    const { bufferId } = await world.open('notebooks/run.ipynb')

    const discovered = record(await notebook(world, bufferId, 'environments'))
    expect(records(discovered.environments).some((environment) => environment.source === 'venv')).toBe(true)
    const before = readFileSync(join(world.root, 'notebooks/run.ipynb'), 'utf8')
    const selected = await notebook(world, bufferId, 'select', { python })
    expect(selected).toMatchObject({ selected: true, language: 'python' })
    expect(readFileSync(join(world.root, 'notebooks/run.ipynb'), 'utf8')).toBe(before)
    await notebook(world, bufferId, 'trust')
    const started = await notebook(world, bufferId, 'start', { python })
    expect(started).toMatchObject({ status: 'ready' })

    const first = record(await notebook(world, bufferId, 'run', { index: 0, mode: 'in-place' }))
    expect(first).toMatchObject({ status: 'ok', executionCount: 1 })
    const second = record(await notebook(world, bufferId, 'run', { index: 1, mode: 'in-place' }))
    expect(second).toMatchObject({ status: 'ok', outputCount: expect.any(Number) })
    const secondPage = record(await notebook(world, bufferId, 'parse', { offset: 1, limit: 1, outputLimit: 8, sourceLength: 1 }))
    const secondCell = notebookCells(secondPage)[0]!
    const secondOutputs = records(secondCell.outputs, 'execution outputs')
    const combinedOutput = secondOutputs.map(outputText).join('\n')
    expect(combinedOutput).toContain('42')
    expect(combinedOutput).toContain(join(world.root, 'notebooks'))
    expect(combinedOutput).toContain(world.harness.home)
    const display = secondOutputs.find((output) => output.output_type === 'display_data')
    const displayData = record(display?.data, 'display data')
    expect(displayData['text/html']).toContain('<b>safe</b>')
    expect(displayData['application/json']).toEqual({ answer: 42 })
    expect(displayData['application/javascript']).toBeUndefined()

    const third = record(await notebook(world, bufferId, 'run', { index: 2, mode: 'in-place' }))
    expect(third.status).toBe('error')
    const thirdPage = record(await notebook(world, bufferId, 'parse', { offset: 2, limit: 1, outputLimit: 8, sourceLength: 1 }))
    expect(records(notebookCells(thirdPage)[0]!.outputs, 'stdin error outputs').some((output) =>
      output.ename === 'StdinNotImplementedError' || /stdin|input/i.test(JSON.stringify(output))
    )).toBe(true)
    const state = record(await notebook(world, bufferId, 'state'))
    expect(state).toMatchObject({ trusted: true, busy: false, kernel: { status: 'ready' } })
    const stateCell = notebookCells(record(await notebook(world, bufferId, 'parse', { offset: 0, limit: 1, outputLimit: 1, sourceLength: 1 })))[0]!
    expect(stateCell).toMatchObject({ execution_count: 1 })
    expect(typeof stateCell.id).toBe('string')
    expect(stateCell.outputs).toBeDefined()
    await notebook(world, bufferId, 'save')
  })

  test.skipIf(!python)('SC-18: run-all executes serially, preserves variables, and cancels queued cells after an error', async () => {
    const world = await start({
      'queue.ipynb': JSON.stringify({ cells: [
        { cell_type: 'code', source: ['state = 3\n'], metadata: {}, outputs: [], execution_count: null },
        { cell_type: 'code', source: ['print(state)\n'], metadata: {}, outputs: [], execution_count: null },
        { cell_type: 'code', source: ["raise RuntimeError('stop')\n"], metadata: {}, outputs: [], execution_count: null },
        { cell_type: 'code', source: ["open('must-not-run', 'w').write('bad')\n"], metadata: {}, outputs: [], execution_count: null }
      ], metadata: {}, nbformat: 4, nbformat_minor: 5 })
    })
    const { bufferId } = await world.open('queue.ipynb')
    await notebook(world, bufferId, 'select', { python })
    await notebook(world, bufferId, 'trust')
    await notebook(world, bufferId, 'start', { python })

    const result = record(await notebook(world, bufferId, 'runAll'))
    expect(result.status).toBe('error')
    expect(result.completed).toBe(3)
    expect(result.cancelled).toBe(1)
    expect(existsSync(join(world.root, 'must-not-run'))).toBe(false)
    const secondCell = notebookCells(record(await notebook(world, bufferId, 'parse', { offset: 1, limit: 1, outputLimit: 1, sourceLength: 1 })))[0]!
    expect(outputs(secondCell).map(outputText).join('\n')).toContain('3')
    const notRunCell = notebookCells(record(await notebook(world, bufferId, 'parse', { offset: 3, limit: 1, sourceLength: 1 })))[0]!
    expect(notRunCell.execution_count).toBeNull()
    await notebook(world, bufferId, 'save')
  })

  test.skipIf(!python)('SC-18: interrupt, restart, and closing the owning edit tab clean up the actual kernel process', async () => {
    const world = await start({
      'lifecycle.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', source: ['import time\ntime.sleep(30)\n'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 })
    })
    const { bufferId, tabId } = await world.open('lifecycle.ipynb')
    await notebook(world, bufferId, 'select', { python })
    await notebook(world, bufferId, 'trust')
    await notebook(world, bufferId, 'start', { python })
    const initial = record(await notebook(world, bufferId, 'state'))
    const pid = kernelPid(initial)

    const running = notebook(world, bufferId, 'run', { index: 0, mode: 'in-place' })
    await waitForAsync(async () => Boolean(record(await notebook(world, bufferId, 'state')).busy))
    await notebook(world, bufferId, 'interrupt')
    expect(record(await running).status).not.toBe('running')
    await notebook(world, bufferId, 'restart')
    const restarted = record(await notebook(world, bufferId, 'state'))
    expect(restarted).toMatchObject({ trusted: false, busy: false, kernel: { status: 'stopped' } })
    await notebook(world, bufferId, 'trust')
    await notebook(world, bufferId, 'start', { python })
    const restartedPid = kernelPid(record(await notebook(world, bufferId, 'state')))
    expect(restartedPid).not.toBe(pid)
    await notebook(world, bufferId, 'shutdown')
    await world.call('save', { bufferId })
    await world.call('close', { bufferId, ...(tabId ? { tabId } : {}), choice: 'discard' })

    await waitFor(() => processIsGone(restartedPid), 10_000)
  })
})
