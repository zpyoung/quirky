import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = import.meta.dir
const dist = process.env.QUIRKY_UI_OUT ? resolve(process.env.QUIRKY_UI_OUT) : join(root, 'dist')
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

for (const result of [app, vendor]) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

await copyFile(join(root, 'src/index.html'), join(dist, 'index.html'))
await copyFile(Bun.resolveSync('@xterm/xterm/css/xterm.css', root), join(dist, 'xterm.css'))

console.log(`built ${app.outputs.length + vendor.outputs.length} files into ${dist}`)
