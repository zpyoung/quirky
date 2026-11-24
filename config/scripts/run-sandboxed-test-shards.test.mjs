import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  RELATED_SINGLE_CONTAINER_MAX,
  buildSelectionTar,
  laneCommand,
  laneEnvArgs,
  parseSelectMode,
  readSelectionList,
  resolveSelectionBuckets
} from './run-sandboxed-test-shards.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const workflow = (name) =>
  parse(readFileSync(resolve(projectDir, `.github/workflows/${name}.yml`), 'utf8'))

const unitShardEnv = workflow('unit-tests').jobs.test.steps.find(
  (step) => step.name === 'Test shard'
).env

describe('sandbox lane selection', () => {
  it('runs the shell contracts serially without stale spec paths', () => {
    const command = laneCommand({ lane: 'shell', extraArgs: [] }, 1)
    const shellSpecs = command.filter((arg) => arg.endsWith('.test.ts'))

    expect(shellSpecs.length).toBeGreaterThan(0)
    expect(command).toContain('--maxWorkers=1')
    expect(command.some((arg) => arg.startsWith('--shard='))).toBe(false)
    for (const spec of shellSpecs) {
      expect(existsSync(resolve(projectDir, spec)), spec).toBe(true)
    }
  })

  it('keeps the same shell contracts out of parallel shards as CI', () => {
    const command = laneCommand({ lane: 'unit', shardTotal: 16, extraArgs: [] }, 3)

    expect(unitShardEnv.QUIRKY_BALANCE_UNIT_SHARDS).toBe('1')
    expect(laneEnvArgs('unit')).toEqual(['--env', 'QUIRKY_BALANCE_UNIT_SHARDS=1'])
    expect(command.some((arg) => arg.startsWith('--exclude='))).toBe(false)
    expect(command).toContain('--shard=3/16')
  })

  it('leaves the default (no select) command a plain argv array with no shell wrapper', () => {
    const unit = laneCommand({ lane: 'unit', shardTotal: 16, extraArgs: ['--bail=1'] }, 5)
    expect(unit.slice(0, 6)).toEqual([
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'config/vitest.config.ts'
    ])
    expect(unit).toContain('--shard=5/16')
    expect(unit).toContain('--bail=1')
    expect(unit[0]).not.toBe('sh')

    const shell = laneCommand({ lane: 'shell', extraArgs: [] }, 1)
    expect(shell[0]).toBe('pnpm')
  })
})

