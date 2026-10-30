import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveElectrobunDevkit } from '../scripts/with-electrobun-devkit'

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
