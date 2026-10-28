import { beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import type { EditorStateData, MarkdownPreviewResult } from '../src/types'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { registerIsolatedEditorFixtures } from './isolated-environment'

registerIsolatedEditorFixtures(async () => {
  await activeHarness?.cleanup()
  activeHarness = null
  fixture = null
})

type Preview = Extract<MarkdownPreviewResult, { html: string }>
type MarkdownCapabilities = { imageUrls: Record<string, string> }
type Fixture = { harness: Harness; client: QuirkyClient; worktreeId: string; root: string; home: string }

let fixture: Fixture | null = null
let activeHarness: Harness | null = null

beforeEach(async () => {
  const home = makeHomeWithoutAutoHooks('editor-detached-preview-')
  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  activeHarness = harness
  const client = await harness.connect('cli')
  const root = join(home, 'workspace')
  mkdirSync(root, { recursive: true })
  await client.callAny('quirky.repo/add', { path: root, folder: true })
  const worktree = await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` }) as { id: string }
  fixture = { harness, client, worktreeId: worktree.id, root, home }
})

function current(): Fixture {
  if (!fixture) throw new Error('Detached preview daemon fixture was not started')
  return fixture
}

const call = <Result = unknown>(method: string, params: Record<string, unknown> = {}) =>
  current().client.callAny(method, params) as Promise<Result>

function put(path: string, content: string | Uint8Array): void {
  const absolute = join(current().root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

function render(leaseId: string, path: string, text: string, worktree = `id:${current().worktreeId}`): Promise<Preview> {
  return call('quirky.editor/markdownPreview', { action: 'render', leaseId, worktree, path, text })
}

function resourceUrl(path: string): string {
  return new URL(path, `http://127.0.0.1:${current().harness.runtime.port}`).toString()
}

function imageSrc(html: string): string {
  const match = /<img\b[^>]*\bsrc="([^"]+)"/.exec(html)
  if (!match) throw new Error('Preview did not contain an authorized image resource')
  return match[1]!
}

async function markdown<Result = unknown>(action: string, fields: Record<string, unknown>): Promise<Result> {
  return call<Result>('quirky.editor/markdown', { action, ...fields })
}

async function editorState(): Promise<EditorStateData> {
  return call('quirky.editor/state', { worktree: `id:${current().worktreeId}` })
}

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 7, 19, 42])

