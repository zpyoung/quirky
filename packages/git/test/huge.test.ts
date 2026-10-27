import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NotAllowedError } from '../src/conflicts'
import { HUGE_FOLDER_NAMES, appendIgnore, hugeFolders } from '../src/huge'
import { isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()

describe('hugeFolders', () => {
  test('lists the allowlisted directories that exist, in list order', async () => {
    const repo = makeRepo(scratch())
    for (const name of ['vendor', 'node_modules', 'src']) mkdirSync(join(repo, name))
    writeFileSync(join(repo, 'dist'), 'a file, not a folder\n')
    expect(await hugeFolders(repo)).toEqual(['node_modules', 'vendor'])
  })

  test('skips ignored folders', async () => {
    const repo = makeRepo(scratch())
    mkdirSync(join(repo, 'node_modules'))
    mkdirSync(join(repo, 'build'))
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    expect(await hugeFolders(repo)).toEqual(['build'])
  })

  test('is empty when none exist', async () => {
    expect(await hugeFolders(makeRepo(scratch()))).toEqual([])
  })
})

describe('appendIgnore', () => {
  test('creates .gitignore and makes the folder ignored', async () => {
    const repo = makeRepo(scratch())
    mkdirSync(join(repo, 'dist'))
    expect(await appendIgnore(repo, 'dist')).toEqual({ added: true })
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('dist/\n')
    expect(await hugeFolders(repo)).toEqual([])
  })

  test('adds a newline first when the file does not end in one', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, '.gitignore'), 'logs')
    await appendIgnore(repo, 'target')
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('logs\ntarget/\n')
  })

  test('appends directly when the file ends in a newline', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, '.gitignore'), 'logs\n')
    await appendIgnore(repo, 'build')
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('logs\nbuild/\n')
  })

  test('is idempotent', async () => {
    const repo = makeRepo(scratch())
    await appendIgnore(repo, 'vendor')
    expect(await appendIgnore(repo, 'vendor')).toEqual({ added: false })
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('vendor/\n')
  })

  test('refuses names outside the allowlist', async () => {
    const repo = makeRepo(scratch())
    for (const name of ['src', '../x', 'node_modules/foo', '']) {
      await expect(appendIgnore(repo, name)).rejects.toBeInstanceOf(NotAllowedError)
    }
  })

  test('refuses a .gitignore symlink and leaves its target untouched', async () => {
    const repo = makeRepo(scratch())
    const folder = join(scratch(), 'outside')
    mkdirSync(folder, { recursive: true })
    const outside = join(folder, 'target')
    writeFileSync(outside, 'keep\n')
    symlinkSync(outside, join(repo, '.gitignore'))
    await expect(appendIgnore(repo, 'dist')).rejects.toBeInstanceOf(NotAllowedError)
    expect(readFileSync(outside, 'utf8')).toBe('keep\n')
    expect(lstatSync(join(repo, '.gitignore')).isSymbolicLink()).toBe(true)
  })

  test('refuses a dangling .gitignore symlink without creating its target', async () => {
    const repo = makeRepo(scratch())
    const folder = join(scratch(), 'outside')
    mkdirSync(folder, { recursive: true })
    const outside = join(folder, 'not-yet')
    symlinkSync(outside, join(repo, '.gitignore'))
    await expect(appendIgnore(repo, 'dist')).rejects.toBeInstanceOf(NotAllowedError)
    expect(existsSync(outside)).toBe(false)
  })

  test('refuses a .gitignore that is a directory', async () => {
    const repo = makeRepo(scratch())
    mkdirSync(join(repo, '.gitignore'))
    await expect(appendIgnore(repo, 'dist')).rejects.toBeInstanceOf(NotAllowedError)
  })

  test('keeps the file mode and leaves no temp files behind', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, '.gitignore'), 'logs\n', { mode: 0o640 })
    await appendIgnore(repo, 'dist')
    expect(lstatSync(join(repo, '.gitignore')).mode & 0o777).toBe(0o640)
    expect(readdirSync(repo).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('exports the allowlist in order', () => {
    expect([...HUGE_FOLDER_NAMES]).toEqual(['node_modules', '.next', 'dist', 'build', 'target', 'vendor'])
  })
})
