import { describe, expect, test } from 'bun:test'
import type { PluginSource } from '@quirky/protocol'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme', name: 'Acme', version: '1.0.0' }

function parse(manifest: unknown, source: PluginSource = 'installed') {
  return parseManifest(JSON.stringify(manifest), { dirName: 'acme', dir: '/plugins/acme', source })
}

describe('declared plugin workers', () => {
  test.each([
    [],
    { 'bad name': 'src/worker.ts' },
    { scanner: '/tmp/worker.ts' },
    { scanner: '../worker.ts' },
    { scanner: 'src/\ud800.ts' }
  ])('rejects malformed or escaping worker declarations: %j', (workers) => {
    expect(parse({ ...base, workers }).ok).toBe(false)
  })
})