describe('related and files selection modes', () => {
  it('builds a related-mode command that reads paths from the sandboxed selection file, not argv', () => {
    const command = laneCommand({ lane: 'unit', select: 'related', extraArgs: ['--bail=1'] }, null)

    expect(command[0]).toBe('sh')
    expect(command[2]).toContain('vitest')
    expect(command[2]).toContain('related')
    expect(command[2]).toContain('.quirky-sandbox/selection.txt')
    expect(command[2]).toContain('--run')
    expect(command[2]).toContain('--bail=1')
    expect(command[2]).not.toContain('--exclude=')
  })

  it('builds a files-mode command with "run", no "--run" flag, still reading the selection file', () => {
    const command = laneCommand({ lane: 'unit', select: 'files', extraArgs: [] }, null)

    expect(command[0]).toBe('sh')
    expect(command[2]).toContain('vitest')
    expect(command[2]).toContain('.quirky-sandbox/selection.txt')
    expect(command[2]).not.toContain("'--run'")
  })

  it('rejects an unknown --select value and a mismatched pairing with --files-from', () => {
    expect(() => parseSelectMode({ select: 'bogus', 'files-from': 'list.txt' })).toThrow(
      /related|files/
    )
    expect(() => parseSelectMode({ select: 'related' })).toThrow('--files-from')
    expect(() => parseSelectMode({ 'files-from': 'list.txt' })).toThrow('--select')
    expect(parseSelectMode({})).toEqual({ select: null, filesFrom: null })
    for (const lane of ['shell', 'e2e']) {
      expect(() => parseSelectMode({ lane, select: 'related', 'files-from': 'list.txt' })).toThrow(
        'unit lane'
      )
    }
    expect(parseSelectMode({ lane: 'unit', select: 'related', 'files-from': 'list.txt' })).toEqual({
      select: 'related',
      filesFrom: 'list.txt'
    })
    expect(parseSelectMode({ select: 'files', 'files-from': 'list.txt' })).toEqual({
      select: 'files',
      filesFrom: 'list.txt'
    })
  })

  describe('readSelectionList precondition', () => {
    const directories = []
    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('reads a newline-delimited, repo-relative selection file', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-'))
      directories.push(directory)
      const listPath = join(directory, 'selection.txt')
      writeFileSync(listPath, 'config/scripts/run-sandboxed-test-shards.mjs\n\npackage.json\n')

      expect(readSelectionList(listPath)).toEqual([
        'config/scripts/run-sandboxed-test-shards.mjs',
        'package.json'
      ])
    })

    it('rejects a missing list file, an absolute path entry, and a path escaping the project', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-'))
      directories.push(directory)

      expect(() => readSelectionList(join(directory, 'missing.txt'))).toThrow('not found')

      const absolutePath = join(directory, 'absolute.txt')
      writeFileSync(absolutePath, '/etc/passwd\n')
      expect(() => readSelectionList(absolutePath)).toThrow('repo-relative')

      const escapingPath = join(directory, 'escaping.txt')
      writeFileSync(escapingPath, '../outside.txt\n')
      expect(() => readSelectionList(escapingPath)).toThrow('escapes')
    })

    it('rejects an entry starting with "-" so it cannot be parsed as a vitest flag', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-'))
      directories.push(directory)
      const listPath = join(directory, 'flag-like.txt')
      writeFileSync(listPath, 'package.json\n--coverage\n')

      expect(() => readSelectionList(listPath)).toThrow('--coverage')
    })

    it('rejects an empty selection file (blank lines only) instead of selecting the whole suite', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-'))
      directories.push(directory)
      const listPath = join(directory, 'empty.txt')
      writeFileSync(listPath, '\n\n  \n')

      expect(() => readSelectionList(listPath)).toThrow('no paths')
    })

    it('exits 2 via fail() when the runner is invoked with an unreadable --files-from list', () => {
      const result = spawnSync(
        'node',
        [
          resolve(projectDir, 'config/scripts/run-sandboxed-test-shards.mjs'),
          '--select=related',
          '--files-from=/tmp/does-not-exist-quirky-selection.txt'
        ],
        { encoding: 'utf8' }
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('run-sandboxed-test-shards')
    })

    it('exits 2 via fail() for an empty --files-from list without reaching the Docker probe', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-'))
      directories.push(directory)
      const listPath = join(directory, 'empty.txt')
      writeFileSync(listPath, '\n')

      const result = spawnSync(
        'node',
        [
          resolve(projectDir, 'config/scripts/run-sandboxed-test-shards.mjs'),
          '--select=related',
          `--files-from=${listPath}`
        ],
        { encoding: 'utf8' }
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('run-sandboxed-test-shards')
      expect(result.stdout).not.toContain('Docker daemon')
    })
  })

  it('returns no buckets for an empty selection instead of one that runs unfiltered', () => {
    expect(resolveSelectionBuckets([], 3)).toEqual([])
  })

  it('splits a selection into buckets: at most RELATED_SINGLE_CONTAINER_MAX files run in one container', () => {
    const small = Array.from(
      { length: RELATED_SINGLE_CONTAINER_MAX },
      (_, i) => `src/f${i}.test.ts`
    )
    expect(resolveSelectionBuckets(small, 3)).toHaveLength(1)
    expect(resolveSelectionBuckets(small, 3)[0]).toHaveLength(RELATED_SINGLE_CONTAINER_MAX)
  })

  it('splits an oversized selection into up to 3 buckets, never more, preserving every path once', () => {
    const large = Array.from(
      { length: RELATED_SINGLE_CONTAINER_MAX + 1 },
      (_, i) => `src/f${i}.test.ts`
    )

    expect(resolveSelectionBuckets(large, 1)).toHaveLength(1)
    expect(resolveSelectionBuckets(large, 2)).toHaveLength(2)
    expect(resolveSelectionBuckets(large, 5)).toHaveLength(3)

    const buckets = resolveSelectionBuckets(large, 5)
    expect(buckets.flat().sort()).toEqual([...large].sort())
    expect(new Set(buckets.flat()).size).toBe(large.length)
  })

  describe('selection tar delivery', () => {
    const directories = []
    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('places the selection list inside the tar at .quirky-sandbox/selection.txt, not in argv', () => {
      const directory = mkdtempSync(join(tmpdir(), 'quirky-selection-tar-'))
      directories.push(directory)
      writeFileSync(join(directory, 'dummy.txt'), 'placeholder\n')
      const baseTarPath = join(directory, 'base.tar')
      const build = spawnSync(
        'tar',
        ['-c', '--format', 'ustar', '-f', baseTarPath, '-C', directory, 'dummy.txt'],
        {
          encoding: 'utf8'
        }
      )
      expect(build.status).toBe(0)

      const paths = ['src/a.test.ts', 'src/b.test.ts']
      const selectionTarPath = buildSelectionTar(baseTarPath, paths)
      directories.push(resolve(selectionTarPath, '..'))

      const listing = spawnSync('tar', ['-tf', selectionTarPath], { encoding: 'utf8' })
      expect(listing.stdout).toContain('.quirky-sandbox/selection.txt')
      expect(listing.stdout).toContain('dummy.txt')

      const contents = spawnSync(
        'tar',
        ['-xO', '-f', selectionTarPath, '.quirky-sandbox/selection.txt'],
        {
          encoding: 'utf8'
        }
      )
      expect(contents.stdout).toBe('src/a.test.ts\nsrc/b.test.ts\n')

      const command = laneCommand({ lane: 'unit', select: 'files', extraArgs: [] }, null)
      expect(command.flat().join(' ')).not.toContain('src/a.test.ts')
      expect(command.flat().join(' ')).not.toContain('src/b.test.ts')
    })
  })
})
