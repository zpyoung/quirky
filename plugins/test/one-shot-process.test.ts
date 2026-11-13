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
import { playSound } from '../quirky.notifications/src/player'
import { openExternal } from '../quirky.terminal/src/open-external'
import { LayoutService } from '../quirky.terminal/src/layout/service'
import { readDesktopAway } from '../quirky.mobile/src/daemon/notification-presence'
import { EmulatorService } from '../quirky.terminal/src/emulator'
import { registerMobileNotifications } from '../quirky.mobile/src/daemon/notifications'
import { NotificationReplay, type NotificationPage, type NotificationPoll } from '../quirky.mobile/src/daemon/notification-replay'

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
const ignored = (timeoutMs: number, maxOutputBytes = 1): RunOptions => ({ timeoutMs, maxOutputBytes, overflow: 'truncate', killGraceMs: 2000 })
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

describe('fire-and-forget effects keep immediate acknowledgements', () => {
  test('sound submits bounded playback immediately with an environment snapshot', async () => {
    const previous = process.env.QUIRKY_SOUND_PLAYER
    delete process.env.QUIRKY_SOUND_PLAYER
    try {
      const done = Promise.withResolvers<RunResult>()
      const { runner, calls } = recording(() => done.promise)
      const logs: string[] = []
      expect(playSound(runner, '/fixture/tone.wav', 60, message => logs.push(message))).toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.argv).toEqual(['afplay', '-v', '0.6', '/fixture/tone.wav'])
      expect(calls[0]!.options).toEqual({ ...ignored(86400000), env: { ...process.env } })
      expect(calls[0]!.options.env).not.toBe(process.env)
      done.resolve(result({ truncated: { stdout: true, stderr: true } }))
      await done.promise
      expect(logs).toEqual([])
      process.env.QUIRKY_SOUND_PLAYER = '/fixture/player with spaces'
      expect(playSound(runner, '/fixture/tone.wav', 60, message => logs.push(message))).toBeUndefined()
      expect(calls[1]!.argv).toEqual(['/fixture/player with spaces', '/fixture/tone.wav', '60'])
      expect(calls[0]!.options.env!.QUIRKY_SOUND_PLAYER).toBeUndefined()
      await Promise.resolve()
    } finally {
      if (previous === undefined) delete process.env.QUIRKY_SOUND_PLAYER
      else process.env.QUIRKY_SOUND_PLAYER = previous
    }
  })
  for (const failure of failures) test(`sound logs ${failure.name} exactly once`, async () => {
    const previous = process.env.QUIRKY_SOUND_PLAYER
    process.env.QUIRKY_SOUND_PLAYER = '/fixture/player'
    try {
      const { runner, calls } = recording(() => settle(failure.value))
      const logs: string[] = []
      expect(playSound(runner, '/fixture/tone.wav', 60, message => logs.push(message))).toBeUndefined()
      await Promise.resolve(); await Promise.resolve()
      const reasons: Record<string, string> = { signal: 'process terminated by SIGTERM', timeout: 'process stopped: timeout', aborted: 'process stopped: aborted', overflow: 'process stopped: overflow', spawn: 'fixture missing', rejection: 'fixture rejected' }
      expect(logs).toEqual([failure.name === 'exit' ? '/fixture/player exited with 7 playing /fixture/tone.wav' : `could not play /fixture/tone.wav: ${reasons[failure.name]}`])
      expect(calls).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.QUIRKY_SOUND_PLAYER
      else process.env.QUIRKY_SOUND_PLAYER = previous
    }
  })
  test('synchronous runner throws are contained for both detached effects', () => {
    const runner: ProcessRunner = { run() { throw new Error('fixture threw') } }
    const logs: string[] = []
    expect(playSound(runner, '/fixture/tone.wav', 60, message => logs.push(message))).toBeUndefined()
    expect(openExternal(runner, { target: 'https://example.test/a?b=1' }, message => logs.push(message), {})).toBeUndefined()
    expect(logs).toEqual(['could not play /fixture/tone.wav: fixture threw', 'could not open external target: fixture threw'])
  })
  test('open submits URL/reveal argv without waiting or forwarding its test environment', async () => {
    const done = Promise.withResolvers<RunResult>()
    const { runner, calls } = recording(() => done.promise)
    const logs: string[] = []
    for (const request of [{ target: 'https://example.test/a?b=1' }, { target: '/fixture/a b.txt', reveal: true }, { target: 'mailto:fixture@example.test', reveal: true }]) {
      expect(openExternal(runner, request, message => logs.push(message), { FIXTURE: 'not child env' })).toBeUndefined()
    }
    expect(calls.map(call => call.argv)).toEqual([['open', 'https://example.test/a?b=1'], ['open', '-R', '/fixture/a b.txt'], ['open', 'mailto:fixture@example.test']])
    for (const call of calls) expect(call.options).toEqual(ignored(30000))
    done.resolve(result({ truncated: { stdout: true, stderr: true } }))
    await done.promise
    expect(logs).toEqual([])
  })
  for (const failure of failures) test(`open logs ${failure.name} without later rejection`, async () => {
    const { runner, calls } = recording(() => settle(failure.value))
    const logs: string[] = []
    expect(openExternal(runner, { target: 'https://example.test/private' }, message => logs.push(message), {})).toBeUndefined()
    await Promise.resolve(); await Promise.resolve()
    const reasons: Record<string, string> = { exit: 'open exited with 7', signal: 'open terminated by SIGTERM', timeout: 'open stopped: timeout', aborted: 'open stopped: aborted', overflow: 'open stopped: overflow', spawn: 'fixture missing', rejection: 'fixture rejected' }
    expect(logs).toEqual([`could not open external target: ${reasons[failure.name]}`])
    expect(calls).toHaveLength(1)
  })
  test('open validates synchronously and retains its log-only hook', () => {
    const { runner, calls } = recording()
    for (const target of ['file:///etc/passwd', 'relative/path', '/fixture/a\nfile']) expect(() => openExternal(runner, { target }, () => {}, {})).toThrow()
    const log = join(directory(), 'open.log')
    openExternal(runner, { target: '/fixture/a b.txt', reveal: true }, () => {}, { QUIRKY_TEST_OPEN_LOG: log })
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ target: '/fixture/a b.txt', reveal: true })
    expect(() => openExternal(runner, { target: '/fixture/file' }, () => {}, { QUIRKY_TEST_OPEN_LOG: join(log, 'bad') })).toThrow()
    expect(calls).toEqual([])
  })
  test('layout acknowledges before completion using its own activation runner and bound logger', async () => {
    const done = Promise.withResolvers<RunResult>()
    const { runner, calls } = recording(() => done.promise)
    const logs: string[] = []
    const context = { process: runner, error, log(message: string) { expect(this).toBe(context); logs.push(message) } }
    const prototype = LayoutService.prototype as unknown as { openExternal(this: unknown, params: { target: string }): { ok: true } }
    const invoke = prototype.openExternal
    expect(invoke.call({ context }, { target: 'https://example.test' })).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    done.resolve(result({ stopped: 'timeout' }))
    await done.promise
    expect(logs).toEqual(['could not open external target: open stopped: timeout'])
  })
  test('both notification service branches bind the activation runner and preserve desktop delegation', () => {
    const source = readFileSync('plugins/quirky.notifications/src/service.ts', 'utf8')
    expect(source.match(/playSound\(this\.context\.process,/g)).toHaveLength(2)
    expect(source).toContain('if (!(await this.hasDesktopClient())) playSound(this.context.process,')
    expect(source).toContain('if (playHere) playSound(this.context.process,')
  })
  test('detached effects declare truncation support and remove direct acquisition allowances', () => {
    boundary(['plugins/quirky.notifications/src/player.ts', 'plugins/quirky.terminal/src/open-external.ts'], { notifications: '1.9.0', terminal: '1.9.0' })
  })
})

