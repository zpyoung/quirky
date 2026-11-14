import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { readBrowserTable } from './browser-table'
import type { BrowserParityReport } from './browser-run'

const root = join(import.meta.dir, '../..')

async function childRun(command: string[], timeout: number): Promise<{ code: number; report: BrowserParityReport; stderr: string }> {
  const started = Date.now()
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: root })
  mkdirSync(env.TMPDIR, { recursive: true })
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  // These watchdogs bound real subprocess cleanup; fake time cannot terminate a stuck daemon.
  const deadline = Promise.withResolvers<never>()
  const workMs = Math.max(1, timeout - (Date.now() - started) - 6_000)
  const watchdog = setTimeout(() => { scope.killNow(); deadline.reject(new Error(`parity child exhausted its ${timeout}ms startup/work/cleanup budget`)) }, workMs)
  try {
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const code = await Promise.race([child.exited, deadline.promise])
    const report: BrowserParityReport = JSON.parse(await stdout)
    expect(sentinel.exitCode).toBeNull()
    process.kill(sentinel.pid, 0)
    expect(report.cleanup.ok).toBe(true)
    return { code, report, stderr: await stderr }
  } finally {
    clearTimeout(watchdog)
    sentinel.kill('SIGTERM')
    await sentinel.exited
    await scope.cleanup()
  }
}

test('one isolated real CLI run records every browser command and removes its process identities', async () => {
  const { code, report, stderr } = await childRun([process.execPath, 'scripts/parity/browser.ts', '--json'], 490_000)
  expect({ code, error: report.error, failed: report.rows.filter(row => row.status === 'failed'), stderr }).toEqual({ code: 0, error: undefined, failed: [], stderr })
  expect(report.ok).toBe(true)
  expect(report.parityComplete).toBe(true)
  const rows = readBrowserTable()
  expect(report.rows.map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort())
  for (const row of report.rows) {
    const source = rows.find(source => source.id === row.id)!
    if (source.disposition === 'excluded') expect(row.status).toBe('excluded')
    else {
      expect(row).toMatchObject({ status: 'passed', executed: true })
      expect(row.evidence.receipts).toBeArray()
      expect(Object.keys(row.evidence).some(key => key !== 'receipts')).toBe(true)
    }
  }
  for (const id of ['intercept-enable', 'intercept-list', 'intercept-disable']) {
    expect(report.rows.find(row => row.id === id)?.evidence).toMatchObject({
      pendingBeforeDisable: true, listedPending: true, serverRequestsBeforeDisable: 0, released: true
    })
  }
  expect(report.rows.find(row => row.id === 'wait-url')?.evidence).toMatchObject({
    pendingBeforeRelease: true, waitResult: { waited: true }
  })
  expect(report.rows.find(row => row.id === 'tab-profile-delete')?.evidence).toMatchObject({
    deleted: true, metadataRemoved: true, chromeRemoved: true
  })
  expect(report.rows.find(row => row.id === 'tab-switch-focus')?.evidence).toMatchObject({
    first: { focused: true, paneOpened: true }
  })
  expect(report.rows.find(row => row.id === 'open-url')?.evidence).toMatchObject({
    routed: { client: expect.any(Number) }
  })
  const watch = report.rows.find(row => row.id === 'worktree-watch-page')!
  expect(watch).toMatchObject({ status: 'passed', executed: true })
  const beforeSample = watch.evidence.beforeSample as { r: number; g: number; b: number; digest: string }
  const afterSample = watch.evidence.afterSample as { r: number; g: number; b: number; digest: string }
  expect(beforeSample.r).toBeGreaterThan(180)
  expect(beforeSample.g).toBeLessThan(80)
  expect(beforeSample.b).toBeLessThan(80)
  expect(afterSample.g).toBeGreaterThan(180)
  expect(afterSample.r).toBeLessThan(80)
  expect(afterSample.b).toBeLessThan(80)
  expect(afterSample.digest).not.toBe(beforeSample.digest)
  expect(watch.evidence).toMatchObject({
    worktreeBBefore: { title: 'Parity fixture', field: 'seed', result: '' },
    worktreeBAfter: { title: 'Parity fixture', field: 'seed', result: '' }
  })
  const restart = report.rows.find(row => row.id === 'daemon-restart-profile')!
  expect(restart).toMatchObject({ status: 'passed', executed: true, evidence: { localStorageA: 'local-restart', cookieA: 'cookie-restart', localStorageB: null, cookieCountB: 0 } })
  expect(restart.evidence.previousPid).not.toBe(restart.evidence.daemonPid)
  const identity = report.rows.find(row => row.id === 'browser-identity-set-activation-after-restart')!
  expect(identity).toMatchObject({ status: 'passed', executed: true, evidence: { afterRestart: { mode: 'native', active: 'native', restartRequired: false } } })
  expect(identity.evidence.userAgentBeforeRestart).not.toContain('HeadlessChrome/')
  expect(identity.evidence.userAgentAfterRestart).toContain('HeadlessChrome/')
  expect(report.cleanup.evidence).toMatchObject({
    aliveAfter: [], orcaLog: '', securityLog: '', homeRemoved: true,
    shimLogsEmpty: true, shimLogBytes: { orca: 0, security: 0 }, excludedPlugins: ['quirky.accounts']
  })
  const identities: unknown = report.cleanup.evidence?.trackedIdentities
  if (!Array.isArray(identities)) throw new Error('cleanup did not record owned process identities')
  const commands = identities.map((identity: unknown) => {
    if (!identity || typeof identity !== 'object' || !('command' in identity) || typeof identity.command !== 'string') throw new Error('cleanup returned an invalid process identity')
    return identity.command
  })
  expect(commands.some(command => command.includes('packages/daemon/src/main.ts'))).toBe(true)
  expect(commands.some(command => /chrome|chromium/i.test(command))).toBe(true)
  expect(commands.some(command => command.includes('agent-browser'))).toBe(true)
  expect(report.cleanup.evidence?.processIdentitiesGone).toBe(true)
}, 495_000)

for (const mode of ['daemon-exit', 'sigterm']) {
  test(`real ${mode} before Chrome launch is bounded and uses owned cleanup`, async () => {
    const source = `
      import {runBrowserParity} from './scripts/parity/browser-run';
      import {startBrowserWorld,BrowserFailure} from './scripts/parity/browser-world';
      const controller=new AbortController();
      const terminated=Promise.withResolvers<void>();
      process.on('SIGTERM',()=>{controller.abort(new BrowserFailure('deadline','SIGTERM'));terminated.resolve()});
      const report=await runBrowserParity({signal:controller.signal,startWorld:options=>startBrowserWorld({...options,deadline:Date.now()+19000,afterReady:async world=>{
        ${mode === 'daemon-exit' ? "process.kill(world.daemonPid,'SIGKILL'); await world.daemonExited; await world.cli(['status']);" : "process.kill(process.pid,'SIGTERM'); await terminated.promise; controller.signal.throwIfAborted();"}
      }})});
      console.log(JSON.stringify(report)); process.exitCode=report.ok?0:1;
    `
    const { code, report } = await childRun([process.execPath, '-e', source], 35_000)
    expect(code).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.error?.kind).toBe(mode === 'daemon-exit' ? 'daemon-exited' : 'deadline')
    expect(report.rows.filter(row => row.executed)).toEqual([])
    expect(report.cleanup.evidence).toMatchObject({ aliveAfter: [], orcaLog: '', securityLog: '', homeRemoved: true })
  }, 37_000)
}
