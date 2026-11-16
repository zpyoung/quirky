import { expect, spyOn, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runBrowserParity, validateOutcomes, type BrowserCheck, type BrowserParityReport } from './browser-run'
import { parseBrowserArgs, createBrowserEnvironment, createBuiltinPluginsDirectory, boundedDiagnostic, decodeCliReceipt, BrowserFailure, daemonStatus, readShimLogs, startBrowserWorld, waitForDaemon, restartBrowserDaemon, areChromeProcessesGone, type BrowserWorld, type CliReceipt } from './browser-world'
import type { RuntimeInfo } from '@quirky/protocol/node'
import { startBrowserFixture } from './browser-fixture'
import type { BrowserRow } from './browser-table'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { stageBuiltinPlugins } from '../soak/world'
import { actionChecks } from './browser-checks-actions'
import { stateChecks } from './browser-checks-state'
import { networkChecks } from './browser-checks-network'
import { tabChecks } from './browser-checks-tabs'

const PARITY_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
const LINUX_PARITY_CHROME_CANDIDATES = PARITY_CHROME_CANDIDATES.slice(2)

async function withBrowserChromeProbes<T>(
  files: readonly string[],
  executablePaths: readonly string[],
  action: () => T | Promise<T>
): Promise<T> {
  const virtualPaths = new Set(PARITY_CHROME_CANDIDATES)
  const fileSet = new Set(files)
  const executableSet = new Set(executablePaths)
  const originalStatSync = fs.statSync
  const originalAccessSync = fs.accessSync
  const statSpy = spyOn(fs, 'statSync').mockImplementation(new Proxy(originalStatSync, {
    apply(target, receiver, args) {
      const candidate = String(args[0])
      if (!virtualPaths.has(candidate)) return Reflect.apply(target, receiver, args)
      return { isFile: () => fileSet.has(candidate) }
    }
  }))
  const accessSpy = spyOn(fs, 'accessSync').mockImplementation((path, mode) => {
    const candidate = String(path)
    if (virtualPaths.has(candidate)) {
      if (executableSet.has(candidate)) return
      throw Object.assign(new Error(`not executable: ${candidate}`), { code: 'EACCES' })
    }
    return originalAccessSync(path, mode)
  })
  try {
    return await action()
  } finally {
    accessSpy.mockRestore()
    statSpy.mockRestore()
  }
}

