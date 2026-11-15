import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { servePluginFile } from '../../packages/daemon/src/plugin-files'
import { stageBuiltinPlugins } from './world.ts'

const homes: string[] = []
const repoRoot = resolve(import.meta.dir, '../..')

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-soak-world-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function snapshotTree(root: string): string {
  const rows: unknown[] = []
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path)
    const row: Record<string, unknown> = {
      name,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    }
    if (stat.isSymbolicLink()) row.target = readlinkSync(path)
    else if (stat.isFile()) row.bytes = readFileSync(path).toString('base64')
    rows.push(row)
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child)
    }
  }
  visit(root, '')
  return JSON.stringify(rows)
}

function fixturePlugin(plugins: string, id: string, options: { ui?: boolean } = {}): string {
  const root = join(plugins, id)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'quirky-plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0' }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: id, type: 'module' }))
  writeFileSync(join(root, 'main.ts'), 'export function activate() {}\n')
  if (options.ui) {
    mkdirSync(join(root, 'src', 'viewers'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pdfjs-dist', 'build'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pdfjs-dist', 'package.json'), JSON.stringify({ name: 'pdfjs-dist' }))
    writeFileSync(join(root, 'src', 'ui.tsx'), [
      "import image from './pixel.png'",
      "export const imageUrl = image",
      "export const loadPanel = () => import('./lazy')",
      ''
    ].join('\n'))
    writeFileSync(join(root, 'src', 'lazy.ts'), 'export const lazyPanel = true\n')
    writeFileSync(join(root, 'src', 'pixel.png'), Buffer.alloc(4096, 0x5a))
    writeFileSync(join(root, 'src', 'viewers', 'ViewerSurface.tsx'), 'export function ViewerSurface() {}\n')
    writeFileSync(join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'), 'fixture-pdf-worker-bytes\n')
  }
  return root
}

function walk(root: string): string[] {
  const paths: string[] = []
  const visit = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      paths.push(child)
      if (lstatSync(child).isDirectory()) visit(child)
    }
  }
  visit(root)
  return paths
}

test('stages every plugin and keeps real builder and served outputs inside the owned home', async () => {
  const home = makeHome()
  const fixtureRepo = join(home, 'source-repo')
  const sourcePlugins = join(fixtureRepo, 'plugins')
  mkdirSync(sourcePlugins, { recursive: true })

  const canary = fixturePlugin(sourcePlugins, 'acme.canary', { ui: true })
  mkdirSync(join(canary, 'dist'), { recursive: true })
  writeFileSync(join(canary, 'dist', 'canary.txt'), 'source-dist-canary\n')
  writeFileSync(join(canary, 'dist', 'ui.js'), 'source-ui-canary\n')
  const absent = fixturePlugin(sourcePlugins, 'acme.absent')
  const linked = fixturePlugin(sourcePlugins, 'acme.linked')
  const linkedDist = join(home, 'linked-source-dist')
  mkdirSync(linkedDist, { recursive: true })
  writeFileSync(join(linkedDist, 'canary.txt'), 'linked-dist-canary\n')
  symlinkSync(linkedDist, join(linked, 'dist'), 'dir')
  const before = new Map([canary, absent, linked].map((path) => [path, snapshotTree(path)]))

  const stagedRoot = stageBuiltinPlugins(fixtureRepo, home)
  expect(stagedRoot).toBe(join(home, 'builtin-plugins'))
  for (const id of ['acme.canary', 'acme.absent', 'acme.linked']) {
    const stagedPlugin = join(stagedRoot, id)
    expect(lstatSync(stagedPlugin).isDirectory()).toBe(true)
    expect(lstatSync(stagedPlugin).isSymbolicLink()).toBe(false)
    expect(existsSync(join(stagedPlugin, 'quirky-plugin.json'))).toBe(true)
    expect(existsSync(join(stagedPlugin, 'dist'))).toBe(false)
  }
  const stagedCanary = join(stagedRoot, 'acme.canary')
  expect(lstatSync(join(stagedCanary, 'src', 'pixel.png')).isFile()).toBe(true)
  expect(lstatSync(join(stagedCanary, 'src', 'pixel.png')).isSymbolicLink()).toBe(false)

  const uiDist = join(home, 'ui-dist')
  const build = Bun.spawn([process.execPath, join(repoRoot, 'packages/ui/build.ts')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      QUIRKY_PLUGINS_DIR: stagedRoot,
      QUIRKY_UI_OUT: uiDist,
      QUIRKY_UI_DEV: ''
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text()
  ])
  expect(code, `${stdout}\n${stderr}`).toBe(0)

  for (const [path, snapshot] of before) expect(snapshotTree(path)).toBe(snapshot)
  expect(existsSync(join(absent, 'dist'))).toBe(false)
  expect(existsSync(join(linked, 'dist'))).toBe(true)
  expect(lstatSync(join(linked, 'dist')).isSymbolicLink()).toBe(true)

  const pluginDist = join(stagedRoot, 'acme.canary', 'dist')
  expect(lstatSync(pluginDist).isDirectory()).toBe(true)
  expect(lstatSync(pluginDist).isSymbolicLink()).toBe(false)
  expect(existsSync(join(pluginDist, 'ui.js'))).toBe(true)
  expect(existsSync(join(pluginDist, 'pdf.worker.min.mjs'))).toBe(true)
  expect(readdirSync(pluginDist).some((name) => name.startsWith('chunk-') && name.endsWith('.js'))).toBe(true)
  expect(readFileSync(join(pluginDist, 'pdf.worker.min.mjs'), 'utf8')).toBe('fixture-pdf-worker-bytes\n')
  expect(existsSync(join(stagedRoot, 'acme.absent', 'dist'))).toBe(false)
  expect(existsSync(join(stagedRoot, 'acme.linked', 'dist'))).toBe(false)

  const generated = [...walk(uiDist), ...walk(pluginDist)]
  const homeReal = realpathSync(home)
  for (const path of generated) {
    const stat = lstatSync(path)
    expect(stat.isSymbolicLink(), `generated output is a symlink: ${relative(home, path)}`).toBe(false)
    expect(realpathSync(path).startsWith(`${homeReal}/`), `generated output escaped the home: ${relative(home, path)}`).toBe(true)
  }

  const pluginDirectory = join(stagedRoot, 'acme.canary')
  const lookup = (id: string) => id === 'acme.canary' ? { dir: pluginDirectory } : null
  const servedBundle = servePluginFile(lookup, '/plugins/acme.canary/dist/ui.js', 'GET')
  expect(servedBundle.status).toBe(200)
  const bundleBytes = await servedBundle.text()
  expect(bundleBytes).toBe(readFileSync(join(pluginDist, 'ui.js'), 'utf8'))
  expect(bundleBytes).not.toContain('source-ui-canary')
  const canaryResponse = servePluginFile(lookup, '/plugins/acme.canary/dist/canary.txt', 'GET')
  expect(canaryResponse.status).toBe(404)
  const assetName = readdirSync(pluginDist).find((name) => name.startsWith('asset-') && name.endsWith('.png'))
  expect(assetName).toBeDefined()
  const servedAsset = servePluginFile(lookup, `/plugins/acme.canary/dist/${assetName!}`, 'GET')
  expect(servedAsset.status).toBe(200)
  expect(Buffer.from(await servedAsset.arrayBuffer())).toEqual(readFileSync(join(pluginDist, assetName!)))

  const appFiles = walk(uiDist).map((path) => relative(home, path))
  expect(appFiles).toContain('ui-dist/index.html')
  expect(appFiles.some((path) => path.startsWith('ui-dist/vendor/'))).toBe(true)
}, 180_000)
