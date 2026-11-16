import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { readBrowserTable } from './browser-table'
import type { BrowserParityReport } from './browser-run'
import { paneChecks } from './browser-pane'

const root = join(import.meta.dir, '../..')

async function childRun(command: string[], timeout: number): Promise<{ code: number; report: BrowserParityReport; stderr: string }> {
  const started = Date.now()
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: root })
  mkdirSync(env.TMPDIR, { recursive: true })
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const deadline = Promise.withResolvers<never>()
  const workMs = Math.max(1, timeout - (Date.now() - started) - 6_000)
  const watchdog = setTimeout(() => { scope.killNow(); deadline.reject(new Error(`pane child exhausted its ${timeout}ms startup/work/cleanup budget`)) }, workMs)
  try {
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const code = await Promise.race([child.exited, deadline.promise])
    const report: BrowserParityReport = JSON.parse(await stdout)
    expect(sentinel.exitCode).toBeNull()
    process.kill(sentinel.pid, 0)
    expect(report.cleanup).toMatchObject({ ok: true })
    return { code, report, stderr: await stderr }
  } finally {
    clearTimeout(watchdog)
    sentinel.kill('SIGTERM')
    await sentinel.exited
    await scope.cleanup()
  }
}

test('standalone pane checks seed their profiles and verify Watch plus restart continuity', async () => {
  const source = `
    import {runBrowserParity} from './scripts/parity/browser-run';
    import {readBrowserTable} from './scripts/parity/browser-table';
    import {startBrowserWorld} from './scripts/parity/browser-world';
    import {paneChecks} from './scripts/parity/browser-pane';
    const ids=new Set(paneChecks.map(check=>check.id));
    const deadline=Date.now()+180000;
    const report=await runBrowserParity({rows:readBrowserTable().filter(row=>ids.has(row.id)),checks:paneChecks,deadline,startWorld:options=>startBrowserWorld({...options,deadline})});
    console.log(JSON.stringify(report)); process.exitCode=report.ok?0:1;
  `
  const { code, report, stderr } = await childRun([process.execPath, '-e', source], 200_000)
  expect({ code, error: report.error, failed: report.rows.filter(row => row.status === 'failed'), stderr }).toEqual({ code: 0, error: undefined, failed: [], stderr: '' })
  expect(report.ok).toBe(true)
  expect(report.rows.map(row => row.id).sort()).toEqual(paneChecks.map(check => check.id).sort())
  expect(report.rows.every(row => row.status === 'passed' && row.executed)).toBe(true)
  const watch = report.rows.find(row => row.id === 'worktree-watch-page')!.evidence
  expect(watch).toMatchObject({
    beforeSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) },
    afterSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) },
    worktreeBBefore: { title: 'Parity fixture', field: 'seed', result: '' },
    worktreeBAfter: { title: 'Parity fixture', field: 'seed', result: '' }
  })
  const restart = report.rows.find(row => row.id === 'daemon-restart-profile')!.evidence
  expect(restart.previousPid).not.toBe(restart.daemonPid)
  expect(restart).toMatchObject({ localStorageA: 'local-restart', cookieA: 'cookie-restart', localStorageB: null, cookieCountB: 0 })
  const identity = report.rows.find(row => row.id === 'browser-identity-set-activation-after-restart')!.evidence
  expect(identity).toMatchObject({ afterRestart: { mode: 'native', active: 'native', restartRequired: false }, restoredMode: 'clean' })
  expect(identity.userAgentBeforeRestart).not.toContain('HeadlessChrome/')
  expect(identity.userAgentAfterRestart).toContain('HeadlessChrome/')
  expect(report.cleanup.evidence).toMatchObject({
    aliveAfter: [], processIdentitiesGone: true, homeRemoved: true,
    orcaLog: '', securityLog: '', shimLogsEmpty: true, shimLogBytes: { orca: 0, security: 0 },
    excludedPlugins: ['quirky.accounts']
  })
}, 210_000)