test('mobile presence submits both owned probes and simulator listing uses the same activation runner', async () => {
  for (const file of ['plugins/quirky.mobile/src/daemon/notification-presence.ts', 'plugins/quirky.terminal/src/emulator.ts']) expect(scanSourceContent(file, readFileSync(file, 'utf8'))).toEqual([])
  platform('darwin')
  const { runner, calls } = recording(async argv => {
    if (argv[0] === 'xcrun') return result({ stdout: Buffer.from('{"devices":{}}') })
    return result({ stdoutText: argv.includes('IOHIDSystem') ? '"HIDIdleTime" = 179999999999' : '"IOConsoleLocked" = No' })
  })
  expect(await readDesktopAway(runner)).toBe(false)
  expect(calls.map(call => call.argv)).toEqual([
    ['/usr/sbin/ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1'],
    ['/usr/sbin/ioreg', '-n', 'Root', '-d', '1', '-l']
  ])
  const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
  expect(await service.list()).toEqual({ available: true, devices: [] })
  expect(calls[2]!.argv).toEqual(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])
  expect(calls[2]!.options).toMatchObject({ timeoutMs: 10000, maxOutputBytes: 1048576, killGraceMs: 0 })
})

test.each(['deadline', 'shutdown'])('simulator cancellation maps a rejecting runner after %s', async mode => {
  platform('darwin')
  const token = 1 as unknown as Timer
  let deadline: (() => void) | undefined
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    expect(delay).toBe(10000)
    deadline = () => { if (typeof handler === 'function') handler(...args) }
    return token
  })
  const { runner } = recording((_argv, options) => {
    const done = Promise.withResolvers<RunResult>()
    options.signal!.addEventListener('abort', () => done.reject(new Error('fixture cancelled')), { once: true })
    return done.promise
  })
  const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
  try {
    const pending = service.list()
    if (mode === 'deadline') deadline!()
    else service.shutdown()
    expect(await pending).toEqual({ available: false, devices: [], reason: mode === 'deadline' ? 'simctl stopped: timeout' : 'Simulator preview service has stopped' })
  } finally {
    service.shutdown()
    timer.mockRestore()
  }
})

