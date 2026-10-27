import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Harness } from '../helpers'
import { startHarness } from '../helpers'

let harness: Harness | undefined
let home: string | undefined

afterEach(async () => {
  for (const client of harness?.clients ?? []) client.close()
  await harness?.daemon.stop()
  harness?.pty.stop()
  harness = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('PluginContext.workerEntrypoint', () => {
  test('resolves only a declared worker relative to the active plugin directory', async () => {
    home = mkdtempSync(join(tmpdir(), 'worker-context-'))
    const plugins = join(home, 'plugins')
    const pluginDir = join(plugins, 'acme.worker')
    mkdirSync(pluginDir, { recursive: true })
    write(join(pluginDir, 'main.ts'), `export function activate(context) { context.provide('method:acme.worker/resolve', ({name}) => context.workerEntrypoint(name)) }`)
    write(join(pluginDir, 'src', 'scanner.ts'), 'export const ready = true')
    write(join(pluginDir, 'quirky-plugin.json'), JSON.stringify({
      id: 'acme.worker', name: 'Worker fixture', version: '1.0.0', main: 'main.ts',
      workers: { scanner: 'src/scanner.ts' },
      contributes: { method: [{ id: 'resolve', readOnly: true, params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, result: { type: 'string' } }] }
    }))

    harness = await startHarness({ home, builtinPluginsDir: plugins })
    const client = await harness.connect('cli')
    const entrypoint = (await client.callAny('acme.worker/resolve', { name: 'scanner' })) as string
    expect(entrypoint).toBe(pathToFileURL(join(pluginDir, 'src', 'scanner.ts')).href)
    await expect(client.callAny('acme.worker/resolve', { name: 'undeclared' })).rejects.toThrow(/undeclared worker/i)
  })
})
