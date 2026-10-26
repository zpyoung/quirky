import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const uiDir = join(import.meta.dir, '..')
let out = ''
let plugins = ''

/** Source of a plugin UI module that imports React bare and a sibling file, as the built-ins do. */
const FIXTURE_UI = [
  "import { useState } from 'react'",
  "import { jsx } from 'react/jsx-runtime'",
  "import { greeting } from './greeting'",
  'export function activate(context: { provide(id: string, impl: unknown): void }) {',
  "  context.provide('view:acme.fixture/page', () => jsx('p', { children: [greeting, typeof useState] }))",
  '}',
  ''
].join('\n')

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'quirky-ui-build-'))
  plugins = mkdtempSync(join(tmpdir(), 'quirky-ui-plugins-'))
  mkdirSync(join(plugins, 'acme.fixture', 'src'), { recursive: true })
  writeFileSync(join(plugins, 'acme.fixture', 'src', 'ui.tsx'), FIXTURE_UI)
  writeFileSync(join(plugins, 'acme.fixture', 'src', 'greeting.ts'), "export const greeting = 'hello from the bundle'\n")
  mkdirSync(join(plugins, 'acme.headless'), { recursive: true })
  writeFileSync(join(plugins, 'acme.headless', 'main.ts'), 'export function activate() {}\n')
  const proc = Bun.spawn(['bun', join(uiDir, 'build.ts')], {
    cwd: uiDir,
    env: { ...process.env, QUIRKY_UI_OUT: out, QUIRKY_PLUGINS_DIR: plugins },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`build failed (${code}): ${stderr}`)
}, 60_000)

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
  if (plugins) rmSync(plugins, { recursive: true, force: true })
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
    expect(Object.keys(map.imports).sort()).toEqual(['react', 'react-dom/client', 'react/jsx-runtime'])
    for (const target of Object.values(map.imports)) {
      expect(Bun.file(join(out, target)).size).toBeGreaterThan(0)
    }
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
