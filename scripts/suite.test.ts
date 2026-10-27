import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, macosOnly, runFiles, runSuite } from './suite'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-'))
  mkdirSync(join(dir, 'pkg'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, body: string) =>
  writeFileSync(join(dir, 'pkg', name), `import { expect, test } from 'bun:test'\nimport { existsSync, writeFileSync } from 'node:fs'\n${body}\n`)

const passing = (name: string) => write(name, `test('ok', () => expect(1).toBe(1))`)
const broken = (name: string) => write(name, `test('broken', () => expect(1).toBe(2))`)
// fails the first time it runs and passes after, the way a load flake does
const flaky = (name: string) =>
  write(name, `test('flaky', () => {\n  const seen = existsSync(import.meta.path + '.ran')\n  writeFileSync(import.meta.path + '.ran', '')\n  expect(seen).toBe(true)\n})`)

test('a green suite passes without a rerun', async () => {
  passing('a.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: [] })
})

test('a file that fails in the suite and passes alone is reported as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
})

test('a file that fails again alone fails the run', async () => {
  flaky('a.test.ts')
  broken('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
})

test('a file that fails to load fails the run, since the report cannot name it', async () => {
  flaky('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
})

test('more failing files than the limit fail the run without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'], 1)).toEqual({ ok: false, flaky: [] })
})

test('runFiles runs each file in its own process and reports one that passes alone as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
})

test('runFiles fails on a file that fails again, including one that fails to load', async () => {
  passing('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: false, flaky: [] })
})

test('runFiles with more failing files than the limit fails without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2, 1)).toEqual({ ok: false, flaky: [] })
})

test('discover lists the tracked and untracked test files under the given paths, as bun would', () => {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  passing('a.test.ts')
  write('b.spec.tsx', '')
  write('helper.ts', '')
  mkdirSync(join(dir, 'other'))
  writeFileSync(join(dir, 'other/c.test.ts'), '')
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
  mkdirSync(join(dir, 'ignored'))
  writeFileSync(join(dir, 'ignored/d.test.ts'), '')
  expect(discover(dir, ['pkg', '--timeout=1'])).toEqual(['pkg/a.test.ts', 'pkg/b.spec.tsx'])
  expect(discover(dir, [])).toEqual(['other/c.test.ts', 'pkg/a.test.ts', 'pkg/b.spec.tsx'])
})

test('macosOnly reads the first word of each line and skips comments and blanks', () => {
  writeFileSync(join(dir, 'list.txt'), '# why\n\npkg/a.test.ts  needs zsh\npkg/b.test.ts\n')
  expect(macosOnly(join(dir, 'list.txt'))).toEqual(new Set(['pkg/a.test.ts', 'pkg/b.test.ts']))
  expect(macosOnly(join(dir, 'missing.txt'))).toEqual(new Set())
})
