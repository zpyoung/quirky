import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'

setDefaultTimeout(60_000)

type ApiRecord = Record<string, unknown>
type FileData = string | Uint8Array

type ViewerWorld = {
  harness: Harness
  client: QuirkyClient
  root: string
  worktree: string
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  open(path: string): Promise<{ bufferId: string; tabId?: string; buffer: ApiRecord }>
}

const worlds: ViewerWorld[] = []

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

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

async function start(files: Record<string, FileData>): Promise<ViewerWorld> {
  const home = makeHomeWithoutAutoHooks('m2-viewer-')
  const root = join(home, 'repo')
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Viewer Tests')
  git(root, 'config', 'user.email', 'viewer-tests@example.invalid')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'test fixtures')

  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
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
      const bufferId = requiredString(buffer, 'id')
      const tabId = typeof buffer.tabId === 'string' ? buffer.tabId : undefined
      return { bufferId, tabId, buffer }
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
    return {
      code: typeof rpc.code === 'number' ? rpc.code : Number.NaN,
      message: requiredString(rpc, 'message')
    }
  }
  throw new Error('expected the editor API call to fail')
}

const viewer = (world: ViewerWorld, bufferId: string, action: string, fields: Record<string, unknown> = {}) =>
  world.call('viewer', { bufferId, action, ...fields })

