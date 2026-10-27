import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkExternalTarget, openExternal, shellEscapePaths } from '../src/open-external'

describe('checkExternalTarget', () => {
  test.each(['https://example.com/x?y=1#z', 'http://localhost:3000', 'mailto:me@example.com', '/tmp/w/api/src/app.ts', '/tmp/w/api/a b.txt'])('allows %p', (target) => {
    expect(checkExternalTarget(target)).toBeNull()
  })

  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'ftp://example.com/file',
    'vscode://open',
    'src/app.ts',
    './app.ts',
    '~/notes',
    '-R',
    '--help',
    '',
    'https://exa\nmple.com',
    '/tmp/a\u0000b'
  ])('refuses %p', (target) => {
    expect(typeof checkExternalTarget(target)).toBe('string')
  })

  test('refuses non-strings', () => {
    expect(checkExternalTarget(undefined)).toBe('target must be a non-empty string')
    expect(checkExternalTarget(42)).toBe('target must be a non-empty string')
  })

  test('says what is allowed', () => {
    expect(checkExternalTarget('src/app.ts')).toBe('target must be an http, https or mailto URL or an absolute path')
    expect(checkExternalTarget('file:///x')).toBe('only http, https and mailto links can be opened')
  })
})

describe('openExternal in log mode', () => {
  let dir: string
  let log: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qoe-'))
    log = join(dir, 'open.log')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const lines = () => readFileSync(log, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))

  test('SC-41: appends one JSON line per call instead of opening anything', () => {
    const env = { QUIRKY_TEST_OPEN_LOG: log }
    openExternal({ target: 'https://example.com/docs' }, env)
    openExternal({ target: '/tmp/w/api/src/app.ts', reveal: true }, env)
    openExternal({ target: '/tmp/w/api/src/app.ts', reveal: false }, env)
    expect(lines()).toEqual([
      { target: 'https://example.com/docs', reveal: false },
      { target: '/tmp/w/api/src/app.ts', reveal: true },
      { target: '/tmp/w/api/src/app.ts', reveal: false }
    ])
  })

  test('a refused target throws and logs nothing', () => {
    const env = { QUIRKY_TEST_OPEN_LOG: log }
    expect(() => openExternal({ target: 'file:///etc/passwd' }, env)).toThrow('only http, https and mailto links can be opened')
    expect(() => openExternal({ target: 'relative/path' }, env)).toThrow()
    expect(existsSync(log)).toBe(false)
  })
})

describe('shellEscapePaths', () => {
  test('SC-38: quotes a path with a space and leaves a plain one bare', () => {
    expect(shellEscapePaths(['/tmp/w/api/a b.txt', '/tmp/w/api/c.txt'])).toBe("'/tmp/w/api/a b.txt' /tmp/w/api/c.txt")
  })

  test('quotes every character outside [A-Za-z0-9_./-]', () => {
    expect(shellEscapePaths(['/tmp/$HOME', '/tmp/a;b', '/tmp/a&b', '/tmp/é', '/tmp/a*b', '/tmp/a\nb'])).toBe(
      "'/tmp/$HOME' '/tmp/a;b' '/tmp/a&b' '/tmp/é' '/tmp/a*b' '/tmp/a\nb'"
    )
    expect(shellEscapePaths(['/a_b-c.d/e'])).toBe('/a_b-c.d/e')
  })

  test('an embedded single quote is closed, escaped and reopened', () => {
    expect(shellEscapePaths(["/tmp/it's"])).toBe("'/tmp/it'\\''s'")
  })

  test('no paths, and an empty path', () => {
    expect(shellEscapePaths([])).toBe('')
    expect(shellEscapePaths([''])).toBe("''")
  })
})
