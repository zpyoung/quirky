import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servePluginFile } from '../src/plugin-files'

let root: string
let pluginDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qd-plugin-files-'))
  pluginDir = join(root, 'acme.notes')
  mkdirSync(join(pluginDir, 'dist'), { recursive: true })
  writeFileSync(join(pluginDir, 'dist', 'ui.js'), 'import "./chunk.js"\n')
  writeFileSync(join(pluginDir, 'dist', 'chunk.js'), 'export const chunk = 1\n')
  writeFileSync(join(root, 'secret'), 'outside\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const lookup = (id: string) => (id === 'acme.notes' ? { dir: pluginDir } : null)
const get = (pathname: string, method = 'GET') => servePluginFile(lookup, pathname, method)

describe('servePluginFile', () => {
  test('serves the entry module and its chunk as JavaScript', async () => {
    for (const [path, body] of [
      ['dist/ui.js', 'import "./chunk.js"\n'],
      ['dist/chunk.js', 'export const chunk = 1\n']
    ] as const) {
      const response = get(`/plugins/acme.notes/${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(await response.text()).toBe(body)
    }
  })

  test('an encoded traversal is 404', () => {
    expect(get('/plugins/acme.notes/%2e%2e/secret').status).toBe(404)
    expect(get('/plugins/acme.notes/dist/%2e%2e/%2e%2e/secret').status).toBe(404)
  })

  test('an unknown plugin is 404', () => {
    expect(get('/plugins/acme.ghost/ui.js').status).toBe(404)
  })

  test('an empty path is 404', () => {
    expect(get('/plugins/acme.notes').status).toBe(404)
    expect(get('/plugins/acme.notes/').status).toBe(404)
  })

  test('a directory is 404 with no index fallback', () => {
    writeFileSync(join(pluginDir, 'dist', 'index.html'), '<html></html>')
    expect(get('/plugins/acme.notes/dist').status).toBe(404)
    expect(get('/plugins/acme.notes/dist/').status).toBe(404)
  })

  test('a missing file is 404', () => {
    expect(get('/plugins/acme.notes/dist/nope.js').status).toBe(404)
  })

  test('a symlink pointing outside the directory is 404', () => {
    symlinkSync(join(root, 'secret'), join(pluginDir, 'dist', 'link.js'))
    expect(get('/plugins/acme.notes/dist/link.js').status).toBe(404)
  })

  test('a symlink that stays inside the directory is served', () => {
    symlinkSync(join(pluginDir, 'dist', 'ui.js'), join(pluginDir, 'dist', 'alias.js'))
    expect(get('/plugins/acme.notes/dist/alias.js').status).toBe(200)
  })

  test('a bad percent-encoding is 400', () => {
    expect(get('/plugins/acme.notes/dist/%E0%A4%A.js').status).toBe(400)
  })

  test('HEAD returns the headers with an empty body', async () => {
    const response = get('/plugins/acme.notes/dist/ui.js', 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await response.text()).toBe('')
  })

  test('a file name containing an encoded # is served when requested encoded', async () => {
    writeFileSync(join(pluginDir, 'dist', 'a#b.js'), 'export const hash = 1\n')
    const response = get('/plugins/acme.notes/dist/a%23b.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('export const hash = 1\n')
  })

  test('an unknown extension is served as octet-stream', () => {
    writeFileSync(join(pluginDir, 'dist', 'ui.ts'), 'export {}\n')
    expect(get('/plugins/acme.notes/dist/ui.ts').headers.get('content-type')).toBe('application/octet-stream')
  })
})