test('browser parity selects installed Linux Chrome over a poisoned inherited override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'parity-linux-chrome-'))
  const previous = process.env.QUIRKY_BROWSER_CHROME
  process.env.QUIRKY_BROWSER_CHROME = '/synthetic/poison'
  try {
    for (const candidate of LINUX_PARITY_CHROME_CANDIDATES) {
      const env = await withBrowserChromeProbes([candidate], [candidate], () =>
        createBrowserEnvironment(join(home, candidate.split('/').at(-1)!), resolve(import.meta.dir, '../..'))
      )
      expect(env.QUIRKY_BROWSER_CHROME).toBe(candidate)
    }

    const macOrder = await withBrowserChromeProbes(
      PARITY_CHROME_CANDIDATES.slice(0, 2),
      PARITY_CHROME_CANDIDATES.slice(0, 2),
      () => createBrowserEnvironment(join(home, 'mac-order'), resolve(import.meta.dir, '../..'))
    )
    expect(macOrder.QUIRKY_BROWSER_CHROME).toBe(PARITY_CHROME_CANDIDATES[0])

    const nonFileCandidate = await withBrowserChromeProbes(
      [],
      [PARITY_CHROME_CANDIDATES[0]!],
      () => createBrowserEnvironment(join(home, 'non-file'), resolve(import.meta.dir, '../..'))
    )
    expect(nonFileCandidate.QUIRKY_BROWSER_CHROME).toBeUndefined()

    const skippedInvalidCandidates = await withBrowserChromeProbes(
      [LINUX_PARITY_CHROME_CANDIDATES[1]!, LINUX_PARITY_CHROME_CANDIDATES[2]!],
      [LINUX_PARITY_CHROME_CANDIDATES[0]!, LINUX_PARITY_CHROME_CANDIDATES[2]!],
      () => createBrowserEnvironment(join(home, 'candidate-validation'), resolve(import.meta.dir, '../..'))
    )
    expect(skippedInvalidCandidates.QUIRKY_BROWSER_CHROME).toBe(LINUX_PARITY_CHROME_CANDIDATES[2])
  } finally {
    if (previous === undefined) delete process.env.QUIRKY_BROWSER_CHROME
    else process.env.QUIRKY_BROWSER_CHROME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('browser parity keeps missing Chrome visible when no installed candidate exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'parity-missing-chrome-'))
  const previous = process.env.QUIRKY_BROWSER_CHROME
  process.env.QUIRKY_BROWSER_CHROME = '/synthetic/poison'
  try {
    const env = await withBrowserChromeProbes([], [], () =>
      createBrowserEnvironment(home, resolve(import.meta.dir, '../..'))
    )
    expect(env.QUIRKY_BROWSER_CHROME).toBeUndefined()
    const startup = await withBrowserChromeProbes([], [], () =>
      startBrowserWorld({ beforeBrowser: true, deadline: Date.now() + 20_000 }).then(
        () => undefined,
        (error: unknown) => error
      )
    )
    expect(startup).toBeInstanceOf(BrowserFailure)
    expect(startup).toMatchObject({ kind: 'missing-chrome' })
  } finally {
    if (previous === undefined) delete process.env.QUIRKY_BROWSER_CHROME
    else process.env.QUIRKY_BROWSER_CHROME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('daemon status retries transient health misses while the owned daemon remains alive', async () => {
  const runtime: RuntimeInfo = { pid: 37, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  let attempts = 0
  let now = 0
  const alive = await daemonStatus('/owned/home', { pid: runtime.pid, exited: Promise.withResolvers<number>().promise }, 5_000, {
    now: () => now,
    readRuntime: () => runtime,
    isDaemonAlive: async () => ++attempts >= 3,
    sleep: async (milliseconds) => { now += milliseconds }
  })
  expect(alive).toBe(true)
  expect(attempts).toBe(3)
})

test('daemon status returns immediately when the owned daemon exits during a probe', async () => {
  const runtime: RuntimeInfo = { pid: 38, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  const probe = Promise.withResolvers<boolean>()
  const exited = Promise.withResolvers<number>()
  const probeStarted = Promise.withResolvers<void>()
  const status = daemonStatus('/owned/home', { pid: runtime.pid, exited: exited.promise }, 5_000, {
    now: () => 0,
    readRuntime: () => runtime,
    isDaemonAlive: () => { probeStarted.resolve(); return probe.promise }
  })
  await probeStarted.promise
  exited.resolve(0)
  expect(await status).toBe(false)
})

test('daemon status stops a pending probe when the world is aborted', async () => {
  const runtime: RuntimeInfo = { pid: 41, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  const controller = new AbortController()
  const probe = Promise.withResolvers<boolean>()
  const probeStarted = Promise.withResolvers<void>()
  const status = daemonStatus('/owned/home', { pid: runtime.pid, exited: Promise.withResolvers<number>().promise }, 5_000, {
    signal: controller.signal,
    now: () => 0,
    readRuntime: () => runtime,
    isDaemonAlive: () => { probeStarted.resolve(); return probe.promise }
  })
  await probeStarted.promise
  controller.abort()
  expect(await status).toBe(false)
})

test('daemon status refuses missing or mismatched runtime ownership before probing', async () => {
  const runtime: RuntimeInfo = { pid: 39, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  for (const current of [null, { ...runtime, pid: runtime.pid + 1 }]) {
    let probes = 0
    const status = await daemonStatus('/owned/home', { pid: runtime.pid, exited: Promise.withResolvers<number>().promise }, 5_000, {
      now: () => 0,
      readRuntime: () => current,
      isDaemonAlive: async () => { probes++; return true }
    })
    expect(status).toBe(false)
    expect(probes).toBe(0)
  }
})

test('daemon status rejects a successful probe after runtime ownership changes', async () => {
  const runtime: RuntimeInfo = { pid: 40, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  let reads = 0
  const status = await daemonStatus('/owned/home', { pid: runtime.pid, exited: Promise.withResolvers<number>().promise }, 5_000, {
    now: () => 0,
    readRuntime: () => ++reads === 1 ? runtime : { ...runtime, pid: runtime.pid + 1 },
    isDaemonAlive: async () => true
  })
  expect(status).toBe(false)
})

test('daemon status refuses a health reply received after its retry budget', async () => {
  const runtime: RuntimeInfo = { pid: 42, port: 1, token: '', hookToken: '', daemonVersion: 'test', protocolVersion: 1, startedAt: 0 }
  let now = 0
  const status = await daemonStatus('/owned/home', { pid: runtime.pid, exited: Promise.withResolvers<number>().promise }, 5_000, {
    now: () => now,
    readRuntime: () => runtime,
    isDaemonAlive: async () => { now = 5_001; return true }
  })
  expect(status).toBe(false)
})

test('builtin plugin fixture stages every checkout plugin except Accounts', () => {
  const repoRoot = resolve(import.meta.dir, '../..')
  const checkout = realpathSync(repoRoot)
  const pluginsRoot = join(checkout, 'plugins')
  const home = mkdtempSync(join(tmpdir(), 'quirky-browser-plugins-'))
  try {
    const expected = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(pluginsRoot, entry.name, 'quirky-plugin.json')))
      .map((entry) => {
        const manifest: unknown = JSON.parse(readFileSync(join(pluginsRoot, entry.name, 'quirky-plugin.json'), 'utf8'))
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
          !('id' in manifest) || typeof manifest.id !== 'string') {
          throw new Error(`plugin manifest is missing a string id: ${entry.name}`)
        }
        return { name: entry.name, id: manifest.id }
      })
    const included = expected.filter((plugin) => plugin.id !== 'quirky.accounts')
    const env: Record<string, string> = {}
    const fixture = createBuiltinPluginsDirectory(home, checkout, env)

    expect(fixture.includedPlugins).toEqual(included.map(({ id }) => id).sort())
    expect(fixture.excludedPlugins).toEqual(['quirky.accounts'])
    expect(readdirSync(fixture.directory).sort()).toEqual(included.map(({ name }) => name).sort())
    expect(env.QUIRKY_PLUGINS_DIR).toBe(fixture.directory)
    expect(env.QUIRKY_BUILTIN_PLUGINS_DIR).toBe(fixture.directory)
    for (const plugin of included) {
      const staged = join(fixture.directory, plugin.name)
      expect(lstatSync(staged).isSymbolicLink()).toBe(false)
      expect(lstatSync(staged).isDirectory()).toBe(true)
      expect(realpathSync(staged).startsWith(`${realpathSync(home)}${sep}`)).toBe(true)
      expect(readFileSync(join(staged, 'quirky-plugin.json'), 'utf8')).toBe(readFileSync(join(pluginsRoot, plugin.name, 'quirky-plugin.json'), 'utf8'))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Browser preparation reuses staged outputs and excludes Accounts without touching checkout output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-browser-staging-'))
  const checkout = join(root, 'checkout')
  const home = join(root, 'home')
  const names = ['quirky.accounts', 'quirky.palette', 'quirky.headless']
  const snapshot = (directory: string) => {
    const rows: unknown[] = []
    const visit = (path: string) => {
      const stat = lstatSync(path)
      rows.push([path, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
        stat.isFile() ? readFileSync(path).toString('base64') : 'directory'])
      if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child))
    }
    visit(directory)
    return rows
  }
  try {
    mkdirSync(home, { recursive: true })
    for (const name of names) {
      const plugin = join(checkout, 'plugins', name)
      mkdirSync(join(plugin, 'src'), { recursive: true })
      writeFileSync(join(plugin, 'quirky-plugin.json'), JSON.stringify({ id: name, name, version: '1.0.0' }))
      writeFileSync(join(plugin, 'src', 'main.ts'), 'export function activate() {}\n')
      if (name !== 'quirky.headless') {
        mkdirSync(join(plugin, 'dist'))
        writeFileSync(join(plugin, 'dist', 'canary.txt'), `${name} source output\n`)
      }
    }
    writeFileSync(join(checkout, 'plugins', 'quirky.palette', 'src', 'ui.tsx'), 'export function activate() { return "fixture" }\n')
    const before = snapshot(join(checkout, 'plugins'))
    const staged = stageBuiltinPlugins(checkout, home)
    const preparationEnv = createIsolatedRuntimeEnvironment(home, { repoRoot: checkout })
    preparationEnv.QUIRKY_PLUGINS_DIR = staged
    preparationEnv.QUIRKY_BUILTIN_PLUGINS_DIR = staged
    const browserEnv = createBrowserEnvironment(home, checkout)
    const fixture = createBuiltinPluginsDirectory(home, checkout, browserEnv)
    Object.assign(preparationEnv, browserEnv)

    expect(fixture.directory).toBe(staged)
    expect(fixture.includedPlugins).toEqual(['quirky.headless', 'quirky.palette'])
    expect(fixture.excludedPlugins).toEqual(['quirky.accounts'])
    expect(existsSync(join(staged, 'quirky.accounts'))).toBe(false)
    expect(browserEnv.QUIRKY_PLUGINS_DIR).toBe(staged)
    expect(browserEnv.QUIRKY_BUILTIN_PLUGINS_DIR).toBe(staged)
    expect(preparationEnv.QUIRKY_PLUGINS_DIR).toBe(preparationEnv.QUIRKY_BUILTIN_PLUGINS_DIR)
    expect(lstatSync(staged).isSymbolicLink()).toBe(false)
    for (const name of fixture.includedPlugins) expect(lstatSync(join(staged, name)).isSymbolicLink()).toBe(false)

    const output = join(preparationEnv.QUIRKY_PLUGINS_DIR, 'quirky.palette', 'dist')
    const build = await Bun.build({
      entrypoints: [join(staged, 'quirky.palette', 'src', 'ui.tsx')],
      outdir: output,
      target: 'browser',
      naming: 'ui.js'
    })
    expect(build.success).toBe(true)
    expect(lstatSync(output).isDirectory()).toBe(true)
    expect(lstatSync(output).isSymbolicLink()).toBe(false)
    const served = join(preparationEnv.QUIRKY_BUILTIN_PLUGINS_DIR, 'quirky.palette', 'dist', 'ui.js')
    expect(realpathSync(served).startsWith(`${realpathSync(home)}${sep}`)).toBe(true)
    expect(readFileSync(served, 'utf8')).toBe(await build.outputs[0]!.text())
    expect(existsSync(join(checkout, 'plugins', 'quirky.headless', 'dist'))).toBe(false)
    expect(snapshot(join(checkout, 'plugins'))).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const row = (id: string, disposition: BrowserRow['disposition'] = 'covered'): BrowserRow => ({
  id, command: id, equivalent: `quirky browser ${id}`, check: id, disposition, reason: disposition === 'gap' ? 'known capability gap' : '', primary: true, deferred: false
})
const fakeWorld = (cleanup: BrowserWorld['cleanup'] = async () => ({ ok: true })): BrowserWorld => ({
  home: '/owned/home', env: {}, fixture: {
    origin: 'http://127.0.0.1:1234', startedAt: 0, requests: [], dialogCount: 0,
    waitForDialog: async () => {}, waitForGate: async () => {}, releaseGate: () => {}, stop: async () => {}
  }, worktreeA: 'a', worktreeB: 'b', daemonPid: 1,
  cli: async () => ({ argv: [], result: {}, exitCode: 0, stderrTail: '' }), cleanup, processEvidence: async () => ({})
})
type ProfileDeleteOutcome = 'refused' | 'completed' | 'metadata-retained' | 'directory-retained'
const profileDeleteWorld = (home: string, outcome: ProfileDeleteOutcome) => {
  const world = fakeWorld()
  world.home = home
  const chromeProfile = join(home, 'data', 'profiles', 'profile_g107', 'chrome-profile')
  mkdirSync(chromeProfile, { recursive: true })
  const profile = { id: 'profile_g107', label: 'Delete proof', scope: 'isolated' }
  let metadataPresent = true
  world.cli = async argv => {
    const flagIndex = argv.findIndex(argument => argument.startsWith('--'))
    const command = argv.slice(1, flagIndex < 0 ? argv.length : flagIndex).join(' ')
    if (command === 'tab profile create') return { argv, result: { profile }, exitCode: 0, stderrTail: '' }
    if (command === 'tab profile list') return { argv, result: { profiles: metadataPresent ? [profile] : [] }, exitCode: 0, stderrTail: '' }
    if (command === 'tab create') return { argv, result: { browserPageId: 'page-profile-delete', profileId: profile.id }, exitCode: 0, stderrTail: '' }
    if (command === 'cookie set') return { argv, result: { success: true }, exitCode: 0, stderrTail: '' }
    if (command === 'tab close') return { argv, result: { closed: true }, exitCode: 0, stderrTail: '' }
    if (command === 'tab profile delete') {
      if (outcome === 'refused') return {
        argv,
        result: { error: { code: 'conflict', message: 'browser_error: Native storage clearance requires a live desktop acknowledgement; no Quirky window is open' } },
        exitCode: 1,
        stderrTail: ''
      }
      if (outcome !== 'directory-retained') rmSync(chromeProfile, { recursive: true, force: true })
      if (outcome !== 'metadata-retained') metadataPresent = false
      return { argv, result: { deleted: true }, exitCode: 0, stderrTail: '' }
    }
    throw new Error(`unexpected profile-delete command ${command}`)
  }
  return { world, chromeProfile }
}
const runProfileDelete = async (
  outcome: ProfileDeleteOutcome,
  inspect: (report: BrowserParityReport, chromeProfile: string) => void
) => {
  const home = mkdtempSync(join(tmpdir(), 'browser-profile-delete-'))
  try {
    const { world, chromeProfile } = profileDeleteWorld(home, outcome)
    const check = tabChecks.find(candidate => candidate.id === 'tab-profile-delete')
    if (!check) throw new Error('missing tab-profile-delete check')
    const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
    inspect(report, chromeProfile)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('closed arguments reject caller targets before allocation', () => {
  for (const arg of ['--home', '--runtime', '--repo', '--url', '--page', '--profile', '--command', '--chrome', '--unknown']) {
    expect(() => parseBrowserArgs([arg, 'target'])).toThrow()
  }
  expect(parseBrowserArgs(['--json'])).toEqual({ json: true, help: false })
  expect(parseBrowserArgs(['--help'])).toEqual({ json: false, help: true })
})

test('invalid public arguments exit 2 without allocating runner state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-arguments-'))
  try {
    for (const arg of ['--home', '--runtime', '--repo', '--url', '--page', '--profile', '--command', '--chrome', '--unknown']) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'browser.ts'), arg, 'target'], {
        env: { ...createIsolatedRuntimeEnvironment(home, { repoRoot: join(import.meta.dir, '../..') }), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdout: 'pipe', stderr: 'pipe', timeout: 5_000
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      expect(await child.exited).toBe(2)
      expect(await stdout).toBe('')
      expect(await stderr).toBeTruthy()
      expect(readdirSync(home)).toEqual([])
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('owned environment does not inherit parent identities, proxies or browser overrides', async () => {
  const home = mkdtempSync(join(tmpdir(), `parity ' ; $ home-`))
  const keys = ['HOME', 'QUIRKY_HOME', 'QUIRKY_RUNTIME', 'QUIRKY_PAIRING', 'AGENT_BROWSER_SESSION', 'HTTP_PROXY', 'GIT_CONFIG_GLOBAL', 'QUIRKY_BROWSER_CHROME']
  const source = `import {createBrowserEnvironment} from ${JSON.stringify(join(import.meta.dir, 'browser-world.ts'))};
    for (const key of ${JSON.stringify(keys)}) process.env[key]='/synthetic/poison';
    console.log(JSON.stringify(createBrowserEnvironment(${JSON.stringify(home)},${JSON.stringify(join(import.meta.dir, '../..'))})));`
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...createIsolatedRuntimeEnvironment(home, { repoRoot: join(import.meta.dir, '../..') }), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    stdout: 'pipe', stderr: 'pipe', timeout: 5_000
  })
  try {
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(await stderr).toBe('')
    const parsed: unknown = JSON.parse(await stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('environment child returned no object')
    const env: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed)) env[key] = value
    expect(env.QUIRKY_HOME).toBe(home)
    expect(env.HOME).not.toBe('/synthetic/poison')
    for (const key of keys.filter(key => !['HOME', 'QUIRKY_HOME', 'GIT_CONFIG_GLOBAL', 'QUIRKY_BROWSER_CHROME'].includes(key))) expect(env[key]).toBeUndefined()
    expect(env.QUIRKY_BROWSER_CHROME).not.toBe('/synthetic/poison')
    expect(env.GIT_CONFIG_GLOBAL).not.toBe('/synthetic/poison')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('fixture destinations and dialog barrier remain loopback and self contained', async () => {
  const f = startBrowserFixture()
  try {
    const page = await (await fetch(`${f.origin}/page`)).text()
    expect(page).toContain('Text field')
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/)
    expect(page).not.toMatch(/src=["']\/\//)
    const previous = f.dialogCount
    const observed = f.waitForDialog(previous)
    await fetch(`${f.origin}/dialog-opening`, { method: 'POST' })
    await observed
    expect(f.dialogCount).toBe(previous + 1)
    expect(await (await fetch(`${f.origin}/download`)).text()).toBe('download-proof\n')
    expect((await fetch(`${f.origin}/auth`)).status).toBe(401)
    expect(await (await fetch(`${f.origin}/auth`, { headers: { authorization: `Basic ${btoa('parity:fixture-only')}` } })).text()).toBe('authenticated')
  } finally { await f.stop() }
})

for (const kind of ['missing-chrome', 'missing-helper', 'malformed-cli-json', 'cli-nonzero', 'wrong-page', 'lost-cookie', 'daemon-exited', 'deadline']) {
  test(`${kind} fails instead of converting a declared gap to success`, async () => {
    let cleaned = false
    const checks: BrowserCheck[] = [{ id: 'first', run: async () => { throw new BrowserFailure(kind, 'operation failed') } }, { id: 'second', run: async () => ({ observed: true }) }]
    const report = await runBrowserParity({ rows: [row('first', 'gap'), row('second')], checks, startWorld: async () => fakeWorld(async () => { cleaned = true; return { ok: true } }) })
    expect(report.ok).toBe(false)
    expect(report.rows[0]).toMatchObject({ status: 'failed', executed: true, error: { kind } })
    expect(report.rows[1]).toMatchObject({ status: 'not-run', executed: false })
    expect(cleaned).toBe(true)
  })
}

test('startup failure identifies its stage and leaves checks not run', async () => {
  const report = await runBrowserParity({ rows: [row('first')], checks: [], startWorld: async () => { throw new BrowserFailure('missing-chrome', 'not installed') } })
  expect(report.ok).toBe(false)
  expect(report.rows[0]?.status).toBe('not-run')
  expect(report.error?.kind).toBe('missing-chrome')
})

test('missing executable check fails rather than disappearing from the report', async () => {
  const report = await runBrowserParity({ rows: [row('missing')], checks: [], startWorld: async () => fakeWorld() })
  expect(report.ok).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'missing-check' } })
})

test('cleanup failure preserves the earlier row failure', async () => {
  const report = await runBrowserParity({ rows: [row('first')], checks: [{ id: 'first', run: async () => { throw new BrowserFailure('wrong-page', 'wrong page') } }], startWorld: async () => fakeWorld(async () => ({ ok: false, error: 'cleanup-failed' })) })
  expect(report.ok).toBe(false)
  expect(report.cleanup).toMatchObject({ ok: false })
  expect(report.rows[0]?.error?.kind).toBe('wrong-page')
})

test('deferred observer cannot be forged into a pass and gaps keep parity incomplete', async () => {
  const deferred = { ...row('worktree-watch-page', 'gap'), check: undefined, deferred: true, primary: false, reason: 'Prove CLI page identity in a worktree Watch pane across daemon restart' }
  const report = await runBrowserParity({ rows: [deferred], checks: [], startWorld: async () => fakeWorld() })
  expect(report.ok).toBe(true)
  expect(report.parityComplete).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'gap', executed: false })
  expect(() => validateOutcomes([deferred], [{ ...report.rows[0]!, status: 'passed' }], [])).toThrow()
})

test('diagnostics drain to bounded tails and redact homes and tokens', () => {
  const diagnostic = boundedDiagnostic('x'.repeat(20000) + '/owned/home secret-token', '/owned/home', ['secret-token'])
  expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8192)
  expect(diagnostic).toContain('<browser-home>')
  expect(diagnostic).not.toContain('secret-token')
})

test('a repaired executable gap can pass without requiring the old defect', async () => {
  const report = await runBrowserParity({ rows: [row('first', 'gap')], checks: [{ id: 'first', run: async () => ({ observed: 'desired behavior' }) }], startWorld: async () => fakeWorld() })
  expect(report.ok).toBe(true)
  expect(report.parityComplete).toBe(true)
  expect(report.rows[0]).toMatchObject({ status: 'passed', executed: true })
})

test('an undeclared gap is an evidence failure, not a new exclusion', async () => {
  const report = await runBrowserParity({ rows: [row('first')], checks: [{ id: 'first', run: async () => ({ gap: 'unexpected limitation' }) }], startWorld: async () => fakeWorld() })
  expect(report.ok).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'invalid-report' } })
})

test('CLI decoding rejects malformed success and preserves structured refusals', () => {
  const argv = ['browser', 'eval', '--expression', '42']
  try {
    decodeCliReceipt(argv, 'not JSON', '', 0, '/owned/home')
    throw new Error('decoder accepted malformed JSON')
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserFailure)
    if (error instanceof BrowserFailure) expect(error.kind).toBe('malformed-cli-json')
  }
  const refusal = { error: { code: 'conflict', message: 'no Quirky window is open' } }
  const receipt = decodeCliReceipt(argv, JSON.stringify(refusal), 'λ'.repeat(10000), 1, '/owned/home', true)
  expect(receipt.exitCode).toBe(1)
  expect(receipt.result).toEqual(refusal)
  expect(Buffer.byteLength(receipt.stderrTail)).toBeLessThanOrEqual(8192)
  try {
    decodeCliReceipt(argv, JSON.stringify(refusal), '', 1, '/owned/home')
    throw new Error('decoder accepted an unexpected nonzero result')
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserFailure)
    if (error instanceof BrowserFailure) expect(error.kind).toBe('cli-nonzero')
  }
})

test('startup cleanup failure retains both errors without claiming successful teardown', async () => {
  const error = new BrowserFailure('daemon-exited', 'daemon stopped during startup')
  error.cleanup = { ok: false, error: 'cleanup-failed' }
  const report = await runBrowserParity({ rows: [row('first')], checks: [], startWorld: async () => { throw error } })
  expect(report.error?.kind).toBe('daemon-exited')
  expect(report.cleanup).toEqual({ ok: false, error: 'cleanup-failed' })
  expect(report.ok).toBe(false)
})

test('fixture waits release on cancellation and server shutdown', async () => {
  const f = startBrowserFixture()
  const controller = new AbortController()
  const cancelled = f.waitForDialog(f.dialogCount, controller.signal).catch((error: unknown) => error)
  const gateCancelled = f.waitForGate('cancelled', controller.signal).catch((error: unknown) => error)
  controller.abort(new Error('cancelled fixture wait'))
  const cancellation = await cancelled
  expect(cancellation).toBeInstanceOf(Error)
  if (cancellation instanceof Error) expect(cancellation.message).toBe('cancelled fixture wait')
  const gateCancellation = await gateCancelled
  expect(gateCancellation).toBeInstanceOf(Error)
  if (gateCancellation instanceof Error) expect(gateCancellation.message).toBe('cancelled fixture wait')

  const held = fetch(`${f.origin}/wait-gate?key=released`)
  await f.waitForGate('released')
  f.releaseGate('released')
  const released = await held
  expect(released.ok).toBe(true)
  expect(await released.text()).toContain('__parityWaitGateReleased')

  const stopped = f.waitForDialog(f.dialogCount).catch((error: unknown) => error)
  const stoppedGate = f.waitForGate('shutdown').catch((error: unknown) => error)
  await f.stop()
  const shutdown = await stopped
  expect(shutdown).toBeInstanceOf(Error)
  if (shutdown instanceof Error) expect(shutdown.message).toContain('stopped')
  const gateShutdown = await stoppedGate
  expect(gateShutdown).toBeInstanceOf(Error)
  if (gateShutdown instanceof Error) expect(gateShutdown.message).toContain('stopped')
})
test('wait evidence rejects an immediate success while the fixture gate is held', async () => {
  const world = fakeWorld()
  let waitCalls = 0
  world.cli = async argv => {
    const flagIndex = argv.findIndex(argument => argument.startsWith('--'))
    const command = argv.slice(0, flagIndex < 0 ? argv.length : flagIndex).join(' ')
    if (command === 'browser goto') {
      const url = String(argv[argv.indexOf('--url') + 1])
      return { argv, result: { url, title: url.endsWith('/page') ? 'Parity fixture' : '' }, exitCode: 0, stderrTail: '' }
    }
    if (command === 'browser click') return { argv, result: { clicked: '#readyButton' }, exitCode: 0, stderrTail: '' }
    if (command === 'browser wait') {
      waitCalls += 1
      return { argv, result: { waited: true }, exitCode: 0, stderrTail: '' }
    }
    if (command === 'browser eval') {
      const expression = String(argv[argv.indexOf('--expression') + 1])
      if (expression === 'location.href') return { argv, result: { value: `${world.fixture.origin}/page` }, exitCode: 0, stderrTail: '' }
      if (expression === 'document.title') return { argv, result: { value: 'Parity fixture' }, exitCode: 0, stderrTail: '' }
      return { argv, result: { value: false }, exitCode: 0, stderrTail: '' }
    }
    throw new Error(`unexpected wait evidence command ${command}`)
  }
  const source = actionChecks.find(check => check.id === 'wait-selector')
  if (!source) throw new Error('missing wait-selector check')
  const check: BrowserCheck = {
    ...source,
    async run(c) {
      c.state.pageA = 'page-a'
      c.state.pageB = 'page-b'
      return await source.run(c)
    }
  }
  const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
  expect(waitCalls).toBe(1)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'wrong-page' } })
  expect(report.rows[0].status).not.toBe('passed')
})


