import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { NotAllowedError } from '../src/conflicts'
import { GitError } from '../src/index'
import {
  ChangedOnDiskError,
  IMAGE_MIME,
  MAX_BLOB_BYTES,
  MAX_RENDER_CHARACTERS,
  MAX_RENDER_LINES_PER_SIDE,
  contentHash,
  diffSource,
  saveWorkingFile
} from '../src/diffs'

const fixture = isolateGitConfig()

function commitAll(dir: string, files: Record<string, string | Uint8Array>, message = 'update'): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('constants and hashing', () => {
  test('limits and mime types', () => {
    expect(MAX_BLOB_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_RENDER_LINES_PER_SIDE).toBe(120_000)
    expect(MAX_RENDER_CHARACTERS).toBe(6_000_000)
    expect(IMAGE_MIME['.png']).toBe('image/png')
    expect(Object.keys(IMAGE_MIME).sort()).toEqual(['.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.svg', '.webp'])
  })

  test('contentHash is the sha-256 hex of the bytes', () => {
    expect(contentHash(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('diffSource sides', () => {
  /** SC-55: math.ts HEAD v1, index v2, disk v3; untracked notes.txt. */
  function threeVersions(): string {
    const dir = makeRepo(fixture.scratch(), { 'math.ts': 'v1\n' })
    writeFileSync(join(dir, 'math.ts'), 'v2\n')
    git(dir, 'add', 'math.ts')
    writeFileSync(join(dir, 'math.ts'), 'v3\n')
    writeFileSync(join(dir, 'notes.txt'), 'notes\n')
    return dir
  }

  test('SC-55: staged is HEAD to index, unstaged is index to disk', async () => {
    const dir = threeVersions()
    const staged = await diffSource(dir, { path: 'math.ts', source: 'staged' })
    expect(staged).toMatchObject({ path: 'math.ts', staged: true, source: 'staged', kind: 'text', binary: false, original: 'v1\n', modified: 'v2\n' })
    expect(staged.modifiedHash).toBeUndefined()
    const unstaged = await diffSource(dir, { path: 'math.ts', source: 'unstaged' })
    expect(unstaged).toMatchObject({ staged: false, source: 'unstaged', original: 'v2\n', modified: 'v3\n' })
    expect(unstaged.modifiedHash).toBe(contentHash(new TextEncoder().encode('v3\n')))
    expect(unstaged.modifiedDeleted).toBeUndefined()
  })

  test('an untracked file is empty to its content', async () => {
    const dir = threeVersions()
    const d = await diffSource(dir, { path: 'notes.txt', source: 'unstaged' })
    expect(d).toMatchObject({ original: '', modified: 'notes\n', kind: 'text' })
  })

  test('compareAgainstHead reads HEAD against the working file even with a newer staged index', async () => {
    const dir = threeVersions()
    const d = await diffSource(dir, { path: 'math.ts', source: 'unstaged', compareAgainstHead: true })
    expect(d).toMatchObject({ source: 'unstaged', staged: false, original: 'v1\n', modified: 'v3\n' })
    expect(d.modifiedHash).toBe(contentHash(new TextEncoder().encode('v3\n')))
  })

  test('compareAgainstHead rejects non-unstaged sources', async () => {
    const dir = threeVersions()
    await expect(diffSource(dir, { path: 'math.ts', source: 'staged', compareAgainstHead: true })).rejects.toThrow(
      'compareAgainstHead is only available for source unstaged.'
    )
    await expect(diffSource(dir, { path: 'math.ts', source: 'branch', compareAgainstHead: true, mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) })).rejects.toThrow(
      'compareAgainstHead is only available for source unstaged.'
    )
  })


  test('an unstaged file removed from the index falls back to HEAD', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'head\n' })
    git(dir, 'rm', '-q', '--cached', 'a.txt')
    const d = await diffSource(dir, { path: 'a.txt', source: 'unstaged' })
    expect(d).toMatchObject({ original: 'head\n', modified: 'head\n' })
  })

  test('a staged addition has an empty left side, also in a repo with no commits', async () => {
    const dir = fixture.scratch()
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'n.txt'), 'new\n')
    git(dir, 'add', 'n.txt')
    expect(await diffSource(dir, { path: 'n.txt', source: 'staged' })).toMatchObject({ original: '', modified: 'new\n' })
  })

  test('SC-56: a file deleted on disk has its index content left and is marked deleted', async () => {
    const dir = makeRepo(fixture.scratch(), { 'gone.ts': 'bye\n' })
    rmSync(join(dir, 'gone.ts'))
    const d = await diffSource(dir, { path: 'gone.ts', source: 'unstaged' })
    expect(d).toMatchObject({ original: 'bye\n', modified: '', modifiedDeleted: true, modifiedHash: null, kind: 'text' })
  })

  test('SC-55: branch reads merge base to head, with the old path for a rename', async () => {
    const dir = makeRepo(fixture.scratch(), { 'old.ts': 'a\nb\nc\nd\n' })
    const mergeBase = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'mv', 'old.ts', 'new.ts')
    writeFileSync(join(dir, 'util.ts'), 'util\n')
    writeFileSync(join(dir, 'new.ts'), 'a\nb\nc\nd\ne\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'work')
    const head = git(dir, 'rev-parse', 'HEAD')
    expect(await diffSource(dir, { path: 'util.ts', source: 'branch', mergeBase, head })).toMatchObject({ original: '', modified: 'util\n', staged: false, source: 'branch' })
    const renamed = await diffSource(dir, { path: 'new.ts', source: 'branch', oldPath: 'old.ts', mergeBase, head })
    expect(renamed).toMatchObject({ original: 'a\nb\nc\nd\n', modified: 'a\nb\nc\nd\ne\n', oldPath: 'old.ts' })
    expect(renamed.modifiedHash).toBeUndefined()
  })

  test('SC-53: commit reads the parent to the commit, empty for a root', async () => {
    const dir = makeRepo(fixture.scratch(), { 'old.ts': 'x\ny\n' })
    const root = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'mv', 'old.ts', 'new.ts')
    git(dir, 'commit', '-q', '-am', 'rename')
    writeFileSync(join(dir, 'new.ts'), 'x\ny\nz\n')
    git(dir, 'commit', '-q', '-am', 'edit')
    const commit = git(dir, 'rev-parse', 'HEAD')
    const parent = git(dir, 'rev-parse', 'HEAD~1')
    expect(await diffSource(dir, { path: 'new.ts', source: 'commit', commit, parent })).toMatchObject({ original: 'x\ny\n', modified: 'x\ny\nz\n' })
    expect(await diffSource(dir, { path: 'new.ts', oldPath: 'old.ts', source: 'commit', commit: parent, parent: root })).toMatchObject({ original: 'x\ny\n', modified: 'x\ny\n', oldPath: 'old.ts' })
    expect(await diffSource(dir, { path: 'old.ts', source: 'commit', commit: root, parent: null })).toMatchObject({ original: '', modified: 'x\ny\n' })
  })

  test('commit ids must be 40-hex', async () => {
    const dir = makeRepo(fixture.scratch())
    const head = git(dir, 'rev-parse', 'HEAD')
    for (const bad of ['HEAD', '--output=/tmp/x', head.slice(0, 12), `${head}:a.txt`, '']) {
      await expect(diffSource(dir, { path: 'a.txt', source: 'commit', commit: bad, parent: null })).rejects.toThrow('Invalid commit id')
      await expect(diffSource(dir, { path: 'a.txt', source: 'branch', mergeBase: bad, head })).rejects.toThrow('Invalid commit id')
      await expect(diffSource(dir, { path: 'a.txt', source: 'branch', mergeBase: head, head: bad })).rejects.toBeInstanceOf(GitError)
    }
    await expect(diffSource(dir, { path: 'a.txt', source: 'commit', commit: head, parent: 'HEAD~1' })).rejects.toThrow('Invalid commit id')
    await expect(diffSource(dir, { path: 'a.txt', source: 'branch' })).rejects.toThrow('Invalid commit id')
  })
})

