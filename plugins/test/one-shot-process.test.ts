import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PluginCaller, PluginContext, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner } from '../../packages/process/src/runner'
import { reveal } from '../quirky.git/src/daemon/files'
import type { DaemonEnv } from '../quirky.git/src/daemon/env'
import { createErrors } from '../quirky.git/src/daemon/errors'
import { VaultActions } from '../quirky.vault/src/actions'
import type { VaultWorkerClient } from '../quirky.vault/src/worker-client'
import { scanSourceContent } from '../../scripts/spawn-lint'

const roots: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'one-shot-')); roots.push(path); return path }
const error = (kind: string, message: string) => Object.assign(new Error(message), { kind })
const caller = { role: 'plugin', pluginId: 'fixture' } as PluginCaller
function result(overrides: Partial<RunResult> = {}): RunResult {
  return { stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, ...overrides }
}
const failures: { name: string; value: RunResult | Error; reason: string }[] = [
  { name: 'exit', value: result({ exitCode: 7 }), reason: 'macOS Foundation Trash failed with exit 7' },
  { name: 'signal', value: result({ signal: 'SIGTERM' }), reason: 'macOS Foundation Trash terminated by SIGTERM' },
  ...(['timeout', 'aborted', 'overflow'] as const).map(stopped => ({ name: stopped, value: result({ stopped }), reason: `macOS Foundation Trash stopped: ${stopped}` })),
  { name: 'spawn', value: result({ spawnError: { code: 'ENOENT', message: 'fixture missing' } }), reason: 'fixture missing' },
  { name: 'rejection', value: new Error('fixture rejected'), reason: 'fixture rejected' }
]
function recording(answer: (argv: readonly string[], options: RunOptions) => Promise<RunResult> = async () => result()) {
  const calls: { argv: readonly string[]; options: RunOptions }[] = []
  const runner: ProcessRunner = { run(argv, options = {}) { calls.push({ argv, options }); return answer(argv, options) } }
  return { runner, calls }
}
const settle = (value: RunResult | Error) => value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
const ignored = (timeoutMs: number, maxOutputBytes = 1) => ({ timeoutMs, maxOutputBytes, overflow: 'truncate', killGraceMs: 2000 })
function gitEnv(path: string, runner: ProcessRunner): DaemonEnv {
  return { context: { process: runner }, resolve: async () => ({ path }), errors: createErrors({ error } as Pick<PluginContext, 'error'>) } as unknown as DaemonEnv
}
function vault(runner: ProcessRunner, targets: { path: string; kind: 'file' | 'directory' }[], presence = 'present') {
  const requests: string[] = []
  const worker = { async request(op: string) { requests.push(op); if (op === 'get') return { presence }; if (op === 'deleteTargets') return targets; return null } } as unknown as VaultWorkerClient
  const actions = new VaultActions({ process: runner, error } as unknown as PluginContext, directory(), worker)
  return { actions, requests }
}
const publicId = (hostId = 'local') => `vault1.${Buffer.from(JSON.stringify({ hostId, sourceId: 'fixture' })).toString('base64url')}`
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
function platform(value: string) { Object.defineProperty(process, 'platform', { ...platformDescriptor, value }) }
let spawnGuard: { mockRestore(): void }
beforeEach(() => { spawnGuard = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('direct process acquisition forbidden in fixtures') }) })
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  delete globalThis.__QUIRKY_TEST_REVEAL__
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  spawnGuard.mockRestore()
})

function boundary(files: string[], floors: Record<string, string>) {
  const baseline = JSON.parse(readFileSync('scripts/spawn-lint-baseline.json', 'utf8'))
  for (const file of files) {
    expect(scanSourceContent(file, readFileSync(file, 'utf8'))).toEqual([])
    expect(baseline[file]).toBeUndefined()
  }
  for (const [plugin, floor] of Object.entries(floors)) {
    const version = JSON.parse(readFileSync(`plugins/quirky.${plugin}/quirky-plugin.json`, 'utf8')).apiVersion
    expect(Bun.semver.satisfies(version, `>=${floor}`)).toBe(true)
  }
}