function heldInterceptWorld(listedPending: boolean): BrowserWorld {
  const world = fakeWorld()
  const key = '__g10_1_intercept_enable'
  const pattern = '*g10-1-intercept-enable*'
  const url = `${world.fixture.origin}/intercept?probe=g10-1-intercept-enable`
  const expression = `window[${JSON.stringify(key)}]`
  let disabled = false
  world.cli = async argv => {
    const flagIndex = argv.findIndex(argument => argument.startsWith('--'))
    const command = argv.slice(0, flagIndex < 0 ? argv.length : flagIndex).join(' ')
    if (command === 'browser intercept enable') return { argv, result: { enabled: true, patterns: [pattern] }, exitCode: 0, stderrTail: '' }
    if (command === 'browser intercept list') return { argv, result: { patterns: [pattern], requests: [{ url, pending: listedPending }] }, exitCode: 0, stderrTail: '' }
    if (command === 'browser intercept disable') {
      disabled = true
      world.fixture.requests.push({ path: '/intercept', method: 'GET', headers: {} })
      return { argv, result: { disabled: true }, exitCode: 0, stderrTail: '' }
    }
    if (command === 'browser eval') {
      const source = String(argv[argv.indexOf('--expression') + 1])
      if (source === expression) {
        const value = disabled
          ? { status: 'fulfilled', responseStatus: 200, body: 'intercept-proof' }
          : { status: 'pending' }
        return { argv, result: { value }, exitCode: 0, stderrTail: '' }
      }
      return { argv, result: { value: true }, exitCode: 0, stderrTail: '' }
    }
    throw new Error(`unexpected interception command ${command}`)
  }
  return world
}