describe('diffSource kinds', () => {
  test('SC-56: an image has base64 sides and a mime type', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    commitAll(dir, { 'logo.png': PNG_A })
    writeFileSync(join(dir, 'logo.png'), PNG_B)
    const d = await diffSource(dir, { path: 'logo.png', source: 'unstaged' })
    expect(d).toMatchObject({ kind: 'image', binary: true, mime: 'image/png', original: b64(PNG_A), modified: b64(PNG_B) })
  })

  test('an image with a missing side has an empty string there', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    writeFileSync(join(dir, 'pic.SVG'), '<svg/>')
    const d = await diffSource(dir, { path: 'pic.SVG', source: 'unstaged' })
    expect(d).toMatchObject({ kind: 'image', mime: 'image/svg+xml', original: '', modified: b64(new TextEncoder().encode('<svg/>')) })
  })

  test('SC-56: NUL bytes make a binary diff with empty bodies', async () => {
    const dir = makeRepo(fixture.scratch(), { 'blob.bin': 'plain\n' })
    writeFileSync(join(dir, 'blob.bin'), Uint8Array.from([1, 0, 2]))
    const d = await diffSource(dir, { path: 'blob.bin', source: 'unstaged' })
    expect(d).toMatchObject({ kind: 'binary', binary: true, original: '', modified: '' })
    expect(d.mime).toBeUndefined()
    expect(d.modifiedHash).toBe(contentHash(Uint8Array.from([1, 0, 2])))
  })

  test('SC-56: a side over 10 MiB is binary, whether read from git or from disk', async () => {
    const dir = makeRepo(fixture.scratch(), { 'huge.json': '{}\n' })
    const big = Buffer.alloc(MAX_BLOB_BYTES + 1, 0x61)
    commitAll(dir, { 'huge.json': big })
    writeFileSync(join(dir, 'huge.json'), 'small\n')
    expect(await diffSource(dir, { path: 'huge.json', source: 'staged' })).toMatchObject({ kind: 'binary', binary: true, original: '', modified: '' })
    const unstaged = await diffSource(dir, { path: 'huge.json', source: 'unstaged' })
    expect(unstaged).toMatchObject({ kind: 'binary', original: '', modified: '' })
    writeFileSync(join(dir, 'huge.json'), big)
    const disk = await diffSource(dir, { path: 'huge.json', source: 'unstaged' })
    expect(disk).toMatchObject({ kind: 'binary', modified: '' })
    expect(disk.modifiedHash).toBe(contentHash(big))
  })

  test('SC-56: 130,000 changed lines is text with empty bodies and a too-large marker', async () => {
    const lines = (tag: string) => Array.from({ length: 130_000 }, (_, i) => `${tag}${i % 10}\n`).join('')
    const dir = makeRepo(fixture.scratch(), { 'big.txt': lines('a') })
    writeFileSync(join(dir, 'big.txt'), lines('b'))
    const d = await diffSource(dir, { path: 'big.txt', source: 'unstaged' })
    expect(d.kind).toBe('text')
    expect(d.binary).toBe(false)
    expect(d).toMatchObject({ original: '', modified: '' })
    expect(d.tooLarge).toEqual({ originalLines: 130_000, modifiedLines: 130_000, characters: 2 * 130_000 * 3, reason: 'lines' })
  })

  test('over 6,000,000 characters is too large with reason characters', async () => {
    const long = (c: string) => `${c.repeat(3_100_000)}\n`
    const dir = makeRepo(fixture.scratch(), { 'wide.txt': long('a') })
    writeFileSync(join(dir, 'wide.txt'), long('b'))
    const d = await diffSource(dir, { path: 'wide.txt', source: 'unstaged' })
    expect(d.tooLarge).toMatchObject({ originalLines: 1, modifiedLines: 1, reason: 'characters' })
    expect(d.tooLarge!.characters).toBe(6_200_002)
    expect(d).toMatchObject({ original: '', modified: '' })
  })

  test('text at the limits still renders', async () => {
    const dir = makeRepo(fixture.scratch(), { 'ok.txt': 'a\n' })
    writeFileSync(join(dir, 'ok.txt'), 'b\n'.repeat(1000))
    const d = await diffSource(dir, { path: 'ok.txt', source: 'unstaged' })
    expect(d.tooLarge).toBeUndefined()
    expect(d.modified).toHaveLength(2000)
  })
})

