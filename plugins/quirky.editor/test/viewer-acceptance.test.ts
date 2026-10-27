import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'

setDefaultTimeout(120_000)

type ApiRecord = Record<string, unknown>
type FileData = string | Uint8Array
type ViewerWorld = {
  harness: Harness
  client: QuirkyClient
  root: string
  worktree: string
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  open(path: string): Promise<{ bufferId: string; tabId?: string }>
}

const harnesses: Harness[] = []

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
  if (typeof result !== 'string') throw new Error(`${key} is missing from API result`)
  return result
}

function notebookCells(value: ApiRecord): ApiRecord[] {
  return records(value.cells, 'notebook cells')
}

function outputText(output: ApiRecord): string {
  if (typeof output.text === 'string') return output.text
  if (Array.isArray(output.text) && output.text.every((part) => typeof part === 'string')) return output.text.join('')
  const data = output.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const plain = record(data, 'output data')['text/plain']
    if (typeof plain === 'string') return plain
  }
  return ''
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: isolatedChildEnv(dirname(root)), stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function start(files: Record<string, FileData>): Promise<ViewerWorld> {
  const home = makeHomeWithoutAutoHooks('m2-viewer-acceptance-')
  const root = join(home, 'repo')
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Viewer Acceptance Tests')
  git(root, 'config', 'user.email', 'viewer-acceptance@example.invalid')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'test fixtures')

  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  harnesses.push(harness)
  const client = await harness.connect('cli')
  const repo = record(await client.callAny('quirky.repo/add', { path: root }), 'added repo')
  const worktrees = records(await client.callAny('quirky.worktree/list', { repo: requiredString(repo, 'id') }), 'worktree list')
  const worktree = worktrees.find((entry) => entry.path === root) ?? worktrees[0]
  if (!worktree) throw new Error('test worktree was not registered')

  const world: ViewerWorld = {
    harness,
    client,
    root,
    worktree: requiredString(worktree, 'id'),
    call: (method, params = {}) => client.callAny(`quirky.editor/${method}`, params),
    async open(path) {
      const buffer = record(await this.call('open', { worktree: this.worktree, path, focus: false }), 'editor.open buffer')
      const tabId = typeof buffer.tabId === 'string' ? buffer.tabId : undefined
      return { bufferId: requiredString(buffer, 'id'), ...(tabId ? { tabId } : {}) }
    }
  }
  return world
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    const rpc = record(error, 'RPC error')
    return {
      code: typeof rpc.code === 'number' ? rpc.code : Number.NaN,
      message: requiredString(rpc, 'message')
    }
  }
  throw new Error('expected the editor API call to fail')
}

const notebook = (world: ViewerWorld, bufferId: string, action: string, fields: Record<string, unknown> = {}) =>
  world.call('notebook', { bufferId, action, ...fields })

const viewer = (world: ViewerWorld, bufferId: string, action: string, fields: Record<string, unknown> = {}) =>
  world.call('viewer', { bufferId, action, ...fields })

async function closeBuffer(world: ViewerWorld, bufferId: string, tabId?: string): Promise<void> {
  await world.call('close', { bufferId, ...(tabId ? { tabId } : {}), choice: 'discard' })
}

function kernelPid(value: ApiRecord): number {
  const kernel = record(value.kernel, 'kernel state')
  const pid = kernel.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('kernel state has no process id')
  return pid
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function resourceUrl(world: ViewerWorld, path: string): string {
  return new URL(path, `http://127.0.0.1:${world.harness.runtime.port}`).toString()
}

function isolatedChildEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    QUIRKY_HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  }
}

const python = process.env.QUIRKY_TEST_NOTEBOOK_PYTHON?.trim() ?? ''

