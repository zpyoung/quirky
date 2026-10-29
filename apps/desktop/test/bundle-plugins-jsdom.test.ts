import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inlineJsdomStylesheet } from '../scripts/bundle-plugins'

// the editor plugin reaches jsdom through isomorphic-dompurify, so resolve it the same way
const editorRequire = createRequire(join(import.meta.dir, '..', '..', '..', 'plugins', 'quirky.editor', 'package.json'))
const jsdomRequire = createRequire(editorRequire.resolve('isomorphic-dompurify'))
const styleRules = join(dirname(jsdomRequire.resolve('jsdom')), 'jsdom', 'living', 'helpers', 'style-rules.js')

let out: string
beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'qbj-')) })
afterEach(() => rmSync(out, { recursive: true, force: true }))

async function bundle(plugins: Bun.BunPlugin[]): Promise<string> {
  const result = await Bun.build({ entrypoints: [styleRules], target: 'bun', outdir: out, naming: 'out.js', plugins, throw: false })
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
