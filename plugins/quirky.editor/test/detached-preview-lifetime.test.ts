import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FileResourceRegistry } from '../../../packages/daemon/src/file-resources'
import type { EditorServices, MarkdownPreviewResult } from '../src/types'
import { registerIsolatedEditorFixtures } from './isolated-environment'
import { createDetachedMarkdownPreviewService, type DetachedMarkdownPreviewService } from '../src/markdown/detachedPreview'

type CreatedResource = { url: string; revoke(): void }
type Fixture = {
  service: DetachedMarkdownPreviewService
  entered: Promise<void>
  complete(): void
  created: CreatedResource[]
  call(params: Record<string, unknown>): Promise<MarkdownPreviewResult>
  resourceUrl(resource: CreatedResource): string
  cleanup(): Promise<void>
}

const fixtures = new Set<Fixture>()
registerIsolatedEditorFixtures(async () => {
  for (const fixture of fixtures) {
    fixtures.delete(fixture)
    await fixture.cleanup()
  }
})

function startFixture(fixtureOptions: { failAtCreate?: number } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-detached-preview-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'Guide.md'), '# Source\n')
  writeFileSync(join(root, 'docs', 'chart.png'), new Uint8Array([137, 80, 78, 71, 1, 2, 3]))
  writeFileSync(join(root, 'docs', 'other.png'), new Uint8Array([137, 80, 78, 71, 4, 5, 6]))
  const registry = new FileResourceRegistry()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return registry.serve(request, new URL(request.url).pathname)
    }
  })
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const created: CreatedResource[] = []
  const pending = new Set<Promise<unknown>>()
  let resourceCreateCount = 0
  const context = {
    error: (_kind: string, message: string) => new Error(message),
    async createFileResource(resourceOptions: { path: string; contentType: string; disposition?: 'inline' | 'attachment' }) {
      resourceCreateCount += 1
      if (fixtureOptions.failAtCreate === resourceCreateCount) throw new Error('injected resource creation failure')
      if (resourceCreateCount === 1 && fixtureOptions.failAtCreate === undefined) {
        entered.resolve()
        await gate.promise
      }
      const resource = await registry.create('quirky.editor', resourceOptions, () => false)
      created.push(resource)
      return resource
    }
  }
  const host = {
    context,
    async resolve(worktree?: string) {
      if (worktree !== 'id:detached-worktree') throw new Error('unexpected worktree selector')
      return { id: 'detached-worktree', path: root }
    },
    async path(worktreeId: string, relativePath: string) {
      if (worktreeId !== 'detached-worktree') throw new Error('unexpected worktree id')
      return resolve(root, relativePath)
    }
  } as unknown as EditorServices
  const service = createDetachedMarkdownPreviewService(host)
  const fixture: Fixture = {
    service,
    entered: entered.promise,
    complete: () => gate.resolve(),
    created,
    call(params) {
      const request = Promise.resolve(service.method(params, {} as never))
      pending.add(request)
      void request.then(() => pending.delete(request), () => pending.delete(request))
      return request
    },
    resourceUrl(resource) {
      return new URL(resource.url, `http://127.0.0.1:${server.port}`).toString()
    },
    async cleanup() {
      gate.resolve()
      try {
        service.dispose()
        await Promise.allSettled([...pending])
      } finally {
        try {
          await registry.close()
        } finally {
          server.stop(true)
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  }
  fixtures.add(fixture)
  return fixture
}

function render(leaseId: string): Record<string, unknown> {
  return {
    action: 'render', leaseId, worktree: 'id:detached-worktree', path: 'docs/Guide.md',
    text: '![Chart](chart.png)'
  }
}
function imageResourcePath(result: MarkdownPreviewResult): string {
  if (!('html' in result)) throw new Error('Detached preview returned no HTML.')
  const match = /<img\b[^>]*\bsrc="([^"]+)"/.exec(result.html)
  if (!match) throw new Error('Detached preview returned no image resource.')
  return match[1]!
}