function createNoPipEnvironment(world: ViewerWorld): { directory: string; python: string } {
  const directory = join(world.root, '.test-without-ipykernel')
  const result = Bun.spawnSync([python, '-m', 'venv', '--without-pip', directory], {
    cwd: world.root,
    env: isolatedChildEnv(world.harness.home),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim() || new TextDecoder().decode(result.stdout).trim()
    throw new Error(`Could not create the isolated no-pip Python environment: ${detail}`)
  }
  const executable = process.platform === 'win32'
    ? join(directory, 'Scripts', 'python.exe')
    : join(directory, 'bin', 'python')
  if (!existsSync(executable)) throw new Error('The isolated venv did not contain its Python executable')
  return { directory, python: executable }
}

describe('viewer and notebook API acceptance', () => {
  test('SC-17: selecting a missing Python executable returns an actionable error without creating a workspace environment', async () => {
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {}, nbformat: 4, nbformat_minor: 5
    })
    const world = await start({ 'missing-python.ipynb': source })
    const { bufferId } = await world.open('missing-python.ipynb')
    const executable = join(world.root, 'not-installed', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')

    const selected = await failure(notebook(world, bufferId, 'select', { python: executable }))
    expect(selected.code).toBe(RpcErrorCode.InvalidParams)
    expect(existsSync(join(world.root, '.venv'))).toBe(false)
  })

  test.skipIf(!python)('SC-17: missing ipykernel is reported from a real no-pip venv and setup stays behind trust and central consent', async () => {
    expect(existsSync(python)).toBe(true)
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print("must not run")'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {}, nbformat: 4, nbformat_minor: 5
    })
    const world = await start({ 'missing-ipykernel.ipynb': source })
    const { bufferId } = await world.open('missing-ipykernel.ipynb')
    const isolated = createNoPipEnvironment(world)

    const description = record(await notebook(world, bufferId, 'describe', { path: isolated.python }), 'Python description')
    expect(record(description.environment, 'described Python')).toMatchObject({ hasIpykernel: false, hasPip: false, externallyManaged: false })

    const installConsent = await failure(notebook(world, bufferId, 'install', { python: isolated.python }))
    expect(installConsent.code).toBe(RpcErrorCode.ConfirmationRequired)
    const venvConsent = await failure(notebook(world, bufferId, 'venv', { python: python }))
    expect(venvConsent.code).toBe(RpcErrorCode.ConfirmationRequired)

    const installTrust = await failure(notebook(world, bufferId, 'install', { python: isolated.python, yes: true }))
    expect(installTrust).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringMatching(/trust/i) })
    const venvTrust = await failure(notebook(world, bufferId, 'venv', { python, yes: true }))
    expect(venvTrust).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringMatching(/trust/i) })
    expect(existsSync(join(world.root, '.venv'))).toBe(false)

    await notebook(world, bufferId, 'trust')
    const missingKernel = record(await notebook(world, bufferId, 'run', { index: 0, mode: 'in-place', python: isolated.python }), 'run result')
    expect(missingKernel).toMatchObject({ status: 'missing-ipykernel', completed: 0, cancelled: 1, externallyManaged: false })

    const installStillNeedsConsent = await failure(notebook(world, bufferId, 'install', { python: isolated.python }))
    expect(installStillNeedsConsent.code).toBe(RpcErrorCode.ConfirmationRequired)
    const venvStillNeedsConsent = await failure(notebook(world, bufferId, 'venv', { python }))
    expect(venvStillNeedsConsent.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(existsSync(join(world.root, '.venv'))).toBe(false)
    const unchanged = record(await notebook(world, bufferId, 'describe', { path: isolated.python }), 'Python description after refused setup')
    expect(record(unchanged.environment, 'described Python after refused setup')).toMatchObject({ hasIpykernel: false, hasPip: false })
  })

  test.skipIf(!python)('SC-17: closing and reopening a trusted notebook revokes trust and stops its real kernel', async () => {
    expect(existsSync(python)).toBe(true)
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print("trusted notebook")'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {}, nbformat: 4, nbformat_minor: 5
    })
    const world = await start({ 'trust.ipynb': source })
    const opened = await world.open('trust.ipynb')
    let startedPid: number | undefined
    let closed = false

    try {
      await notebook(world, opened.bufferId, 'select', { python })
      await notebook(world, opened.bufferId, 'trust')
      const started = record(await notebook(world, opened.bufferId, 'start', { python }), 'kernel start result')
      expect(started.status).toBe('ready')
      startedPid = kernelPid(record(await notebook(world, opened.bufferId, 'state'), 'trusted notebook state'))
      expect(record(await notebook(world, opened.bufferId, 'state'), 'trusted notebook state')).toMatchObject({ trusted: true, kernel: { status: 'ready' } })

      await closeBuffer(world, opened.bufferId, opened.tabId)
      closed = true
      const pid = startedPid
      await waitFor(() => processIsGone(pid), 10_000)

      const reopened = await world.open('trust.ipynb')
      const reopenedState = record(await notebook(world, reopened.bufferId, 'state'), 'reopened notebook state')
      expect(reopenedState).toMatchObject({ trusted: false, busy: false, kernel: { status: 'stopped' } })
      const denied = await failure(notebook(world, reopened.bufferId, 'run', { index: 0, python }))
      expect(denied).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringMatching(/trust/i) })
    } finally {
      if (!closed) {
        try {
          await notebook(world, opened.bufferId, 'shutdown')
        } catch {
          // Harness cleanup remains the final owner if the buffer was already discarded.
        }
        if (startedPid !== undefined) {
          const pid = startedPid
          await waitFor(() => processIsGone(pid), 10_000)
        }
      }
    }
  })

  test.skipIf(!python)('SC-16/18: a real executed id-less cell saves with a generated ID, nbformat 4.5, and unknown metadata intact', async () => {
    expect(existsSync(python)).toBe(true)
    const rootMetadata = { vendorRoot: { retained: true, values: ['a', 'b'] }, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }
    const cellMetadata = { vendorCell: { retained: 'cell metadata' } }
    const source = JSON.stringify({
      cells: [{ cell_type: 'code', execution_count: null, metadata: cellMetadata, outputs: [], source: ['print("executed-cell-output")\n'] }],
      metadata: rootMetadata, nbformat: 4, nbformat_minor: 4
    })
    const world = await start({ 'executed-idless.ipynb': source })
    const { bufferId } = await world.open('executed-idless.ipynb')
    let startedPid: number | undefined

    try {
      await notebook(world, bufferId, 'select', { python })
      await notebook(world, bufferId, 'trust')
      const started = record(await notebook(world, bufferId, 'start', { python }), 'kernel start result')
      expect(started.status).toBe('ready')
      startedPid = kernelPid(record(await notebook(world, bufferId, 'state'), 'kernel state'))

      const execution = record(await notebook(world, bufferId, 'run', { index: 0, mode: 'in-place', python }), 'cell execution result')
      expect(execution).toMatchObject({ status: 'ok', executionCount: 1 })
      const parsed = record(await notebook(world, bufferId, 'parse', { offset: 0, limit: 1, outputLimit: 8 }), 'executed notebook parse')
      const executedCell = notebookCells(parsed)[0]!
      expect(requiredString(executedCell, 'id')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(records(executedCell.outputs, 'executed cell outputs').map(outputText).join('\n')).toContain('executed-cell-output')

      await notebook(world, bufferId, 'save')
      const saved = record(JSON.parse(readFileSync(join(world.root, 'executed-idless.ipynb'), 'utf8')), 'saved notebook')
      expect(saved.nbformat).toBe(4)
      expect(typeof saved.nbformat_minor).toBe('number')
      expect(saved.nbformat_minor as number).toBeGreaterThanOrEqual(5)
      expect(saved.metadata).toEqual(rootMetadata)
      const savedCell = records(saved.cells, 'saved notebook cells')[0]!
      expect(requiredString(savedCell, 'id')).toBe(requiredString(executedCell, 'id'))
      expect(savedCell.metadata).toEqual(cellMetadata)
      expect(records(savedCell.outputs, 'saved cell outputs').map(outputText).join('\n')).toContain('executed-cell-output')
    } finally {
      try {
        await notebook(world, bufferId, 'shutdown')
      } catch {
        // Harness cleanup remains the final owner if the notebook was already closed.
      }
      if (startedPid !== undefined) {
        const pid = startedPid
        await waitFor(() => processIsGone(pid), 10_000)
      }
    }
  })

  test('SC-19: TSV quoted tabs, multiline fields, and Unicode survive viewer parse, edit, and save', async () => {
    const source = 'Name\tNote\tValue\r\nZoë\t"left\tright\nLine 2 ""quoted"""\t雪\r\n東京\tplain\t終\r\n'
    const world = await start({ 'people.tsv': source })
    const { bufferId } = await world.open('people.tsv')

    const metadata = record(await viewer(world, bufferId, 'metadata'), 'TSV metadata')
    expect(metadata).toMatchObject({ paged: false, readOnly: false, delimiter: '\t' })
    const initialPage = record(await viewer(world, bufferId, 'page', { page: 0 }), 'initial TSV page')
    expect(records(initialPage.rows, 'initial TSV rows').map((row) => row.cells)).toEqual([
      ['Name', 'Note', 'Value'],
      ['Zoë', 'left\tright\nLine 2 "quoted"', '雪'],
      ['東京', 'plain', '終']
    ])

    await viewer(world, bufferId, 'edit', { row: 1, column: 2, value: 'updated\tvalue λ' })
    await viewer(world, bufferId, 'save')

    const expected = 'Name\tNote\tValue\r\nZoë\t"left\tright\nLine 2 ""quoted"""\t"updated\tvalue λ"\r\n東京\tplain\t終\r\n'
    expect(readFileSync(join(world.root, 'people.tsv'), 'utf8')).toBe(expected)
    const savedPage = record(await viewer(world, bufferId, 'page', { page: 0 }), 'saved TSV page')
    expect(records(savedPage.rows, 'saved TSV rows').map((row) => row.cells)).toEqual([
      ['Name', 'Note', 'Value'],
      ['Zoë', 'left\tright\nLine 2 "quoted"', 'updated\tvalue λ'],
      ['東京', 'plain', '終']
    ])
  })

  test('SC-20: a malformed image failure does not disable another viewer and a corrected image retries successfully', async () => {
    const safeBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
    const world = await start({ 'safe.png': safeBytes, 'recover.png': new Uint8Array([1, 2, 3, 4]) })
    const safe = await world.open('safe.png')
    const recover = await world.open('recover.png')

    const malformed = record(await viewer(world, recover.bufferId, 'metadata'), 'malformed image metadata')
    expect(malformed).toMatchObject({ previewable: false, error: expect.any(String) })
    const failedResource = await failure(viewer(world, recover.bufferId, 'media'))
    expect(failedResource.code).toBe(RpcErrorCode.Conflict)

    const safeMetadata = record(await viewer(world, safe.bufferId, 'metadata'), 'other image metadata')
    expect(safeMetadata).toMatchObject({ width: 1, height: 1, bytes: safeBytes.byteLength, previewable: true })
    const safeResource = record(await viewer(world, safe.bufferId, 'media'), 'other image resource')
    const safeResponse = await fetch(resourceUrl(world, requiredString(safeResource, 'url')))
    expect(safeResponse.status).toBe(200)
    expect([...new Uint8Array(await safeResponse.arrayBuffer())]).toEqual([...safeBytes])

    const correctedBytes = safeBytes
    writeFileSync(join(world.root, 'recover.png'), correctedBytes)
    await waitForAsync(async () => {
      const state = record(await world.call('state', { bufferId: recover.bufferId }), 'editor state')
      return records(state.buffers, 'editor buffers')[0]!.external === 'changed'
    }, 10_000)
    await world.call('view', { bufferId: recover.bufferId, action: 'reload' })

    const recovered = record(await viewer(world, recover.bufferId, 'metadata'), 'recovered image metadata')
    expect(recovered).toMatchObject({ width: 1, height: 1, bytes: correctedBytes.byteLength, previewable: true })
    const recoveredResource = record(await viewer(world, recover.bufferId, 'media'), 'recovered image resource')
    const recoveredResponse = await fetch(resourceUrl(world, requiredString(recoveredResource, 'url')))
    expect(recoveredResponse.status).toBe(200)
    expect([...new Uint8Array(await recoveredResponse.arrayBuffer())]).toEqual([...correctedBytes])
  })
})
