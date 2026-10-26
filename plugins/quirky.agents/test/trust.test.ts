import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TRUST_PRESETS } from '../src/core/types'
import { writeTrust } from '../src/trust'

let home: string
let area: string
let folder: string

beforeEach(() => {
  area = mkdtempSync('/tmp/a5t-')
  home = join(area, 'home')
  folder = join(area, 'wt-a')
  mkdirSync(home)
  mkdirSync(folder)
})
afterEach(() => {
  chmodSync(home, 0o755)
  rmSync(area, { recursive: true, force: true })
})

const real = () => realpathSync.native(folder)
const put = (path: string, text: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, mode === undefined ? undefined : { mode })
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.tmp'))

describe('claude', () => {
  const file = () => join(home, '.claude.json')

  test('sets hasTrustDialogAccepted for the folder and keeps every other key', () => {
    put(file(), JSON.stringify({ numStartups: 3, projects: { '/other': { allowedTools: ['x'] } } }))
    writeTrust('claude', folder, home)
    const config = json(file())
    expect(config.numStartups).toBe(3)
    expect(config.projects['/other']).toEqual({ allowedTools: ['x'] })
    expect(config.projects[real()]).toEqual({ hasTrustDialogAccepted: true })
  })

  test('keeps the fields of an existing untrusted entry', () => {
    put(file(), JSON.stringify({ projects: { [real()]: { hasTrustDialogAccepted: false, history: [1] } } }))
    writeTrust('claude', folder, home)
    expect(json(file()).projects[real()]).toEqual({ hasTrustDialogAccepted: true, history: [1] })
  })

  test('records both the given and the real path of a symlinked folder', () => {
    const link = join(area, 'link')
    symlinkSync(folder, link)
    put(file(), '{}')
    writeTrust('claude', link, home)
    const projects = json(file()).projects
    expect(projects[real()].hasTrustDialogAccepted).toBe(true)
    expect(projects[link].hasTrustDialogAccepted).toBe(true)
  })

  test('a second write leaves the file untouched', () => {
    put(file(), '{"a":1}')
    writeTrust('claude', folder, home)
    const first = readFileSync(file(), 'utf8')
    const inode = statSync(file()).ino
    writeTrust('claude', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(first)
    expect(statSync(file()).ino).toBe(inode)
  })

  test('creates a missing file owner-only', () => {
    writeTrust('claude', folder, home)
    expect(json(file()).projects[real()].hasTrustDialogAccepted).toBe(true)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test('keeps the mode of an existing file and leaves no temp file behind', () => {
    put(file(), '{}', 0o640)
    chmodSync(file(), 0o640)
    writeTrust('claude', folder, home)
    expect(statSync(file()).mode & 0o777).toBe(0o640)
    expect(leftovers(home)).toEqual([])
  })

  test('writes through a symlinked config and keeps the link', () => {
    const target = join(area, 'dotfiles', 'claude.json')
    put(target, '{"k":1}')
    symlinkSync(target, file())
    writeTrust('claude', folder, home)
    expect(json(target).k).toBe(1)
    expect(json(target).projects[real()].hasTrustDialogAccepted).toBe(true)
    expect(lstatSync(file()).isSymbolicLink()).toBe(true)
    expect(readFileSync(file(), 'utf8')).toBe(readFileSync(target, 'utf8'))
  })

  test('prefers the legacy .claude/.config.json when it exists', () => {
    const legacy = join(home, '.claude', '.config.json')
    put(legacy, '{}')
    writeTrust('claude', folder, home)
    expect(json(legacy).projects[real()].hasTrustDialogAccepted).toBe(true)
    expect(existsSync(file())).toBe(false)
  })

  test('SC-36: throws on a corrupt file and leaves it untouched', () => {
    put(file(), '{not json')
    expect(() => writeTrust('claude', folder, home)).toThrow()
    expect(readFileSync(file(), 'utf8')).toBe('{not json')
  })

  test('throws when projects is not an object', () => {
    put(file(), '{"projects":[1]}')
    expect(() => writeTrust('claude', folder, home)).toThrow()
    expect(readFileSync(file(), 'utf8')).toBe('{"projects":[1]}')
  })

  test('SC-36: throws when the target cannot be written', () => {
    chmodSync(home, 0o500)
    expect(() => writeTrust('claude', folder, home)).toThrow()
    expect(existsSync(file())).toBe(false)
  })

  test('SC-36: throws when the config path is not a file', () => {
    mkdirSync(file())
    expect(() => writeTrust('claude', folder, home)).toThrow()
  })
})

describe('cursor', () => {
  test('writes the workspace-trusted marker under a slug of the real path', () => {
    writeTrust('cursor', folder, home)
    const slug = real().replace(/^\/+/, '').replace(/\//g, '-')
    const marker = join(home, '.cursor', 'projects', slug, '.workspace-trusted')
    const payload = json(marker)
    expect(payload.workspacePath).toBe(real())
    expect(Number.isNaN(Date.parse(payload.trustedAt))).toBe(false)
  })

  test('a second write keeps the original trustedAt', () => {
    writeTrust('cursor', folder, home)
    const slug = real().replace(/^\/+/, '').replace(/\//g, '-')
    const marker = join(home, '.cursor', 'projects', slug, '.workspace-trusted')
    const first = readFileSync(marker, 'utf8')
    writeTrust('cursor', folder, home)
    expect(readFileSync(marker, 'utf8')).toBe(first)
  })

  test('throws when the marker cannot be written', () => {
    put(join(home, '.cursor'), 'a file where a directory belongs')
    expect(() => writeTrust('cursor', folder, home)).toThrow()
  })
})

describe('copilot', () => {
  const file = () => join(home, '.copilot', 'config.json')

  test('appends the folder to trustedFolders and keeps other keys', () => {
    put(file(), JSON.stringify({ loggedInUsers: ['u'], trustedFolders: ['/existing'] }))
    writeTrust('copilot', folder, home)
    expect(json(file())).toEqual({ loggedInUsers: ['u'], trustedFolders: ['/existing', real()] })
  })

  test('does not add a folder twice', () => {
    put(file(), JSON.stringify({ trustedFolders: [real()] }))
    const before = readFileSync(file(), 'utf8')
    writeTrust('copilot', folder, home)
    writeTrust('copilot', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  test('creates a missing config owner-only', () => {
    writeTrust('copilot', folder, home)
    expect(json(file()).trustedFolders).toEqual([real()])
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test('keeps an existing owner-only mode', () => {
    put(file(), '{"copilotTokens":{}}', 0o600)
    chmodSync(file(), 0o600)
    writeTrust('copilot', folder, home)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(leftovers(dirname(file()))).toEqual([])
  })

  test('throws on a corrupt config instead of overwriting it', () => {
    put(file(), 'oops')
    expect(() => writeTrust('copilot', folder, home)).toThrow()
    expect(readFileSync(file(), 'utf8')).toBe('oops')
  })
})

describe('antigravity', () => {
  const file = () => join(home, '.gemini', 'antigravity-cli', 'settings.json')

  test('appends the folder to trustedWorkspaces and keeps sibling keys', () => {
    put(file(), JSON.stringify({ model: 'm', permissions: { a: 1 }, trustedWorkspaces: ['/home/u'] }))
    writeTrust('antigravity', folder, home)
    expect(json(file())).toEqual({ model: 'm', permissions: { a: 1 }, trustedWorkspaces: ['/home/u', real()] })
  })

  test('creates the file and is idempotent', () => {
    writeTrust('antigravity', folder, home)
    writeTrust('antigravity', folder, home)
    expect(json(file()).trustedWorkspaces).toEqual([real()])
  })

  test('throws on a corrupt config', () => {
    put(file(), '[')
    expect(() => writeTrust('antigravity', folder, home)).toThrow()
  })
})

describe.each([
  ['qoder', '.qoder'],
  ['qoder-cn', '.qoder-cn']
] as const)('%s', (preset, dirName) => {
  const file = () => join(home, dirName, 'settings.json')

  test('adds the folder to permissions.trustDirectories and keeps other keys', () => {
    put(file(), JSON.stringify({ theme: 'dark', permissions: { allow: ['x'], trustDirectories: ['/old'] } }))
    writeTrust(preset, folder, home)
    expect(json(file())).toEqual({ theme: 'dark', permissions: { allow: ['x'], trustDirectories: ['/old', real()] } })
  })

  test('creates the file and is idempotent', () => {
    writeTrust(preset, folder, home)
    writeTrust(preset, folder, home)
    expect(json(file()).permissions.trustDirectories).toEqual([real()])
  })

  test('throws when permissions has the wrong shape', () => {
    put(file(), '{"permissions":{"trustDirectories":"x"}}')
    expect(() => writeTrust(preset, folder, home)).toThrow()
  })
})

describe('codex', () => {
  const file = () => join(home, '.codex', 'config.toml')
  const header = () => `[projects."${real()}"]`

  test('creates a trusted project table in an empty config', () => {
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`${header()}\ntrust_level = "trusted"\n`)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test('appends after unrelated content without changing it', () => {
    put(file(), 'model = "gpt"\n\n[mcp_servers.x]\ncommand = "y"\n')
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`model = "gpt"\n\n[mcp_servers.x]\ncommand = "y"\n\n${header()}\ntrust_level = "trusted"\n`)
  })

  test('rewrites an untrusted level in the existing table and keeps its other keys', () => {
    put(file(), `${header()}\ntrust_level = "untrusted"\nnote = 1\n\n[other]\na = 1\n`)
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`${header()}\ntrust_level = "trusted"\nnote = 1\n\n[other]\na = 1\n`)
  })

  test('adds trust_level to an existing table that lacks one', () => {
    put(file(), `${header()}\nnote = 1\n`)
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`${header()}\ntrust_level = "trusted"\nnote = 1\n`)
  })

  test('recognises other spellings of the same table and key', () => {
    put(file(), `["projects"."${real()}"]\n"trust_level" = 'untrusted'\n`)
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`["projects"."${real()}"]\ntrust_level = "trusted"\n`)
  })

  test('keeps CRLF line endings', () => {
    put(file(), `${header()}\r\ntrust_level = "untrusted"\r\n`)
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(`${header()}\r\ntrust_level = "trusted"\r\n`)
  })

  test('ignores a table header that sits inside a multiline string', () => {
    put(file(), `note = """\n${header()}\ntrust_level = "untrusted"\n"""\n`)
    writeTrust('codex', folder, home)
    const text = readFileSync(file(), 'utf8')
    expect(text.startsWith(`note = """\n${header()}\ntrust_level = "untrusted"\n"""\n`)).toBe(true)
    expect(text.endsWith(`\n${header()}\ntrust_level = "trusted"\n`)).toBe(true)
  })

  test('escapes quotes and backslashes in the path', () => {
    const odd = join(area, 'a"b\\c')
    mkdirSync(odd)
    writeTrust('codex', odd, home)
    const text = readFileSync(file(), 'utf8')
    expect(text).toContain('a\\"b\\\\c"]')
    writeTrust('codex', odd, home)
    expect(readFileSync(file(), 'utf8')).toBe(text)
  })

  test('a second write leaves the file untouched', () => {
    writeTrust('codex', folder, home)
    const first = readFileSync(file(), 'utf8')
    const inode = statSync(file()).ino
    writeTrust('codex', folder, home)
    expect(readFileSync(file(), 'utf8')).toBe(first)
    expect(statSync(file()).ino).toBe(inode)
    expect(leftovers(dirname(file()))).toEqual([])
  })

  test('does not read CODEX_HOME', () => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(area, 'elsewhere')
    try {
      writeTrust('codex', folder, home)
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
    expect(existsSync(file())).toBe(true)
    expect(existsSync(join(area, 'elsewhere'))).toBe(false)
  })

  test('SC-36: throws when the config cannot be written', () => {
    put(file(), '')
    chmodSync(dirname(file()), 0o500)
    try {
      expect(() => writeTrust('codex', folder, home)).toThrow()
    } finally {
      chmodSync(dirname(file()), 0o755)
    }
  })
})

describe('folders too broad to pre-trust', () => {
  test.each(['claude', 'copilot', 'qoder', 'qoder-cn'] as const)('%s writes nothing for the home or a folder above it', (preset) => {
    writeTrust(preset, home, home)
    writeTrust(preset, area, home)
    writeTrust(preset, '/', home)
    expect(readdirSync(home)).toEqual([])
  })

  test.each(['codex', 'cursor', 'antigravity'] as const)('%s trusts exactly the folder it is given', (preset) => {
    writeTrust(preset, home, home)
    expect(readdirSync(home).length).toBeGreaterThan(0)
  })
})

test('every preset writes under the given home only', () => {
  for (const preset of TRUST_PRESETS) writeTrust(preset, folder, home)
  expect(readdirSync(area).sort()).toEqual(['home', 'wt-a'])
  expect(readdirSync(home).sort()).toEqual(['.claude.json', '.codex', '.copilot', '.cursor', '.gemini', '.qoder', '.qoder-cn'])
})
