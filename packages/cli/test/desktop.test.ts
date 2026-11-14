import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], options: { cwd?: string } = {}) =>
  runCli(args, { home: daemon.home, ...options })

describe('desktop pick-folder', () => {
  test('prints the chosen path and sends only the options it was given', async () => {
    daemon.results.set('desktop.folder.pick', { cancelled: false, paths: ['/Users/me/work'] })

    const result = await run(['desktop', 'pick-folder'])

    expect(result).toEqual({ code: 0, stdout: '/Users/me/work\n', stderr: '' })
    expect(daemon.methodCalls('desktop.folder.pick')).toEqual([{}])
  })

  test('passes every option and prints one path per line', async () => {
    daemon.results.set('desktop.folder.pick', { cancelled: false, paths: ['/a', '/b'] })

    const result = await run([
      'desktop', 'pick-folder', '--title', 'Pick a home', '--starting-folder', '/tmp', '--multiple'
    ])

    expect(result.stdout).toBe('/a\n/b\n')
    expect(daemon.methodCalls('desktop.folder.pick')).toEqual([
      { title: 'Pick a home', startingFolder: '/tmp', multiple: true }
    ])
  })

  test('resolves a relative starting folder against the working directory', async () => {
    const cwd = join(daemon.home, 'repo')
    mkdirSync(cwd)
    daemon.results.set('desktop.folder.pick', { cancelled: false, paths: ['/chosen'] })

    const result = await run(['desktop', 'pick-folder', '--starting-folder', 'sub'], { cwd })

    expect(result.code).toBe(0)
    expect(daemon.methodCalls('desktop.folder.pick')).toEqual([
      { startingFolder: join(cwd, 'sub') }
    ])
  })

  test('prints cancelled and exits 1 when the selection is cancelled', async () => {
    daemon.results.set('desktop.folder.pick', { cancelled: true, paths: [] })

    const result = await run(['desktop', 'pick-folder'])

    expect(result).toEqual({
      code: 1,
      stdout: 'cancelled\n',
      stderr: 'quirky: folder selection cancelled\n'
    })
  })

  test('--json prints the raw result for selected and cancelled folders', async () => {
    daemon.results.set('desktop.folder.pick', { cancelled: false, paths: ['/a'] })
    const selected = await run(['desktop', 'pick-folder', '--json'])
    expect(selected).toEqual({ code: 0, stdout: '{"cancelled":false,"paths":["/a"]}\n', stderr: '' })

    daemon.results.set('desktop.folder.pick', { cancelled: true, paths: [] })
    const cancelled = await run(['desktop', 'pick-folder', '--json'])
    expect(cancelled).toEqual({ code: 1, stdout: '{"cancelled":true,"paths":[]}\n', stderr: '' })
  })

  test('reports a conflict when no capable window supports folder selection', async () => {
    const message = 'no capable native desktop window supports directory selection'
    daemon.errors.set('desktop.folder.pick', { code: RpcErrorCode.Conflict, message })

    const plain = await run(['desktop', 'pick-folder'])
    expect(plain.code).toBe(1)
    expect(plain.stderr).toBe(`quirky: ${message}\n`)

    const json = await run(['desktop', 'pick-folder', '--json'])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout).error.code).toBe('conflict')
  })

  test('an extra argument is a usage error and does not call the picker', async () => {
    const result = await run(['desktop', 'pick-folder', 'extra'])

    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^quirky: unexpected argument "extra"/)
    expect(daemon.methodCalls('desktop.folder.pick')).toEqual([])
  })

  test('help lists the desktop folder picker command', async () => {
    const result = await run(['help', 'desktop'])

    expect(result.stdout).toContain('desktop pick-folder [--title <string>] [--starting-folder <string>] [--multiple]')
  })
})