test('interception auto-delivery fails as wrong-page evidence', async () => {
  const world = fakeWorld()
  const key = '__g10_1_intercept_enable'
  const pattern = '*g10-1-intercept-enable*'
  const url = `${world.fixture.origin}/intercept?probe=g10-1-intercept-enable`
  const expression = `window[${JSON.stringify(key)}]`
  let stateReads = 0
  world.cli = async argv => {
    const flagIndex = argv.findIndex(argument => argument.startsWith('--'))
    const command = argv.slice(0, flagIndex < 0 ? argv.length : flagIndex).join(' ')
    if (command === 'browser intercept enable') return { argv, result: { enabled: true, patterns: [pattern] }, exitCode: 0, stderrTail: '' }
    if (command === 'browser intercept list') return { argv, result: { patterns: [pattern], requests: [{ url, pending: false }] }, exitCode: 0, stderrTail: '' }
    if (command === 'browser intercept disable') return { argv, result: { disabled: true }, exitCode: 0, stderrTail: '' }
    if (command === 'browser eval') {
      const source = String(argv[argv.indexOf('--expression') + 1])
      if (source === expression) {
        stateReads += 1
        if (stateReads === 1) return { argv, result: { value: { status: 'pending' } }, exitCode: 0, stderrTail: '' }
        if (stateReads === 2) world.fixture.requests.push({ path: '/intercept', method: 'GET', headers: {} })
        return { argv, result: { value: { status: 'fulfilled', responseStatus: 200, body: 'intercept-proof' } }, exitCode: 0, stderrTail: '' }
      }
      return { argv, result: { value: true }, exitCode: 0, stderrTail: '' }
    }
    throw new Error(`unexpected interception command ${command}`)
  }
  const source = networkChecks.find(check => check.id === 'intercept-enable')
  if (!source) throw new Error('missing intercept-enable check')
  const check: BrowserCheck = {
    ...source,
    async run(c) {
      c.state.pageA = 'page-a'
      return await source.run(c)
    }
  }
  const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
  expect(stateReads).toBeGreaterThanOrEqual(3)
  expect(report.ok).toBe(false)
  expect(report.parityComplete).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'wrong-page' } })
})

