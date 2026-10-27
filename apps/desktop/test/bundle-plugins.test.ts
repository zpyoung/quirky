import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bundlePlugins } from '../scripts/bundle-plugins'

let work: string
let src: string
let out: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'qbp-'))
  src = join(work, 'plugins')
  out = join(work, 'resources', 'plugins')
  mkdirSync(src)
})

afterEach(() => rmSync(work, { recursive: true, force: true }))

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writePlugin(id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(src, id)
  write(join(dir, 'quirky-plugin.json'), JSON.stringify({ id, name: id, version: '0.1.0', ...manifest }))
  for (const [name, content] of Object.entries(files)) write(join(dir, name), content)
  return dir
}

const readManifest = (id: string) => JSON.parse(readFileSync(join(out, id, 'quirky-plugin.json'), 'utf8'))

describe('bundlePlugins', () => {
  test('inlines main and cli dependencies into .js files and rewrites the manifest', async () => {
    const dir = writePlugin(
      'quirky.demo',
      { main: 'main.ts', cli: 'cli.ts' },
      {
        'main.ts': "import { greeting } from './helper'\nexport const main = greeting('main')\n",
        'cli.ts': "import { greeting } from './helper'\nexport const cli = greeting('cli')\n",
        'helper.ts': 'export const greeting = (who: string): string => `hello ${who}`\n'
      }
    )
    write(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    write(join(dir, 'test', 'main.test.ts'), 'export {}')

    await bundlePlugins(src, out)

    const manifest = readManifest('quirky.demo')
    expect(manifest.main).toBe('main.js')
    expect(manifest.cli).toBe('cli.js')
    expect(manifest.name).toBe('quirky.demo')
    expect(existsSync(join(out, 'quirky.demo', 'helper.ts'))).toBe(false)
    expect(existsSync(join(out, 'quirky.demo', 'main.ts'))).toBe(false)
    const bundled = await import(join(out, 'quirky.demo', 'main.js'))
    expect(bundled.main).toBe('hello main')
    expect((await import(join(out, 'quirky.demo', 'cli.js'))).cli).toBe('hello cli')
  })

  test('copies nothing but the manifest, bundles and ui, skipping test/ and node_modules/', async () => {
    const dir = writePlugin(
      'quirky.demo',
      { main: 'main.ts', ui: 'dist/ui.js' },
      { 'main.ts': 'export const x = 1\n', 'dist/ui.js': 'export default 1\n', 'package.json': '{}' }
    )
    write(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    write(join(dir, 'test', 'main.test.ts'), 'export {}')

    await bundlePlugins(src, out)

    expect(readFileSync(join(out, 'quirky.demo', 'dist', 'ui.js'), 'utf8')).toBe('export default 1\n')
    expect(existsSync(join(out, 'quirky.demo', 'node_modules'))).toBe(false)
    expect(existsSync(join(out, 'quirky.demo', 'test'))).toBe(false)
    expect(readManifest('quirky.demo').ui).toBe('dist/ui.js')
  })

  test('copies a sounds/ directory when the plugin has one', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, { 'main.ts': 'export const x = 1\n' })
    write(join(dir, 'sounds', 'ding.wav'), 'RIFF-ding')
    write(join(dir, 'sounds', 'nested', 'blip.wav'), 'RIFF-blip')
    writePlugin('quirky.plain', { main: 'main.ts' }, { 'main.ts': 'export const x = 1\n' })

    await bundlePlugins(src, out)

    expect(readFileSync(join(out, 'quirky.demo', 'sounds', 'ding.wav'), 'utf8')).toBe('RIFF-ding')
    expect(readFileSync(join(out, 'quirky.demo', 'sounds', 'nested', 'blip.wav'), 'utf8')).toBe('RIFF-blip')
    expect(existsSync(join(out, 'quirky.plain', 'sounds'))).toBe(false)
  })

  test('a plugin without cli.ts gets no cli entry', async () => {
    writePlugin('quirky.demo', { main: 'main.ts' }, { 'main.ts': 'export const x = 1\n' })
    await bundlePlugins(src, out)
    expect(readManifest('quirky.demo').cli).toBeUndefined()
    expect(existsSync(join(out, 'quirky.demo', 'cli.js'))).toBe(false)
  })

  test('fails with a clear message when the manifest names a ui module that was not built', async () => {
    writePlugin('quirky.demo', { main: 'main.ts', ui: 'dist/ui.js' }, { 'main.ts': 'export const x = 1\n' })
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*dist\/ui\.js.*bun run build/s)
  })

  test('ignores entries that are not plugin directories and clears stale output', async () => {
    writePlugin('quirky.demo', { main: 'main.ts' }, { 'main.ts': 'export const x = 1\n' })
    write(join(src, 'README.md'), '# plugins')
    write(join(out, 'quirky.gone', 'quirky-plugin.json'), '{}')

    const bundled = await bundlePlugins(src, out)

    expect(bundled).toEqual(['quirky.demo'])
    expect(existsSync(join(out, 'README.md'))).toBe(false)
    expect(existsSync(join(out, 'quirky.gone'))).toBe(false)
  })

  test('fails when a bundle does not compile', async () => {
    writePlugin('quirky.demo', { main: 'main.ts' }, { 'main.ts': "import './missing'\n" })
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo/)
  })
})
