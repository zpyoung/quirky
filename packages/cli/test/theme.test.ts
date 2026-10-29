import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const SOLAR = 'theme:acme.solar/solar'
const LUNAR = 'theme:acme.lunar/lunar'
const themeRow = (output: string, id: string) =>
  output.split('\n').find((line) => line.split(/\s+/, 1)[0] === id)

describe('theme list', () => {
  test('tracks active and chosen themes through set and list', async () => {
    daemon.addTheme('acme.solar', 'solar', { title: 'Solar' })
    daemon.addTheme('acme.lunar', 'lunar', { title: 'Lunar' })
    daemon.chooseTheme(SOLAR)

    const solarActive = await run(['theme', 'list'])
    const solarRow = themeRow(solarActive.stdout, SOLAR)
    const lunarRow = themeRow(solarActive.stdout, LUNAR)
    expect(solarRow?.split(/\s+/).includes('*')).toBe(true)
    expect(lunarRow).toBeDefined()
    expect(lunarRow?.split(/\s+/).includes('*')).toBe(false)

    const set = await run(['theme', 'set', LUNAR])
    expect(set.code).toBe(0)
    const lunarActive = await run(['theme', 'list'])
    const solarAfterSet = themeRow(lunarActive.stdout, SOLAR)
    const lunarAfterSet = themeRow(lunarActive.stdout, LUNAR)
    expect(solarAfterSet).toBeDefined()
    expect(solarAfterSet?.split(/\s+/).includes('*')).toBe(false)
    expect(lunarAfterSet?.split(/\s+/).includes('*')).toBe(true)

    daemon.ui.theme = { chosen: SOLAR, active: LUNAR }
    const inactiveChosen = await run(['theme', 'list'])
    const solarChosen = themeRow(inactiveChosen.stdout, SOLAR)
    const lunarChosen = themeRow(inactiveChosen.stdout, LUNAR)
    expect(solarChosen).toBeDefined()
    expect(solarChosen?.split(/\s+/).includes('(chosen)')).toBe(true)
    expect(solarChosen?.split(/\s+/).includes('*')).toBe(false)
    expect(lunarChosen?.split(/\s+/).includes('*')).toBe(true)

    const missing = 'theme:acme.ghost/ghost'
    daemon.ui.theme = { chosen: missing, active: LUNAR }
    const missingChosen = await run(['theme', 'list'])
    expect(themeRow(missingChosen.stdout, missing)).toBeUndefined()
    const missingLine = missingChosen.stdout.split('\n').find((line) => line.split(/\s+/).includes(missing))
    expect(missingLine).toBeDefined()
    expect(missingLine?.split(/\s+/).includes('*')).toBe(false)
    const activeLunar = themeRow(missingChosen.stdout, LUNAR)
    expect(activeLunar).toBeDefined()
    expect(activeLunar?.split(/\s+/).includes('*')).toBe(true)
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