function deadlines() {
  const scheduled: { callback(): void; delay: number | undefined; token: Timer }[] = []
  const cleared: unknown[] = []
  const start = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    const token = (scheduled.length + 100) as unknown as Timer
    scheduled.push({ callback: () => { if (typeof handler === 'function') handler(...args) }, delay, token })
    return token
  })
  const stop = spyOn(globalThis, 'clearTimeout').mockImplementation(token => { cleared.push(token) })
  return { scheduled, cleared, restore() { start.mockRestore(); stop.mockRestore() } }
}
const device = '11111111-2222-3333-4444-555555555555'
const devicesJSON = JSON.stringify({ devices: { runtime: [{ udid: device, name: 'Owned simulator', state: 'Booted', isAvailable: true }] } })
const listed = { available: true, devices: [{ id: device, name: 'Owned simulator', state: 'Booted', runtime: 'runtime' }] }
function png(width = 1, height = 1, size = 24) {
  const bytes = Buffer.alloc(size)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes
}
async function flushRecording() {
  const done = Promise.withResolvers<void>()
  setImmediate(done.resolve)
  await done.promise
}

describe('mobile presence keeps its whole-call deadline and unknown semantics', () => {
  test.each([
    ['"HIDIdleTime" = 179999999999', '"IOConsoleLocked" = No', false],
    ['"HIDIdleTime" = 180000000000', '"IOConsoleLocked" = No', true],
    ['', '"IOConsoleLocked" = Yes', true],
    ['', '"IOConsoleLocked" = No', null],
    ['"HIDIdleTime" = 180000000000', '', null],
    ['"HIDIdleTime" = 180000000000', '"IOConsoleLocked" = unknown', null]
  ] as const)('parses HID %s and lock %s as %s', async (hid, root, expected) => {
    platform('darwin')
    const clock = deadlines()
    const a = Promise.withResolvers<RunResult>(), b = Promise.withResolvers<RunResult>()
    const { runner, calls } = recording(() => calls.length === 1 ? a.promise : b.promise)
    try {
      const pending = readDesktopAway(runner)
      expect(calls.map(call => call.argv)).toEqual([
        ['/usr/sbin/ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1'],
        ['/usr/sbin/ioreg', '-n', 'Root', '-d', '1', '-l']
      ])
      expect(clock.scheduled.map(timer => timer.delay)).toEqual([1500])
      expect(calls[0]!.options.signal).toBe(calls[1]!.options.signal)
      for (const call of calls) expect(call.options).toEqual({ timeoutMs: 1500, maxOutputBytes: 2097152, killGraceMs: 0, signal: calls[0]!.options.signal })
      a.resolve(result({ stdoutText: hid })); b.resolve(result({ stdoutText: root }))
      expect(await pending).toBe(expected)
      expect(clock.cleared).toEqual([clock.scheduled[0]!.token])
    } finally { clock.restore() }
  })
  for (const failure of failures) for (const index of [0, 1]) test(`probe ${index} ${failure.name} discards all partial presence`, async () => {
    platform('darwin')
    const clock = deadlines()
    const { runner, calls } = recording(async () => calls.length - 1 === index ? settle(failure.value) : result({ stdoutText: '"HIDIdleTime" = 180000000000 "IOConsoleLocked" = Yes' }))
    try {
      expect(await readDesktopAway(runner)).toBeNull()
      expect(calls).toHaveLength(2)
      expect(clock.cleared).toEqual([clock.scheduled[0]!.token])
    } finally { clock.restore() }
  })
  test('deadline aborts both outstanding probes and rejection aborts an unsettled sibling', async () => {
    platform('darwin')
    for (const rejectFirst of [false, true]) {
      const clock = deadlines()
      const reject = Promise.withResolvers<RunResult>()
      const { runner, calls } = recording((_argv, options) => {
        if (rejectFirst && calls.length === 1) return reject.promise
        const done = Promise.withResolvers<RunResult>()
        options.signal!.addEventListener('abort', () => done.resolve(result({ stopped: 'aborted' })), { once: true })
        return done.promise
      })
      try {
        const pending = readDesktopAway(runner)
        if (rejectFirst) reject.reject(new Error('fixture rejected'))
        else clock.scheduled[0]!.callback()
        expect(await pending).toBeNull()
        expect(calls).toHaveLength(2)
        for (const call of calls) expect(call.options.signal!.aborted).toBe(true)
        expect(clock.scheduled.map(timer => timer.delay)).toEqual([1500])
        expect(clock.cleared).toEqual([clock.scheduled[0]!.token])
      } finally { clock.restore() }
    }
  })
  test('non-Darwin presence never submits a command', async () => {
    platform('linux')
    const { runner, calls } = recording()
    expect(await readDesktopAway(runner)).toBeNull()
    expect(calls).toEqual([])
  })
  test.each([false, true, null])('subscriber records %s with its activation runner and unknown still delivers', async away => {
    platform('darwin')
    const { runner, calls } = recording(async argv => away === null ? result({ stopped: 'timeout' }) : result({ stdoutText: argv.includes('IOHIDSystem') ? '"HIDIdleTime" = 0' : `"IOConsoleLocked" = ${away ? 'Yes' : 'No'}` }))
    let notify: (event: unknown) => void = () => { throw new Error('not subscribed') }
    const methods = new Map<string, (params: NotificationPoll, caller: PluginCaller) => Promise<NotificationPage>>()
    const logs: string[] = []
    let unsubscribed = false
    const context = { process: runner, error, log: (message: string) => logs.push(message), subscribe(handler: typeof notify) { notify = handler; return () => { unsubscribed = true } }, provide(name: string, handler: (params: NotificationPoll, caller: PluginCaller) => Promise<NotificationPage>) { methods.set(name, handler) } }
    const dispose = registerMobileNotifications(context as unknown as PluginContext)
    const client = { role: 'mobile', deviceId: 'fixture-phone', connection: { id: 'fixture-connection', onClose: () => () => {} } } as unknown as PluginCaller
    try {
      notify({ type: 'notify', title: 'Owned notification', body: 'Fixture body' })
      await flushRecording()
      const poll = methods.get('method:quirky.mobile/notificationPoll')!
      const page = await poll({ waitMs: 0 }, client)
      expect(page.notifications.map(row => ({ title: row.title, desktopAway: row.desktopAway }))).toEqual([{ title: 'Owned notification', desktopAway: away }])
      const onlyAway = await poll({ waitMs: 0, onlyWhenDesktopAway: true }, client)
      expect(onlyAway.notifications).toHaveLength(away === false ? 0 : 1)
      expect(calls).toHaveLength(2)
      expect(logs).toEqual([])
    } finally { dispose() }
    expect(unsubscribed).toBe(true)
  })
  test('disposal while presence is pending prevents late replay appends', async () => {
    platform('darwin')
    const done = Promise.withResolvers<RunResult>(), started = Promise.withResolvers<void>()
    const { runner } = recording(() => { started.resolve(); return done.promise })
    let notify: (event: unknown) => void = () => {}
    const append = spyOn(NotificationReplay.prototype, 'append')
    const dispose = registerMobileNotifications({ process: runner, error, log() {}, subscribe(handler: typeof notify) { notify = handler; return () => {} }, provide() {} } as unknown as PluginContext)
    try {
      notify({ type: 'notify', title: 'Late', body: 'Owned' })
      await started.promise
      dispose()
      done.resolve(result({ stdoutText: '"IOConsoleLocked" = Yes' }))
      await flushRecording()
      expect(append).not.toHaveBeenCalled()
    } finally { done.resolve(result()); dispose(); append.mockRestore() }
  })
})