describe('awaited desktop actions use the activation runner', () => {
  test('Git reveal awaits exactly one normalized request and tolerates truncated output', async () => {
    const root = directory()
    const done = Promise.withResolvers<RunResult>()
    const started = Promise.withResolvers<void>()
    const { runner, calls } = recording(() => { started.resolve(); return done.promise })
    let finished = false
    const pending = Promise.resolve(reveal(gitEnv(root, runner))({ path: 'src/../a b.txt' }, caller)).then(value => { finished = true; return value })
    await Promise.race([started.promise, pending.then(() => { throw new Error('runner was not called') })])
    expect(finished).toBe(false)
    expect(calls).toEqual([{ argv: ['open', '-R', join(root, 'a b.txt')], options: ignored(30000) }])
    done.resolve(result({ truncated: { stdout: true, stderr: true } }))
    expect(await pending).toEqual({ ok: true })
  })
  test.each(failures)('Git maps $name to its existing conflict', async ({ value }) => {
    const { runner, calls } = recording(() => settle(value))
    await expect(reveal(gitEnv(directory(), runner))({ path: 'src/../a b.txt' }, caller)).rejects.toMatchObject({ kind: 'conflict', data: { reason: 'failed' }, message: 'Could not reveal src/../a b.txt in Finder.' })
    expect(calls).toHaveLength(1)
  })
  test('Git hook and rejected paths never execute a process', async () => {
    const root = directory(), outside = directory()
    symlinkSync(outside, join(root, 'escape'))
    const { runner, calls } = recording()
    const handler = reveal(gitEnv(root, runner))
    const seen: string[] = []
    globalThis.__QUIRKY_TEST_REVEAL__ = async path => { seen.push(path) }
    expect(await handler({ path: 'owned' }, caller)).toEqual({ ok: true })
    expect(seen).toEqual([join(root, 'owned')])
    delete globalThis.__QUIRKY_TEST_REVEAL__
    for (const path of ['/absolute', '../escape', 'escape/file']) await expect(handler({ path }, caller)).rejects.toThrow('outside the worktree')
    expect(calls).toEqual([])
  })
  test('Vault waits per target and invalidates only after both confirmed successes', async () => {
    platform('darwin')
    const root = directory(), a = join(root, 'a'), b = join(root, 'b')
    writeFileSync(a, 'owned'); writeFileSync(b, 'owned')
    const first = Promise.withResolvers<RunResult>(), started = Promise.withResolvers<void>()
    const { runner, calls } = recording(async () => { if (calls.length === 1) { started.resolve(); return first.promise }; return result({ truncated: { stdout: true, stderr: true } }) })
    const { actions, requests } = vault(runner, [{ path: a, kind: 'file' }, { path: b, kind: 'file' }])
    const pending = actions.deleteSession({ id: publicId() })
    await Promise.race([started.promise, pending.then(() => { throw new Error('runner was not called') })])
    expect(requests).toEqual(['get', 'deleteTargets'])
    expect(calls).toHaveLength(1)
    first.resolve(result())
    expect(await pending).toEqual({ deleted: true, trashed: 2, alreadyMissing: false })
    expect(requests).toEqual(['get', 'deleteTargets', 'invalidate'])
    for (const [index, target] of [a, b].entries()) {
      expect(calls[index]!.argv.slice(0, 4)).toEqual(['/usr/bin/osascript', '-l', 'JavaScript', '-e'])
      expect(calls[index]!.argv[4]).toContain('trashItemAtURLResultingItemURLError')
      expect(calls[index]!.argv.slice(5)).toEqual([target])
      expect(calls[index]!.options).toEqual(ignored(86400000, 65536))
      expect(readFileSync(target, 'utf8')).toBe('owned')
    }
  })
  for (const failure of failures) {
    for (const completed of [0, 1]) test(`Vault ${failure.name} after ${completed} successes preserves partial progress`, async () => {
      platform('darwin')
      const root = directory(), a = join(root, 'a'), b = join(root, 'b')
      writeFileSync(a, 'owned'); writeFileSync(b, 'owned')
      const { runner, calls } = recording(() => calls.length <= completed ? Promise.resolve(result()) : settle(failure.value))
      const { actions, requests } = vault(runner, [{ path: a, kind: 'file' }, { path: b, kind: 'file' }])
      expect(await actions.deleteSession({ id: publicId() })).toEqual({ deleted: false, trashed: completed, alreadyMissing: false, reason: failure.reason })
      expect(calls).toHaveLength(completed + 1)
      expect(requests.filter(op => op === 'invalidate')).toHaveLength(completed)
    })
  }
  test('Vault preserves stderr diagnostics and invalidates a missing predecessor on failure', async () => {
    platform('darwin')
    const root = directory(), target = join(root, 'present')
    writeFileSync(target, 'owned')
    const { runner } = recording(async () => result({ exitCode: 7, stderr: '  fixture detail \n' }))
    const { actions, requests } = vault(runner, [{ path: join(root, 'missing'), kind: 'file' }, { path: target, kind: 'file' }])
    expect(await actions.deleteSession({ id: publicId() })).toEqual({ deleted: false, trashed: 0, alreadyMissing: false, reason: 'fixture detail' })
    expect(requests).toEqual(['get', 'deleteTargets', 'invalidate'])
  })
  test('Vault safety refusals never reach the runner', async () => {
    platform('darwin')
    const root = directory(), file = join(root, 'file'), link = join(root, 'link')
    writeFileSync(file, 'owned'); symlinkSync(file, link)
    const { runner, calls } = recording()
    await expect(vault(runner, []).actions.deleteSession({ id: publicId('remote') })).rejects.toThrow('only local')
    await expect(vault(runner, [{ path: 'relative', kind: 'file' }]).actions.deleteSession({ id: publicId() })).rejects.toThrow('non-absolute')
    for (const target of [{ path: link, kind: 'file' as const }, { path: file, kind: 'directory' as const }]) {
      expect(await vault(runner, [target]).actions.deleteSession({ id: publicId() })).toMatchObject({ deleted: false, trashed: 0, reason: 'scanner returned a symlink or wrong-kind Trash target' })
    }
    const missing = vault(runner, [{ path: join(root, 'missing'), kind: 'file' }])
    expect(await missing.actions.deleteSession({ id: publicId() })).toEqual({ deleted: true, trashed: 0, alreadyMissing: true })
    expect(missing.requests).toEqual(['get', 'deleteTargets', 'invalidate'])
    platform('linux')
    expect(await vault(runner, [{ path: file, kind: 'file' }]).actions.deleteSession({ id: publicId() })).toMatchObject({ deleted: false, reason: 'OS Trash is supported only on macOS' })
    expect(calls).toEqual([])
  })
  test('Git and Vault declare truncation support and leave no direct acquisition allowance', () => {
    boundary(['plugins/quirky.git/src/daemon/files.ts', 'plugins/quirky.vault/src/actions.ts'], { git: '1.9.0', vault: '1.9.0' })
  })
  test('the shared runner truncates both streams without stopping a successful child', async () => {
    const runner = createProcessRunner({ owner: 'g2-42-fixture', start: () => ({ pid: 424242, stdout: new Blob(['abc']).stream(), stderr: new Blob(['def']).stream(), exited: Promise.resolve({ exitCode: 0, signal: null }), killGroup() {} }) })
    try {
      const actual = await runner.run(['fixture'], { maxOutputBytes: 1, overflow: 'truncate' })
      expect(actual.exitCode).toBe(0)
      expect(actual.stopped).toBeUndefined()
      expect(actual.stdoutText).toBe('a')
      expect(actual.stderr).toBe('d')
      expect(actual.truncated).toEqual({ stdout: true, stderr: true })
    } finally { await runner.dispose() }
  })
})
