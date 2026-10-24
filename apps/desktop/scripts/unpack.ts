/**
 * Turns the stable build's self-extracting installer into a plain `build/Quirky.app`.
 *
 * The installer stays alive on a "Installation complete" panel until someone clicks Close, so a
 * quit app leaves a stray `launcher` process behind. The build also writes the real app as a
 * tarball under `artifacts/`; unpacking that gives an app that starts directly and exits with
 * its window.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const desktop = join(import.meta.dir, '..')
const artifacts = join(desktop, 'artifacts')
const build = join(desktop, 'build')

const manifest = JSON.parse(readFileSync(join(artifacts, 'stable-macos-arm64-update.json'), 'utf8')) as {
  artifact: { file: string }
}
const tarball = join(artifacts, manifest.artifact.file)
if (!existsSync(tarball)) throw new Error(`build artifact missing: ${tarball}`)

const staging = join(build, '.unpack')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const untar = Bun.spawnSync(['tar', '--zstd', '-xf', tarball, '-C', staging], { stderr: 'inherit' })
if (untar.exitCode !== 0) throw new Error(`unpacking ${tarball} failed`)

const unpacked = join(staging, 'Quirky.app')
const launcher = join(unpacked, 'Contents', 'MacOS', 'launcher')
if (!existsSync(launcher)) throw new Error(`unpacked app has no launcher: ${launcher}`)

const target = join(build, 'Quirky.app')
rmSync(target, { recursive: true, force: true })
renameSync(unpacked, target)
rmSync(staging, { recursive: true, force: true })
rmSync(join(build, 'stable-macos-arm64'), { recursive: true, force: true })
console.log(`packaged app: ${target}`)