test('a held interception passes with pending evidence', async () => {
  const world = heldInterceptWorld(true)
  const source = networkChecks.find(check => check.id === 'intercept-enable')
  if (!source) throw new Error('missing intercept-enable check')
  const check: BrowserCheck = {
    ...source,
    async run(c) {
      c.state.pageA = 'page-a'
      return await source.run(c)
    }
  }
  const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
  expect(world.fixture.requests.filter(request => request.path === '/intercept')).toHaveLength(1)
  expect(report.rows[0]).toMatchObject({
    status: 'passed',
    evidence: {
      pendingBeforeDisable: true,
      listedPending: true,
      serverRequestsBeforeDisable: 0,
      serverRequestsAfterDisable: 1,
      responseStatus: 200,
      responseBody: 'intercept-proof'
    }
  })
})

test('a listed interception without pending evidence fails as wrong-page', async () => {
  const world = heldInterceptWorld(false)
  const source = networkChecks.find(check => check.id === 'intercept-enable')
  if (!source) throw new Error('missing intercept-enable check')
  const check: BrowserCheck = {
    ...source,
    async run(c) {
      c.state.pageA = 'page-a'
      return await source.run(c)
    }
  }
  const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'wrong-page' } })
})

test('a refused profile deletion fails with cli-nonzero and retains its directory', async () => {
  await runProfileDelete('refused', (report, chromeProfile) => {
    expect(report.ok).toBe(false)
    expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'cli-nonzero' } })
    expect(existsSync(chromeProfile)).toBe(true)
  })
})