test('detached local image bytes use exact independent leases without editor or disk mutation', async () => {
  const f = current()
  put('docs/Guide.md', '# Original\n\n![Chart](images/chart.png)\n')
  put('docs/images/chart.png', IMAGE_BYTES)
  const sourceBuffer = await call<{ id: string }>('quirky.editor/open', {
    worktree: `id:${f.worktreeId}`, path: 'docs/Guide.md', mode: 'source', focus: false
  })
  const sourcePreview = await markdown<MarkdownCapabilities>('capabilities', { bufferId: sourceBuffer.id, includePreview: true })
  const sourceImagePath = sourcePreview.imageUrls['images/chart.png']
  const sourceResponseBefore = await fetch(resourceUrl(sourceImagePath))
  expect(sourceResponseBefore.status).toBe(200)
  expect([...new Uint8Array(await sourceResponseBefore.arrayBuffer())]).toEqual([...IMAGE_BYTES])

  const stateBefore = await editorState()
  const diskBefore = readFileSync(join(f.root, 'docs/Guide.md'), 'utf8')
  const text = '# Modified\n\n<script>alert(1)</script>\n\n![Chart](images/chart.png)\n'
  const [first, second] = await Promise.all([
    render(crypto.randomUUID(), 'docs/Guide.md', text),
    render(crypto.randomUUID(), 'docs/Guide.md', text)
  ]) as [Preview, Preview]
  expect(first).toMatchObject({ worktreeId: f.worktreeId, path: 'docs/Guide.md' })
  expect(first.html).toContain('<h1')
  expect(first.html).toContain('Modified')
  expect(first.html).not.toMatch(/<script|onerror\s*=|javascript:/i)
  const firstImage = imageSrc(first.html)
  const secondImage = imageSrc(second.html)
  expect(firstImage).not.toBe(secondImage)
  expect(firstImage).not.toContain(f.root)
  expect(secondImage).not.toContain(f.root)
  for (const path of [firstImage, secondImage]) {
    const response = await fetch(resourceUrl(path))
    expect(response.status).toBe(200)
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...IMAGE_BYTES])
  }
  expect(await editorState()).toEqual(stateBefore)
  expect(readFileSync(join(f.root, 'docs/Guide.md'), 'utf8')).toBe(diskBefore)

  expect(await call('quirky.editor/markdownPreview', { action: 'release', leaseId: first.leaseId })).toEqual({ leaseId: first.leaseId, released: true })
  expect(await call('quirky.editor/markdownPreview', { action: 'release', leaseId: first.leaseId })).toEqual({ leaseId: first.leaseId, released: false })
  const unknownLeaseId = crypto.randomUUID()
  expect(await call('quirky.editor/markdownPreview', { action: 'release', leaseId: unknownLeaseId })).toEqual({
    leaseId: unknownLeaseId,
    released: false
  })
  expect((await fetch(resourceUrl(firstImage))).status).toBe(404)
  const secondAfterRelease = await fetch(resourceUrl(secondImage))
  expect(secondAfterRelease.status).toBe(200)
  expect([...new Uint8Array(await secondAfterRelease.arrayBuffer())]).toEqual([...IMAGE_BYTES])
  const sourceAfterRelease = await fetch(resourceUrl(sourceImagePath))
  expect(sourceAfterRelease.status).toBe(200)
  expect([...new Uint8Array(await sourceAfterRelease.arrayBuffer())]).toEqual([...IMAGE_BYTES])
  expect(await editorState()).toEqual(stateBefore)
  expect(readFileSync(join(f.root, 'docs/Guide.md'), 'utf8')).toBe(diskBefore)

  expect(await call('quirky.editor/markdownPreview', { action: 'release', leaseId: second.leaseId })).toEqual({ leaseId: second.leaseId, released: true })
})

test('authorized missing historical Markdown location resolves without creating a file', async () => {
  const f = current()
  const rendered = await render(crypto.randomUUID(), 'removed/old/./Guide.mdx', '# Historical text\n')
  expect(rendered).toMatchObject({ worktreeId: f.worktreeId, path: 'removed/old/Guide.mdx' })
  expect(rendered.html).toContain('Historical text')
  expect(existsSync(join(f.root, 'removed'))).toBe(false)
  expect((await editorState()).buffers).toHaveLength(0)
  await call('quirky.editor/markdownPreview', { action: 'release', leaseId: rendered.leaseId })
})

