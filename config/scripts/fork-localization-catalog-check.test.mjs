import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  main,
  runUpstreamVerifierWithForkCatalogs,
  validateForkLocalizationCatalogs
} from './fork-localization-catalog-check.mjs'

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeProject({ sourceText, enCatalog, esCatalog = {}, upstreamEn = {}, upstreamEs = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), 'quirky-fork-locales-'))
  const featureDir = path.join(root, 'src/renderer/src/components/fork-chat')
  const localesDir = path.join(featureDir, 'locales')
  const upstreamLocales = path.join(root, 'src/renderer/src/i18n/locales')
  const mainDir = path.join(root, 'src/main')
  mkdirSync(localesDir, { recursive: true })
  mkdirSync(upstreamLocales, { recursive: true })
  mkdirSync(mainDir, { recursive: true })
  writeFileSync(path.join(featureDir, 'Example.tsx'), sourceText, 'utf8')
  writeFileSync(path.join(mainDir, 'empty.ts'), 'export {}\n', 'utf8')
  writeJson(path.join(localesDir, 'en.json'), enCatalog)
  writeJson(path.join(localesDir, 'es.json'), esCatalog)
  writeJson(path.join(upstreamLocales, 'en.json'), upstreamEn)
  writeJson(path.join(upstreamLocales, 'es.json'), upstreamEs)
  return { root, localesDir, upstreamLocales }
}

function snapshotFiles(filePaths) {
  return new Map(
    filePaths.map((filePath) => [
      filePath,
      { content: readFileSync(filePath, 'utf8'), mtimeMs: statSync(filePath).mtimeMs }
    ])
  )
}

describe('fork-localization-catalog-check', () => {
  it('checks fork keys used from an upstream seam and accepts sparse translations', async () => {
    const { root } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{name}}' } } }
    })
    const seam = path.join(root, 'src/renderer/src/components/Seam.tsx')
    writeFileSync(seam, "translate('components.chat.label', 'Chat {{name}}')\n", 'utf8')

    await expect(validateForkLocalizationCatalogs(root, { fix: false })).resolves.toBe(0)
  })

  it('rejects target-only keys and interpolation mismatches with the upstream parity rules', async () => {
    const { root } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{wrong}}', stale: 'Stale' } } }
    })

    await expect(validateForkLocalizationCatalogs(root, { fix: false })).resolves.toBe(1)
  })

  it('adds a missing English key with its literal fallback to the owning fork catalog', async () => {
    const { root, localesDir } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat')\n",
      enCatalog: {},
      esCatalog: {}
    })

    await expect(validateForkLocalizationCatalogs(root, { fix: true })).resolves.toBe(0)
    await expect(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(path.join(localesDir, 'en.json'), 'utf8')
      )
    ).resolves.toContain('"label": "Chat"')
  })

  it('never writes tracked locale files across a passing run', async () => {
    const { root, upstreamLocales } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      upstreamEn: { app: { title: 'Quirky' } },
      upstreamEs: { app: { title: 'Quirky' } }
    })
    const seam = path.join(root, 'src/renderer/src/components/Seam.tsx')
    writeFileSync(seam, "translate('components.chat.label', 'Chat {{name}}')\n", 'utf8')
    const trackedFiles = [
      path.join(upstreamLocales, 'en.json'),
      path.join(upstreamLocales, 'es.json')
    ]
    const before = snapshotFiles(trackedFiles)

    await expect(main(root, { fix: false, verifyExtraction: false })).resolves.toBe(0)

    expect(snapshotFiles(trackedFiles)).toEqual(before)
  })

  it('detects a key missing from both catalogs on the catalog and extraction paths', async () => {
    const { root } = makeProject({
      sourceText: "translate('components.chat.ghost', 'Ghost')\n",
      enCatalog: {},
      esCatalog: {}
    })

    await expect(main(root, { fix: false, verifyExtraction: false })).resolves.toBe(1)
    await expect(main(root, { fix: false, verifyExtraction: true })).resolves.toBe(1)
  })
})

describe('runUpstreamVerifierWithForkCatalogs', () => {
  it('overlays merged catalog text for tracked locale reads and passes other reads through', async () => {
    const { root, upstreamLocales } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      upstreamEn: { app: { title: 'Quirky' } },
      upstreamEs: { app: { title: 'Quirky' } }
    })
    const trackedFiles = [
      path.join(upstreamLocales, 'en.json'),
      path.join(upstreamLocales, 'es.json')
    ]
    const before = snapshotFiles(trackedFiles)
    const otherFile = path.join(root, 'src/main/empty.ts')
    const otherFileContentBefore = readFileSync(otherFile, 'utf8')

    let seenEnglish
    let seenSpanish
    let seenOther
    const result = await runUpstreamVerifierWithForkCatalogs(root, {}, async () => {
      seenEnglish = JSON.parse(await fs.readFile(trackedFiles[0], 'utf8'))
      seenSpanish = JSON.parse(await fs.readFile(trackedFiles[1], 'utf8'))
      seenOther = await fs.readFile(otherFile, 'utf8')
      return 0
    })

    expect(result).toBe(0)
    expect(seenEnglish).toEqual({
      app: { title: 'Quirky' },
      components: { chat: { label: 'Chat {{name}}' } }
    })
    expect(seenSpanish).toEqual({
      app: { title: 'Quirky' },
      components: { chat: { label: 'Chat {{name}}' } }
    })
    expect(seenOther).toBe(otherFileContentBefore)
    expect(snapshotFiles(trackedFiles)).toEqual(before)
  })

  it('detects a fork key missing from the merged English catalog with the onlyEnglish overlay', async () => {
    const { root, upstreamLocales } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } }
    })
    const enPath = path.join(upstreamLocales, 'en.json')

    const result = await runUpstreamVerifierWithForkCatalogs(
      root,
      {},
      async () => {
        const merged = JSON.parse(await fs.readFile(enPath, 'utf8'))
        return merged?.components?.chat?.missing === undefined ? 1 : 0
      },
      { onlyEnglish: true }
    )

    expect(result).toBe(1)
  })

  it('restores the original readFile after verify resolves or throws', async () => {
    const { root } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } }
    })
    const originalReadFile = fs.readFile

    await expect(runUpstreamVerifierWithForkCatalogs(root, {}, async () => 1)).resolves.toBe(1)
    expect(fs.readFile).toBe(originalReadFile)

    await expect(
      runUpstreamVerifierWithForkCatalogs(root, {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(fs.readFile).toBe(originalReadFile)
  })
})
