import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const uiDir = join(import.meta.dir, '..')
const repoRoot = join(uiDir, '../..')
let out = ''
let plugins = ''
const scratch: string[] = []

/** Source of a plugin UI module that imports React bare and a sibling file, as the built-ins do. */
const FIXTURE_UI = [
  "import { useState } from 'react'",
  "import { createPortal } from 'react-dom'",
  "import { jsx } from 'react/jsx-runtime'",
  "import { greeting } from './greeting'",
  "import { Panel } from './Panel'",
  'export const buildInfo = [process.env.QUIRKY_BUILD_VERSION, process.env.QUIRKY_BUILD_COMMIT, process.env.QUIRKY_BUILD_CHANNEL]',
  'export function activate(context: { provide(id: string, impl: unknown): void }) {',
  "  context.provide('view:acme.fixture/page', () => jsx('p', { children: [greeting, typeof useState, typeof createPortal, Panel] }))",
  '}',
  ''
].join('\n')

const FIXTURE_PANEL = [
  "import { jsx } from 'react/jsx-runtime'",
  'export function Panel() {',
  '  return (',
  '    <section>',
  '      <Inner />',
  '    </section>',
  '  )',
  '}',
  'function Inner() {',
  "  return jsx('i', {})",
  '}',
  ''
].join('\n')

function fixturePlugins(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-ui-plugins-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'acme.fixture', 'src'), { recursive: true })
  writeFileSync(join(dir, 'acme.fixture', 'src', 'ui.tsx'), FIXTURE_UI)
  writeFileSync(join(dir, 'acme.fixture', 'src', 'Panel.tsx'), FIXTURE_PANEL)
  writeFileSync(join(dir, 'acme.fixture', 'src', 'greeting.ts'), "export const greeting = 'hello from the bundle'\n")
  mkdirSync(join(dir, 'acme.headless'), { recursive: true })
  writeFileSync(join(dir, 'acme.headless', 'main.ts'), 'export function activate() {}\n')
  return dir
}