describe('diffSource failures', () => {
  test('SC-57: a branch diff against an unreadable merge base throws git\'s message', async () => {
    const dir = makeRepo(fixture.scratch(), { 'math.ts': 'v1\n' })
    const head = commitAll(dir, { 'math.ts': 'v2\n' })
    const bogus = 'a'.repeat(40)
    const err = await diffSource(dir, { path: 'math.ts', source: 'branch', mergeBase: bogus, head }).catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).message).toContain(bogus)
    await expect(diffSource(dir, { path: 'math.ts', source: 'commit', commit: head, parent: bogus })).rejects.toBeInstanceOf(GitError)
  })

  test('a path missing at a real commit is an empty side, not an error', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\n' })
    const head = git(dir, 'rev-parse', 'HEAD')
    const d = await diffSource(dir, { path: 'nope.txt', source: 'branch', mergeBase: head, head })
    expect(d).toMatchObject({ original: '', modified: '', kind: 'text' })
  })
})

describe('diffSource symlinks', () => {
  test('SC-67: the working side of a symlink is its target text, never the target file', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    const outside = join(fixture.scratch(), 'secret.txt')
    mkdirSync(join(outside, '..'), { recursive: true })
    writeFileSync(outside, 'TOP SECRET\n')
    symlinkSync(outside, join(dir, 'link.txt'))
    const d = await diffSource(dir, { path: 'link.txt', source: 'unstaged' })
    expect(d.modified).toBe(outside)
    expect(d.original).toBe('')
    expect(JSON.stringify(d)).not.toContain('TOP SECRET')
    expect(d.modifiedDeleted).toBeUndefined()
  })

  test('a committed symlink reads as its target text on both sides', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    symlinkSync('/tmp/s/secret.txt', join(dir, 'link.txt'))
    git(dir, 'add', 'link.txt')
    const staged = await diffSource(dir, { path: 'link.txt', source: 'staged' })
    expect(staged).toMatchObject({ original: '', modified: '/tmp/s/secret.txt' })
    const unstaged = await diffSource(dir, { path: 'link.txt', source: 'unstaged' })
    expect(unstaged).toMatchObject({ original: '/tmp/s/secret.txt', modified: '/tmp/s/secret.txt' })
  })

  test('a dangling symlink is not reported as deleted', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    symlinkSync('missing-target', join(dir, 'dangling'))
    const d = await diffSource(dir, { path: 'dangling', source: 'unstaged' })
    expect(d.modified).toBe('missing-target')
    expect(d.modifiedDeleted).toBeUndefined()
  })
})

