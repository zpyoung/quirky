import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeSessionScannerService } from './session-scanner-service-smoke.mjs'
import {
  externalNativeAddons,
  QUIRKYD_CHILD_ENTRY_POINTS,
  QUIRKYD_EXTERNAL_MODULES,
  quirkydChildOutputFilename
} from './quirkyd-entry-build.mjs'

const ENTRY = quirkydChildOutputFilename(QUIRKYD_CHILD_ENTRY_POINTS.sessionScanner)
const directories = []
let builtDirectory

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-session-scanner-smoke-test-'))
  directories.push(directory)
  return directory
}

beforeAll(async () => {
  builtDirectory = fixtureDirectory()
  await build({
    entryPoints: [resolve(QUIRKYD_CHILD_ENTRY_POINTS.sessionScanner)],
    outfile: join(builtDirectory, ENTRY),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: QUIRKYD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    logLevel: 'silent'
  })
}, 60_000)

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('session scanner service build smoke', () => {
  it('lists a seeded session through the built entry', () => {
    expect(() => smokeSessionScannerService(builtDirectory)).not.toThrow()
  }, 60_000)

  it('fails when the entry is missing', () => {
    expect(() => smokeSessionScannerService(fixtureDirectory())).toThrow('smoke failed')
  })

  it('fails when the child answers without scanning', () => {
    const directory = fixtureDirectory()
    writeFileSync(
      join(directory, ENTRY),
      `process.on('message', (m) => {
        if (m.type === 'init') process.send({ type: 'ready', protocol: m.protocol, pid: process.pid })
        if (m.type === 'request') process.send({ type: 'result', id: m.id, operation: 'scan',
          value: { result: { sessions: [], issues: [] }, durationMs: 0 } })
      })`
    )
    expect(() => smokeSessionScannerService(directory)).toThrow('smoke failed')
  })
})
