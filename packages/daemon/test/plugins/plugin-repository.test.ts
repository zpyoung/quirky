import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../helpers'

let harness: Harness | null = null
afterEach(async () => {
  await harness?.cleanup()
  harness = null
})

function installPlugin(home: string, manifest: { id: string } & Record<string, unknown>): void {
  const dir = join(home, 'plugins', manifest.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'quirky-plugin.json'),
    JSON.stringify({ apiVersion: '1.2.0', name: manifest.id, version: '1.0.0', ...manifest })
  )
}

test('plugin.list carries repository only for plugins whose manifest declares it', async () => {
  const home = makeTempHome('qrepo-')
  installPlugin(home, { id: 'acme.with-repo', repository: 'https://github.com/acme/with-repo' })
  installPlugin(home, { id: 'acme.without-repo' })
  harness = await startHarness({ home })
  const client = await harness.connect('cli')

  const listed = await client.call('plugin.list', {})
  const withRepo = listed.find((plugin) => plugin.id === 'acme.with-repo')!
  const withoutRepo = listed.find((plugin) => plugin.id === 'acme.without-repo')!

  expect(withRepo.repository).toBe('https://github.com/acme/with-repo')
  expect(withoutRepo.diagnostics).toEqual([])
  expect('repository' in withoutRepo).toBe(false)
}, 20_000)
