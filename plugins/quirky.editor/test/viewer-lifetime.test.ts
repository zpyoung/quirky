import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileResourceRegistry } from '../../../packages/daemon/src/file-resources'
import type { EditorBuffer, EditorServices, FeatureMethods } from '../src/types'
import { createViewerMethods } from '../src/viewers/service'

type CreatedResource = { url: string; revoke(): void }
type Fixture = {
  feature: FeatureMethods
  entered: Promise<void>
  complete(): void
  created: CreatedResource[]
  call(params: Record<string, unknown>): Promise<unknown>
  closeBuffer(): void
  resourceUrl(resource: CreatedResource): string
  cleanup(): Promise<void>
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

function startFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-viewer-lifetime-'))
  const path = join(root, 'tone.wav')
  const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])
  writeFileSync(path, bytes)
  const buffer: EditorBuffer = {
    id: 'viewer-buffer', worktreeId: 'viewer-worktree', root, path, relativePath: 'tone.wav', name: 'tone.wav',
    kind: 'audio', content: '', draft: null, baseline: null, size: bytes.byteLength, readOnly: false, dirty: false,
    external: null, diskContent: null, mode: 'rich', tabId: null, preview: false, pinned: false, untitled: false,
    revision: 0, contentRevision: 0, view: {}, error: null
  }
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
  const closeListeners = new Set<(bufferId: string) => void>()
  let delayed = true
  let closed = false
  const host = {
    context: {
      error: (_kind: string, message: string) => new Error(message),
      async createFileResource(options: { path: string; contentType: string; disposition?: 'inline' | 'attachment' }) {
        if (delayed) {
          delayed = false
          entered.resolve()
          await gate.promise
        }
        const resource = await registry.create('quirky.editor.test', options, () => false)
        created.push(resource)
        return resource
      }
    },
    get(bufferId: string) {
      if (closed || bufferId !== buffer.id) throw new Error('buffer is closed')
      return buffer
    },
    async path() {
      return path
    },
    onClose(listener: (bufferId: string) => void) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    }
  } as unknown as EditorServices
  const feature = createViewerMethods(host)
  const fixture: Fixture = {
    feature,
    entered: entered.promise,
    complete: () => gate.resolve(),
    created,
    call(params) {
      const request = Promise.resolve(feature.methods.viewer(params, {} as never))
      pending.add(request)
      void request.then(() => pending.delete(request), () => pending.delete(request))
      return request
    },
    closeBuffer() {
      closed = true
      for (const listener of [...closeListeners]) listener(buffer.id)
    },
    resourceUrl(resource) {
      return new URL(resource.url, `http://127.0.0.1:${server.port}`).toString()
    },
    async cleanup() {
      gate.resolve()
      try {
        await feature.dispose()
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
  fixtures.push(fixture)
  return fixture
}

async function expectResourceRevoked(fixture: Fixture, resource: CreatedResource): Promise<void> {
  const response = await fetch(fixture.resourceUrl(resource))
  expect(response.status).toBe(404)
}

describe('viewer media lease late cleanup', () => {
  test('release during acquisition revokes the resource created after release', async () => {
    const fixture = startFixture()
    const acquisition = fixture.call({ bufferId: 'viewer-buffer', action: 'media', leaseId: 'pending-release' })
    await fixture.entered

    expect(await fixture.call({ bufferId: 'viewer-buffer', action: 'release', leaseId: 'pending-release' })).toEqual({ released: true })
    fixture.complete()
    await expect(acquisition).rejects.toThrow()
    expect(fixture.created).toHaveLength(1)
    await expectResourceRevoked(fixture, fixture.created[0]!)
  })

  test('buffer close during anonymous acquisition revokes its late resource', async () => {
    const fixture = startFixture()
    const acquisition = fixture.call({ bufferId: 'viewer-buffer', action: 'media' })
    await fixture.entered

    fixture.closeBuffer()
    fixture.complete()
    await expect(acquisition).rejects.toThrow()
    expect(fixture.created).toHaveLength(1)
    await expectResourceRevoked(fixture, fixture.created[0]!)
  })

  test('service disposal during anonymous acquisition revokes its late resource', async () => {
    const fixture = startFixture()
    const acquisition = fixture.call({ bufferId: 'viewer-buffer', action: 'media' })
    await fixture.entered

    await fixture.feature.dispose()
    fixture.complete()
    await expect(acquisition).rejects.toThrow()
    expect(fixture.created).toHaveLength(1)
    await expectResourceRevoked(fixture, fixture.created[0]!)
  })

  test('service disposal revokes live leased and anonymous resources', async () => {
    const fixture = startFixture()
    const leased = fixture.call({ bufferId: 'viewer-buffer', action: 'media', leaseId: 'live-lease' })
    await fixture.entered
    fixture.complete()
    await leased
    await fixture.call({ bufferId: 'viewer-buffer', action: 'media' })
    expect(fixture.created).toHaveLength(2)

    await fixture.feature.dispose()
    for (const resource of fixture.created) await expectResourceRevoked(fixture, resource)
  })
})
