import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

const version: string = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

describe('SC-6: --version works without the daemon', () => {
  test('--version and -v print the package version and exit 0', async () => {
    for (const flag of ['--version', '-v']) {
      const result = await runCli([flag], { home: daemon.home })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`quirky ${version}\n`)
      expect(result.stderr).toBe('')
    }
  })

  test('--json prints one JSON document, before or after the flag', async () => {
    for (const args of [['--version', '--json'], ['--json', '-v']]) {
      const result = await runCli(args, { home: daemon.home })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ version })
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
    }
  })

  test('no connection is attempted, even to a running daemon', async () => {
    await runCli(['--version'], { home: daemon.home })
    await runCli(['-v', '--json'], { home: daemon.home })
    expect(daemon.connections).toBe(0)
    expect(daemon.calls).toEqual([])
  })

  test('no daemon is started when none is running', async () => {
    const home = realpathSync(mkdtempSync('/tmp/qcli-'))
    try {
      const result = await runCli(['--version'], {
        home,
        env: { QUIRKY_DAEMON_ENTRY: join(home, 'missing-entry.ts') }
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`quirky ${version}\n`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('-v next to another command is not the version switch', async () => {
    const result = await runCli(['status', '-v'], { home: daemon.home })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag -v')
    expect(daemon.calls).toEqual([])
  })
})
