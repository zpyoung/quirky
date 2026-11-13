import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBrowserParity, validateOutcomes, type BrowserCheck } from './browser-run'
import { parseBrowserArgs, createBrowserEnvironment, boundedDiagnostic, decodeCliReceipt, BrowserFailure, type BrowserWorld } from './browser-world'
import { startBrowserFixture } from './browser-fixture'
import type { BrowserRow } from './browser-table'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { stateChecks } from './browser-checks-state'

const row = (id: string, disposition: BrowserRow['disposition'] = 'covered'): BrowserRow => ({
  id, command: id, equivalent: `quirky browser ${id}`, check: id, disposition, reason: disposition === 'gap' ? 'known capability gap' : '', primary: true, deferred: false
})
const fakeWorld = (cleanup: BrowserWorld['cleanup'] = async () => ({ ok: true })): BrowserWorld => ({
  home: '/owned/home', env: {}, fixture: {
    origin: 'http://127.0.0.1:1234', startedAt: 0, requests: [], dialogCount: 0,
    waitForDialog: async () => {}, stop: async () => {}
  }, worktreeA: 'a', worktreeB: 'b', daemonPid: 1,
  cli: async () => ({ argv: [], result: {}, exitCode: 0, stderrTail: '' }), cleanup, processEvidence: async () => ({})
})

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
  controller.abort(new Error('cancelled fixture wait'))
  const cancellation = await cancelled
  expect(cancellation).toBeInstanceOf(Error)
  if (cancellation instanceof Error) expect(cancellation.message).toBe('cancelled fixture wait')
  const stopped = f.waitForDialog(f.dialogCount).catch((error: unknown) => error)
  await f.stop()
  const shutdown = await stopped
  expect(shutdown).toBeInstanceOf(Error)
  if (shutdown instanceof Error) expect(shutdown.message).toContain('stopped')
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
