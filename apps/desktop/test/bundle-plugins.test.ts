import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bundlePlugins } from '../scripts/bundle-plugins'
import { bundleMobilePlugins } from '../scripts/bundle-mobile'

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

  test('preserves root LICENSE, LICENCE, and NOTICE files in the distribution', async () => {
    const notices = {
      'LICENSE.orca': 'Lovecast copyright and MIT terms',
      'LICENCE.third-party': 'Third-party permission terms',
      'NOTICE.txt': 'Attribution notice'
    }
    writePlugin('quirky.demo', { main: 'main.ts' }, { 'main.ts': 'export const x = 1\n', ...notices })

    await bundlePlugins(src, out)

    for (const [name, content] of Object.entries(notices)) {
      expect(readFileSync(join(out, 'quirky.demo', name), 'utf8')).toBe(content)
    }
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

  test('packages declared native and license assets with their bytes and executable mode', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [
          { dependency: 'demo-native', source: 'bin/native-{platform}-{arch}', destination: 'bin/worker', executable: true },
          { dependency: 'demo-native', source: 'LICENSE', destination: 'licenses/demo-native.LICENSE' }
        ] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    const nativeBytes = '#!/bin/sh\nprintf fixture-helper\n'
    write(join(dir, 'node_modules', 'demo-native', 'bin', `native-${process.platform}-${process.arch}`), nativeBytes)
    const licenseBytes = 'Apache-2.0 terms for the native helper'
    write(join(dir, 'node_modules', 'demo-native', 'LICENSE'), licenseBytes)

    await bundlePlugins(src, out)

    const packaged = join(out, 'quirky.demo', 'bin', 'worker')
    expect(existsSync(packaged)).toBe(true)
    expect(readFileSync(packaged, 'utf8')).toBe(nativeBytes)
    expect(statSync(packaged).mode & 0o111).toBe(0o111)
    const license = join(out, 'quirky.demo', 'licenses', 'demo-native.LICENSE')
    expect(readFileSync(license, 'utf8')).toBe(licenseBytes)
    expect(statSync(license).mode & 0o111).toBe(0)
    expect(existsSync(join(out, 'quirky.demo', 'node_modules'))).toBe(false)
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
  test('rejects a native asset whose dependency is not declared by that plugin', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: {},
        quirky: { assets: [{ dependency: 'demo-native', source: 'bin/native', destination: 'bin/native' }] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    write(join(dir, 'node_modules', 'demo-native', 'bin', 'native'), 'not allowed')
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*demo-native.*declared dependency/i)
  })

  test('does not copy an existing source outside its declared dependency', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [{ dependency: 'demo-native', source: '../outside-native', destination: 'bin/worker' }] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    const outside = join(dir, 'node_modules', 'outside-native')
    write(outside, 'outside-payload')

    await expect(bundlePlugins(src, out)).rejects.toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('outside-payload')
    expect(existsSync(join(out, 'quirky.demo', 'bin', 'worker'))).toBe(false)
  })

  test('does not copy a literal source name with an unknown asset placeholder', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [{ dependency: 'demo-native', source: 'native-{unknown}', destination: 'bin/worker' }] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    write(join(dir, 'node_modules', 'demo-native', 'native-{unknown}'), 'literal-payload')

    await expect(bundlePlugins(src, out)).rejects.toThrow()
    expect(existsSync(join(out, 'quirky.demo', 'bin', 'worker'))).toBe(false)
  })

  test('rejects native asset sources that escape their dependency through a symlink', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [{ dependency: 'demo-native', source: 'bin/escape', destination: 'bin/worker' }] }
      })
    })
    const dependencyDir = join(dir, 'node_modules', 'demo-native')
    const outside = join(work, 'outside')
    mkdirSync(dependencyDir, { recursive: true })
    write(join(dependencyDir, 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    write(outside, 'secret')
    mkdirSync(join(dependencyDir, 'bin'))
    symlinkSync(outside, join(dependencyDir, 'bin', 'escape'))
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*(escape|symlink)/i)
  })

  test('rejects asset destinations colliding with manifest or bundled entries', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [{ dependency: 'demo-native', source: 'asset', destination: 'main.js' }] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    write(join(dir, 'node_modules', 'demo-native', 'asset'), 'not an entry point')
    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*(collision|collid)/i)
  })
  test('fails with a plugin-specific error when a declared asset source is missing', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [{ dependency: 'demo-native', source: 'bin/missing', destination: 'bin/worker' }] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))

    await expect(bundlePlugins(src, out)).rejects.toThrow(/plugin quirky\.demo.*asset source bin\/missing.*missing/i)
  })

  test('rejects absolute destinations and manifest collisions', async () => {
    for (const destination of [join(work, 'outside-native'), 'quirky-plugin.json']) {
      const id = destination.startsWith('/') ? 'quirky.absolute' : 'quirky.manifest'
      const dir = writePlugin(id, { main: 'main.ts' }, {
        'main.ts': 'export const x = 1\n',
        'package.json': JSON.stringify({
          dependencies: { 'demo-native': '1.0.0' },
          quirky: { assets: [{ dependency: 'demo-native', source: 'asset', destination }] }
        })
      })
      write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
      write(join(dir, 'node_modules', 'demo-native', 'asset'), 'fixture')
      await expect(bundlePlugins(src, out)).rejects.toThrow(/asset (destination|.*)/i)
      rmSync(src, { recursive: true, force: true })
      mkdirSync(src)
    }
  })

  test('rejects colliding asset destinations before either asset overwrites the other', async () => {
    const dir = writePlugin('quirky.demo', { main: 'main.ts' }, {
      'main.ts': 'export const x = 1\n',
      'package.json': JSON.stringify({
        dependencies: { 'demo-native': '1.0.0' },
        quirky: { assets: [
          { dependency: 'demo-native', source: 'first', destination: 'bin/worker' },
          { dependency: 'demo-native', source: 'second', destination: 'bin/worker' }
        ] }
      })
    })
    write(join(dir, 'node_modules', 'demo-native', 'package.json'), JSON.stringify({ name: 'demo-native', version: '1.0.0' }))
    write(join(dir, 'node_modules', 'demo-native', 'first'), 'first')
    write(join(dir, 'node_modules', 'demo-native', 'second'), 'second')

    await expect(bundlePlugins(src, out)).rejects.toThrow(/quirky\.demo.*collid/i)
  })
  test('copies the generated mobile page bundle into the packaged quirky.mobile plugin', async () => {
    const mobile = writePlugin('quirky.mobile', {
      main: 'main.ts',
      staticAssets: ['assets/mobile']
    }, {
      'main.ts': 'export const active = true\n',
      'assets/mobile/manifest.json': '{\"v\":1,\"shellVersion\":1}\n',
      'assets/mobile/index.html': '<!doctype html><script src=\"/page.js\"></script>',
      'assets/mobile/page.js': 'document.body.dataset.bundle = \"ready\"'
    })
    expect(existsSync(join(mobile, 'assets', 'mobile', 'page.js'))).toBe(true)

    await bundlePlugins(src, out)

    const packaged = join(out, 'quirky.mobile', 'assets', 'mobile')
    expect(readFileSync(join(packaged, 'manifest.json'), 'utf8')).toBe('{\"v\":1,\"shellVersion\":1}\n')
    expect(readFileSync(join(packaged, 'page.js'), 'utf8')).toContain('dataset.bundle')
  })
})

test('desktop mobile packaging builds a fresh page bundle before copying plugin assets', async () => {
  const mobile = writePlugin('quirky.mobile', { main: 'main.ts', staticAssets: ['assets/mobile'] }, {
    'main.ts': 'export const active = true\n'
  })
  write(join(work, 'apps', 'mobile', 'web-entry', 'main.tsx'), 'document.body.dataset.bundle = \"fresh\"')
  const bundled = await bundleMobilePlugins(work, out)
  expect(bundled).toContain('quirky.mobile')

  const sourceManifest = JSON.parse(readFileSync(join(mobile, 'assets', 'mobile', 'manifest.json'), 'utf8'))
  const packaged = join(out, 'quirky.mobile', 'assets', 'mobile')
  expect(readFileSync(join(packaged, 'manifest.json'), 'utf8')).toBe(readFileSync(join(mobile, 'assets', 'mobile', 'manifest.json'), 'utf8'))
  expect(sourceManifest.assets.map((asset: { path: string }) => asset.path)).toEqual(expect.arrayContaining(['index.html', 'page.js']))
  expect(readFileSync(join(packaged, 'page.js'), 'utf8')).toContain('fresh')
})
