import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const SOLAR = 'theme:acme.solar/solar'

describe('theme list', () => {
  test('marks the active theme with *', async () => {
    daemon.addTheme('acme.solar', 'solar', { title: 'Solar' })
    const result = await run(['theme', 'list'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0].split(/\s{2,}/)).toEqual(['ID', 'TITLE', 'APPEARANCE'])
    expect(lines[1].split(/\s{2,}/)).toEqual(['default', 'Quirky Dark', 'dark', '*'])
    expect(lines[2].split(/\s{2,}/)).toEqual([SOLAR, 'Solar', 'light'])
    expect(lines).toHaveLength(3)
    expect(daemon.methodCalls('theme.list')).toEqual([{}])
  })

  test('marks the active theme after a choice', async () => {
    daemon.addTheme('acme.solar', 'solar', { title: 'Solar' })
    daemon.chooseTheme(SOLAR)
    const lines = (await run(['theme', 'list'])).stdout.trimEnd().split('\n')
    expect(lines[1].split(/\s{2,}/)).toEqual(['default', 'Quirky Dark', 'dark'])
    expect(lines[2].split(/\s{2,}/)).toEqual([SOLAR, 'Solar', 'light', '*'])
  })

  test('marks a chosen theme that is not active with (chosen)', async () => {
    daemon.addTheme('acme.solar', 'solar', { title: 'Solar' })
    daemon.chooseTheme(SOLAR)
    daemon.ui.theme = { chosen: SOLAR, active: 'default' }
    const lines = (await run(['theme', 'list'])).stdout.trimEnd().split('\n')
    expect(lines[1].split(/\s{2,}/)).toEqual(['default', 'Quirky Dark', 'dark', '*'])
    expect(lines[2].split(/\s{2,}/)).toEqual([SOLAR, 'Solar', 'light', '(chosen)'])
  })

  test('--json prints the theme list', async () => {
    daemon.addTheme('acme.solar', 'solar')
    const result = await run(['theme', 'list', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ chosen: 'default', active: 'default', themes: daemon.ui.themes })
  })

  test('surplus arguments are a usage error', async () => {
    expect((await run(['theme', 'list', 'extra'])).code).toBe(2)
  })
})

describe('theme set', () => {
  test('prints the active theme ID', async () => {
    daemon.addTheme('acme.solar', 'solar')
    const result = await run(['theme', 'set', SOLAR])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${SOLAR}\n`)
    expect(daemon.methodCalls('theme.set')).toEqual([{ id: SOLAR }])
    expect((await run(['theme', 'set', 'default'])).stdout).toBe('default\n')
  })

  test('--json prints the theme list', async () => {
    daemon.addTheme('acme.solar', 'solar')
    const result = await run(['theme', 'set', SOLAR, '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ chosen: SOLAR, active: SOLAR, themes: daemon.ui.themes })
  })

  test('an unknown theme exits 1 with the daemon message and leaves the theme unchanged', async () => {
    const result = await run(['theme', 'set', 'theme:acme.ghost/x'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no theme theme:acme.ghost/x')
    expect(daemon.ui.theme).toEqual({ chosen: 'default', active: 'default' })
  })

  test('a missing id is a usage error', async () => {
    const result = await run(['theme', 'set'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing <id>')
    expect(daemon.methodCalls('theme.set')).toEqual([])
  })
})

describe('help', () => {
  test('lists the theme group', async () => {
    const result = await run(['theme', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('theme list')
    expect(result.stdout).toContain('theme set')
  })
})
