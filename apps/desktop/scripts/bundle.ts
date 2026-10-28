/**
 * Prepares `apps/desktop/resources/` for the Electrobun copy step: one bundled file per helper
 * process, the built UI, the tray images and the bundled built-in plugins. Missing inputs are skipped with a
 * warning; pass `--strict` to fail instead. A plugin whose UI module is not built always fails.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bundleMobilePlugins } from './bundle-mobile'

const root = join(import.meta.dir, '..', '..', '..')
const resources = join(import.meta.dir, '..', 'resources')
const strict = process.argv.includes('--strict')

const bundles = [
  { entry: join(root, 'packages', 'daemon', 'src', 'main.ts'), out: 'daemon.js' },
  { entry: join(root, 'packages', 'pty-host', 'src', 'main.ts'), out: 'pty-host.js' },
  { entry: join(root, 'packages', 'cli', 'src', 'main.ts'), out: 'cli.js' }
]
const uiDist = join(root, 'packages', 'ui', 'dist')

let missing = 0
const skip = (what: string) => {
  missing += 1
  console.warn(`warning: ${what} not found, skipping`)
}

mkdirSync(resources, { recursive: true })

for (const { entry, out } of bundles) {
  rmSync(join(resources, out), { force: true })
  if (!existsSync(entry)) {
    skip(entry)
    continue
  }
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: resources, naming: out })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bundling ${entry} failed`)
  }
  console.log(`bundled ${entry} -> resources/${out}`)
}

rmSync(join(resources, 'ui'), { recursive: true, force: true })
if (existsSync(join(uiDist, 'index.html'))) {
  cpSync(uiDist, join(resources, 'ui'), { recursive: true })
  console.log('copied packages/ui/dist -> resources/ui')
} else {
  skip(join(uiDist, 'index.html'))
}

const assetsDir = join(import.meta.dir, '..', 'assets')
rmSync(join(resources, 'assets'), { recursive: true, force: true })
if (existsSync(assetsDir)) {
  cpSync(assetsDir, join(resources, 'assets'), { recursive: true })
  console.log('copied apps/desktop/assets -> resources/assets')
} else {
  skip(assetsDir)
}

const plugins = await bundleMobilePlugins(root, join(resources, 'plugins'))
if (plugins === null) {
  skip(join(root, 'plugins'))
} else {
  console.log(`bundled ${plugins.length} plugins -> resources/plugins`)
}

if (strict && missing > 0) {
  console.error(`${missing} input(s) missing`)
  process.exit(1)
}