describe('saveWorkingFile', () => {
  test('writes the content and returns its hash', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\n' })
    const result = await saveWorkingFile(dir, 'a.txt', 'two\n')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
    expect(result.hash).toBe(contentHash(new TextEncoder().encode('two\n')))
    expect(readdirSync(dir).filter((n) => n.includes('tmp'))).toEqual([])
  })

  test('a matching precondition saves, a stale one throws and leaves the file alone', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\n' })
    const one = contentHash(new TextEncoder().encode('one\n'))
    await saveWorkingFile(dir, 'a.txt', 'two\n', one)
    await expect(saveWorkingFile(dir, 'a.txt', 'three\n', one)).rejects.toBeInstanceOf(ChangedOnDiskError)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
    expect(readdirSync(dir).filter((n) => n.includes('tmp'))).toEqual([])
  })

  test('expected null means the file must be missing', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\n' })
    await expect(saveWorkingFile(dir, 'a.txt', 'x', null)).rejects.toBeInstanceOf(ChangedOnDiskError)
    const created = await saveWorkingFile(dir, 'fresh.txt', 'new\n', null)
    expect(readFileSync(join(dir, 'fresh.txt'), 'utf8')).toBe('new\n')
    expect(created.hash).toBe(contentHash(new TextEncoder().encode('new\n')))
    await expect(saveWorkingFile(dir, 'missing2.txt', 'x', 'f'.repeat(64))).rejects.toBeInstanceOf(ChangedOnDiskError)
  })

  test('SC-67: a symlink leaf is refused and nothing outside is written', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    const outside = join(fixture.scratch(), 'secret.txt')
    mkdirSync(join(outside, '..'), { recursive: true })
    writeFileSync(outside, 'TOP SECRET\n')
    symlinkSync(outside, join(dir, 'link.txt'))
    await expect(saveWorkingFile(dir, 'link.txt', 'pwned')).rejects.toBeInstanceOf(NotAllowedError)
    await expect(saveWorkingFile(dir, 'link.txt', 'pwned', null)).rejects.toBeInstanceOf(NotAllowedError)
    expect(readFileSync(outside, 'utf8')).toBe('TOP SECRET\n')
    expect(lstatSync(join(dir, 'link.txt')).isSymbolicLink()).toBe(true)
  })

  test('the existing file mode is preserved', async () => {
    const dir = makeRepo(fixture.scratch(), { 'run.sh': '#!/bin/sh\n' })
    chmodSync(join(dir, 'run.sh'), 0o755)
    await saveWorkingFile(dir, 'run.sh', '#!/bin/sh\necho\n')
    expect(lstatSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755)
    chmodSync(join(dir, 'run.sh'), 0o600)
    await saveWorkingFile(dir, 'run.sh', 'x')
    expect(lstatSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o600)
  })
})
