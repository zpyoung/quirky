import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { jsxSourcePlugin } from './jsx-source-plugin'

const root = import.meta.dir
const dist = process.env.QUIRKY_UI_OUT ? resolve(process.env.QUIRKY_UI_OUT) : join(root, 'dist')
const pluginsDir = process.env.QUIRKY_PLUGINS_DIR ? resolve(process.env.QUIRKY_PLUGINS_DIR) : join(root, '../../plugins')
const repoRoot = join(root, '../..')
const dev = process.env.QUIRKY_UI_DEV === '1'

// CI rewrites this version with sed before building, so it is read as text
const configText = await Bun.file(join(repoRoot, 'apps/desktop/electrobun.config.ts')).text()
const version = configText.match(/version:\s*'([^']*)'/)?.[1] ?? 'unknown'

function gitCommit(): string {
  // an inherited GIT_DIR (hooks set one) would point git at a different repository
  const { GIT_DIR, GIT_WORK_TREE, ...env } = process.env
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRoot, env, stderr: 'ignore' })
    const commit = result.stdout.toString().trim()
    return result.exitCode === 0 && commit ? commit : 'unknown'
  } catch {
    return 'unknown'
  }
}

const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.QUIRKY_BUILD_VERSION': JSON.stringify(version),
  'process.env.QUIRKY_BUILD_COMMIT': JSON.stringify(gitCommit()),
  'process.env.QUIRKY_BUILD_CHANNEL': JSON.stringify(dev ? 'dev' : 'release')
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

// plugin modules import react bare and get the window's copy through the import map in index.html
const shared = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']

// every plugin that has UI source gets a module beside its manifest, which the daemon serves to the window
const pluginIds = (await readdir(pluginsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'src/ui.tsx')))
  .map((entry) => entry.name)
// dev builds stay readable and record which source line rendered each element
const devPlugins = dev ? [jsxSourcePlugin(repoRoot, [join(root, 'src'), ...pluginIds.map((id) => join(pluginsDir, id, 'src'))])] : []

const app = await Bun.build({
  entrypoints: [join(root, 'src/main.tsx')],
  target: 'browser',
  minify: !dev,
  plugins: devPlugins,
  outdir: dist,
  naming: '[name].[ext]',
  external: shared,
  define
})
const gallery = await Bun.build({
  entrypoints: [join(root, 'src/gallery.tsx')],
  target: 'browser',
  minify: !dev,
  plugins: devPlugins,
  outdir: dist,
  naming: '[name].[ext]',
  external: shared,
  define
})

// one splitting build so the vendor entries share a single React chunk
const vendor = await Bun.build({
  entrypoints: ['react.ts', 'react-dom.ts', 'react-dom-client.ts', 'jsx-runtime.ts'].map(name => join(root, 'src/vendor', name)),
  target: 'browser',
  minify: true,
  splitting: true,
  outdir: join(dist, 'vendor'),
  naming: { entry: '[name].[ext]', chunk: 'chunk-[hash].[ext]' },
  define
})

const pluginBuilds = await Promise.all(
  pluginIds.map(async (id) => {
    const pluginDirectory = join(pluginsDir, id)
    const outputDirectory = join(pluginDirectory, 'dist')
    await rm(outputDirectory, { recursive: true, force: true })
    return Bun.build({
      entrypoints: [join(pluginDirectory, 'src/ui.tsx')],
      target: 'browser',
      minify: !dev,
      plugins: devPlugins,
      splitting: true,
      outdir: outputDirectory,
      naming: { entry: 'ui.[ext]', chunk: 'chunk-[hash].[ext]', asset: 'asset-[hash].[ext]' },
      external: shared,
      define
    })
  })
)

for (const result of [app, gallery, vendor, ...pluginBuilds]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}
for (const id of pluginIds) {
  const pluginDirectory = join(pluginsDir, id)
  const outputDirectory = join(pluginDirectory, 'dist')
  if (existsSync(join(pluginDirectory, 'src/viewers/ViewerSurface.tsx'))) {
    const worker = Bun.resolveSync('pdfjs-dist/build/pdf.worker.min.mjs', pluginDirectory)
    await copyFile(worker, join(outputDirectory, 'pdf.worker.min.mjs'))
  }
}

await copyFile(join(root, 'src/index.html'), join(dist, 'index.html'))
await copyFile(join(root, 'src/gallery.html'), join(dist, 'gallery.html'))
await copyFile(Bun.resolveSync('@xterm/xterm/css/xterm.css', root), join(dist, 'xterm.css'))

console.log(`built ${app.outputs.length + gallery.outputs.length + vendor.outputs.length} files into ${dist} and ${pluginBuilds.length} plugin UI modules`)
