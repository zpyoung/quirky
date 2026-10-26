import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = import.meta.dir
const dist = process.env.QUIRKY_UI_OUT ? resolve(process.env.QUIRKY_UI_OUT) : join(root, 'dist')
const pluginsDir = process.env.QUIRKY_PLUGINS_DIR ? resolve(process.env.QUIRKY_PLUGINS_DIR) : join(root, '../../plugins')
const define = { 'process.env.NODE_ENV': '"production"' }

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

// plugin modules import react bare and get the window's copy through the import map in index.html
const shared = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']

const app = await Bun.build({
  entrypoints: [join(root, 'src/main.tsx')],
  target: 'browser',
  minify: true,
  outdir: dist,
  naming: '[name].[ext]',
  external: shared,
  define
})

// one splitting build so the three vendor entries share a single React chunk
const vendor = await Bun.build({
  entrypoints: ['react.ts', 'react-dom-client.ts', 'jsx-runtime.ts'].map(name => join(root, 'src/vendor', name)),
  target: 'browser',
  minify: true,
  splitting: true,
  outdir: join(dist, 'vendor'),
  naming: { entry: '[name].[ext]', chunk: 'chunk-[hash].[ext]' },
  define
})

// every plugin that has UI source gets a module beside its manifest, which the daemon serves to the window
const pluginIds = (await readdir(pluginsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'src/ui.tsx')))
  .map((entry) => entry.name)
const pluginBuilds = await Promise.all(
  pluginIds.map((id) =>
    Bun.build({
      entrypoints: [join(pluginsDir, id, 'src/ui.tsx')],
      target: 'browser',
      minify: true,
      outdir: join(pluginsDir, id, 'dist'),
      naming: 'ui.js',
      external: shared,
      define
    })
  )
)

for (const result of [app, vendor, ...pluginBuilds]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

await copyFile(join(root, 'src/index.html'), join(dist, 'index.html'))
await copyFile(Bun.resolveSync('@xterm/xterm/css/xterm.css', root), join(dist, 'xterm.css'))

console.log(`built ${app.outputs.length + vendor.outputs.length} files into ${dist} and ${pluginBuilds.length} plugin UI modules`)
