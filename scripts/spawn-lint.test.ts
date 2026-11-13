import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { formatDiagnostic, runSpawnLint, scanSourceContent } from './spawn-lint'

const file = 'plugins/example/a.ts'
const hit = 'process/no-direct-spawn: Use the shared process runner.'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function put(root: string, path: string, source: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), source)
}
function fixture(baseline: unknown = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spawn-lint-'))
  roots.push(root)
  for (const path of ['packages/daemon', 'packages/git', 'plugins', 'state']) mkdirSync(join(root, path), { recursive: true })
  put(root, 'scripts/spawn-lint-baseline.json', JSON.stringify(baseline))
  return root
}
function capture(root: string, printBaseline = false) {
  const stdout: string[] = [], stderr: string[] = []
  const log = console.log, error = console.error
  console.log = (...args: unknown[]) => { stdout.push(args.join(' ') + '\n') }
  console.error = (...args: unknown[]) => { stderr.push(args.join(' ') + '\n') }
  try { return { status: runSpawnLint(root, { printBaseline }), stdout: stdout.join(''), stderr: stderr.join('') } }
  finally { console.log = log; console.error = error }
}
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: isolatedEnv(root) })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
function isolatedEnv(root: string) {
  return { PATH: process.env.PATH, HOME: root, QUIRKY_HOME: join(root, 'state'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

const bunAccesses = [
  'Bun.spawn([])', 'Bun.spawnSync([])', 'Bun.$`true`', 'Bun["spawn"]([])', 'Bun[`spawnSync`]([])',
  '(Bun as any).spawn?.([])', 'Bun!.spawn([])', 'globalThis["Bun"]["spawn"]([])',
  'const launch = Bun.spawn; launch([])', 'const { spawn: launch } = Bun; launch([])',
  'Bun /* gap */ ?. ["spawn"]?.([])', '(Bun satisfies unknown).spawn([])', '(<any>Bun).spawn([])',
  '(globalThis.Bun).spawnSync([])', 'const { ["spawn"]: launch } = Bun', 'const { [`spawnSync`]: launch } = Bun',
  'import { spawn as launch } from "bun"; launch([])', 'import { spawnSync } from "bun"', 'import { $ } from "bun"',
  'import * as B from "bun"; B.spawn([])', 'import B from "bun"; B.$`true`',
  'require("bun").spawn([])', '(await import("bun")).spawn([])', '(await import(`bun`))["spawnSync"]([])',
  'const { spawn } = require("bun")', 'const { spawn } = globalThis.Bun',
  'const { spawn } = (Bun as unknown)', 'import * as B from "bun"; const { spawn } = B',
  'const text = `example ${Bun.spawn([])}`', '// lint-disable process/no-direct-spawn\nBun.spawn([])',
]
test.each(bunAccesses)('detects one Bun capability acquisition: %s', source => {
  expect(scanSourceContent(file, source).map(d => d.rule)).toEqual(['process/no-direct-spawn'])
})
test('counts members, not calls through extracted functions', () => {
  expect(scanSourceContent(file, 'const { spawn, spawnSync: sync, file } = Bun; spawn([]); sync([])')).toHaveLength(2)
  expect(scanSourceContent(file, 'import { spawn, spawnSync, $, YAML } from "bun"; spawn([])')).toHaveLength(3)
})
const childLoads = [
  'import { spawn, exec as launch } from "child_process"; spawn([]); launch("")',
  'import * as cp from "node:child_process"', 'import cp from "child_process"', 'import "node:child_process"',
  'import type { ChildProcess } from "child_process"', 'import { type ChildProcess } from "node:child_process"',
  'import cp = require("node:child_process")', 'require("child_process")', 'module.require("node:child_process")',
  'import("child_process")', 'import(`node:child_process`)', 'export { spawn, exec } from "child_process"',
  'export * from "node:child_process"', 'export type { ChildProcess } from "child_process"',
  'type C = import("node:child_process").ChildProcess',
  'type C = ReturnType<typeof import("child_process").spawn>',
]
test.each(childLoads)('detects one child_process acquisition: %s', source => {
  const diagnostics = scanSourceContent(file, source)
  expect(diagnostics.map(d => d.rule)).toEqual(['process/no-direct-spawn'])
  const start = source.startsWith('type C') ? source.indexOf(source.includes('typeof import(') ? 'typeof import(' : 'import(') : 0
  expect(diagnostics[0]).toMatchObject({ file, line: 1, column: start + 1 })
})
test.each([
  '// Bun.spawn([])\n/* require("child_process") */', 'const s = "Bun.spawn([])"',
  'const s = `require("child_process") Bun.spawn([])`', 'type R = ReturnType<typeof Bun.spawn>',
  'ctx.process.run({}); ctx.process.spawn({}); Bun.file("x")', 'import { YAML } from "bun"',
  'import type B from "bun"; type R = typeof B.spawn', 'import { type spawn } from "bun"',
  'type C = typeof globalThis.Bun.spawn', 'const b = Bun; b.spawn([])',
])('ignores prose, Bun types, and allowed APIs: %s', source => { expect(scanSourceContent(file, source)).toEqual([]) })
test('reports exact positions, ordering, and padded source without truncation', () => {
  expect(scanSourceContent(file, 'Bun.spawn([])').map(formatDiagnostic)).toEqual([`${file}:1:1 ${hit}`])
  expect(scanSourceContent(file, 'Bun.spawn([]); Bun.spawnSync([])\n  Bun.$`true`').map(formatDiagnostic)).toEqual([
    `${file}:1:1 ${hit}`, `${file}:1:16 ${hit}`, `${file}:2:3 ${hit}`,
  ])
  expect(scanSourceContent(file, ' '.repeat(1024 * 1024) + 'Bun.spawn([])')[0]?.column).toBe(1024 * 1024 + 1)
})
test.each(['tsx', 'jsx', 'TSX', 'JSX'])('scans runtime expressions inside %s markup', extension => {
  const diagnostics = scanSourceContent(`plugins/example/view.${extension}`, 'const view = <div>{Bun.spawn([])}</div>')
  expect(diagnostics.map(d => [d.line, d.column, d.rule])).toEqual([[1, 20, 'process/no-direct-spawn']])
})

test('scans each production root and plugin entry without a manifest', () => {
  const root = fixture()
  for (const path of ['packages/daemon/src/a.ts', 'packages/git/src/a.mts', 'plugins/example/entry.ts']) put(root, path, 'Bun.spawn([])')
  const result = capture(root)
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr.split('\n').filter(s => s.includes('process/no-direct-spawn'))).toEqual([
    `packages/daemon/src/a.ts:1:1 ${hit}`, `packages/git/src/a.mts:1:1 ${hit}`, `plugins/example/entry.ts:1:1 ${hit}`,
  ])
})
test('accepts all script extensions case-insensitively', () => {
  const root = fixture()
  for (const [index, extension] of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'TS', 'TSX'].entries()) put(root, `plugins/example/a${index}.${extension}`, 'Bun.spawn([])')
  expect(Object.keys(JSON.parse(capture(root, true).stdout))).toHaveLength(10)
})
test('excludes declarations, tests, artifacts, other roots, and symlinks', () => {
  const root = fixture()
  for (const directory of ['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', 'test', 'tests', '__tests__', '__test__', '_test', '_tests', 'fixture', 'fixtures', '__fixtures__', '_fixtures', 'TeStS']) put(root, `plugins/example/${directory}/a.ts`, 'Bun.spawn([])')
  for (const path of ['a.d.ts', 'a.d.mts', 'a.d.cts', 'a.D.TS', 'a.test.ts', 'a-spec.ts', 'fixture.ts', 'a.fixtures.jsx', 'a.json']) put(root, `plugins/example/${path}`, 'Bun.spawn([])')
  for (const path of ['packages/process/src/child.ts', 'scripts/soak/faults/main.ts', 'plugins/entry.ts', 'plugins/tests/a.ts']) put(root, path, 'Bun.spawn([])')
  symlinkSync(join(root, 'packages/process/src/child.ts'), join(root, 'plugins/example/link.ts'))
  symlinkSync(join(root, 'packages/process'), join(root, 'plugins/linked'))
  expect(capture(root)).toEqual({ status: 0, stdout: '', stderr: '' })
})
test('uses isolated Git inventory for tracked, untracked, ignored, and deleted files', () => {
  const root = fixture()
  git(root, 'init', '--quiet')
  put(root, '.gitignore', 'plugins/example/ignored/\nplugins/example/tracked.ts\n')
  put(root, 'plugins/example/ignored/a.ts', 'Bun.spawn([])')
  put(root, 'plugins/example/tracked.ts', 'Bun.spawn([])')
  put(root, 'plugins/example/deleted.ts', 'Bun.spawn([])')
  git(root, 'add', '--force', 'plugins/example/tracked.ts', 'plugins/example/deleted.ts')
  rmSync(join(root, 'plugins/example/deleted.ts'))
  put(root, 'plugins/example/new.ts', 'Bun.spawnSync([])')
  const previous = process.env.GIT_DIR
  process.env.GIT_DIR = '/does-not-exist'
  try {
    expect(capture(root, true)).toEqual({ status: 0, stdout: '{\n  "plugins/example/new.ts": 1,\n  "plugins/example/tracked.ts": 1\n}\n', stderr: '' })
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous }
})
test('enforces per-file ceilings, printing every located hit only for over-budget files', () => {
  const root = fixture({ [file]: 1, 'plugins/example/b.ts': 4 })
  put(root, file, 'Bun.spawn([])')
  put(root, 'plugins/example/b.ts', 'Bun.spawn([]); Bun.spawn([]); Bun.spawn([]); Bun.spawn([])')
  expect(capture(root)).toEqual({ status: 0, stdout: '', stderr: '' })
  put(root, file, 'Bun.spawn([]); Bun.spawnSync([])')
  const exceeded = capture(root)
  expect(exceeded).toEqual({ status: 1, stdout: '', stderr: `${file}:1:1 process/baseline-exceeded: found 2, baseline 1.\n${file}:1:1 ${hit}\n${file}:1:16 ${hit}\n` })
  expect(capture(root)).toEqual(exceeded)
  put(root, 'plugins/example/new.ts', 'Bun.spawn([])')
  expect(capture(root).stderr).toContain('plugins/example/new.ts:1:1 process/baseline-exceeded: found 1, baseline 0.')
})
test('allows migration in either merge order without rewriting policy', () => {
  const root = fixture({ [file]: 2 })
  const baselinePath = join(root, 'scripts/spawn-lint-baseline.json')
  const before = readFileSync(baselinePath, 'utf8')
  put(root, file, 'Bun.spawn([])')
  expect(capture(root)).toEqual({ status: 0, stdout: '', stderr: `${file}:1:1 process/baseline-stale: found 1, baseline 2; lower or remove this entry.\n` })
  expect(readFileSync(baselinePath, 'utf8')).toBe(before)
  writeFileSync(baselinePath, JSON.stringify({ [file]: 1 }))
  expect(capture(root).status).toBe(0)
  put(root, file, '')
  writeFileSync(baselinePath, '{}')
  expect(capture(root)).toEqual({ status: 0, stdout: '', stderr: '' })
})
test('notes zero-hit, deleted, and removed-plugin entries; rename fails at its new path', () => {
  const root = fixture({ [file]: 1, 'plugins/removed/a.ts': 2, 'packages/git/zero.ts': 1 })
  put(root, file, 'Bun.spawn([])')
  put(root, 'packages/git/zero.ts', 'Bun.file("x")')
  renameSync(join(root, file), join(root, 'plugins/example/renamed.ts'))
  const result = capture(root)
  expect(result.status).toBe(1)
  for (const [path, count] of [['packages/git/zero.ts', 1], [file, 1], ['plugins/removed/a.ts', 2]]) expect(result.stderr).toContain(`${path}:1:1 process/baseline-stale: found 0, baseline ${count}; lower or remove this entry.`)
  expect(result.stderr).toContain('plugins/example/renamed.ts:1:1 process/baseline-exceeded: found 1, baseline 0.')
  rmSync(join(root, 'plugins/example'), { recursive: true })
  expect(capture(root).status).toBe(0)
})
test.each([null, [], 42, 'text', { [file]: 0 }, { [file]: -1 }, { [file]: 1.5 }, { [file]: '1' }, { [file]: true }, { [file]: null }, { [file]: Number.MAX_SAFE_INTEGER + 1 }].map(baseline => ({ baseline })))('rejects invalid baseline shape/count: %j', ({ baseline }) => {
  const result = capture(fixture(baseline))
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('scripts/spawn-lint-baseline.json:1:1 process/config:')
})
test.each(['/plugins/example/a.ts', 'plugins\\example\\a.ts', 'plugins//a.ts', 'plugins/./a.ts', 'plugins/../a.ts', 'plugins/example/a.ts/', 'packages/process/a.ts', 'plugins/a.ts', 'plugins/example/a.test.ts', 'plugins/example/dist/a.ts', 'plugins/example/a.d.cts', ''])('rejects ineligible baseline key: %s', key => {
  const result = capture(fixture({ [key]: 1 }))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('process/config:')
})
test('fails on missing/malformed baseline and missing roots', () => {
  const root = fixture()
  const baseline = join(root, 'scripts/spawn-lint-baseline.json')
  for (const text of ['{', '{"plugins/example/a.ts":1e400}']) {
    writeFileSync(baseline, text)
    expect(capture(root).status).toBe(1)
  }
  rmSync(baseline)
  expect(capture(root).stderr).toContain('scripts/spawn-lint-baseline.json:1:1 process/config:')
  writeFileSync(baseline, '{}')
  for (const path of ['packages/daemon', 'packages/git', 'plugins']) {
    rmSync(join(root, path), { recursive: true })
    expect(capture(root).stderr).toContain(`${path}:1:1 process/config:`)
    mkdirSync(join(root, path))
  }
})
test('fails closed on Git inventory, source read, and traversal errors in both modes', () => {
  const root = fixture()
  put(root, '.git', 'gitdir: missing\n')
  for (const mode of [false, true]) expect(capture(root, mode).stderr).toContain('process/config:')
  rmSync(join(root, '.git'))
  put(root, file, 'Bun.spawn([])')
  for (const path of [file, 'plugins/example']) {
    chmodSync(join(root, path), 0)
    try {
      for (const mode of [false, true]) {
        const result = capture(root, mode)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain(`${path}:1:1 process/config:`)
      }
    } finally { chmodSync(join(root, path), path === file ? 0o600 : 0o700) }
  }
})
test('prints a deterministic candidate without reading or rewriting the old baseline', () => {
  const root = fixture()
  put(root, file, 'Bun.spawn([])')
  const expected = { status: 0, stdout: '{\n  "plugins/example/a.ts": 1\n}\n', stderr: '' }
  expect(capture(root, true)).toEqual(expected)
  for (const text of ['broken', '{}']) {
    put(root, 'scripts/spawn-lint-baseline.json', text)
    expect(capture(root, true)).toEqual(expected)
    expect(readFileSync(join(root, 'scripts/spawn-lint-baseline.json'), 'utf8')).toBe(text)
  }
  rmSync(join(root, 'scripts/spawn-lint-baseline.json'))
  expect(capture(root, true)).toEqual(expected)
  put(root, 'plugins/example/Z.ts', 'Bun.spawn([]); Bun.spawnSync([])')
  expect(Object.keys(JSON.parse(capture(root, true).stdout))).toEqual(['plugins/example/Z.ts', file])
  rmSync(join(root, 'plugins/example'), { recursive: true })
  expect(capture(root, true)).toEqual({ status: 0, stdout: '{}\n', stderr: '' })
})
test('CLI rejects unknown arguments and remains import-safe', () => {
  const root = fixture()
  const script = resolve(import.meta.dir, 'spawn-lint.ts')
  const result = Bun.spawnSync([process.execPath, script, '--unknown'], { cwd: root, env: isolatedEnv(root) })
  expect(result.exitCode).toBe(1)
  expect(result.stdout.toString()).toBe('')
  expect(result.stderr.toString()).toMatch(/[Uu]sage/)
  // importing from a fresh process must not initialize CLI state.
  const imported = Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(script)}); console.log(process.exitCode ?? 0)`], { cwd: root, env: isolatedEnv(root) })
  expect(imported.exitCode).toBe(0)
  expect(imported.stdout.toString()).toBe('0\n')
  expect(imported.stderr.toString()).toBe('')
})

test('package scripts preserve every typecheck stage and insert the spawn guard', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8'))
  expect(scripts['spawn:lint']).toBe('bun scripts/spawn-lint.ts')
  expect(scripts.typecheck).toBe('bun install --frozen-lockfile && bun run ui:lint && bun run spawn:lint && bunx tsc --noEmit -p tsconfig.json && bun run typecheck:mobile && bun run typecheck:desktop')
})
test('repository fits its ceiling and CLI resolves root independently of cwd', () => {
  const root = resolve(import.meta.dir, '..')
  const result = capture(root)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr.split('\n').filter(Boolean).every(line => line.includes(' process/baseline-stale:'))).toBe(true)
  const expected = capture(root, true)
  expect(expected.status).toBe(0)
  const home = fixture()
  const cli = Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'spawn-lint.ts'), '--print-baseline'], {
    cwd: resolve(import.meta.dir), env: isolatedEnv(home),
  })
  expect(cli.exitCode).toBe(0)
  expect(cli.stdout.toString()).toBe(expected.stdout)
  expect(cli.stderr.toString()).toBe('')
}, 20_000)

test('required-root symlinks cannot hide an incomplete scan', () => {
  const root = fixture()
  const other = fixture()
  rmSync(join(root, 'packages/daemon'), { recursive: true })
  symlinkSync(join(other, 'packages/daemon'), join(root, 'packages/daemon'))
  for (const mode of [false, true]) {
    const result = capture(root, mode)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('packages/daemon:1:1 process/config:')
  }
})

test('inventory requires no plugin id naming convention or manifest', () => {
  const root = fixture()
  for (const path of ['plugins/.local/entry.ts', 'plugins/with space/entry.ts']) put(root, path, 'Bun.spawn([])')
  expect(JSON.parse(capture(root, true).stdout)).toEqual({ 'plugins/.local/entry.ts': 1, 'plugins/with space/entry.ts': 1 })
})

test('class heritage acquires a runtime value while interface heritage does not', () => {
  expect(scanSourceContent(file, 'class C extends Bun.spawn {}').map(d => d.rule)).toEqual(['process/no-direct-spawn'])
  expect(scanSourceContent(file, 'interface C extends Bun.spawn {}')).toEqual([])
})
