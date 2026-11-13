import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { readBrowserTable } from './browser-table'
import type { BrowserParityReport } from './browser-run'

const root = join(import.meta.dir, '../..')

async function childRun(command: string[], timeout: number): Promise<{ code: number; report: BrowserParityReport; stderr: string }> {
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: root })
  mkdirSync(env.TMPDIR, { recursive: true })
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  // These watchdogs bound real subprocess cleanup; fake time cannot terminate a stuck daemon.
  const deadline = Promise.withResolvers<never>()
  const watchdog = setTimeout(() => { scope.killNow(); deadline.reject(new Error(`parity child exceeded ${timeout}ms watchdog`)) }, timeout)
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
  expect(report.parityComplete).toBe(false)
  const rows = readBrowserTable()
  expect(report.rows.map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort())
  for (const row of report.rows) {
    const source = rows.find(source => source.id === row.id)!
    if (source.deferred) expect(row).toMatchObject({ status: 'gap', executed: false, reason: source.reason })
    else if (source.disposition === 'excluded') expect(row.status).toBe('excluded')
    else {
      expect(['passed', 'gap']).toContain(row.status)
      expect(row.executed).toBe(true)
      expect(row.evidence.receipts).toBeArray()
      expect(Object.keys(row.evidence).some(key => !['receipts', 'gap'].includes(key))).toBe(true)
      if (row.status === 'gap') expect(row.reason).toBeTruthy()
    }
  }
  expect(report.cleanup.evidence).toMatchObject({ aliveAfter: [], orcaLog: '', securityLog: '', homeRemoved: true })
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
      const report=await runBrowserParity({signal:controller.signal,startWorld:options=>startBrowserWorld({...options,deadline:Date.now()+20000,afterReady:async world=>{
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
