import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, truncateSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { MAX_CARRIED_FILES, MAX_INCLUDE_BYTES, MAX_SHARED_DIRECTORIES, carryFiles } from '../src/daemon/carry'
import { makeProject } from './fixtures/repos'

const { scratch } = isolateGitConfig()
afterEach(() => {})

/** A primary with `.env*` and `cache/` ignored, and an empty directory to carry into. */
function setup(ignored = ['.env*', 'cache/', 'build/']) {
  const primary = makeProject(join(scratch(), 'primary'), { ignored })
  const target = join(scratch(), 'target')
  mkdirSync(target, { recursive: true })
  return { primary, target }
}

describe('carryFiles: symlinked destination ancestors', () => {
  test('an included file is not copied through a symlinked directory of the worktree', async () => {
    const { primary, target } = setup()
    mkdirSync(join(primary, 'cache'))
    writeFileSync(join(primary, 'cache', 'secret'), 's')
    writeFileSync(join(primary, '.worktreeinclude'), 'cache/\n')
    const outside = join(scratch(), 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(target, 'cache'))

    const warnings = await carryFiles(primary, target, [])
    expect(existsSync(join(outside, 'secret'))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cache/secret')
    expect(warnings[0]).toContain(join(target, 'cache'))
  })

  test('a shared directory is not linked through a symlinked directory of the worktree', async () => {
    const { primary, target } = setup()
    mkdirSync(join(primary, 'cache', 'deep'), { recursive: true })
    const outside = join(scratch(), 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(target, 'cache'))

    const warnings = await carryFiles(primary, target, ['cache/deep'])
    expect(existsSync(join(outside, 'deep'))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('symlink')
  })
})

describe('carryFiles: .worktreeinclude', () => {
  test('copies the ignored files its patterns match, keeps modes, and never overwrites', async () => {
    const { primary, target } = setup()
    writeFileSync(join(primary, '.env'), 'A=1\n')
    writeFileSync(join(primary, '.env.local'), 'B=2\n')
    chmodSync(join(primary, '.env.local'), 0o700)
    mkdirSync(join(primary, 'build', 'deep'), { recursive: true })
    writeFileSync(join(primary, 'build', 'deep', 'out.js'), 'x')
    writeFileSync(join(primary, 'untracked-not-ignored.txt'), 'u')
    writeFileSync(join(primary, '.worktreeinclude'), '.env*\nbuild/\nuntracked-not-ignored.txt\n')
    writeFileSync(join(target, '.env'), 'existing\n')

    expect(await carryFiles(primary, target, [])).toEqual([])
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('existing\n')
    expect(readFileSync(join(target, '.env.local'), 'utf8')).toBe('B=2\n')
    expect(statSync(join(target, '.env.local')).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(target, 'build', 'deep', 'out.js'), 'utf8')).toBe('x')
    expect(existsSync(join(target, 'untracked-not-ignored.txt'))).toBe(false)
  })

  test('without the file nothing is copied, and an include file over 256 KiB is refused with a warning', async () => {
    const { primary, target } = setup()
    writeFileSync(join(primary, '.env'), 'A=1\n')
    expect(await carryFiles(primary, target, [])).toEqual([])
    expect(existsSync(join(target, '.env'))).toBe(false)

    writeFileSync(join(primary, '.worktreeinclude'), `.env\n${'#'.repeat(MAX_INCLUDE_BYTES)}\n`)
    const warnings = await carryFiles(primary, target, [])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('larger than 256 KiB')
    expect(existsSync(join(target, '.env'))).toBe(false)
  })

  test('.git is never copied, a symlink is recreated as a symlink', async () => {
    const { primary, target } = setup(['.env*', 'cache/', '.git/'])
    writeFileSync(join(primary, '.env'), 'A=1\n')
    symlinkSync('.env', join(primary, '.env.link'))
    writeFileSync(join(primary, '.worktreeinclude'), '.git\n.git/\n.env*\n')
    await carryFiles(primary, target, [])
    expect(existsSync(join(target, '.git'))).toBe(false)
    expect(lstatSync(join(target, '.env.link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, '.env.link'))).toBe('.env')
  })

  test('at most 1000 files are copied, with a warning naming the count', async () => {
    const { primary, target } = setup()
    mkdirSync(join(primary, 'cache'))
    for (let i = 0; i < MAX_CARRIED_FILES + 5; i++) writeFileSync(join(primary, 'cache', `f${String(i).padStart(4, '0')}`), 'x')
    writeFileSync(join(primary, '.worktreeinclude'), 'cache/\n')
    const warnings = await carryFiles(primary, target, [])
    expect(warnings).toEqual([`.worktreeinclude matched ${MAX_CARRIED_FILES + 5} files; only the first ${MAX_CARRIED_FILES} were copied`])
    expect(existsSync(join(target, 'cache', 'f0999'))).toBe(true)
    expect(existsSync(join(target, 'cache', 'f1000'))).toBe(false)
  })

  test('a file over the 500 MiB budget stops the copying and the warning counts what was skipped', async () => {
    const { primary, target } = setup()
    mkdirSync(join(primary, 'cache'))
    writeFileSync(join(primary, 'cache', 'a-small'), 'x')
    writeFileSync(join(primary, 'cache', 'b-huge'), '')
    truncateSync(join(primary, 'cache', 'b-huge'), 600 * 1024 * 1024)
    writeFileSync(join(primary, 'cache', 'c-after'), 'x')
    writeFileSync(join(primary, '.worktreeinclude'), 'cache/\n')
    const warnings = await carryFiles(primary, target, [])
    expect(warnings).toEqual(['stopped copying at 500 MiB; 2 files were skipped'])
    expect(existsSync(join(target, 'cache', 'a-small'))).toBe(true)
    expect(existsSync(join(target, 'cache', 'b-huge'))).toBe(false)
    expect(existsSync(join(target, 'cache', 'c-after'))).toBe(false)
  })

  test('never throws: an unreadable primary is a warning', async () => {
    const warnings = await carryFiles(join(scratch(), 'nowhere'), join(scratch(), 'also-nowhere'), ['cache'])
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('carryFiles: shared directories', () => {
  test('an ignored existing directory is linked to the primary; every other entry is skipped with a reason', async () => {
    const { primary, target } = setup()
    mkdirSync(join(primary, 'cache'))
    mkdirSync(join(primary, 'docs'))
    const warnings = await carryFiles(primary, target, ['cache', 'docs', '../out', '/etc', '.git', 'missing', 'build/', ''])
    expect(readlinkSync(join(target, 'cache'))).toBe(join(primary, 'cache'))
    expect(warnings.map((warning) => warning.replace(/^shared directory "([^"]*)" was skipped: /, '$1: '))).toEqual([
      'docs: it is not ignored by git',
      '../out: it is outside the repository',
      '/etc: it is not a relative path',
      '.git: it is inside .git',
      `missing: it does not exist in ${primary}`,
      `build/: it does not exist in ${primary}`,
      ': it is not a relative path'
    ])
    expect(existsSync(join(target, 'docs'))).toBe(false)
  })

  test('a nested entry gets its parent folders, an existing destination is kept, and more than 100 entries are cut', async () => {
    const { primary, target } = setup(['a/b/', 'keep/'])
    mkdirSync(join(primary, 'a', 'b'), { recursive: true })
    mkdirSync(join(primary, 'keep'))
    mkdirSync(join(target, 'keep'))
    const entries = ['a/b', 'keep', ...Array.from({ length: MAX_SHARED_DIRECTORIES + 3 }, (_, i) => `n${i}`)]
    const warnings = await carryFiles(primary, target, entries)
    expect(readlinkSync(join(target, 'a', 'b'))).toBe(join(primary, 'a', 'b'))
    expect(lstatSync(join(target, 'keep')).isSymbolicLink()).toBe(false)
    expect(warnings.some((warning) => warning.includes('"keep" was skipped: it already exists in the worktree'))).toBe(true)
    expect(warnings.some((warning) => warning.includes(`lists ${entries.length} entries; only the first ${MAX_SHARED_DIRECTORIES}`))).toBe(true)
    expect(git(primary, 'status', '--porcelain')).toBe('')
  })
})
