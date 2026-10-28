import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './fixtures'

const PLUGIN_ID = 'acme.files'
const METHOD_CREATE = `${PLUGIN_ID}/create`
const METHOD_REVOKE = `${PLUGIN_ID}/revoke`
const FIXTURE_MIME = 'application/pdf'

let harness: Harness | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
  removeTempDirs()
})

function fixturePlugin(home: string, marker: string, authorizedRoot: string) {
  const manifest = {
    id: PLUGIN_ID,
    name: 'File resource fixture',
    version: '1.0.0',
    contributes: {
      method: [
        {
          id: 'create',
          params: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string' },
              contentType: { type: 'string' },
              disposition: { type: 'string', enum: ['inline', 'attachment'] }
            }
          }
        },
        { id: 'revoke', params: { type: 'object' } },
      ]
    }
  }
  const root = JSON.stringify(authorizedRoot)
  const behavior = {
    imports: [
      "import { realpathSync } from 'node:fs'",
      "import { relative, isAbsolute, sep } from 'node:path'"
    ],
    activate: `
      let current
      const authorizedRoot = realpathSync(${root})
      const create = async (params) => {
        const target = realpathSync(params.path)
        const rel = relative(authorizedRoot, target)
        if (!isAbsolute(params.path) || (rel !== '' && (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)))) {
          throw new Error('path is outside the authorized worktree')
        }
        current = await context.createFileResource({
          path: target,
          contentType: params.contentType ?? '${FIXTURE_MIME}',
          ...(params.disposition === undefined ? {} : { disposition: params.disposition })
        })
        return current.url
      }
      context.provide('method:${PLUGIN_ID}/create', create)
      context.provide('method:${PLUGIN_ID}/revoke', () => {
        current?.revoke()
        return true
      })
    `
  }
  return writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
}

async function boot(options: { content?: string; fileName?: string } = {}) {
  const home = makeHomeWithoutAutoHooks('qd-file-resources-')
  const root = makeTempDir('qd-file-resources-root-')
  const authorizedRoot = join(root, 'authorized')
  mkdirSync(authorizedRoot)
  const file = join(authorizedRoot, options.fileName ?? 'resource.pdf')
  writeFileSync(file, options.content ?? '0123456789')
  const marker = join(makeTempDir('qd-file-resources-marker-'), 'marker.log')
  fixturePlugin(home, marker, authorizedRoot)
  harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  const client = await harness.connect()
  const resource = async (path = file, extra: Record<string, unknown> = {}) =>
    client.callAny(METHOD_CREATE, { path, ...extra }) as Promise<string>
  const url = (value: string) => new URL(value, `http://127.0.0.1:${harness!.runtime.port}`)
  const fetchResource = (value: string, init?: RequestInit) => fetch(url(value), init)
  return { harness, client, root, authorizedRoot, file, marker, resource, url, fetchResource }
}

