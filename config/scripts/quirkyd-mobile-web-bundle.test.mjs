import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QUIRKYD_MOBILE_WEB_MANIFEST } from '../../src/shared/quirkyd-artifacts.ts'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'
import {
  readQuirkydMobileWebAssetFilenames,
  stageQuirkydMobileWebBundle
} from './quirkyd-mobile-web-bundle.mjs'

let scratch
let bundleDir
let outputDir

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'quirkyd-mobile-web-'))
  bundleDir = join(scratch, 'mobile-web')
  outputDir = join(scratch, 'quirkyd')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

it('stages the manifest and every asset it lists, byte for byte', async () => {
  const { manifest } = await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  stageQuirkydMobileWebBundle(outputDir, bundleDir)

  const staged = readQuirkydMobileWebAssetFilenames(outputDir)
  expect(staged).toHaveLength(manifest.assets.length)
  for (const asset of manifest.assets) {
    expect(readFileSync(join(outputDir, 'out', 'mobile-web', asset.path))).toEqual(
      readFileSync(join(bundleDir, asset.path))
    )
  }
  expect(readFileSync(join(outputDir, QUIRKYD_MOBILE_WEB_MANIFEST))).toEqual(
    readFileSync(join(bundleDir, 'manifest.json'))
  )
})

it('stages a dark page into a dark quirkyd, and refuses it in any other', async () => {
  vi.stubEnv('QUIRKY_SIDEBAR_INPUTS', 'main')
  await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  stageQuirkydMobileWebBundle(outputDir, bundleDir)
  expect(existsSync(join(outputDir, QUIRKYD_MOBILE_WEB_MANIFEST))).toBe(true)

  vi.unstubAllEnvs()
  rmSync(outputDir, { recursive: true, force: true })
  expect(() => stageQuirkydMobileWebBundle(outputDir, bundleDir)).toThrow(
    'QUIRKY_SIDEBAR_INPUTS=main'
  )
  expect(existsSync(join(outputDir, QUIRKYD_MOBILE_WEB_MANIFEST))).toBe(false)
})

it('fails the build when the page was never built', () => {
  expect(() => stageQuirkydMobileWebBundle(outputDir, bundleDir)).toThrow('pnpm build:mobile-web')
  expect(existsSync(join(outputDir, QUIRKYD_MOBILE_WEB_MANIFEST))).toBe(false)
})

it('ships the page the qualification lanes tested in the release template', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const template = workflow.jobs.desktop_template
  expect(template.needs).toContain('mobile_web_bundle')
  expect(template.if).toContain("needs.mobile_web_bundle.result == 'success'")
  expect(template.steps.some((step) => step.with?.name === 'quirkyd-mobile-web-bundle')).toBe(true)
  expect(template.steps.some((step) => step.uses?.includes('build-mobile-web-bundle'))).toBe(false)
})