async function expectRevoked(fixture: Fixture, resource: CreatedResource): Promise<void> {
  expect((await fetch(fixture.resourceUrl(resource))).status).toBe(404)
}

test('release during image acquisition rejects duplicate active lease and revokes only its late resource', async () => {
  const fixture = startFixture()
  const acquisition = fixture.call(render('pending-release'))
  await fixture.entered
  await expect(fixture.call(render('pending-release'))).rejects.toThrow()
  expect(await fixture.call({ action: 'release', leaseId: 'pending-release' })).toEqual({ leaseId: 'pending-release', released: true })
  const successor = await fixture.call(render('successor-lease'))
  const successorPath = imageResourcePath(successor)
  expect(successorPath).toBe(fixture.created[0]!.url)
  fixture.complete()
  await expect(acquisition).rejects.toThrow()
  expect(fixture.created).toHaveLength(2)
  expect(await fetch(fixture.resourceUrl(fixture.created[0]!)).then((response) => response.status)).toBe(200)
  await expectRevoked(fixture, fixture.created[1]!)
})

test('service disposal during image acquisition revokes the resource created afterward', async () => {
  const fixture = startFixture()
  const acquisition = fixture.call(render('pending-dispose'))
  await fixture.entered
  fixture.service.dispose()
  await expect(fixture.call(render('pending-dispose'))).rejects.toThrow()
  fixture.complete()
  await expect(acquisition).rejects.toThrow()
  expect(fixture.created).toHaveLength(1)
  await expectRevoked(fixture, fixture.created[0]!)
})

test('service disposal revokes completed lease resources and leaves no active lease', async () => {
  const fixture = startFixture()
  fixture.complete()
  const preview = await fixture.call(render('completed-lease'))
  expect(fixture.created).toHaveLength(1)
  const imagePath = imageResourcePath(preview)
  expect(imagePath).toBe(fixture.created[0]!.url)
  expect(await fetch(fixture.resourceUrl(fixture.created[0]!)).then((response) => response.status)).toBe(200)

  fixture.service.dispose()
  await expectRevoked(fixture, fixture.created[0]!)
  expect(await fixture.call({ action: 'release', leaseId: 'completed-lease' })).toEqual({
    leaseId: 'completed-lease',
    released: false
  })
  await expect(fixture.call(render('after-dispose'))).rejects.toThrow()
})

test('partial image resource creation error revokes resources already acquired for that lease', async () => {
  const fixture = startFixture({ failAtCreate: 2 })
  fixture.complete()
  const params = {
    action: 'render',
    leaseId: 'partial-error',
    worktree: 'id:detached-worktree',
    path: 'docs/Guide.md',
    text: '![First](chart.png)\n\n![Second](other.png)'
  }
  await expect(fixture.call(params)).rejects.toThrow()
  expect(fixture.created).toHaveLength(1)
  await expectRevoked(fixture, fixture.created[0]!)
  expect(await fixture.call({ action: 'release', leaseId: 'partial-error' })).toEqual({ leaseId: 'partial-error', released: false })
})

test('direct service calls strictly reject forbidden context and extra parameters', async () => {
  const fixture = startFixture()
  fixture.complete()
  for (const params of [
    { ...render('buffer-context'), bufferId: 'existing-buffer' },
    { ...render('extra-context'), caller: 'untrusted' },
    { action: 'release', leaseId: 'release-extra', path: 'docs/Guide.md' },
    { action: 'render', leaseId: 'invalid/id', worktree: 'id:detached-worktree', path: 'docs/Guide.md', text: 'x' },
    { action: 'render', leaseId: 'missing-worktree', path: 'docs/Guide.md', text: 'x' },
    { action: 'release', leaseId: '' },
    { action: 'release', leaseId: 'x'.repeat(129) },
    { ...render('nul-path'), path: 'docs/\0Guide.md' },
  ]) {
    await expect(fixture.call(params)).rejects.toThrow()
  }
  expect(fixture.created).toHaveLength(0)
})