describe('plugin-scoped file resources', () => {
  test('serves the authorized regular file with fixed security headers and no daemon token', async () => {
    const s = await boot()
    const resourceUrl = await s.resource(s.file, { disposition: 'attachment' })
    const response = await s.fetchResource(resourceUrl)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0123456789')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe(FIXTURE_MIME)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(resourceUrl).not.toContain(s.harness.runtime.token)
    expect(s.url(resourceUrl).searchParams.has('token')).toBe(false)
  })

  test('refuses executable MIME types while keeping sandboxed SVG resources available', async () => {
    const s = await boot()
    await expect(s.resource(s.file, { contentType: 'text/html' })).rejects.toThrow('contentType is not allowed')

    const resourceUrl = await s.resource(s.file, { contentType: 'image/svg+xml' })
    const response = await s.fetchResource(resourceUrl)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })

  test('HEAD returns whole-file headers without a body', async () => {
    const s = await boot()
    const resourceUrl = await s.resource()
    const response = await s.fetchResource(resourceUrl, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('')
  })

  test('GET and HEAD serve open, suffix, and end-clamped single ranges', async () => {
    const s = await boot()
    const resourceUrl = await s.resource()

    const cases: [string, string, string][] = [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=6-', '6789', 'bytes 6-9/10'],
      ['bytes=-4', '6789', 'bytes 6-9/10'],
      ['bytes=8-100', '89', 'bytes 8-9/10'],
      [`bytes=8-${'9'.repeat(2048)}`, '89', 'bytes 8-9/10']
    ]
    for (const [range, expected, contentRange] of cases) {
      const response = await s.fetchResource(resourceUrl, { headers: { range } })
      expect(response.status).toBe(206)
      expect(await response.text()).toBe(expected)
      expect(response.headers.get('content-range')).toBe(contentRange)
      expect(response.headers.get('content-length')).toBe(String(expected.length))
    }

    const head = await s.fetchResource(resourceUrl, { method: 'HEAD', headers: { range: 'bytes=1-3' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe('bytes 1-3/10')
    expect(head.headers.get('content-length')).toBe('3')
    expect(await head.text()).toBe('')
  })

  test('rejects invalid and multipart ranges with 416', async () => {
    const s = await boot()
    const resourceUrl = await s.resource()

    for (const range of ['items=0-1', 'bytes=99-', 'bytes=8-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=0-1,', `bytes=${'9'.repeat(2048)}-`]) {
      const response = await s.fetchResource(resourceUrl, { headers: { range } })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe('bytes */10')
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(await response.text()).toBe('')
    }
  })

  test('handles an empty resource and unsupported HTTP methods', async () => {
    const s = await boot({ content: '' })
    const resourceUrl = await s.resource()

    const whole = await s.fetchResource(resourceUrl)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('0')
    expect(await whole.text()).toBe('')

    const range = await s.fetchResource(resourceUrl, { headers: { range: 'bytes=0-' } })
    expect(range.status).toBe(416)
    expect(range.headers.get('content-range')).toBe('bytes */0')

    const unsupported = await s.fetchResource(resourceUrl, { method: 'POST' })
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('allow')).toBe('GET, HEAD')
  })

  test('does not expose daemon auth or filesystem paths through forged capability paths', async () => {
    const s = await boot()
    const resourceUrl = await s.resource()
    const valid = s.url(resourceUrl)
    const unknown = new URL(valid)
    unknown.pathname = unknown.pathname.replace(/[^/]+$/, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect((await fetch(unknown)).status).toBe(404)

    const queryPath = new URL(valid)
    queryPath.searchParams.set('path', '/etc/passwd')
    const ignored = await fetch(queryPath)
    expect(ignored.status).toBe(200)
    expect(await ignored.text()).toBe('0123456789')

    const escaped = new URL(valid)
    escaped.pathname += '/../../etc/passwd'
    expect((await fetch(escaped)).status).toBe(404)

    const outside = join(s.root, 'secret.pdf')
    writeFileSync(outside, 'secret')
    await expect(s.resource(outside)).rejects.toThrow('outside the authorized worktree')
  })

  test('refuses replaced files and symlink swaps instead of serving a different target', async () => {
    const s = await boot()
    const replacedUrl = await s.resource()
    const replacement = join(s.authorizedRoot, 'replacement.pdf')
    writeFileSync(replacement, 'different file')
    renameSync(replacement, s.file)
    expect([404, 410]).toContain((await s.fetchResource(replacedUrl)).status)

    const symlinkedUrl = await s.resource()
    const secret = join(s.root, 'outside.pdf')
    writeFileSync(secret, 'outside secret')
    unlinkSync(s.file)
    symlinkSync(secret, s.file)
    expect([404, 410]).toContain((await s.fetchResource(symlinkedUrl)).status)
    expect(readFileSync(secret, 'utf8')).toBe('outside secret')
  })

  test('explicit revoke and plugin deactivation invalidate capabilities', async () => {
    const s = await boot()
    const explicit = await s.resource()
    expect((await s.fetchResource(explicit)).status).toBe(200)
    await s.client.callAny(METHOD_REVOKE, {})
    expect((await s.fetchResource(explicit)).status).toBe(404)

    const deactivated = await s.resource()
    expect((await s.fetchResource(deactivated)).status).toBe(200)
    await s.client.call('plugin.disable', { id: PLUGIN_ID })
    expect((await s.fetchResource(deactivated)).status).toBe(404)
  })

  test('failed activation and plugin replacement revoke activation-owned resources', async () => {
    const s = await boot({ fileName: 'activation.pdf' })
    const failedSource = makeTempDir('qd-file-resource-failure-')
    const failedBehavior = {
      imports: [
        "import { realpathSync } from 'node:fs'",
        "import { relative, isAbsolute, sep } from 'node:path'"
      ],
      activate: `
        const root = realpathSync(${JSON.stringify(s.authorizedRoot)})
        const path = realpathSync(${JSON.stringify(s.file)})
        const rel = relative(root, path)
        if (!isAbsolute(path) || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
          throw new Error('path is outside the authorized worktree')
        }
        const resource = await context.createFileResource({ path, contentType: '${FIXTURE_MIME}' })
        appendFileSync(${JSON.stringify(s.marker)}, 'activation-url ' + resource.url + '\\n')
        throw new Error('failed after creating resource')
      `
    }
    writeModulePlugin(failedSource, s.marker, {
      id: 'acme.failed-resource',
      name: 'Failed resource fixture',
      version: '1.0.0',
      contributes: { method: [{ id: 'activate', params: { type: 'object' } }] }
    }, failedBehavior)
    await s.client.call('plugin.install', { path: join(failedSource, 'acme.failed-resource'), yes: true })
    await expect(s.client.call('plugin.activate', { pluginId: 'acme.failed-resource' })).rejects.toBeTruthy()
    const markerText = readFileSync(s.marker, 'utf8')
    const failedUrl = markerText.match(/activation-url (\S+)/)?.[1]
    expect(failedUrl).toBeTruthy()
    expect((await s.fetchResource(failedUrl!)).status).toBe(404)

    const live = await s.resource()
    expect((await s.fetchResource(live)).status).toBe(200)
    const replacementRoot = makeTempDir('qd-file-resource-replacement-')
    writeModulePlugin(replacementRoot, s.marker, {
      id: PLUGIN_ID,
      name: 'File resource fixture',
      version: '1.1.0',
      contributes: {
        method: [{ id: 'create', params: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }]
      }
    })
    await s.client.call('plugin.install', { path: join(replacementRoot, PLUGIN_ID), yes: true })
    expect((await s.fetchResource(live)).status).toBe(404)
  })

  test('cancelling and revoking active streams terminates them and daemon stop drains cleanup', async () => {
    const s = await boot({ content: 'x'.repeat(256 * 1024) })
    const size = 32 * 1024 * 1024
    truncateSync(s.file, size)
    const resourceUrl = await s.resource()
    const response = await s.fetchResource(resourceUrl)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.value!.byteLength).toBeLessThan(size)
    await reader.cancel()
    expect(await reader.read()).toMatchObject({ done: true })

    const finishReader = async (streamReader: ReadableStreamDefaultReader<Uint8Array>) => {
      let bytesRead = 0
      for (;;) {
        const next = await streamReader.read().catch(() => null)
        if (next === null || next.done) return
        if (next.value.byteLength === 0) throw new Error('resource stream did not make progress')
        bytesRead += next.value.byteLength
        if (bytesRead > size) throw new Error('revoked resource streamed beyond its advertised length')
      }
    }

    const revokedUrl = await s.resource()
    const revokedResponse = await s.fetchResource(revokedUrl)
    const revokedReader = revokedResponse.body!.getReader()
    await revokedReader.read()
    await s.client.callAny(METHOD_REVOKE, {})
    expect((await s.fetchResource(revokedUrl)).status).toBe(404)
    await finishReader(revokedReader)

    const stoppingUrl = await s.resource()
    const active = await s.fetchResource(stoppingUrl)
    const activeReader = active.body!.getReader()
    await activeReader.read()
    await s.harness.daemon.stop()
    await finishReader(activeReader)
  })
})
