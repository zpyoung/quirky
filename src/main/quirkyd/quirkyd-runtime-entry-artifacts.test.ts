// Every separately built entry quirkyd starts by filename (a worker thread or a forked child) must
// ship in its slot: the bundle names it, the runtime looks for it beside quirkyd.js, and a missing
// file only shows up on a host as a feature that never starts.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { runProcessSync } from '@quirky/process-host'
import { quirkydArtifactFilenames } from '../../shared/quirkyd-artifacts'

const REPO_ROOT = join(__dirname, '..', '..', '..')
// The desktop's built entries follow this naming; quirkyd resolves them by these literal names.
const RUNTIME_ENTRY_FILENAME = /[A-Za-z0-9_.-]+-(?:entry|worker)\.c?js/g
/**
 * Named in quirkyd's bundle but not shipped yet. Each is a known gap, not an exemption: shipping
 * one removes it here, and this list may only shrink.
 */
const KNOWN_UNSHIPPED_ENTRIES = new Set(['wsl-transcript-fs-process-entry.js'])
const directory = mkdtempSync(join(tmpdir(), 'quirkyd-runtime-entries-'))

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** quirkyd.js and every child it ships, built as build-quirkyd.mjs builds them. */
function buildQuirkydBundles(): string[] {
  const builder = pathToFileURL(join(REPO_ROOT, 'config/scripts/quirkyd-entry-build.mjs')).href
  const script = `
    import { build } from 'esbuild'
    import { join } from 'node:path'
    import * as entries from ${JSON.stringify(builder)}
    const out = ${JSON.stringify(directory)}
    await entries.buildQuirkydEntry(join(out, 'quirkyd.js'))
    await Promise.all(Object.values(entries.QUIRKYD_CHILD_ENTRY_POINTS).map((entry) => build({
      entryPoints: [entry], bundle: true, platform: 'node', target: 'node18', format: 'cjs',
      outfile: join(out, entries.quirkydChildOutputFilename(entry)),
      external: entries.QUIRKYD_EXTERNAL_MODULES, plugins: [entries.externalNativeAddons],
      logLevel: 'error'
    })))`
  const built = runProcessSync({
    program: process.execPath,
    args: ['--input-type=module', '-e', script],
    cwd: REPO_ROOT,
    env: { ...process.env, QUIRKY_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 120_000
  })
  expect(built.code, built.stderr.slice(0, 2_000)).toBe(0)
  return readdirSync(directory).map((file) => readFileSync(join(directory, file), 'utf8'))
}

it('ships every worker and child entry quirkyd loads at runtime', () => {
  const named = new Set(
    buildQuirkydBundles().flatMap((text) => text.match(RUNTIME_ENTRY_FILENAME) ?? [])
  )
  const shipped = new Set(quirkydArtifactFilenames('linux-x64-glibc', []))
  const missing = [...named].filter(
    (filename) => !shipped.has(filename) && !KNOWN_UNSHIPPED_ENTRIES.has(filename)
  )
  expect(missing, 'add these to QUIRKYD_ARTIFACTS and build them in build-quirkyd.mjs').toEqual([])
  // A gap that ships, or that quirkyd stops naming, must leave the known list.
  for (const filename of KNOWN_UNSHIPPED_ENTRIES) {
    expect(named.has(filename) && !shipped.has(filename), filename).toBe(true)
  }
})

it('ships every child entry build-quirkyd.mjs builds', async () => {
  const builder = pathToFileURL(join(REPO_ROOT, 'config/scripts/quirkyd-entry-build.mjs')).href
  const entries = await import(builder)
  const shipped = new Set(quirkydArtifactFilenames('linux-x64-glibc', []))
  const built = Object.values<string>(entries.QUIRKYD_CHILD_ENTRY_POINTS).map((entry) =>
    entries.quirkydChildOutputFilename(entry)
  )
  expect(built).toContain('session-scanner-service-entry.js')
  expect(built.filter((filename) => !shipped.has(filename))).toEqual([])
})
