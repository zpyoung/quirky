import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import hutchConfig from '../hutch.config'

const RELEASES = 'https://github.com/zpyoung/electrobun/releases/download'
const ASSET = 'electrobun-core-darwin-arm64.tar.gz'
const FORK_RELEASE = /^\d+\.\d+\.\d+-quirky\.[1-9]\d*$/

type DevkitOptions = {
  env?: Record<string, string | undefined>
  cacheRoot?: string
  platform?: string
  arch?: string
  fetchAsset?: (url: string) => Promise<Uint8Array>
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Resolves the devkit root Hutch must load for a pinned Electrobun version, downloading and
 * verifying a fork release into a shared per-version cache on first use. Returns null for an
 * upstream pin, which Hutch fetches itself. An explicit HUTCH_ELECTROBUN_DEVKIT_ROOT always wins.
 * Throws when the version can't be satisfied, so a build never falls back to stock Electrobun.
 */
export async function resolveElectrobunDevkit(version: string, options: DevkitOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env
  if (env.HUTCH_ELECTROBUN_DEVKIT_ROOT) return env.HUTCH_ELECTROBUN_DEVKIT_ROOT
  if (!version.includes('-quirky.')) return null
  if (!FORK_RELEASE.test(version)) {
    throw new Error(`Electrobun ${version} is a private test build; set HUTCH_ELECTROBUN_DEVKIT_ROOT to its devkit`)
  }
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(`Electrobun ${version} only ships a macOS arm64 devkit, not ${platform} ${arch}`)
  }

  const cacheRoot = options.cacheRoot ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'quirky', 'electrobun-devkit')
  const root = join(cacheRoot, version)
  if (existsSync(root)) return root

  const fetchAsset = options.fetchAsset ?? download
  const base = `${RELEASES}/v${version}/${ASSET}`
  const [archive, checksum] = await Promise.all([fetchAsset(base), fetchAsset(`${base}.sha256`)])
  const expected = new TextDecoder().decode(checksum).trim().split(/\s+/)[0]
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) throw new Error(`${ASSET} for ${version} failed its checksum: expected ${expected}, got ${actual}`)

  mkdirSync(cacheRoot, { recursive: true })
  const staging = mkdtempSync(join(cacheRoot, `.${version}-`))
  try {
    const archivePath = join(staging, ASSET)
    writeFileSync(archivePath, archive)
    const extracted = join(staging, 'devkit')
    mkdirSync(extracted)
    const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extracted], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`could not extract ${ASSET}: ${tar.stderr || tar.error?.message}`)
    try {
      renameSync(extracted, root)
    } catch (error) {
      // parallel builds race to fill the cache, and either complete copy is the same release
      if (!existsSync(root)) throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return root
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('usage: with-electrobun-devkit.ts <command> [args...]')
  const root = await resolveElectrobunDevkit(hutchConfig.electrobun.version)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: root ? { ...process.env, HUTCH_ELECTROBUN_DEVKIT_ROOT: root } : process.env
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