/** Runs packages/ui/build.ts into fresh output directories; the flavor is chosen by `QUIRKY_UI_DEV`. */
async function runBuild(flavor: { dev: boolean }, pluginsDir: string) {
  const outDir = mkdtempSync(join(tmpdir(), 'quirky-ui-build-'))
  scratch.push(outDir)
  const proc = Bun.spawn(['bun', join(uiDir, 'build.ts')], {
    cwd: uiDir,
    env: { ...process.env, QUIRKY_UI_OUT: outDir, QUIRKY_PLUGINS_DIR: pluginsDir, QUIRKY_UI_DEV: flavor.dev ? '1' : '' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { outDir, code, stderr }
}

beforeAll(async () => {
  plugins = fixturePlugins()
  const result = await runBuild({ dev: false }, plugins)
  if (result.code !== 0) throw new Error(`build failed (${result.code}): ${result.stderr}`)
  out = result.outDir
}, 60_000)

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const read = (rel: string) => readFileSync(join(out, rel), 'utf8')
const load = (rel: string) => import(pathToFileURL(join(out, rel)).href)
const resolveFromUi = (spec: string) => Bun.resolveSync(spec, uiDir)

describe("SC-29: plugin UI modules share the window's React", () => {
  test('index.html declares the import map before the module script', () => {
    const html = read('index.html')
    const mapAt = html.indexOf('type="importmap"')
    const moduleAt = html.indexOf('type="module"')
    expect(mapAt).toBeGreaterThan(-1)
    expect(moduleAt).toBeGreaterThan(mapAt)

    const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
    const map = JSON.parse(match![1]!) as { imports: Record<string, string> }
    expect(Object.keys(map.imports).sort()).toEqual(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])
    for (const target of Object.values(map.imports)) {
      expect(Bun.file(join(out, target)).size).toBeGreaterThan(0)
    }
  })

  test('a plugin importing react-dom bare gets the window\'s createPortal through the map', async () => {
    const dom = await load('vendor/react-dom.js')
    expect(typeof dom.createPortal).toBe('function')
    expect(typeof dom.flushSync).toBe('function')
  })

  test('main.js imports React bare and carries no copy of it', () => {
    const main = read('main.js')
    expect(main).toMatch(/from\s*"react"/)
    expect(main).toMatch(/from\s*"react\/jsx-runtime"/)
    expect(main).not.toContain('react.transitional.element')

    const vendorText = readdirSync(join(out, 'vendor'))
      .map(name => read(join('vendor', name)))
      .join('\n')
    expect(vendorText).toContain('react.transitional.element')
  })

  for (const [file, pkg] of [
    ['vendor/react.js', 'react'],
    ['vendor/react-dom-client.js', 'react-dom/client'],
    ['vendor/jsx-runtime.js', 'react/jsx-runtime']
  ] as const) {
    test(`${file} exports every key of ${pkg}`, async () => {
      const expected = Object.keys(require(resolveFromUi(pkg)))
      const mod = await load(file)
      for (const key of expected) expect(mod).toHaveProperty(key)
      expect(mod.default).toBeDefined()
    })
  }

  test('vendor entries share one React instance', async () => {
    const a = await load('vendor/react.js')
    const b = await load('vendor/react.js?again')
    const jsx = await load('vendor/jsx-runtime.js')
    const dom = await load('vendor/react-dom-client.js')
    expect(a.createElement).toBe(b.createElement)
    expect(a.default.createElement).toBe(a.createElement)

    // jsx() reads React's element symbol and internals, so its output must be a valid element of the same React
    const element = jsx.jsx('div', { id: 'x' })
    expect(a.isValidElement(element)).toBe(true)
    expect(typeof dom.createRoot).toBe('function')

    const chunks = readdirSync(join(out, 'vendor')).filter(name => !/^(react|react-dom-client|jsx-runtime)\.js$/.test(name))
    expect(chunks.length).toBeGreaterThan(0)
    for (const entry of ['react.js', 'react-dom-client.js', 'jsx-runtime.js']) {
      expect(read(join('vendor', entry))).toMatch(/from\s*"\.\/chunk-/)
    }
  })
})

describe('plugin UI modules are bundled beside their plugins', () => {
  const bundle = () => join(plugins, 'acme.fixture', 'dist', 'ui.js')

  test('each plugins/*/src/ui.tsx becomes plugins/*/dist/ui.js, and a plugin without one gets nothing', () => {
    expect(existsSync(bundle())).toBe(true)
    expect(existsSync(join(plugins, 'acme.headless', 'dist'))).toBe(false)
  })

  test('the bundle keeps React bare, inlines local imports and is minified', () => {
    const text = readFileSync(bundle(), 'utf8')
    expect(text).toMatch(/from\s*"react"/)
    expect(text).toMatch(/from\s*"react-dom"/)
    expect(text).toMatch(/from\s*"react\/jsx-runtime"/)
    expect(text).not.toContain('react.transitional.element')
    expect(text).toContain('hello from the bundle')
    expect(text).not.toContain("import './greeting'")
    expect(text.split('\n').length).toBeLessThan(10)
  })

  test('the app build leaves no plugin output in the app directory', () => {
    expect(existsSync(join(out, 'ui.js'))).toBe(false)
    expect(existsSync(join(out, 'acme.fixture'))).toBe(false)
  })
})

describe('build flavors', () => {
  const version = readFileSync(join(repoRoot, 'apps/desktop/electrobun.config.ts'), 'utf8').match(/version:\s*'([^']*)'/)![1]!
  const commit = (() => {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
    return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown'
  })()
  const releaseBundle = () => readFileSync(join(plugins, 'acme.fixture', 'dist', 'ui.js'), 'utf8')

  test('a release build carries no source attributes anywhere', () => {
    expect(read('main.js')).not.toContain('data-quirky-source')
    expect(read('gallery.js')).not.toContain('data-quirky-source')
    expect(releaseBundle()).not.toContain('data-quirky-source')
  })

  test('a release build resolves the build defines with the release channel', () => {
    const text = releaseBundle()
    expect(text).toContain(`"${version}","${commit}","release"`)
    expect(text).not.toContain('process.env.QUIRKY_BUILD')
  })

  describe('with QUIRKY_UI_DEV=1', () => {
    let devOut = ''
    let devPlugins = ''
    const devBundle = () => readFileSync(join(devPlugins, 'acme.fixture', 'dist', 'ui.js'), 'utf8')

    beforeAll(async () => {
      devPlugins = fixturePlugins()
      const result = await runBuild({ dev: true }, devPlugins)
      if (result.code !== 0) throw new Error(`dev build failed (${result.code}): ${result.stderr}`)
      devOut = result.outDir
    }, 60_000)

    test('a plugin UI intrinsic element records its file and line, and a component does not', () => {
      const text = devBundle()
      expect(text).toMatch(/"data-quirky-source":\s*"[^"]*acme\.fixture\/src\/Panel\.tsx:4"/)
      expect(text.match(/data-quirky-source/g)).toHaveLength(1)
    })

    test('the app records repo-relative paths under packages/ui/src', () => {
      const text = readFileSync(join(devOut, 'main.js'), 'utf8')
      expect(text).toMatch(/"data-quirky-source":\s*"packages\/ui\/src\/[^"]+\.tsx:\d+"/)
    })

    test('output stays unminified on one production runtime', () => {
      const text = devBundle()
      expect(text.split('\n').length).toBeGreaterThan(10)
      expect(text).not.toContain('jsxDEV')
      expect(readFileSync(join(devOut, 'main.js'), 'utf8')).not.toContain('jsxDEV')
    })

    test('the build defines resolve with the dev channel', () => {
      const text = devBundle()
      expect(text).toMatch(new RegExp(`"${version}",\\s*"${commit}",\\s*"dev"`))
      expect(text).not.toContain('process.env.QUIRKY_BUILD')
    })

    test('a plugin file that does not parse fails the build and names the file', async () => {
      const broken = fixturePlugins()
      writeFileSync(join(broken, 'acme.fixture', 'src', 'Panel.tsx'), 'export const Panel = () => <div>\n')
      const result = await runBuild({ dev: true }, broken)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('Panel.tsx')
    }, 60_000)
  })
})
