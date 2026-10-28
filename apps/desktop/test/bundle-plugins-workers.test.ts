import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bundlePlugins } from '../scripts/bundle-plugins'

let work: string
let src: string
let out: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'qbp-worker-'))
  src = join(work, 'plugins')
  out = join(work, 'bundled')
  mkdirSync(src)
})

afterEach(() => rmSync(work, { recursive: true, force: true }))

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('bundle worker entrypoints', () => {
  test('bundles each declared source worker and rewrites its mapping to the packaged file', async () => {
    const dir = join(src, 'quirky.demo')
    write(join(dir, 'quirky-plugin.json'), JSON.stringify({
      id: 'quirky.demo', name: 'Demo', version: '1.0.0', main: 'main.ts',
      workers: { scanner: 'src/worker.ts' }
    }))
    write(join(dir, 'main.ts'), 'export const main = true')
    write(join(dir, 'src', 'worker.ts'), 'export const workerReady = true')

    await bundlePlugins(src, out)

    const manifest = JSON.parse(readFileSync(join(out, 'quirky.demo', 'quirky-plugin.json'), 'utf8'))
    expect(manifest.workers).toEqual({ scanner: 'src/worker.js' })
    expect(existsSync(join(out, 'quirky.demo', 'src', 'worker.js'))).toBe(true)
    expect((await import(join(out, 'quirky.demo', 'src', 'worker.js'))).workerReady).toBe(true)
  })

  test('refuses traversal before writing a worker bundle', async () => {
    const dir = join(src, 'quirky.demo')
    write(join(dir, 'quirky-plugin.json'), JSON.stringify({
      id: 'quirky.demo', name: 'Demo', version: '1.0.0', main: 'main.ts', workers: { scanner: '../outside.ts' }
    }))
    write(join(dir, 'main.ts'), 'export const main = true')
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*worker.*inside/i)
  })
})
