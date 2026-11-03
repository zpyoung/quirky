import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { commandEnv, resolveElectrobunDevkit } from '../scripts/with-electrobun-devkit'

const VERSION = '2.0.5-quirky.1'
const macOS = { platform: 'darwin', arch: 'arm64', env: {} }
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-devkit-test-'))
  dirs.push(dir)
  return dir
}

/** A real tarball holding one file, served with its checksum like a fork release's assets. */
function releaseAssets(checksum?: string) {
  const source = tempDir()
  mkdirSync(join(source, 'bin'))
  writeFileSync(join(source, 'bin', 'marker'), 'devkit')
  const archive = join(tempDir(), 'devkit.tar.gz')
  expect(spawnSync('tar', ['-czf', archive, '-C', source, 'bin']).status).toBe(0)
  const bytes = readFileSync(archive)
  const requests: string[] = []
  const fetchAsset = async (url: string): Promise<Uint8Array> => {
    requests.push(url)
    if (!url.endsWith('.sha256')) return bytes
    const hash = checksum ?? createHash('sha256').update(bytes).digest('hex')
    return new TextEncoder().encode(`${hash}  electrobun-core-darwin-arm64.tar.gz\n`)
  }
  return { fetchAsset, requests }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Electrobun devkit resolution', () => {
  test('an upstream pin leaves the devkit to Hutch', async () => {
    expect(await resolveElectrobunDevkit('2.0.4', macOS)).toBeNull()
  })

  test('an explicit devkit root wins over the pinned release', async () => {
    const env = { HUTCH_ELECTROBUN_DEVKIT_ROOT: '/local/dist' }
    expect(await resolveElectrobunDevkit(VERSION, { ...macOS, env })).toBe('/local/dist')
    expect(await resolveElectrobunDevkit('2.0.5-quirky.0-user-agent', { ...macOS, env })).toBe('/local/dist')
  })

  test('a private test version needs an explicit devkit', async () => {
    await expect(resolveElectrobunDevkit('2.0.5-quirky.0-user-agent', macOS)).rejects.toThrow('private test build')
  })

  test('a fork pin refuses a platform with no release asset instead of using stock Electrobun', async () => {
    await expect(resolveElectrobunDevkit(VERSION, { ...macOS, platform: 'linux', arch: 'x64' })).rejects.toThrow('macOS arm64')
  })

  test('a release is downloaded once, verified and extracted into its version directory', async () => {
    const cacheRoot = tempDir()
    const { fetchAsset, requests } = releaseAssets()
    const root = await resolveElectrobunDevkit(VERSION, { ...macOS, cacheRoot, fetchAsset })

    expect(root).toBe(join(cacheRoot, VERSION))
    expect(readFileSync(join(cacheRoot, VERSION, 'bin', 'marker'), 'utf8')).toBe('devkit')
    expect(requests).toEqual([
      `https://github.com/zpyoung/electrobun/releases/download/v${VERSION}/electrobun-core-darwin-arm64.tar.gz`,
      `https://github.com/zpyoung/electrobun/releases/download/v${VERSION}/electrobun-core-darwin-arm64.tar.gz.sha256`
    ])
    expect(readdirSync(cacheRoot)).toEqual([VERSION])

    await resolveElectrobunDevkit(VERSION, { ...macOS, cacheRoot, fetchAsset })
    expect(requests).toHaveLength(2)
  })

  test('a checksum mismatch leaves nothing in the cache', async () => {
    const cacheRoot = tempDir()
    const { fetchAsset } = releaseAssets('0'.repeat(64))
    await expect(resolveElectrobunDevkit(VERSION, { ...macOS, cacheRoot, fetchAsset })).rejects.toThrow('failed its checksum')
    expect(existsSync(join(cacheRoot, VERSION))).toBe(false)
  })
})

/** A home directory whose ~/.hutch/bin/hutch prints its arguments, like a Hutch install. */
function hutchHome(): string {
  const home = tempDir()
  mkdirSync(join(home, '.hutch', 'bin'), { recursive: true })
  const hutch = join(home, '.hutch', 'bin', 'hutch')
  writeFileSync(hutch, '#!/bin/sh\necho "hutch $*"\n')
  chmodSync(hutch, 0o755)
  return home
}

describe('finding Hutch', () => {
  test('~/.hutch/bin joins the end of PATH when Hutch is installed there', () => {
    const home = hutchHome()
    expect(commandEnv({ PATH: '/usr/bin:/bin' }, home).PATH).toBe(`/usr/bin:/bin:${join(home, '.hutch', 'bin')}`)
  })

  test('PATH is left alone when it already has ~/.hutch/bin or Hutch is not installed there', () => {
    const home = hutchHome()
    const withHutch = `${join(home, '.hutch', 'bin')}:/usr/bin`
    expect(commandEnv({ PATH: withHutch }, home).PATH).toBe(withHutch)
    expect(commandEnv({ PATH: '/usr/bin' }, tempDir()).PATH).toBe('/usr/bin')
  })

  // a shell that skipped the user's profile has only the system dirs and bun on PATH
  const bareShell = (home: string) => ({
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HUTCH_ELECTROBUN_DEVKIT_ROOT: tempDir()
  })
  const script = join(import.meta.dir, '..', 'scripts', 'with-electrobun-devkit.ts')

  test('the wrapper runs ~/.hutch/bin/hutch from a shell without it on PATH', () => {
    const run = spawnSync(process.execPath, [script, 'hutch', 'electrobun', 'prepare'], { env: bareShell(hutchHome()), encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('hutch electrobun prepare')
    expect(run.status).toBe(0)
  })

  test('the wrapper names ~/.hutch/bin when Hutch is nowhere to be found', () => {
    const run = spawnSync(process.execPath, [script, 'hutch', 'electrobun', 'prepare'], { env: bareShell(tempDir()), encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('~/.hutch/bin')
  })
})
