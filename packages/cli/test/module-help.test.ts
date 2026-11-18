import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const VIEW_MODULE = join(import.meta.dir, '..', '..', '..', 'plugins', 'quirky.view', 'cli.ts')

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addCliCommand({
    id: 'cli-command:quirky.view/view',
    plugin: 'quirky.view',
    words: 'view',
    summary: 'draw a view in your chat',
    module: VIEW_MODULE
  })
  daemon.addCliCommand({
    id: 'cli-command:quirky.view/view-wait',
    plugin: 'quirky.view',
    words: 'view wait',
    summary: 'wait for the user to act on a view',
    module: VIEW_MODULE
  })
})

afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })

test('quirky view --help prints the generated help followed by the component catalog', async () => {
  const result = await run(['view', '--help'])
  expect(result.code).toBe(0)
  expect(result.stdout).toStartWith('usage: quirky view\n')
  expect(result.stdout).toContain('global: --json prints machine-readable JSON')
  expect(result.stdout).toContain('quirky view open --spec @file.json')
  expect(result.stdout).toContain('Components')
})

test('help for another command of the same plugin carries no catalog', async () => {
  const result = await run(['view', 'wait', '--help'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('Components')
  expect(result.stdout).toEndWith('global: --json prints machine-readable JSON\n')
})

test('quirky help view reaches the same appended text', async () => {
  const result = await run(['help', 'view'])
  expect(result.stdout).toContain('Components')
})
