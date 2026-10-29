import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dropJsdomSyncXhrWorker, inlineJsdomStylesheet } from '../scripts/bundle-plugins'

// the editor plugin reaches jsdom through isomorphic-dompurify, so resolve it the same way
const editorRequire = createRequire(join(import.meta.dir, '..', '..', '..', 'plugins', 'quirky.editor', 'package.json'))
const jsdomRequire = createRequire(editorRequire.resolve('isomorphic-dompurify'))
const jsdomLib = join(dirname(jsdomRequire.resolve('jsdom')), 'jsdom')
const styleRules = join(jsdomLib, 'living', 'helpers', 'style-rules.js')
const xhrImpl = join(jsdomLib, 'living', 'xhr', 'XMLHttpRequest-impl.js')
const repoRoot = join(import.meta.dir, '..', '..', '..')

let out: string
beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'qbj-')) })
afterEach(() => rmSync(out, { recursive: true, force: true }))

async function bundle(plugins: Bun.BunPlugin[], entry = styleRules): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: out, naming: 'out.js', plugins, throw: false })
  expect(result.success).toBe(true)
  return readFileSync(join(out, 'out.js'), 'utf8')
}

test('a plain bundle reads the stylesheet from the build machine path', async () => {
  expect(await bundle([])).toContain('default-stylesheet.css')
})

test('the plugin inlines the stylesheet so the bundle reads nothing from disk', async () => {
  const bundled = await bundle([inlineJsdomStylesheet])
  expect(bundled).not.toContain('default-stylesheet.css')
  expect(bundled).toContain('display: block')
})

test('a plain bundle resolves the sync XHR worker from the build machine path', async () => {
  expect(await bundle([], xhrImpl)).toContain('xhr-sync-worker.js')
})

test('the plugin drops the sync XHR worker lookup so loading jsdom resolves nothing on disk', async () => {
  const bundled = await bundle([dropJsdomSyncXhrWorker], xhrImpl)
  expect(bundled).not.toContain('xhr-sync-worker.js')
})

test('the bundled editor plugin keeps no path from the build machine', async () => {
  const bundled = await bundle([inlineJsdomStylesheet, dropJsdomSyncXhrWorker], join(repoRoot, 'plugins', 'quirky.editor', 'main.ts'))
  expect(bundled).not.toContain(repoRoot)
}, 60_000)