test('unsafe source locations fail while denied or malformed image targets keep only safe alt text', async () => {
  const f = current()
  put('docs/Guide.md', '# Source exists\n')
  const external = join(f.home, 'external')
  mkdirSync(external, { recursive: true })
  const outside = join(external, 'outside.png')
  writeFileSync(outside, IMAGE_BYTES)
  put('docs/images/not-image.txt', 'not an image')
  mkdirSync(join(f.root, 'docs/images'), { recursive: true })
  symlinkSync(outside, join(f.root, 'docs/images/escape.png'))
  symlinkSync(outside, join(f.root, 'docs/escape.md'))

  for (const path of ['../../external/outside.md', '/etc/passwd.md', 'docs\\Guide.md', 'docs/Guide.txt', 'file:///tmp/Guide.md', 'docs/escape.md']) {
    await expect(render(crypto.randomUUID(), path, '# Rejected')).rejects.toThrow()
  }
  await expect(render(crypto.randomUUID(), 'docs/Guide.md', '# Rejected', 'id:missing-worktree')).rejects.toThrow()

  const text = [
    '![parent escape](../../external/outside.png)',
    '![encoded escape](%2e%2e/%2e%2e/external/outside.png)',
    '![encoded absolute path](%2Fetc/passwd)',
    '![encoded web URL](%68%74%74%70%73%3A%2F%2Fexample.test/image.png)',
    '![symlink escape](images/escape.png)',
    '![absolute path](/etc/passwd)',
    '![network path](//example.test/image.png)',
    '![file scheme](file:///etc/passwd)',
    '![script scheme](javascript:alert(1))',
    '![data scheme](data:image/png;base64,AAAA)',
    '![web URL](https://example.test/image.png)',
    '![malformed encoding](images/%ZZ.png)',
    '![non-image file](images/not-image.txt)',
    '![missing file](images/missing.png)'
  ].join('\n\n')
  const rendered = await render(crypto.randomUUID(), 'docs/Guide.md', text)
  expect(rendered.html).toContain('parent escape')
  expect(rendered.html).toContain('encoded escape')
  expect(rendered.html).toContain('symlink escape')
  expect(rendered.html).not.toMatch(/<img\b|src="(?:\/|\.\.?\/|https?:|file:|javascript:|data:)/i)
  expect(rendered.html).not.toContain(f.root)
  await call('quirky.editor/markdownPreview', { action: 'release', leaseId: rendered.leaseId })
})

test('preview text and per-lease image bounds reject without leaving usable resources', async () => {
  const f = current()
  put('Guide.md', '# Source\n')
  await expect(render(crypto.randomUUID(), 'Guide.md', 'x'.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow(/8 MiB/i)
  await expect(render(crypto.randomUUID(), 'Guide.md', 'x'.repeat(16 * 1024 + 1))).rejects.toThrow(/line.*preview/i)
  await expect(render(crypto.randomUUID(), 'Guide.md', 'line\n'.repeat(16_384))).rejects.toThrow(/preview limits/i)

  const references: string[] = []
  for (let index = 0; index < 65; index += 1) {
    const path = `images/image-${index}.png`
    put(path, IMAGE_BYTES)
    references.push(`![image ${index}](${path})`)
  }
  await expect(render(crypto.randomUUID(), 'Guide.md', references.join('\n\n'))).rejects.toThrow()
  expect(await editorState()).toMatchObject({ buffers: [] })
  expect(readFileSync(join(f.root, 'Guide.md'), 'utf8')).toBe('# Source\n')
}, 75_000)

test('active lease capacity does not evict a live image resource and strict request bounds are enforced', async () => {
  const f = current()
  put('Guide.md', '# Source\n')
  put('images/chart.png', IMAGE_BYTES)
  const leases: Preview[] = []
  leases.push(await render(crypto.randomUUID(), 'Guide.md', '![Chart](images/chart.png)'))
  const protectedImage = imageSrc(leases[0]!.html)
  for (let index = 1; index < 64; index += 1) leases.push(await render(crypto.randomUUID(), 'Guide.md', `# Lease ${index}`))
  await expect(render(crypto.randomUUID(), 'Guide.md', '# Over capacity')).rejects.toThrow()
  const protectedResponse = await fetch(resourceUrl(protectedImage))
  expect(protectedResponse.status).toBe(200)
  expect([...new Uint8Array(await protectedResponse.arrayBuffer())]).toEqual([...IMAGE_BYTES])

  const released = await call<{ leaseId: string; released: boolean }>('quirky.editor/markdownPreview', {
    action: 'release', leaseId: leases[20]!.leaseId
  })
  expect(released.released).toBe(true)
  const replacement = await render(crypto.randomUUID(), 'Guide.md', '# Replacement')
  expect(replacement.html).toContain('Replacement')
  const stillProtected = await fetch(resourceUrl(protectedImage))
  expect(stillProtected.status).toBe(200)
  await Promise.all(leases.filter((_, index) => index !== 20).map(({ leaseId }) =>
    call('quirky.editor/markdownPreview', { action: 'release', leaseId })
  ))
  await call('quirky.editor/markdownPreview', { action: 'release', leaseId: replacement.leaseId })
}, 75_000)
