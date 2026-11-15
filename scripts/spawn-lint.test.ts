import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { formatDiagnostic, runSpawnLint, scanSourceContent } from './spawn-lint'

const file = 'plugins/example/a.ts'
const hit = 'process/no-direct-spawn: Use the shared process runner.'
const spawnDiagnostic = (column: number, line = 1) => ({
  file, line, column, rule: 'process/no-direct-spawn', message: 'Use the shared process runner.',
})
const escapedGlobalDiagnostic = (column: number, line = 1) => ({
  file, line, column, rule: 'process/no-escaped-global',
  message: 'Read Bun, Atomics, process, module and the global object only through a static, allowed member.',
})
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
const spawnGapCases = [
  ['generic instantiation', 'const f = Bun.spawn<any>', 11],
  ['assignment destructuring', 'let f; ({ spawn: f } = Bun)', 11],
  ['untyped parameter default', 'function f({ spawn } = Bun) {}', 14],
  ['typed parameter default', 'function f({ spawn }: typeof Bun = Bun) {}', 14],
  ['named Bun re-export', 'export { spawn } from "bun"', 10],
  ['default-as-named Bun receiver', 'import { default as B } from "bun"; B.spawn([])', 37],
] as const
test.each(spawnGapCases)('detects %s at its exact source column', (_name, source, column) => {
  expect(scanSourceContent(file, source)).toEqual([{
    file, line: 1, column, rule: 'process/no-direct-spawn', message: 'Use the shared process runner.',
  }])
})
test.each(spawnGapCases)('preserves the %s hit and column after large padding', (_name, source, column) => {
  const padding = 1_048_577
  expect(scanSourceContent(file, ' '.repeat(padding) + source)).toEqual([{
    file, line: 1, column: padding + column, rule: 'process/no-direct-spawn', message: 'Use the shared process runner.',
  }])
})
const taskOneErrorCases = [
  ['Bun root alias', 'const b = Bun; b.spawn([])', escapedGlobalDiagnostic(11)],
  ['computed Bun member', 'const k = "spawn"; Bun[k]([])', escapedGlobalDiagnostic(20)],
  ['optional computed Bun member', 'Bun?.[k]?.([])', escapedGlobalDiagnostic(1)],
  ['Bun through Reflect', 'Reflect.get(Bun, "spawn")([])', escapedGlobalDiagnostic(13)],
  ['Bun argument', 'run(Bun)', escapedGlobalDiagnostic(5)],
  ['Bun property argument', 'Object.values(Bun)', escapedGlobalDiagnostic(15)],
  ['Bun spread', 'const b = { ...Bun }', escapedGlobalDiagnostic(16)],
  ['Bun shorthand property', 'const o = { Bun }', escapedGlobalDiagnostic(13)],
  ['Bun default export', 'export default Bun', escapedGlobalDiagnostic(16)],
  ['Bun in array literal', 'const [b] = [Bun]; b.spawn([])', escapedGlobalDiagnostic(14)],
  ['Bun parameter default', 'function f(b = Bun) { b.spawn([]) }', escapedGlobalDiagnostic(16)],
  ['globalThis alias', 'const g = globalThis; g.Bun.spawn([])', escapedGlobalDiagnostic(11)],
  ['globalThis Bun alias', 'const B = globalThis.Bun; B.spawn([])', escapedGlobalDiagnostic(11)],
  ['global Bun alias', 'const B = global["Bun"]; B.spawn([])', escapedGlobalDiagnostic(11)],
  ['self Bun argument', 'f(self.Bun)', escapedGlobalDiagnostic(3)],
  ['dynamic globalThis member', 'globalThis[k]', escapedGlobalDiagnostic(1)],
  ['Bun namespace import escape', 'import * as B from "bun"; f(B)', escapedGlobalDiagnostic(29)],
  ['Bun default import escape', 'import B from "bun"; const c = B; c.spawn([])', escapedGlobalDiagnostic(32)],
  ['dynamic Bun import escape', 'const b = await import("bun"); b.spawn([])', escapedGlobalDiagnostic(17)],
  ['Bun rest destructuring', 'const { ...rest } = Bun; rest.spawn([])', escapedGlobalDiagnostic(9)],
  ['computed Bun destructuring', 'const { [k]: s } = Bun', escapedGlobalDiagnostic(9)],
  ['globalThis Bun destructuring', 'const { Bun: B } = globalThis', escapedGlobalDiagnostic(9)],
  ['nested Bun destructuring spawn', 'const { Bun: { spawn } } = globalThis', spawnDiagnostic(16)],
  ['whole Bun re-export', 'export * from "bun"', escapedGlobalDiagnostic(1)],
  ['Bun namespace re-export', 'export * as B from "bun"', escapedGlobalDiagnostic(1)],
  ['Bun default re-export', 'export { default } from "bun"', escapedGlobalDiagnostic(10)],
  ['global Bun spawn', 'global.Bun.spawn([])', spawnDiagnostic(1)],
  ['self Bun spawnSync', 'self.Bun.spawnSync([])', spawnDiagnostic(1)],
  ['nested globalThis Bun shell', 'globalThis.globalThis.Bun.$`true`', spawnDiagnostic(1)],
  ['Bun import-equals spawn', 'import B = require("bun"); B.spawn([])', spawnDiagnostic(28)],
  ['Bun openInEditor', 'Bun.openInEditor("x")', spawnDiagnostic(1)],
  ['imported openInEditor', 'import { openInEditor } from "bun"', spawnDiagnostic(10)],
  ['Bun spawn instantiation', 'const f = Bun.spawn<any>', spawnDiagnostic(11)],
  ['Bun spawn instantiation in type argument', 'const f = Bun.spawn<typeof Bun.spawn>', spawnDiagnostic(11)],
  ['globalThis Bun spawnSync instantiation', 'const f = globalThis.Bun.spawnSync<unknown>', spawnDiagnostic(11)],
  ['Bun shell instantiation', 'const f = Bun.$<unknown>', spawnDiagnostic(11)],
  ['Bun spawn class heritage', 'class C extends Bun.spawn {}', spawnDiagnostic(17)],
  ['Bun instantiation escape', 'const b = Bun<any>', escapedGlobalDiagnostic(11)],
  ['ambient Bun declaration', 'declare const Bun: any; f(Bun)', escapedGlobalDiagnostic(27)],
  ['ambient self declaration', 'declare global { var self: any }\nf(self)', escapedGlobalDiagnostic(3, 2)],
  ['sibling-scope self shadow', 'let x; { const self = 1 }\nf(self)', escapedGlobalDiagnostic(3, 2)],
] as const
test.each(taskOneErrorCases)('reports exact task 1 diagnostic and padded column: %s', (_name, source, expected) => {
  expect(scanSourceContent(file, source)).toEqual([expected])
  const padding = 1_048_577
  const paddedLines = source.split('\n')
  paddedLines[expected.line - 1] = `${' '.repeat(padding)}${paddedLines[expected.line - 1]!}`
  expect(scanSourceContent(file, paddedLines.join('\n'))).toEqual([{
    ...expected, column: expected.column + padding,
  }])
})
const genericInstantiationCases = (['spawn', 'spawnSync', '$'] as const).map(member =>
  [`generic ${member} instantiation`, `const f = Bun.${member}<unknown>`, 1] as const)
