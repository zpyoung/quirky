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

function logHardKillEvidence(report: BrowserParityReport): BrowserParityReport['rows'][number] {
  const row = report.rows.find(candidate => candidate.id === 'daemon-hard-kill-profile')
  if (!row) throw new Error('hard-kill pane check did not produce a row')
  console.log(`daemon-hard-kill-profile ${JSON.stringify({
    elapsedMs: row.elapsedMs,
    flushWaitMs: row.evidence.flushWaitMs,
    orphanChromeAfterKill: row.evidence.orphanChromeAfterKill,
    firstBrowserCommandExitCode: row.evidence.firstBrowserCommandExitCode,
    oldChromeGone: row.evidence.oldChromeGone,
    localStorageA: row.evidence.localStorageA,
    cookieA: row.evidence.cookieA,
    localStorageB: row.evidence.localStorageB,
    cookieCountB: row.evidence.cookieCountB,
    beforeSample: row.evidence.beforeSample,
    afterSample: row.evidence.afterSample,
    cleanup: {
      aliveAfter: report.cleanup.evidence?.aliveAfter,
      processIdentitiesGone: report.cleanup.evidence?.processIdentitiesGone,
      homeRemoved: report.cleanup.evidence?.homeRemoved
    }
  })}`)
  return row
}

function watchSample(value: unknown): { r: number; g: number; b: number; digest: string } {
  if (!value || typeof value !== 'object' || !('r' in value) || typeof value.r !== 'number' ||
    !('g' in value) || typeof value.g !== 'number' || !('b' in value) || typeof value.b !== 'number' ||
    !('digest' in value) || typeof value.digest !== 'string') {
    throw new Error('hard-kill evidence did not include a pixel sample')
  }
  return { r: value.r, g: value.g, b: value.b, digest: value.digest }
}
type OrphanChromeRoot = { pid: number; started: string; ppid: number; profileId: string }

function isOrphanChromeRoot(value: unknown): value is OrphanChromeRoot {
  return value !== null && typeof value === 'object' &&
    'pid' in value && typeof value.pid === 'number' &&
    'started' in value && typeof value.started === 'string' &&
    'ppid' in value && typeof value.ppid === 'number' &&
    'profileId' in value && typeof value.profileId === 'string'
}

function isOrphanChromeRoots(value: unknown): value is OrphanChromeRoot[] {
  return Array.isArray(value) && value.every(isOrphanChromeRoot)
}


test('standalone pane checks seed their profiles and verify Watch plus restart continuity', async () => {
  const source = `
    import {runBrowserParity} from './scripts/parity/browser-run';
    import {readBrowserTable} from './scripts/parity/browser-table';
    import {startBrowserWorld} from './scripts/parity/browser-world';
    import {paneChecks} from './scripts/parity/browser-pane';
    const ids=new Set(paneChecks.map(check=>check.id));
    const deadline=Date.now()+240000;
    const report=await runBrowserParity({rows:readBrowserTable().filter(row=>ids.has(row.id)),checks:paneChecks,deadline,startWorld:options=>startBrowserWorld({...options,deadline})});
    console.log(JSON.stringify(report)); process.exitCode=report.ok?0:1;
  `
  const { code, report, stderr } = await childRun([process.execPath, '-e', source], 260_000)
  expect({ code, error: report.error, failed: report.rows.filter(row => row.status === 'failed'), stderr }).toEqual({ code: 0, error: undefined, failed: [], stderr: '' })
  expect(report.ok).toBe(true)
  expect(report.rows.map(row => row.id).sort()).toEqual(paneChecks.map(check => check.id).sort())
  expect(report.rows.every(row => row.status === 'passed' && row.executed)).toBe(true)
  const restart = report.rows.find(row => row.id === 'daemon-restart-profile')!.evidence
  const hardKill = logHardKillEvidence(report)
  const flushWaitMs = hardKill.evidence.flushWaitMs
  if (typeof flushWaitMs !== 'number') throw new Error('hard-kill evidence omitted its flush wait')
  expect(flushWaitMs).toBeGreaterThanOrEqual(40_000)
  const orphanRoots = hardKill.evidence.orphanChromeAfterKill
  if (!isOrphanChromeRoots(orphanRoots)) throw new Error('hard-kill evidence did not include orphan Chrome roots')
  expect(orphanRoots).toHaveLength(2)
  const profileA = restart.profileA
  const profileB = restart.profileB
  if (typeof profileA !== 'string' || typeof profileB !== 'string') {
    throw new Error('restart evidence did not include both profile IDs')
  }
  expect(orphanRoots.map(root => root.profileId).sort()).toEqual([profileA, profileB].sort())
  expect(orphanRoots.every(root => root.pid > 0 && root.started.length > 0 && root.ppid === 1)).toBe(true)
  // bun's asymmetric matchers mutate nested inputs; pixel values must stay numeric
  const beforeSample = watchSample(hardKill.evidence.beforeSample)
  const afterSample = watchSample(hardKill.evidence.afterSample)
  expect(beforeSample.r).toBeGreaterThan(180)
  expect(beforeSample.g).toBeLessThan(80)
  expect(beforeSample.b).toBeLessThan(80)
  expect(afterSample.g).toBeGreaterThan(180)
  expect(afterSample.r).toBeLessThan(80)
  expect(afterSample.b).toBeLessThan(80)
  expect(afterSample.digest).not.toBe(beforeSample.digest)
  expect(hardKill).toMatchObject({
    status: 'passed', executed: true,
    evidence: {
      killSignal: 'SIGKILL', firstBrowserCommandExitCode: 0, oldChromeGone: true,
      localStorageA: 'local-restart', cookieA: 'cookie-restart', localStorageB: null, cookieCountB: 0,
      worktreeBMarkerBefore: 'red', worktreeBMarkerAfter: 'red',
      identityAfterRestart: { mode: 'native', active: 'native', restartRequired: false },
      beforeSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) },
      afterSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) }
    }
  })
  expect(report.cleanup.evidence).toMatchObject({ aliveAfter: [], processIdentitiesGone: true, homeRemoved: true, orcaLog: '', securityLog: '' })
  const watch = report.rows.find(row => row.id === 'worktree-watch-page')!.evidence
  expect(watch).toMatchObject({
    beforeSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) },
    afterSample: { r: expect.any(Number), g: expect.any(Number), b: expect.any(Number), digest: expect.any(String) },
    worktreeBBefore: { title: 'Parity fixture', field: 'seed', result: '' },
    worktreeBAfter: { title: 'Parity fixture', field: 'seed', result: '' }
  })
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
}, 270_000)

