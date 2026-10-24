import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = import.meta.dir
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src/main.tsx')],
  target: 'browser',
  minify: true,
  outdir: dist,
  naming: '[name].[ext]',
  define: { 'process.env.NODE_ENV': '"production"' }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await copyFile(join(root, 'src/index.html'), join(dist, 'index.html'))
await copyFile(Bun.resolveSync('@xterm/xterm/css/xterm.css', root), join(dist, 'xterm.css'))

console.log(`built ${result.outputs.length} files into ${dist}`)
