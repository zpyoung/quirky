import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLUGIN_API_VERSION } from '@quirky/protocol'
import { checkKindEntry } from '../../src/plugins/kinds'
import { parseManifest } from '../../src/plugins/manifest'

describe('built-in long-poll deadlines', () => {
  test.each([
    ['quirky.agent-status', { wait: '75s', waitOutput: '75s' }],
    ['quirky.ask', { wait: '75s' }],
    ['quirky.mobile', { notificationPoll: '40s' }]
  ] as const)('%s declares deadlines beyond its polling budget', (id, deadlines) => {
    const dir = new URL(`../../../../plugins/${id}/`, import.meta.url).pathname
    const text = readFileSync(`${dir}quirky-plugin.json`, 'utf8')
    const manifest = JSON.parse(text)
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(parseManifest(text, { dirName: id, dir, source: 'builtin' }).ok).toBe(true)
    for (const [name, timeout] of Object.entries(deadlines)) {
      const entry = manifest.contributes.method.find((method: { id: string }) => method.id === name)
      expect(entry.timeout).toBe(timeout)
      const errors: string[] = []
      checkKindEntry('method', `method ${name}`, entry, errors)
      expect(errors).toEqual([])
    }
  })
})
