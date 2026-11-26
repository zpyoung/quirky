import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QUIRKYD_TEMPLATE_MANIFEST_FILENAME,
  QUIRKYD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/quirkyd-artifacts.ts'
import { writeQuirkydTemplateTestFixture } from './quirkyd-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  assertQuirkydTemplateBuilt,
  finalizePackagedQuirkydTemplate,
  findQuirkydTemplateMachOFiles,
  resealQuirkydTemplateManifest
} = require('./packaged-quirkyd-template.cjs')

const PTY = 'node_modules/node-pty/build/Release/pty.node'
const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])
const roots = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'quirky-packaged-quirkyd-'))
  roots.push(root)
  return root
}

/** The fixture template, with darwin-arm64's pty.node made a real Mach-O as the build leaves it. */
async function createResources() {
  const resourcesDir = await tempRoot()
  const templateDir = await writeQuirkydTemplateTestFixture(resourcesDir)
  const ptyPath = join(templateDir, QUIRKYD_TEMPLATE_TARGETS_DIR, 'darwin-arm64', ...PTY.split('/'))
  await writeFile(ptyPath, MACH_O_64)
  const manifestPath = join(templateDir, QUIRKYD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.targets['darwin-arm64'].files[PTY] = createHash('sha256').update(MACH_O_64).digest('hex')
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { resourcesDir, templateDir, ptyPath, manifestPath }
}

const quietly = () => vi.spyOn(console, 'log').mockImplementation(() => {})

describe('packaged quirkyd template', () => {
  it('signs only darwin Mach-O payloads on macOS and reseals their new bytes', async () => {
    quietly()
    const { resourcesDir, templateDir, ptyPath } = await createResources()
    const signed = []
    const signMacBinary = async (path) => {
      signed.push(path)
      await appendFile(path, 'codesign-blob')
    }

    await finalizePackagedQuirkydTemplate(resourcesDir, { platform: 'darwin', signMacBinary })

    expect(signed).toEqual([ptyPath])
    expect(findQuirkydTemplateMachOFiles(templateDir)).toEqual([`targets/darwin-arm64/${PTY}`])
  })

  it('verifies without signing on Windows and Linux packages', async () => {
    quietly()
    const { resourcesDir } = await createResources()
    const signMacBinary = vi.fn()

    for (const platform of ['win32', 'linux']) {
      await finalizePackagedQuirkydTemplate(resourcesDir, { platform, signMacBinary })
    }
    expect(signMacBinary).not.toHaveBeenCalled()
  })

  it('still rejects a changed file that no signer touched', async () => {
    quietly()
    const { resourcesDir, templateDir } = await createResources()
    await writeFile(join(templateDir, 'quirkyd.js'), 'tampered')

    await expect(
      finalizePackagedQuirkydTemplate(resourcesDir, {
        platform: 'darwin',
        signMacBinary: async () => {}
      })
    ).rejects.toThrow('quirkyd.js checksum mismatch')
  })

  it('refuses to reseal a path the manifest never listed', async () => {
    const { templateDir } = await createResources()

    expect(() =>
      resealQuirkydTemplateManifest(templateDir, ['targets/darwin-arm64/unlisted.node'])
    ).toThrow('is not a template manifest entry')
    expect(() => resealQuirkydTemplateManifest(templateDir, ['targets/win32-x64'])).toThrow(
      'is not a template manifest entry'
    )
  })

  it('fails a required build without the template and lets a dev build skip it', async () => {
    quietly()
    const resourcesDir = await tempRoot()
    const env = { QUIRKY_REQUIRE_QUIRKYD_TEMPLATE: '1' }

    await expect(
      finalizePackagedQuirkydTemplate(resourcesDir, { platform: 'linux', env })
    ).rejects.toThrow('missing the quirkyd deployment template')
    await expect(
      finalizePackagedQuirkydTemplate(resourcesDir, { platform: 'linux', env: {} })
    ).resolves.toBeUndefined()
    expect(() => assertQuirkydTemplateBuilt(resourcesDir, env)).toThrow(
      'QUIRKY_REQUIRE_QUIRKYD_TEMPLATE=1'
    )
    expect(() => assertQuirkydTemplateBuilt(resourcesDir, {})).not.toThrow()
  })
})
