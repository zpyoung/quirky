import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detect, readLoginPath, searchDirs } from '../src/detect'
import type { AgentEntry } from '../src/core/types'

let root: string

beforeEach(() => {
  root = mkdtempSync('/tmp/a5d-')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const dir = (...parts: string[]) => {
  const path = join(root, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

const fake = (where: string, name: string, mode = 0o755) => {
  const path = join(where, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, mode)
  return path
}

const entry = (id: string, over: Partial<AgentEntry> = {}): AgentEntry =>
  ({
    id,
    plugin: 'test',
    label: id,
    detect: id,
    detectAliases: [],
    detectRequires: [],
    launch: id,
    process: id,
    ...over
  }) as AgentEntry

describe('searchDirs', () => {
  test('orders login PATH, quirky bin, then install directories with the home substituted', () => {
    const { dirs, loginDirs } = searchDirs({ loginPath: '/a:/b', fallbackPath: '/f', quirkyBin: '/q/bin', home: '/h' })
    expect(dirs).toEqual([
      '/a',
      '/b',
      '/q/bin',
      '/h/.local/bin',
      '/h/.bun/bin',
      '/h/.npm-global/bin',
      '/h/.cargo/bin',
      '/h/.deno/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ])
    expect([...loginDirs]).toEqual(['/a', '/b', '/q/bin'])
  })

  test('uses the fallback PATH when the login PATH is unavailable', () => {
    const { dirs, loginDirs } = searchDirs({ loginPath: null, fallbackPath: '/f1:/f2', quirkyBin: '/q', home: '/h', override: '' })
    expect(dirs).toEqual(['/f1', '/f2', '/q'])
    expect([...loginDirs]).toEqual(['/f1', '/f2', '/q'])
  })

  test('an override replaces the install directories; empty means none', () => {
    const withOverride = searchDirs({ loginPath: '/a', fallbackPath: '', quirkyBin: '/q', home: '/h', override: '/x:/y' })
    expect(withOverride.dirs).toEqual(['/a', '/q', '/x', '/y'])
    expect(withOverride.loginDirs.has('/x')).toBe(false)
    expect(searchDirs({ loginPath: '/a', fallbackPath: '', quirkyBin: '/q', home: '/h', override: '' }).dirs).toEqual(['/a', '/q'])
  })

  test('de-duplicates in order and drops empty entries', () => {
    const { dirs } = searchDirs({ loginPath: '/a::/b:/a', fallbackPath: '', quirkyBin: '/b', home: '/h', override: '/a:/c:' })
    expect(dirs).toEqual(['/a', '/b', '/c'])
  })
})

describe('detect', () => {
  test('SC-5: finds commands on the login PATH and in install directories, and runs nothing', () => {
    const login = dir('login')
    const local = dir('home', '.local', 'bin')
    const bun = dir('home', '.bun', 'bin')
    const ran = join(root, 'ran.log')
    for (const [where, name] of [[login, 'claude'], [local, 'qwen'], [bun, 'kimi-code']] as const) {
      const path = join(where, name)
      writeFileSync(path, `#!/bin/sh\necho ${name} >> ${ran}\n`)
      chmodSync(path, 0o755)
    }
    const d = detect(
      [entry('claude'), entry('qwen-code', { detect: 'qwen' }), entry('kimi', { detect: 'kimi', detectAliases: ['kimi-code'] }), entry('gemini')],
      searchDirs({ loginPath: login, fallbackPath: '', quirkyBin: dir('qbin'), home: join(root, 'home'), override: `${local}:${bun}` })
    )
    expect(d.installed('claude')).toBe(true)
    expect(d.installed('qwen-code')).toBe(true)
    expect(d.installed('kimi')).toBe(true)
    expect(d.installed('gemini')).toBe(false)
    expect(d.installed('unknown-id')).toBe(false)
    expect(Bun.file(ran).size).toBe(0)
    expect(d.locate('claude')).toEqual({ path: join(login, 'claude'), onLoginPath: true })
    expect(d.locate('qwen')).toEqual({ path: join(local, 'qwen'), onLoginPath: false })
  })

  test('SC-6: a required command and an alias decide installed', () => {
    const bin = dir('bin')
    fake(bin, 'dsh-tui')
    fake(bin, 'qodercn')
    fake(bin, 'claude')
    const entries = [
      entry('dsh', { detect: 'dsh-tui', detectRequires: ['dsh'] }),
      entry('qoder-cn', { detect: 'qoder-cn', detectAliases: ['qodercn'] }),
      entry('claude-agent-teams', { detect: 'claude' })
    ]
    const dirs = searchDirs({ loginPath: bin, fallbackPath: '', quirkyBin: dir('q'), home: root, override: '' })
    const d = detect(entries, dirs)
    expect(d.installed('dsh')).toBe(false)
    expect(d.installed('qoder-cn')).toBe(true)
    expect(d.installed('claude-agent-teams')).toBe(true)
    fake(bin, 'dsh')
    expect(detect(entries, dirs).installed('dsh')).toBe(true)
  })

  test('a file without an execute bit is not found', () => {
    const bin = dir('bin')
    fake(bin, 'plain', 0o644)
    const d = detect([entry('plain')], searchDirs({ loginPath: bin, fallbackPath: '', quirkyBin: dir('q'), home: root, override: '' }))
    expect(d.installed('plain')).toBe(false)
    expect(d.locate('plain')).toBeNull()
  })

  test('a directory with the command name is not found', () => {
    const bin = dir('bin')
    dir('bin', 'claude')
    const d = detect([entry('claude')], searchDirs({ loginPath: bin, fallbackPath: '', quirkyBin: dir('q'), home: root, override: '' }))
    expect(d.installed('claude')).toBe(false)
  })

  test('follows a symlink to an executable and skips a dangling one', () => {
    const target = fake(dir('real'), 'tool')
    const bin = dir('bin')
    symlinkSync(target, join(bin, 'tool'))
    symlinkSync(join(root, 'missing'), join(bin, 'ghost'))
    const d = detect([entry('tool'), entry('ghost')], searchDirs({ loginPath: bin, fallbackPath: '', quirkyBin: dir('q'), home: root, override: '' }))
    expect(d.installed('tool')).toBe(true)
    expect(d.installed('ghost')).toBe(false)
  })

  test('resolveExecutable returns a path only for commands found outside the login directories', () => {
    const login = dir('login')
    const qbin = dir('qbin')
    const local = dir('home', '.local', 'bin')
    fake(login, 'onpath')
    fake(qbin, 'shim')
    fake(local, 'installed')
    const d = detect([], searchDirs({ loginPath: login, fallbackPath: '', quirkyBin: qbin, home: join(root, 'home'), override: local }))
    expect(d.resolveExecutable('onpath')).toBeNull()
    expect(d.resolveExecutable('shim')).toBeNull()
    expect(d.resolveExecutable('installed')).toBe(join(local, 'installed'))
    expect(d.resolveExecutable('absent')).toBeNull()
  })

  test('the first directory in order wins when a command exists twice', () => {
    const first = dir('first')
    const second = dir('second')
    fake(first, 'dup')
    fake(second, 'dup')
    const d = detect([], searchDirs({ loginPath: `${first}:${second}`, fallbackPath: '', quirkyBin: dir('q'), home: root, override: '' }))
    expect(d.locate('dup')?.path).toBe(join(first, 'dup'))
  })
})

describe('readLoginPath', () => {
  const script = (name: string, body: string) => {
    const path = join(root, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('returns the PATH the shell prints, trimmed', async () => {
    const shell = script('shell-ok', 'printf "  /one:/two\\n"')
    expect(await readLoginPath(shell)).toBe('/one:/two')
  })

  test('passes -l -c and the printf command to the shell', async () => {
    const shell = script('shell-args', 'printf "%s|%s|%s" "$1" "$2" "$3"')
    expect(await readLoginPath(shell)).toBe('-l|-c|printf %s "$PATH"')
  })

  test('returns null for a non-zero exit, empty output, or a missing shell', async () => {
    expect(await readLoginPath(script('shell-fail', 'printf /x; exit 3'))).toBeNull()
    expect(await readLoginPath(script('shell-empty', 'printf ""'))).toBeNull()
    expect(await readLoginPath(join(root, 'no-such-shell'))).toBeNull()
  })

  test('returns null within the timeout when the shell hangs', async () => {
    const shell = script('shell-hang', 'exec sleep 30')
    const started = Date.now()
    expect(await readLoginPath(shell, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
