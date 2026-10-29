import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDaemon, ensureHome, openPrivateLog } from '../src/node'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qp-node-'))
  dirs.push(dir)
  return dir
}

const modeOf = (path: string) => statSync(path).mode & 0o777

describe('ensureHome', () => {
  test('creates the home private', () => {
    const home = join(tempDir(), 'home')
    ensureHome(home)
    expect(modeOf(home)).toBe(0o700)
  })

  test('tightens an existing home with loose permissions', () => {
    const home = tempDir()
    chmodSync(home, 0o755)
    ensureHome(home)
    expect(modeOf(home)).toBe(0o700)
  })

  test.skipIf(process.getuid?.() === 0)('refuses a home owned by someone else', () => {
    expect(() => ensureHome('/usr')).toThrow(/not owned by the current user/)
  })
})

describe('openPrivateLog', () => {
  test('creates the log 0600 inside a 0700 logs directory', () => {
    const path = join(tempDir(), 'logs', 'daemon.log')
    closeSync(openPrivateLog(path))
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(join(path, '..'))).toBe(0o700)
  })

  test('tightens a log that already exists', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'logs'), { mode: 0o755 })
    const path = join(dir, 'logs', 'daemon.log')
    writeFileSync(path, 'old\n', { mode: 0o644 })
    chmodSync(path, 0o644)
    closeSync(openPrivateLog(path))
    expect(modeOf(path)).toBe(0o600)
    expect(modeOf(join(dir, 'logs'))).toBe(0o700)
  })
})

describe('ensureDaemon', () => {
  test('keeps the daemon log private even when it already exists loosely', async () => {
    const home = tempDir()
    chmodSync(home, 0o755)
    mkdirSync(join(home, 'logs'))
    const log = join(home, 'logs', 'daemon.log')
    writeFileSync(log, '', { mode: 0o644 })
    chmodSync(log, 0o644)
    const entry = join(home, 'noop.ts')
    writeFileSync(entry, 'process.exit(0)\n')
    await expect(ensureDaemon({ home, daemonEntry: entry, timeoutMs: 300 })).rejects.toThrow()
    expect(modeOf(home)).toBe(0o700)
    expect(modeOf(log)).toBe(0o600)
  })

  test('starts the daemon in the home, not the caller directory', async () => {
    const home = tempDir()
    const marker = join(home, 'cwd.txt')
    const entry = join(home, 'record-cwd.ts')
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())\n`)
    await expect(ensureDaemon({ home, daemonEntry: entry, timeoutMs: 300 })).rejects.toThrow()
    expect(existsSync(marker)).toBe(true)
    expect(realpathSync(readFileSync(marker, 'utf8'))).toBe(realpathSync(home))
  })
})
