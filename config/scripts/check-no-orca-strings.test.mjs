import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureRepo } from './rename-to-quirky/fixture-repo.mjs'
import { globToRegExp, matchesAnyGlob } from './rename-to-quirky/allowlist.mjs'

const SCRIPT = join(import.meta.dirname, 'check-no-orca-strings.mjs')
const repos = []

function makeRepo(files) {
  const repo = createFixtureRepo(files)
  repos.push(repo)
  return repo
}

function check(repo, allowlist = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', repo.root, '--allowlist', repo.writeAllowlist(allowlist)],
    { encoding: 'utf8' }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

afterEach(() => {
  while (repos.length) {
    repos.pop().cleanup()
  }
})

describe('glob matching', () => {
  it('matches exact paths, * within a segment and ** across segments', () => {
    expect(globToRegExp('LICENSE').test('LICENSE')).toBe(true)
    expect(globToRegExp('LICENSE').test('sub/LICENSE')).toBe(false)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false)
    expect(globToRegExp('docs/**').test('docs/a/b/c.md')).toBe(true)
    expect(globToRegExp('docs/**').test('other/a.md')).toBe(false)
    expect(globToRegExp('a/**/z.ts').test('a/z.ts')).toBe(true)
    expect(globToRegExp('a/**/z.ts').test('a/b/c/z.ts')).toBe(true)
    expect(globToRegExp('a.b').test('aXb')).toBe(false)
  })

  it('matchesAnyGlob checks every pattern', () => {
    expect(matchesAnyGlob(['x', 'y/**'], 'y/z')).toBe(true)
    expect(matchesAnyGlob(['x'], 'y/z')).toBe(false)
  })
})

describe('check-no-orca-strings.mjs', () => {
  it('exits 0 when nothing matches', () => {
    const repo = makeRepo({ 'src/a.ts': 'const quirky = 1\n' })
    expect(check(repo).status).toBe(0)
  })

  it('prints file:line: text and exits 1 for each exact-case match', () => {
    const repo = makeRepo({
      'src/a.ts': 'ok\nconst x = "Orca"\n',
      'docs/b.md': 'a\nb\nthe ORCA app\n'
    })
    const { status, stdout } = check(repo)
    expect(status).toBe(1)
    expect(stdout).toContain('src/a.ts:2: const x = "Orca"')
    expect(stdout).toContain('docs/b.md:3: the ORCA app')
  })

  it('does not flag mixed-case runs inside other words', () => {
    const repo = makeRepo({
      'src/a.ts':
        'errorCategory optionsOrCallback NSURLErrorCancelled directorCapacity selectorCalls\n'
    })
    expect(check(repo).status).toBe(0)
  })

  it('flags only the exact-case brand variants', () => {
    const repo = makeRepo({
      'a.ts': 'Orca\n',
      'b.ts': 'orca\n',
      'c.ts': 'ORCA_X\n',
      'd.ts': 'orcad\n',
      'e.ts': 'errorCategory\n',
      'f.ts': 'optionsOrCallback\n'
    })
    const { status, stdout } = check(repo)
    expect(status).toBe(1)
    for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      expect(stdout).toContain(`${file}:1:`)
    }
    expect(stdout).not.toContain('e.ts')
    expect(stdout).not.toContain('f.ts')
  })

  it('honours skipPaths', () => {
    const repo = makeRepo({ LICENSE: 'Orca\n', 'legacy/x.ts': 'orca\n', 'src/a.ts': 'fine\n' })
    expect(check(repo, { skipPaths: ['LICENSE', 'legacy/**'] }).status).toBe(0)
  })

  it('ignores a line whose only match sits inside a keep token', () => {
    const repo = makeRepo({ 'a.md': 'see https://github.com/stablyai/orca/pull/1\n' })
    expect(check(repo, { keepTokens: ['stablyai/orca'] }).status).toBe(0)
  })

  it('still flags a line with a match outside the keep token', () => {
    const repo = makeRepo({ 'a.md': 'orca at https://github.com/stablyai/orca/pull/1\n' })
    const { status, stdout } = check(repo, { keepTokens: ['stablyai/orca'] })
    expect(status).toBe(1)
    expect(stdout).toContain('a.md:1:')
  })

  it('allows credit lines only in their own path and only with their match', () => {
    const repo = makeRepo({
      'README.md': 'Based on Orca by Stably\nOrca again\n',
      'other.md': 'Based on Orca\n'
    })
    const { status, stdout } = check(repo, {
      creditLines: [{ path: 'README.md', match: 'Based on Orca' }]
    })
    expect(status).toBe(1)
    expect(stdout).not.toContain('README.md:1')
    expect(stdout).toContain('README.md:2: Orca again')
    expect(stdout).toContain('other.md:1')
  })

  it('does not scan binary files', () => {
    const repo = makeRepo({ 'logo.png': Buffer.concat([Buffer.from([0, 1]), Buffer.from('orca')]) })
    expect(check(repo).status).toBe(0)
  })

  it('exits 2 on bad arguments', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
  })
})