test('a completed profile deletion passes with removed metadata and directory', async () => {
  await runProfileDelete('completed', (report, chromeProfile) => {
    expect(report.rows[0]).toMatchObject({
      status: 'passed',
      evidence: { deleted: true, metadataRemoved: true, chromeRemoved: true }
    })
    expect(existsSync(chromeProfile)).toBe(false)
  })
})

test('profile deletion fails when metadata is retained', async () => {
  await runProfileDelete('metadata-retained', (report, chromeProfile) => {
    expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'wrong-page' } })
    expect(existsSync(chromeProfile)).toBe(false)
  })
})

test('profile deletion fails when the Chrome directory is retained', async () => {
  await runProfileDelete('directory-retained', (report, chromeProfile) => {
    expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'wrong-page' } })
    expect(existsSync(chromeProfile)).toBe(true)
  })
})
test('cookie evidence rejects a successful setter whose independent read lost the cookie', async () => {
  const world = fakeWorld()
  world.cli = async argv => {
    const command = argv.slice(0, 3).join(' ')
    if (command !== 'browser cookie set' && command !== 'browser cookie get') throw new Error(`unexpected test command ${command}`)
    return { argv, result: command === 'browser cookie set' ? { success: true } : { cookies: [] }, exitCode: 0, stderrTail: '' }
  }
  const check = stateChecks.find(check => check.id === 'cookie-set')!
  const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
  expect(report.ok).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'lost-cookie' } })
})

test('worktree decoding accepts control metadata but rejects malformed ownership fields', () => {
  const worktree = { id: 'owned-worktree', repoId: 'owned-repo', path: '/owned/repository', kind: 'folder', tagIds: [] }
  const receipt = decodeCliReceipt(['worktree', 'list'], JSON.stringify([worktree]), '', 0, '/owned')
  expect(receipt.result).toEqual([worktree])
  expect(() => decodeCliReceipt(['worktree', 'list'], JSON.stringify([{ ...worktree, path: 42 }]), '', 0, '/owned')).toThrow('CLI JSON does not match')
})

test('CLI decoding validates opaque object results without treating them as empty records', () => {
  const result = { command: { path: ['fill'], positionals: ['#text', 'proof'], flags: {} }, result: { filled: '#text' } }
  const receipt = decodeCliReceipt(['browser', 'exec'], JSON.stringify(result), '', 0, '/owned')
  expect(receipt.result).toEqual(result)
  expect(() => decodeCliReceipt(['browser', 'exec'], JSON.stringify({ ...result, command: 42 }), '', 0, '/owned')).toThrow('command must be an object')
})

