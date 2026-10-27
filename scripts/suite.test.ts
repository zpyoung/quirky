import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './suite'

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