describe('simulator commands remain exact, bounded and cancellable', () => {
  test('listing uses raw stdout and removes completed controllers and deadlines', async () => {
    platform('darwin')
    const clock = deadlines()
    const { runner, calls } = recording(async () => result({ stdout: Buffer.from(devicesJSON), stdoutText: 'not the JSON bytes' }))
    const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
    try {
      expect(await service.list()).toEqual(listed)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.argv).toEqual(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])
      expect(calls[0]!.options).toEqual({ timeoutMs: 10000, maxOutputBytes: 1048576, killGraceMs: 0, signal: calls[0]!.options.signal })
      expect(clock.scheduled.map(timer => timer.delay)).toEqual([10000])
      expect(clock.cleared).toEqual([clock.scheduled[0]!.token])
      service.shutdown()
      expect(calls[0]!.options.signal!.aborted).toBe(false)
      expect(await service.list()).toEqual({ available: false, devices: [], reason: 'Simulator preview service has stopped' })
      expect(calls).toHaveLength(1)
    } finally { service.shutdown(); clock.restore() }
  })
  test('frame returns exact owned PNG bytes and cleans the temporary directory', async () => {
    platform('darwin')
    const bytes = png()
    let path = ''
    const { runner, calls } = recording(async argv => { path = argv[argv.length - 1]!; writeFileSync(path, bytes); return result() })
    const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
    try {
      const frame = await service.frame({ device })
      expect(frame).toEqual({ device, mime: 'image/png', data: bytes.toString('base64'), capturedAt: expect.any(Number) })
      expect(calls[0]!.argv).toEqual(['xcrun', 'simctl', 'io', device, 'screenshot', '--type=png', path])
      expect(calls[0]!.options).toEqual({ timeoutMs: 10000, maxOutputBytes: 1048576, killGraceMs: 0, signal: calls[0]!.options.signal })
      expect(existsSync(join(path, '..'))).toBe(false)
      await expect(service.frame({ device: 'booted' })).rejects.toMatchObject({ kind: 'invalid-params' })
      expect(calls).toHaveLength(1)
    } finally { service.shutdown() }
  })
  const reasons: Record<string, string> = { exit: 'simctl exited 7', signal: 'simctl terminated by SIGTERM', timeout: 'simctl stopped: timeout', aborted: 'simctl stopped: aborted', overflow: 'simctl output exceeds the preview limit', spawn: 'fixture missing', rejection: 'fixture rejected' }
  for (const failure of failures) test(`simulator ${failure.name} rejects partial list and frame output`, async () => {
    platform('darwin')
    const clock = deadlines()
    let path = ''
    const { runner, calls } = recording(async argv => {
      if (argv.includes('screenshot')) { path = argv[argv.length - 1]!; writeFileSync(path, png()) }
      return failure.value instanceof Error ? settle(failure.value) : { ...failure.value, stdout: Buffer.from(devicesJSON) }
    })
    const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
    try {
      expect(await service.list()).toEqual({ available: false, devices: [], reason: reasons[failure.name] })
      await expect(service.frame({ device })).rejects.toMatchObject({ kind: 'conflict', message: `Could not capture exact simulator ${device}: ${reasons[failure.name]}` })
      expect(existsSync(join(path, '..'))).toBe(false)
      expect(calls).toHaveLength(2)
      expect(clock.cleared).toEqual(clock.scheduled.map(timer => timer.token))
      service.shutdown()
      for (const call of calls) expect(call.options.signal!.aborted).toBe(false)
    } finally { service.shutdown(); clock.restore() }
  })
  test.each([
    ['not PNG', Buffer.from('not png'), 'simctl did not return a bounded PNG frame'],
    ['oversize', png(1, 1, 4 * 1024 * 1024 + 1), 'Simulator frame exceeds the 4 MiB preview limit'],
    ['too many pixels', png(4096, 4096), 'Simulator frame exceeds the 8 megapixel decode limit'],
    ['zero dimensions', png(0, 1), 'Simulator frame exceeds the 8 megapixel decode limit']
  ] as const)('frame refuses %s and still cleans up', async (_label, bytes, reason) => {
    platform('darwin')
    let path = ''
    const { runner } = recording(async argv => { path = argv[argv.length - 1]!; writeFileSync(path, bytes); return result() })
    const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
    try {
      await expect(service.frame({ device })).rejects.toThrow(reason)
      expect(existsSync(join(path, '..'))).toBe(false)
    } finally { service.shutdown() }
  })
  test('deadlines and shutdown abort all outstanding signals and clear timers', async () => {
    platform('darwin')
    for (const shutdown of [false, true]) {
      const clock = deadlines()
      const { runner, calls } = recording((_argv, options) => {
        const done = Promise.withResolvers<RunResult>()
        options.signal!.addEventListener('abort', () => done.resolve(result({ stopped: 'aborted' })), { once: true })
        return done.promise
      })
      const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
      try {
        const pending = [service.list(), service.list()]
        expect(clock.scheduled.map(timer => timer.delay)).toEqual([10000, 10000])
        if (shutdown) service.shutdown()
        else for (const timer of clock.scheduled) timer.callback()
        expect(await Promise.all(pending)).toEqual([0, 1].map(() => ({ available: false, devices: [], reason: shutdown ? 'Simulator preview service has stopped' : 'simctl stopped: timeout' })))
        for (const call of calls) expect(call.options.signal!.aborted).toBe(true)
        expect(clock.cleared).toEqual(clock.scheduled.map(timer => timer.token))
      } finally { service.shutdown(); clock.restore() }
    }
  })
  test('simulator preserves stderr on ordinary failures and platform guards make zero calls', async () => {
    platform('darwin')
    const { runner, calls } = recording(async () => result({ exitCode: 7, stderr: '  fixture detail \\n' }))
    const service = new EmulatorService({ process: runner, error } as unknown as PluginContext)
    try {
      expect(await service.list()).toEqual({ available: false, devices: [], reason: 'fixture detail \\n' })
      platform('linux')
      expect(await service.list()).toMatchObject({ available: false, devices: [] })
      await expect(service.frame({ device })).rejects.toMatchObject({ kind: 'conflict' })
      expect(calls).toHaveLength(1)
    } finally { service.shutdown() }
  })
})

test.each([1048576, 2097152])('shared runner enforces the %d-byte stopping cap independently per stream', async cap => {
  for (const stream of ['stdout', 'stderr'] as const) for (const extra of [0, 1]) {
    const runner = createProcessRunner({ owner: 'bounded-probe-fixture', start: () => ({
      pid: 424242,
      stdout: new Blob([new Uint8Array(stream === 'stdout' ? cap + extra : 0)]).stream(),
      stderr: new Blob([new Uint8Array(stream === 'stderr' ? cap + extra : 0)]).stream(),
      exited: Promise.resolve({ exitCode: 0, signal: null }), killGroup() {}
    }) })
    try {
      const value = await runner.run(['fixture'], { maxOutputBytes: cap, killGraceMs: 0 })
      expect(value.stopped).toBe(extra ? 'overflow' : undefined)
      if (!extra) expect(value.exitCode).toBe(0)
      expect(stream === 'stdout' ? value.stdout.byteLength : value.stderr.length).toBe(cap)
    } finally { await runner.dispose() }
  }
})