for (const outcome of ['tab-changed', 'fixed', 'timeout', 'other-fault', 'wrong-url'] as const) {
  test(`pending URL wait classifies ${outcome} without hiding other failures`, async () => {
    const world = fakeWorld()
    const waiting = Promise.withResolvers<CliReceipt>()
    let released = false
    let waitCalls = 0
    let waitArgv: string[] = []
    const fault = outcome === 'timeout'
      ? { code: 'conflict', message: 'browser_timeout: wait timed out' }
      : outcome === 'other-fault'
        ? { code: 'not-found', message: 'browser_tab_changed: browser page identity changed during the operation' }
        : { code: 'conflict', message: 'browser_tab_changed: browser page identity changed during the operation' }
    world.fixture.releaseGate = () => {
      released = true
      waiting.resolve({ argv: waitArgv, result: outcome === 'fixed' ? { waited: true } : { error: fault }, exitCode: outcome === 'fixed' ? 0 : 1, stderrTail: '' })
    }
    world.cli = async argv => {
      const flagIndex = argv.findIndex(argument => argument.startsWith('--'))
      const command = argv.slice(0, flagIndex < 0 ? argv.length : flagIndex).join(' ')
      if (command === 'browser goto') {
        const url = argv[argv.indexOf('--url') + 1]
        return { argv, result: { url, title: url.endsWith('/page') ? 'Parity fixture' : '' }, exitCode: 0, stderrTail: '' }
      }
      if (command === 'browser get') return { argv, result: { value: `${world.fixture.origin}/${released && outcome !== 'wrong-url' ? 'second' : 'page'}` }, exitCode: 0, stderrTail: '' }
      if (command === 'browser eval') {
        const expression = argv[argv.indexOf('--expression') + 1]
        const value = expression === 'location.href' ? `${world.fixture.origin}/page` : expression === 'document.title' ? 'Parity fixture' : true
        return { argv, result: { value }, exitCode: 0, stderrTail: '' }
      }
      if (command === 'browser wait') {
        waitCalls += 1
        waitArgv = argv
        return await waiting.promise
      }
      throw new Error(`unexpected URL wait command ${command}`)
    }
    const source = actionChecks.find(check => check.id === 'wait-url')!
    const check: BrowserCheck = { ...source, async run(c) {
      c.state.pageA = 'page-a'
      c.state.pageB = 'page-b'
      return await source.run(c)
    } }
    const report = await runBrowserParity({ rows: [row(check.id)], checks: [check], startWorld: async () => world })
    expect(waitCalls).toBe(1)
    expect(released).toBe(true)
    const status = outcome === 'fixed' ? 'passed' : 'failed'
    expect(report.rows[0].status).toBe(status)
    expect(report.ok).toBe(status === 'passed')
    if (outcome === 'fixed') {
      expect(report.rows[0].evidence).toMatchObject({
        pendingBeforeRelease: true,
        url: `${world.fixture.origin}/second`,
        waitResult: { waited: true }
      })
    } else {
      expect(report.rows[0].error?.kind).toBe(outcome === 'wrong-url' ? 'wrong-page' : 'cli-nonzero')
    }
  })
}

test('a pending observer interrupted before completion cannot become a passing row', async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<Record<string, unknown>>()
  const check: BrowserCheck = { id: 'pending', async run() {
    entered.resolve()
    return await held.promise
  } }
  const pending = runBrowserParity({ rows: [row(check.id)], checks: [check], signal: controller.signal, startWorld: async () => fakeWorld() })
  await entered.promise
  controller.abort(new BrowserFailure('deadline', 'work interrupted'))
  held.resolve({ observed: true })
  const report = await pending
  expect(report.ok).toBe(false)
  expect(report.rows[0]).toMatchObject({ status: 'failed', error: { kind: 'deadline' } })
  expect(report.cleanup.ok).toBe(true)
})

test('watch marker uses a dedicated route without changing the parity page', async () => {
  const fixture = startBrowserFixture()
  try {
    const page = await (await fetch(`${fixture.origin}/page`)).text()
    const watchResponse = await fetch(`${fixture.origin}/watch-page`)
    const watchPage = await watchResponse.text()
    expect(watchResponse.status).toBe(200)
    expect(page).toContain('<title>Parity fixture</title>')
    expect(page).not.toContain('watch-marker')
    expect(watchPage).toContain('<title>Watch parity fixture</title>')
    expect(watchPage).toContain('<button id="watch-marker" type="button" data-state="red" data-clicks="0"')
    expect(watchPage).toContain('width:240px;height:160px')
    expect(watchPage).toContain('background:rgb(225,30,30)')
    expect(watchPage).toContain('Watch Marker: red (0)')
  } finally {
    await fixture.stop()
  }
})

test('manifest CLI results enforce worktree and pane ownership shapes', () => {
  const decode = (argv: string[], result: unknown) =>
    decodeCliReceipt(argv, JSON.stringify(result), '', 0, '/owned/home').result
  const worktreeArgs = ['worktree', 'open-in', 'id:worktree-a', '--target', 'terminal']
  const worktreeResult = { worktreeId: 'worktree-a', target: 'terminal' }
  expect(decode(worktreeArgs, worktreeResult)).toEqual(worktreeResult)
  expect(() => decode(worktreeArgs, { target: 'terminal' })).toThrow('CLI JSON does not match')

  const paneOpenArgs = ['browser', 'pane', 'open', '--mode', 'watch']
  const paneOpenResult = {
    id: 'pane-a',
    worktreeId: 'worktree-a',
    mode: 'watch',
    page: 'page-a',
    url: 'http://127.0.0.1/page',
    title: 'Watch parity fixture',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    viewport: 'default',
    command: null,
    find: { text: '', current: 0, total: 0 },
    prompts: [],
    downloads: [],
    profileId: 'profile-a',
    partition: 'worktree-a:profile-a'
  }
  expect(decode(paneOpenArgs, paneOpenResult)).toEqual(paneOpenResult)
  expect(() => decode(paneOpenArgs, { ...paneOpenResult, mode: 'native' })).toThrow('CLI JSON does not match')
  expect(() => decode(paneOpenArgs, { ...paneOpenResult, page: null })).toThrow('CLI JSON does not match')

  const paneStateArgs = ['browser', 'pane', 'state']
  const paneStateResult = {
    tabs: [{ id: 'pane-a', worktreeId: 'worktree-a', mode: 'watch', profileId: 'profile-a', partition: 'worktree-a:profile-a' }],
    active: 'pane-a',
    history: [{ url: 'http://127.0.0.1/page', title: 'Watch parity fixture', visitedAt: 1 }]
  }
  expect(decode(paneStateArgs, paneStateResult)).toEqual(paneStateResult)
  expect(() => decode(paneStateArgs, { ...paneStateResult, tabs: null })).toThrow('CLI JSON does not match')
})

