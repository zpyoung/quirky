import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  QUIRKYD_MOBILE_WEB_MANIFEST,
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_SERVER_TARGET_FILENAME,
  quirkydArtifactFilenames,
  quirkydRipgrepArtifact
} from '../../src/shared/quirkyd-artifacts.ts'
import { SERVER_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { quirkydAgentBrowserNativeName } from '../../src/shared/quirkyd-agent-browser-name.ts'
import { readQuirkydArtifactIdentity } from '../../src/main/quirkyd/quirkyd-artifact-identity.ts'
import { computeQuirkydFullVersion } from './quirkyd-artifact-version.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const PAGE_ASSET = 'out/mobile-web/index.html'
const PAGE_MANIFEST = JSON.stringify({ assets: [{ path: 'index.html' }] })

function createArtifactDirectory(target = 'linux-x64-glibc') {
  const directory = mkdtempSync(join(tmpdir(), 'quirkyd-version-'))
  directories.push(directory)
  for (const filename of quirkydArtifactFilenames(target, [PAGE_ASSET])) {
    const path = join(directory, filename)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, filename === QUIRKYD_MOBILE_WEB_MANIFEST ? PAGE_MANIFEST : filename)
  }
  writeFileSync(join(directory, QUIRKYD_SERVER_TARGET_FILENAME), `${target}\n`)
  return directory
}

describe('standalone runtime version', () => {
  it('changes when a shipped search binary changes and rejects a missing binary', () => {
    const target = 'linux-x64-glibc'
    const dir = createArtifactDirectory(target)
    const before = computeQuirkydFullVersion(dir, { target })
    const binary = join(dir, quirkydRipgrepArtifact(target))
    writeFileSync(binary, 'updated binary')
    expect(computeQuirkydFullVersion(dir, { target })).not.toBe(before)
    rmSync(binary)
    expect(() => computeQuirkydFullVersion(dir, { target })).toThrow(quirkydRipgrepArtifact(target))
  })

  it('changes when a page asset changes and rejects a missing one', () => {
    const target = 'linux-x64-glibc'
    const dir = createArtifactDirectory(target)
    const before = computeQuirkydFullVersion(dir, { target })
    writeFileSync(join(dir, PAGE_ASSET), 'updated page')
    expect(computeQuirkydFullVersion(dir, { target })).not.toBe(before)
    rmSync(join(dir, PAGE_ASSET))
    expect(() => computeQuirkydFullVersion(dir, { target })).toThrow(PAGE_ASSET)
  })

  it('keys the version on the referenced runtime digest rather than its bytes', () => {
    const target = 'darwin-arm64'
    const dir = createArtifactDirectory(target)
    writeFileSync(join(dir, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME), `${'a'.repeat(64)}\n`)
    const before = computeQuirkydFullVersion(dir, { target })
    writeFileSync(join(dir, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME), `${'b'.repeat(64)}\n`)
    expect(computeQuirkydFullVersion(dir, { target })).not.toBe(before)
  })

  it.each(SERVER_TARGETS)(
    'matches the installed %s identity with and without its optional browser',
    async (target) => {
      const dir = createArtifactDirectory(target)
      const [platform, arch] = target.split('-')
      const agentBrowserFilename = quirkydAgentBrowserNativeName(
        platform,
        arch,
        target.endsWith('-musl') ? 'musl' : 'glibc'
      )
      const options = { target, agentBrowserFilename }
      const withoutBrowser = computeQuirkydFullVersion(dir, options)
      expect(withoutBrowser).toBe(await readQuirkydArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'browser')
      const withBrowser = computeQuirkydFullVersion(dir, options)
      expect(withBrowser).not.toBe(withoutBrowser)
      expect(withBrowser).toBe(await readQuirkydArtifactIdentity(dir))
      writeFileSync(join(dir, agentBrowserFilename), 'updated-browser')
      expect(computeQuirkydFullVersion(dir, options)).not.toBe(withBrowser)
      expect(computeQuirkydFullVersion(dir, options)).toBe(await readQuirkydArtifactIdentity(dir))
    }
  )
})
