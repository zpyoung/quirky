import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketPath } from '../src/node'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function longHome(tag: string): string {
  const base = mkdtempSync(join(tmpdir(), 'qsp-'))
  made.push(base)
  const home = join(base, `${tag}-${'x'.repeat(100)}`)
  mkdirSync(home, { recursive: true })
  return home
}

const uid = process.getuid!()

describe('socketPath', () => {
  test('SC-3: a short home keeps the socket beside runtime.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'qsp-'))
    made.push(home)
    expect(socketPath(home, 'quirkyd.sock')).toBe(join(home, 'quirkyd.sock'))
  })

  test('SC-3: a path of exactly 100 bytes stays, 101 moves', () => {
    const base = mkdtempSync(join(tmpdir(), 'qsp-'))
    made.push(base)
    const name = 'quirkyd.sock'
    const fill = (length: number) => {
      const home = join(base, 'h'.repeat(length - base.length - 1 - name.length - 1))
      mkdirSync(home, { recursive: true })
      return home
    }
    const at100 = fill(100)
    expect(Buffer.byteLength(join(at100, name))).toBe(100)
    expect(socketPath(at100, name)).toBe(join(at100, name))
    const at101 = fill(101)
    expect(Buffer.byteLength(join(at101, name))).toBe(101)
    expect(socketPath(at101, name)).toStartWith(`/tmp/quirky-${uid}/`)
  })

  test('SC-3: a long home maps into a private /tmp directory named by the home hash', () => {
    const home = longHome('a')
    const path = socketPath(home, 'quirkyd.sock')
    const digest = createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16)
    expect(path).toBe(`/tmp/quirky-${uid}/${digest}-quirkyd.sock`)
    expect(Buffer.byteLength(path)).toBeLessThan(104)
    const stats = statSync(`/tmp/quirky-${uid}`)
    expect(stats.isDirectory()).toBe(true)
    expect(stats.uid).toBe(uid)
    expect(stats.mode & 0o777).toBe(0o700)
  })

  test('SC-3: two long homes and two names get different paths', () => {
    const a = longHome('a')
    const b = longHome('b')
    expect(socketPath(a, 'quirkyd.sock')).not.toBe(socketPath(b, 'quirkyd.sock'))
    expect(socketPath(a, 'quirkyd.sock')).not.toBe(socketPath(a, 'pty.sock'))
  })

  test('a symlinked home hashes the same as its real path', () => {
    const home = longHome('a')
    const linkDir = mkdtempSync(join(tmpdir(), 'qsp-'))
    made.push(linkDir)
    const link = join(linkDir, 'l'.repeat(100))
    symlinkSync(home, link)
    expect(socketPath(link, 'pty.sock')).toBe(socketPath(home, 'pty.sock'))
  })
})