function resourceUrl(world: ViewerWorld, path: string): string {
  return new URL(path, `http://127.0.0.1:${world.harness.runtime.port}`).toString()
}
function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(24)
  header.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  header.set([0, 0, 0, 13], 8)
  header.set([73, 72, 68, 82], 12)
  const view = new DataView(header.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return header
}
function minimalPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 10 100 Td (Catalog) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const parts = ['%PDF-1.4\n']
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(parts.join('')).byteLength)
    parts.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`)
  }
  const xrefOffset = new TextEncoder().encode(parts.join('')).byteLength
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n']
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  parts.push(xref.join(''), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return new TextEncoder().encode(parts.join(''))
}

function waveFile(): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  view.setUint32(4, 38, true)
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set(new TextEncoder().encode('data'), 36)
  view.setUint32(40, 2, true)
  view.setInt16(44, 0, true)
  return bytes
}
function validPng(): Uint8Array {
  return new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cS6sAAAAASUVORK5CYII=', 'base64'))
}


describe('viewer API behavior', () => {
  test('SC-19: small quoted CSV preserves multiline UTF-8 fields across table edits and save', async () => {
    const source = 'Name,Note,Value\r\n"Smith, Jane","Line 1\nLine 2 ""quoted""",2\r\nZoë,plain,1\r\n'
    const world = await start({ 'people.csv': source })
    const { bufferId } = await world.open('people.csv')

    const metadata = record(await viewer(world, bufferId, 'metadata'))
    expect(metadata).toMatchObject({ format: 'csv', paged: false, readOnly: false, delimiter: ',' })
    const firstPage = record(await viewer(world, bufferId, 'page', { page: 0 }))
    const rows = records(firstPage.rows, 'CSV rows').map((row) => row.cells)
    expect(rows).toEqual([
      ['Name', 'Note', 'Value'],
      ['Smith, Jane', 'Line 1\nLine 2 "quoted"', '2'],
      ['Zoë', 'plain', '1']
    ])
    await world.call('view', { bufferId, action: 'update', patch: { mode: 'source' } })
    expect(records(record(await world.call('state', { bufferId }), 'editor state').buffers, 'editor buffers')[0]!.mode).toBe('source')
    await world.call('view', { bufferId, action: 'update', patch: { mode: 'rich' } })


    await viewer(world, bufferId, 'edit', { row: 1, column: 2, value: '9' })
    await viewer(world, bufferId, 'insertRow', { index: 3, count: 1 })
    await viewer(world, bufferId, 'paste', { row: 3, column: 0, text: 'New,\"a,b\",4\r\n' })
    const copy = record(await viewer(world, bufferId, 'copy', { row: 3, column: 1 }))
    expect(copy.text).toBe('a,b')
    await viewer(world, bufferId, 'insertColumn', { index: 1, value: 'Extra' })
    await viewer(world, bufferId, 'edit', { row: 1, column: 1, value: 'inserted' })
    await viewer(world, bufferId, 'sort', { column: 2, order: 'asc' })
    await viewer(world, bufferId, 'filter', { query: 'Zoë' })
    expect(records(record(await viewer(world, bufferId, 'page', { page: 0 })).rows, 'filtered CSV rows')).toHaveLength(2)
    await viewer(world, bufferId, 'filter', { query: '' })
    await viewer(world, bufferId, 'deleteRow', { row: 3 })
    await viewer(world, bufferId, 'deleteColumn', { index: 1 })
    await viewer(world, bufferId, 'delimiter', { delimiter: ';' })
    await viewer(world, bufferId, 'save')

    const saved = readFileSync(join(world.root, 'people.csv'), 'utf8')
    expect(saved).toContain('Smith, Jane')
    expect(saved).toContain('"Line 1\nLine 2 ""quoted"""')
    expect(saved).toContain('Zoë')
    expect(saved).toContain(';')
  })

  test('SC-19: table edits are refused at the 1 MiB boundary without changing the draft', async () => {
    const source = `value\n${'a'.repeat(1_048_568)}\n`
    expect(new TextEncoder().encode(source).byteLength).toBeLessThan(1_048_576)
    const world = await start({ 'limit.csv': source })
    const { bufferId } = await world.open('limit.csv')
    const before = record(await world.call('state', { bufferId }), 'editor state')
    expect(records(before.buffers, 'editor buffers')[0]!.dirty).toBe(false)

    const refused = await failure(viewer(world, bufferId, 'edit', { row: 1, column: 0, value: 'b'.repeat(1_048_573) }))
    expect(refused.message).toMatch(/1 MiB/i)
    const after = record(await world.call('state', { bufferId }), 'editor state')
    expect(records(after.buffers, 'editor buffers')[0]!.dirty).toBe(false)
  })

  test('SC-19: a >=1 MiB CSV pages bounded quoted records without loading file content into the editor buffer', async () => {
    const crossing = `"${'x'.repeat(65_510)}💡\ninside,quoted"`
    const padded = Array.from({ length: 20_000 }, (_, index) => `${index},"${'padding'.repeat(7)}"`).join('\n')
    const source = `name,note\n1,${crossing}\n${padded}\n`
    expect(new TextEncoder().encode(source).byteLength).toBeGreaterThanOrEqual(1_048_576)
    const world = await start({ 'large.csv': source })
    const { bufferId, buffer } = await world.open('large.csv')

    expect((typeof buffer.content === 'string' ? new TextEncoder().encode(buffer.content).byteLength : 0)).toBeLessThan(new TextEncoder().encode(source).byteLength)
    const metadata = record(await viewer(world, bufferId, 'metadata'))
    expect(metadata).toMatchObject({ format: 'csv', paged: true, readOnly: true })
    expect(metadata.limits).toMatchObject({ maxColumns: 4096, maxRecordBytes: 1_048_576, maxCachedPages: 64 })
    const page = record(await viewer(world, bufferId, 'page', { page: 0 }))
    const rows = records(page.rows, 'paged CSV rows').map((row) => row.cells)
    expect(rows.length).toBeLessThanOrEqual(100)
    expect(rows[1]).toEqual(['1', `x${'x'.repeat(65_509)}💡\ninside,quoted`])
    expect(page.readOnly).toBe(true)
    expect(await failure(viewer(world, bufferId, 'edit', { row: 1, column: 0, value: 'no draft' }))).toMatchObject({ code: expect.any(Number) })
    const state = record(await world.call('state', { bufferId }), 'editor state')
    expect(records(state.buffers, 'editor buffers')[0]!.dirty).toBe(false)
  })

  test('SC-19: oversized records and too many columns fail visibly rather than being truncated or looping', async () => {
    const oversized = `head\n${'x'.repeat(1_048_577)}\n`
    const columns = `${Array.from({ length: 4097 }, () => 'x').join(',')}\n${'pad,'.repeat(262_144)}\n`
    const world = await start({ 'record-limit.csv': oversized, 'column-limit.csv': columns })
    const recordBuffer = await world.open('record-limit.csv')
    const columnBuffer = await world.open('column-limit.csv')

    expect((await failure(viewer(world, recordBuffer.bufferId, 'page', { page: 0 }))).message).toMatch(/record|1 MiB/i)
    expect((await failure(viewer(world, columnBuffer.bufferId, 'page', { page: 0 }))).message).toMatch(/4096|column/i)
  })

  test('SC-19: changed large CSV requires core reload, then pages the new bytes', async () => {
    const world = await start({ 'changed.csv': `h\n${Array.from({ length: 30_000 }, (_, index) => `${index},old`).join('\n')}\n` })
    const { bufferId } = await world.open('changed.csv')
    const originalPage = record(await viewer(world, bufferId, 'page', { page: 0 }))
    expect(originalPage.changedOnDisk).toBe(false)

    writeFileSync(join(world.root, 'changed.csv'), `h\n${Array.from({ length: 30_000 }, (_, index) => `${index},new`).join('\n')}\n`)
    await waitForAsync(async () => {
      const state = record(await world.call('state', { bufferId }), 'editor state')
      return records(state.buffers, 'editor buffers')[0]!.external === 'changed'
    }, 10_000)
    const stalePage = record(await viewer(world, bufferId, 'page', { page: 0 }))
    expect(stalePage.changedOnDisk).toBe(true)
    await world.call('view', { bufferId, action: 'reload' })
    const refreshed = record(await viewer(world, bufferId, 'page', { page: 0 }))
    expect(refreshed.changedOnDisk).toBe(false)
    expect(records(refreshed.rows, 'reloaded CSV rows')[1]!.cells).toEqual(['0', 'new'])
  })

  test('SC-20: image metadata enforces decoded-pixel limits and ranged resources revoke only when the buffer closes', async () => {
    const safeBytes = validPng()
    const unsafeBytes = pngHeader(40_000, 900)
    const world = await start({ 'safe.png': safeBytes, 'unsafe.png': unsafeBytes })
    const safe = await world.open('safe.png')
    const metadata = record(await viewer(world, safe.bufferId, 'metadata'))
    expect(metadata).toMatchObject({ width: 1, height: 1, bytes: safeBytes.byteLength, zoom: 1 })

    const resource = record(await viewer(world, safe.bufferId, 'media'))
    const url = requiredString(resource, 'url')
    const ranged = await fetch(resourceUrl(world, url), { headers: { Range: 'bytes=4-11' } })
    expect(ranged.status).toBe(206)
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...safeBytes.slice(4, 12)])

    await viewer(world, safe.bufferId, 'zoom', { scale: 8 })
    await viewer(world, safe.bufferId, 'position', { page: 1, offset: 120 })
    const state = record(await world.call('state', { bufferId: safe.bufferId }), 'editor state')
    const buffer = records(state.buffers, 'editor buffers')[0]!
    expect(buffer.view).toMatchObject({ viewer: { zoom: 8, page: 1, offset: 120 } })

    const unsafe = await world.open('unsafe.png')
    const unsafeMetadata = record(await viewer(world, unsafe.bufferId, 'metadata'))
    expect(unsafeMetadata).toMatchObject({ error: expect.stringMatching(/pixel|dimension/i), previewable: false })
    expect(unsafeMetadata.url).toBeUndefined()

    await world.call('close', { bufferId: safe.bufferId, ...(safe.tabId ? { tabId: safe.tabId } : {}), choice: 'discard' })
    const revoked = await fetch(resourceUrl(world, url), { headers: { Range: 'bytes=0-0' } })
    expect([404, 410]).toContain(revoked.status)
  })

  test('SC-20: PDF state and media use range resources; Mermaid stays source-addressable and binary remains read-only', async () => {
    const pdf = minimalPdf()
    const world = await start({
      'sample.pdf': pdf,
      'flow.mmd': 'graph TD\n  A[Start] --> B[End]\n',
      'tone.wav': waveFile(),
      'binary.dat': new Uint8Array([0, 1, 0, 2, 3])
    })
    const pdfBuffer = await world.open('sample.pdf')
    const pdfResource = record(await viewer(world, pdfBuffer.bufferId, 'media'))
    const response = await fetch(resourceUrl(world, requiredString(pdfResource, 'url')), { headers: { Range: 'bytes=0-7' } })
    expect(response.status).toBe(206)
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('%PDF-1.4')
    await viewer(world, pdfBuffer.bufferId, 'zoom', { scale: 5 })
    const audio = await world.open('tone.wav')
    const audioMetadata = record(await viewer(world, audio.bufferId, 'metadata'))
    expect(audioMetadata).toMatchObject({ kind: 'audio', contentType: 'audio/wav', seekable: true })
    const audioResource = record(await viewer(world, audio.bufferId, 'media'))
    const audioResponse = await fetch(resourceUrl(world, requiredString(audioResource, 'url')), { headers: { Range: 'bytes=0-3' } })
    expect(audioResponse.status).toBe(206)
    expect(new TextDecoder().decode(await audioResponse.arrayBuffer())).toBe('RIFF')
    await viewer(world, pdfBuffer.bufferId, 'position', { page: 2, offset: 240 })
    await viewer(world, pdfBuffer.bufferId, 'find', { query: 'Catalog' })
    const pdfState = record(await world.call('state', { bufferId: pdfBuffer.bufferId }), 'editor state')
    expect(records(pdfState.buffers, 'editor buffers')[0]!.view).toMatchObject({ viewer: { zoom: 5, page: 2, offset: 240, query: 'Catalog' } })

    const mermaid = await world.open('flow.mmd')
    const diagram = record(await viewer(world, mermaid.bufferId, 'metadata'))
    expect(diagram).toMatchObject({ kind: 'mermaid', sourceAvailable: true })
    await world.call('view', { bufferId: mermaid.bufferId, action: 'update', patch: { mode: 'source' } })
    const sourceView = record(await world.call('state', { bufferId: mermaid.bufferId }), 'editor state')
    expect(records(sourceView.buffers, 'editor buffers')[0]!.mode).toBe('source')
    expect(records(sourceView.buffers, 'editor buffers')[0]!.content).toContain('graph TD')

    const binary = await world.open('binary.dat')
    const binaryResult = record(await viewer(world, binary.bufferId, 'metadata'))
    expect(binaryResult).toMatchObject({ kind: 'binary', displayable: false, reason: 'binary' })
    expect(binary.buffer.content).toBe('')
  })
})
