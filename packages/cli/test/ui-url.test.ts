import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type ApiCatalog } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], options: { env?: Record<string, string> } = {}) =>
  runCli(args, { home: daemon.home, ...options })

describe('ui url', () => {
  test('prints the URL returned by ui.url alone', async () => {
    const url = 'http://127.0.0.1:43127/#token=secret%20token'
    daemon.results.set('ui.url', { url })

    const result = await run(['ui', 'url'])

    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: '' })
    expect(daemon.methodCalls('ui.url')).toEqual([{}])
    expect(daemon.methodCalls('ui.open')).toEqual([])
  })

  test('--json prints the ui.url result object', async () => {
    const resultValue = { url: 'http://127.0.0.1:43127/#token=secret%20token' }
    daemon.results.set('ui.url', resultValue)

    const result = await run(['ui', 'url', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(resultValue)
    expect(daemon.methodCalls('ui.url')).toEqual([{}])
    expect(daemon.methodCalls('ui.open')).toEqual([])
  })

  test('--open requests ui.open and prints its URL without launching the desktop app', async () => {
    const opened = { url: 'http://127.0.0.1:43127/#token=secret%20token', requested: true as const }
    const trap = mkdtempSync('/tmp/qcli-ui-open-trap-')
    const marker = join(trap, 'desktop-open-called')
    writeFileSync(join(trap, 'open'), '#!/bin/sh\nprintf called > "$QUIRKY_OPEN_TRACE"\nexit 0\n')
    chmodSync(join(trap, 'open'), 0o755)
    daemon.results.set('ui.open', opened)

    try {
      const result = await run(['ui', 'url', '--open'], { env: { PATH: trap, QUIRKY_OPEN_TRACE: marker } })

      expect(result).toEqual({ code: 0, stdout: `${opened.url}\n`, stderr: '' })
      expect(daemon.methodCalls('ui.open')).toEqual([{}])
      expect(daemon.methodCalls('ui.url')).toEqual([])
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(trap, { recursive: true, force: true })
    }
  })

  test('--open --json returns the distinct open result', async () => {
    const opened = { url: 'http://127.0.0.1:43127/#token=secret%20token', requested: true as const }
    daemon.results.set('ui.open', opened)

    const result = await run(['ui', 'url', '--open', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(opened)
    expect(daemon.methodCalls('ui.open')).toEqual([{}])
    expect(daemon.methodCalls('ui.url')).toEqual([])
  })

  test('help works without a daemon connection', async () => {
    const home = mkdtempSync('/tmp/qcli-ui-url-help-')

    try {
      const commandHelp = await runCli(['ui', 'url', '--help'], { home })
      const groupHelp = await runCli(['ui', '--help'], { home })

      expect(commandHelp.code).toBe(0)
      expect(commandHelp.stdout).toContain('usage: quirky ui url [--open]')
      expect(commandHelp.stdout).toContain('--open')
      expect(groupHelp.code).toBe(0)
      expect(groupHelp.stdout).toContain('ui url')
      expect(commandHelp.stderr).toBe('')
      expect(groupHelp.stderr).toBe('')
      expect(daemon.connections).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('surplus arguments and invalid flags are rejected before RPC', async () => {
    const surplus = await run(['ui', 'url', 'extra'])
    const unknownFlag = await run(['ui', 'url', '--not-a-url-option'])

    expect(surplus.code).toBe(2)
    expect(surplus.stderr).toContain('unexpected argument "extra"')
    expect(unknownFlag.code).toBe(2)
    expect(unknownFlag.stderr).toContain('unknown flag --not-a-url-option')
    expect(daemon.calls).toEqual([])
  })

  test('reports a missing browser UI without trying to open the desktop app', async () => {
    daemon.errors.set('ui.url', { code: RpcErrorCode.NotFound, message: 'browser UI is not built' })

    const result = await run(['ui', 'url'])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('browser UI is not built')
    expect(daemon.methodCalls('ui.url')).toEqual([{}])
    expect(daemon.methodCalls('desktop.open')).toEqual([])
    expect(daemon.methodCalls('desktop.folder.pick')).toEqual([])
  })

  test('does not fall back to the desktop app when the default-browser request fails', async () => {
    const trap = mkdtempSync('/tmp/qcli-ui-open-failure-trap-')
    const marker = join(trap, 'desktop-open-called')
    writeFileSync(join(trap, 'open'), '#!/bin/sh\nprintf called > "$QUIRKY_OPEN_TRACE"\nexit 0\n')
    chmodSync(join(trap, 'open'), 0o755)
    daemon.errors.set('ui.open', {
      code: RpcErrorCode.Conflict,
      message: 'could not request the default browser'
    })

    try {
      const result = await run(['ui', 'url', '--open'], { env: { PATH: trap, QUIRKY_OPEN_TRACE: marker } })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('could not request the default browser')
      expect(result.stderr).not.toContain('secret%20token')
      expect(daemon.methodCalls('ui.open')).toEqual([{}])
      expect(daemon.methodCalls('ui.url')).toEqual([])
      expect(daemon.methodCalls('desktop.open')).toEqual([])
      expect(daemon.methodCalls('desktop.folder.pick')).toEqual([])
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(trap, { recursive: true, force: true })
    }
  })

  test('API metadata lists the command, its methods and its open flag', async () => {
    const result = await run(['api', '--json'])

    expect(result.code).toBe(0)
    const catalog = JSON.parse(result.stdout) as ApiCatalog
    expect(catalog.commands.find(({ command }) => command === 'ui url')).toMatchObject({
      methods: ['ui.url', 'ui.open'],
      flags: [{ name: 'open', type: 'boolean' }]
    })
  })
})