test('pane shim diagnostics retain the exact exported evidence shape', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-shim-evidence-'))
  try {
    createBrowserEnvironment(home, join(import.meta.dir, '../..'))
    expect(readShimLogs(home)).toEqual({
      empty: true,
      bytes: { orca: 0, security: 0 },
      orcaLog: '',
      securityLog: ''
    })
    writeFileSync(join(home, 'shim-logs', 'orca.log'), 'invoked\n')
    expect(readShimLogs(home)).toEqual({
      empty: false,
      bytes: { orca: 8, security: 0 },
      orcaLog: 'invoked\n',
      securityLog: ''
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
test('replacement readiness waits through stale runtime ownership and rechecks after health', async () => {
  let now = 0
  const expected = { pid: 41 } as RuntimeInfo
  const stale = { pid: 40 } as RuntimeInfo
  const reads = [stale, expected, stale, expected, expected]
  const probePids: number[] = []
  let sleepCalls = 0
  await waitForDaemon('/isolated/home', {
    pid: 41,
    exitCode: null,
    exited: new Promise<number>(() => {}),
    kill() {}
  } as never, 1_000, undefined, undefined, {
    readRuntime: () => reads.shift() ?? expected,
    probe: async runtime => {
      probePids.push(runtime.pid)
      return true
    },
    now: () => now,
    sleep: async milliseconds => {
      sleepCalls++
      now += milliseconds
    }
  })

  expect(probePids).toEqual([41, 41])
  expect(sleepCalls).toBe(2)
  expect(reads).toEqual([])
})

test('replacement readiness preserves exit, abort, and bounded timeout failures', async () => {
  const pending = () => new Promise<number>(() => {})
  const dependencies = {
    readRuntime: () => ({ pid: 99 } as RuntimeInfo),
    probe: async () => true,
    now: () => 0,
    sleep: async () => {}
  }
  const exited = await waitForDaemon('/isolated/home', {
    pid: 41, exitCode: 17, exited: pending(), kill() {}
  } as never, 100, undefined, undefined, dependencies).then(() => undefined, error => error)
  expect(exited).toMatchObject({ kind: 'daemon-exited' })

  const controller = new AbortController()
  controller.abort()
  const aborted = await waitForDaemon('/isolated/home', {
    pid: 41, exitCode: null, exited: pending(), kill() {}
  } as never, 100, controller.signal, undefined, dependencies).then(() => undefined, error => error)
  expect(aborted).toMatchObject({ kind: 'aborted' })

  let now = 0
  const timedOut = await waitForDaemon('/isolated/home', {
    pid: 41, exitCode: null, exited: pending(), kill() {}
  } as never, 12, undefined, undefined, {
    ...dependencies,
    now: () => now,
    sleep: async milliseconds => { now += milliseconds }
  }).then(() => undefined, error => error)
  expect(timedOut).toMatchObject({ kind: 'daemon-readiness-timeout' })
})

test('browser restart forwards SIGKILL and captures the old Chrome tree before orphan observation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-restart-receipt-'))
  try {
    const profilesRoot = join(home, 'plugin-data', 'quirky.browser', 'profiles')
    mkdirSync(profilesRoot, { recursive: true })
    const canonicalProfilesRoot = join(realpathSync(home), 'plugin-data', 'quirky.browser', 'profiles')
    expect(canonicalProfilesRoot).not.toBe(profilesRoot)
    const roots = ['profile-a', 'profile-b'].map((profileId, index) => {
      const profilePath = join(profilesRoot, profileId)
      mkdirSync(join(profilePath, 'chrome-profile'), { recursive: true })
      const argvProfilesRoot = index === 0 ? canonicalProfilesRoot : profilesRoot
      return {
        profileId,
        command: `Google Chrome --headless --user-data-dir=${join(argvProfilesRoot, profileId, 'chrome-profile')}`
      }
    })
    const before = new Map([
      [201, { pid: 201, ppid: 90, pgid: 201, started: 'root-a', command: roots[0]!.command }],
      [202, { pid: 202, ppid: 201, pgid: 201, started: 'child-a', command: 'Google Chrome Helper --type=renderer' }],
      [301, { pid: 301, ppid: 90, pgid: 301, started: 'root-b', command: roots[1]!.command }],
      [302, { pid: 302, ppid: 301, pgid: 301, started: 'child-b', command: 'Google Chrome Helper --type=renderer' }]
    ])
    const after = new Map([
      [201, { ...before.get(201)!, ppid: 1 }],
      [202, before.get(202)!],
      [301, { ...before.get(301)!, ppid: 1 }],
      [302, before.get(302)!]
    ])
    const snapshots = [before, after]
    let daemonPid = 90
    let forwardedOptions: unknown
    let processEvidenceCalls = 0
    const soakWorld = {
      home,
      get daemonPid() { return daemonPid },
      async restartDaemon(_signal: AbortSignal | undefined, onSpawn: ((spawn: { spawnedAt: number; pid: number }) => void) | undefined, options: { killSignal?: 'SIGTERM' | 'SIGKILL' }) {
        forwardedOptions = options
        daemonPid = 91
        onSpawn?.({ spawnedAt: 23, pid: daemonPid })
        return { spawnedAt: 23, killSignal: options.killSignal ?? 'SIGTERM' }
      }
    } as never
    const receipt = await restartBrowserDaemon(soakWorld, undefined, { killSignal: 'SIGKILL' }, {
      deadline: Date.now() + 5_000,
      async processEvidence() { processEvidenceCalls++; return {} },
      snapshot: () => snapshots.shift() ?? after
    })

    expect(forwardedOptions).toEqual({ killSignal: 'SIGKILL' })
    expect(processEvidenceCalls).toBe(2)
    expect(receipt).toMatchObject({
      previousPid: 90,
      daemonPid: 91,
      spawnedAt: 23,
      killSignal: 'SIGKILL',
      oldChromeTree: [
        { pid: 201, started: 'root-a' },
        { pid: 202, started: 'child-a' },
        { pid: 301, started: 'root-b' },
        { pid: 302, started: 'child-b' }
      ],
      orphanChromeAfterKill: [
        { pid: 201, started: 'root-a', ppid: 1, profileId: 'profile-a' },
        { pid: 301, started: 'root-b', ppid: 1, profileId: 'profile-b' }
      ]
    })
    expect(areChromeProcessesGone(receipt.oldChromeTree ?? [], after)).toBe(false)
    expect(areChromeProcessesGone(receipt.oldChromeTree ?? [], new Map([
      [201, { ...after.get(201)!, started: 'reused' }]
    ]))).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