const extractionCases = [
  ['assignment rename with a default target', 'let launch; ({ spawn: launch = fallback } = (Bun as unknown)); launch([])', 1],
  ['computed assignment from a satisfies receiver', 'let launch; ({ ["spawnSync"]: launch = fallback } = (Bun satisfies unknown)); launch([])', 1],
  ['computed assignment from globalThis.Bun', 'let launch; ({ ["$"]: launch = fallback } = globalThis.Bun); launch`true`', 1],
  ['assignment shorthand with a default target', 'let spawnSync; ({ spawnSync = fallback } = globalThis.Bun); spawnSync([])', 1],
  ['renamed untyped parameter default', 'function f({ spawn: launch = fallback } = (Bun as unknown)) { launch([]) }', 1],
  ['renamed typed parameter default', 'function f({ spawnSync: launch = fallback }: typeof Bun = (Bun satisfies unknown)) { launch([]) }', 1],
  ['arrow parameter default', 'const f = ({ ["$"]: shell = fallback } = (globalThis.Bun satisfies unknown)) => shell`true`', 1],
  ['two-member assignment destructuring', 'let a, b; ({ spawn: a = fallback, ["spawnSync"]: b } = Bun); a([]); b([])', 2],
  ['two aliased named re-exports', 'export { spawn as launch, spawnSync as sync } from "bun"', 2],
  ['three aliased named re-exports', 'export { spawn as launch, spawnSync as sync, $ as shell } from "bun"', 3],
  ['default-as-named receiver accesses and destructuring', 'import { default as B } from "bun"; B.spawn([]); B["spawnSync"]([]); B.$`true`; const { "$": shell = fallback } = B; shell`true`', 4],
] as const
test.each([...genericInstantiationCases, ...extractionCases])('detects each forbidden member once for %s', (_name, source, count) => {
  const diagnostics = scanSourceContent(file, source)
  expect(diagnostics).toHaveLength(count)
  expect(diagnostics.every(diagnostic => diagnostic.rule === 'process/no-direct-spawn')).toBe(true)
  const padding = 1_048_577
  expect(scanSourceContent(file, ' '.repeat(padding) + source)).toEqual(
    diagnostics.map(diagnostic => ({ ...diagnostic, column: diagnostic.column + padding }))
  )
})
test('reports aliased re-exports at their original Bun member names', () => {
  expect(scanSourceContent(file, 'export { spawn as launch, spawnSync as sync } from "bun"').map(diagnostic => diagnostic.column))
    .toEqual([10, 27])
})
test('type arguments and type-only Bun references do not add runtime hits', () => {
  expect(scanSourceContent(file, 'const f = Bun.spawn<typeof Bun.spawn>')).toEqual([{
    file, line: 1, column: 11, rule: 'process/no-direct-spawn', message: 'Use the shared process runner.',
  }])
  for (const source of [
    'type R = typeof Bun.spawn',
    'interface C extends Bun.spawn {}',
    'export type { spawn } from "bun"',
    'export { type spawn } from "bun"',
    'import type { default as B } from "bun"; B.spawn([])',
    'const other = { spawn: () => 0 }; other.spawn()',
  ]) expect(scanSourceContent(file, source)).toEqual([])
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
])('ignores prose, Bun types, and allowed APIs: %s', source => { expect(scanSourceContent(file, source)).toEqual([]) })
const taskOneAllowedCases = [
  ['scenario 7 entry 1', 'Bun.file("x").text(); Bun.env.HOME; Bun["version"]; const { file, env: { HOME } } = Bun'],
  ['scenario 7 entry 2', 'globalThis.setTimeout(f, 1); globalThis.Bun.file("x"); global.process.env.HOME; self.crypto.randomUUID(); const { setTimeout: st } = globalThis; const { Bun: { file } } = globalThis'],
  ['scenario 7 entry 3', 'typeof Bun; typeof globalThis.Bun; "Bun" in globalThis; typeof process'],
  ['scenario 7 entry 8', 'import * as BunRuntime from "bun"; import { YAML } from "bun"; const J = (BunRuntime as typeof BunRuntime & { JSONC: unknown }).JSONC'],
  ['scenario 7 entry 9', 'class C { self = 1; process() {} }; o.self; o.global; o.Bun; ({ Bun: 1, process: 2 }); Bun: for (;;) break Bun'],
  ['scenario 7 entry 10', 'let x: typeof globalThis; type T = typeof Bun; function f(e: globalThis.KeyboardEvent) {}'],
  ['scenario 8 local self', 'const self = { x: 1 }; f(self)'],
  ['scenario 8 local global', 'const global = new Map(); g(global?.[k])'],
  ['scenario 8 local process parameter', 'function f(process) { return process }'],
  ['scenario 8 local Bun parameter', 'function f(Bun) { return Bun }'],
  ['scenario 8 local Atomics catch binding', 'try {} catch (Atomics) { Atomics.wait() }'],
  ['scenario 8 unrelated self import', 'import self from "./x"; f(self)'],
  ['scenario 8 unrelated process import', 'import process from "./process"; f(process); process.getBuiltinModule(x)'],
  ['scenario 8 unrelated loader import', 'import { getBuiltinModule } from "./loader"; getBuiltinModule(x)'],
  ['scenario 13 Bun file instantiation', 'const f = Bun.file<any>'],
  ['scenario 13 allowed Bun member instantiation', 'const f = (Bun as any).file<any>; f("x")'],
  ['scenario 13 Bun file heritage', 'class C extends Bun.file {}'],
  ['scenario 13 Bun spawn interface heritage', 'interface C extends Bun.spawn {}'],
] as const
test.each(taskOneAllowedCases)('keeps applicable task 1 controls allowed: %s', (_name, source) => {
  expect(scanSourceContent(file, source)).toEqual([])
})
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
  expect(scripts.typecheck).toBe('bun install --frozen-lockfile && bun run ui:lint && bun run ui:scoreboard:check && bun run spawn:lint && bunx tsc --noEmit -p tsconfig.json && bun run typecheck:mobile && bun run typecheck:desktop')
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