test('daemon hard-kill pane check runs alone with owned cleanup', async () => {
  const source = `
    import {runBrowserParity} from './scripts/parity/browser-run';
    import {readBrowserTable} from './scripts/parity/browser-table';
    import {startBrowserWorld} from './scripts/parity/browser-world';
    import {paneChecks} from './scripts/parity/browser-pane';
    const check=paneChecks.find(check=>check.id==='daemon-hard-kill-profile');
    if(!check) throw new Error('daemon-hard-kill-profile check is not registered');
    const deadline=Date.now()+240000;
    const report=await runBrowserParity({rows:readBrowserTable().filter(row=>row.id===check.id),checks:[check],deadline,startWorld:options=>startBrowserWorld({...options,deadline})});
    console.log(JSON.stringify(report)); process.exitCode=report.ok?0:1;
  `
  const { code, report, stderr } = await childRun([process.execPath, '-e', source], 260_000)
  expect({ code, error: report.error, failed: report.rows.filter(row => row.status === 'failed'), stderr }).toEqual({ code: 0, error: undefined, failed: [], stderr: '' })
  expect(report.ok).toBe(true)
  expect(report.rows.map(row => row.id)).toEqual(['daemon-hard-kill-profile'])
  const hardKill = logHardKillEvidence(report)
  expect(hardKill).toMatchObject({
    status: 'passed', executed: true,
    evidence: {
      killSignal: 'SIGKILL', firstBrowserCommandExitCode: 0, oldChromeGone: true,
      localStorageA: 'local-restart', cookieA: 'cookie-restart', localStorageB: null, cookieCountB: 0,
      worktreeBMarkerBefore: 'red', worktreeBMarkerAfter: 'red',
      identityAfterRestart: { mode: 'native', active: 'native', restartRequired: false }
    }
  })
  const flushWaitMs = hardKill.evidence.flushWaitMs
  if (typeof flushWaitMs !== 'number') throw new Error('hard-kill evidence omitted its flush wait')
  expect(flushWaitMs).toBeGreaterThanOrEqual(40_000)
  const roots = hardKill.evidence.orphanChromeAfterKill as Array<{ pid: number; started: string; ppid: number; profileId: string }>
  expect(roots).toHaveLength(2)
  expect(roots.every(root => root.pid > 0 && root.started.length > 0 && root.ppid === 1)).toBe(true)
  expect(report.cleanup.evidence).toMatchObject({
    aliveAfter: [], processIdentitiesGone: true, homeRemoved: true,
    orcaLog: '', securityLog: '', shimLogsEmpty: true, shimLogBytes: { orca: 0, security: 0 }
  })
}, 270_000)
