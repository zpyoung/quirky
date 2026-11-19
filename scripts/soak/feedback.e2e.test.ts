import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../soak.ts'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures.ts'
import type { SoakReport } from './contracts.ts'
import { daySchedule } from './day.ts'
import { chromiumPath } from './windows.ts'

const executable = chromiumPath()
const browserCache = executable?.match(/^(.*)[/\\]chromium-[^/\\]+[/\\]/)?.[1]
const repoRoot = resolve(import.meta.dir, '../..')
if (executable === null) console.warn('Skipping feedback window proof: run bunx playwright install chromium')

function sourceOutputs(): unknown[] {
  const entries: unknown[] = []
  const visit = (path: string) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) { entries.push([path, 'absent']); return }
    entries.push([path, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'directory'])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  const plugins = join(repoRoot, 'plugins')
  for (const plugin of readdirSync(plugins).sort()) {
    if (statSync(join(plugins, plugin)).isDirectory()) visit(join(plugins, plugin, 'dist'))
  }
  return entries
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

for (const kind of ['feedback', 'flood']) {
  for (const failure of ['deadline timeout', 'transport error']) {
    test(`${kind} readiness preserves its diagnostic after a ${failure}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'quirky-soak-readiness-rpc-'))
      const out = join(root, 'out')
      const entrypoint = join(root, 'readiness.ts')
      const resultPath = join(root, 'result.json')
      writeFileSync(entrypoint, `
import { mock, vi } from 'bun:test'
import { writeFileSync } from 'node:fs'
import * as day from ${JSON.stringify(join(repoRoot, 'scripts/soak/day.ts'))}
const dayExports = { ...day }
const opened = Promise.withResolvers()
const records = [{ index: 0, connId: 1, worktree: 'a' }, { index: 1, connId: 2, worktree: 'b' }]
let windowStopped = false
let worldStopped = false
let timedOutMs = null
let calls = 0
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}, () => ({
  startWorld: async () => ({
    home: ${JSON.stringify(join(root, 'home'))},
    fixtures: { worktrees: [{ id: 'a' }, { id: 'b' }] },
    control: { callAny: async (method, params, options) => {
      if (method === 'ui.tool.open') { opened.resolve(); return {} }
      if (method !== 'ui.window.state') throw new Error('unexpected method: ' + method)
      calls++
      if (${JSON.stringify(failure)} === 'transport error') throw new Error('readiness transport disconnected')
      if (options.timeoutMs < 1000) {
        timedOutMs = options.timeoutMs
        vi.advanceTimersByTime(options.timeoutMs)
        throw new Error('RPC call timed out after ' + options.timeoutMs + ' ms')
      }
      return { slots: [] }
    } },
    stop: async () => { worldStopped = true }
  })
}))
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/windows.ts'))}, () => ({
  chromiumPath: () => '/fixture/chromium',
  openWindows: async () => ({
    liveness: () => records,
    finish: async () => ({ records, requests: [] }),
    stop: async () => { windowStopped = true }
  })
}))
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/day.ts'))}, () => ({
  ...dayExports,
  applyPhase: async () => {}
}))
// main must load after the isolated setup stand-ins are registered
const { main } = await import(${JSON.stringify(join(repoRoot, 'scripts/soak.ts'))})
vi.useFakeTimers()
let finished = false
const outcome = main(['--fault', ${JSON.stringify(kind)}, '--windows', '2', '--minutes', '0.4', '--out', ${JSON.stringify(out)}])
  .finally(() => { finished = true })
try {
  await opened.promise
  for (let turn = 0; turn < 400 && !finished; turn++) {
    for (let step = 0; step < 20; step++) await Promise.resolve()
    if (!finished) vi.advanceTimersByTime(100)
  }
  if (!finished) throw new Error('readiness did not settle within the controlled deadline')
  const code = await outcome
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ code, timedOutMs, calls, windowStopped, worldStopped }))
  process.exitCode = code
} finally {
  vi.useRealTimers()
}
`)
      const child = Bun.spawn([process.execPath, entrypoint], {
        cwd: repoRoot,
        env: createIsolatedRuntimeEnvironment(root, { repoRoot }),
        stdout: 'pipe', stderr: 'pipe',
      })
      const output = new Response(child.stdout).text()
      const errors = new Response(child.stderr).text()
      // the child owns fake timers; the parent must still bound its OS process
      const watchdog = setTimeout(() => child.kill('SIGTERM'), 10_000)
      try {
        const code = await child.exited
        await output
        const stderr = await errors
        expect(code, stderr).toBe(2)
        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
          code: number; timedOutMs: number | null; calls: number; windowStopped: boolean; worldStopped: boolean
        }
        expect(result).toMatchObject({ code: 2, windowStopped: true, worldStopped: true })
        if (failure === 'deadline timeout') {
          expect(result.timedOutMs).toBeGreaterThan(0)
          expect(result.timedOutMs).toBeLessThan(1000)
          expect(stderr).toContain(`${kind} panel readiness missing for a, b within 30000ms`)
        } else {
          expect(result.calls).toBe(1)
          expect(stderr).toContain('readiness transport disconnected')
          expect(stderr).not.toContain('panel readiness missing')
        }
        expect(existsSync(join(out, 'soak-report.json'))).toBe(false)
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null) child.kill('SIGTERM')
        await child.exited
        await Promise.all([output, errors])
        rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
}

for (const count of [2, 3]) {
  test.skipIf(executable === null)(`rejects exactly 17 mounted-panel feedback refreshes with ${count} windows`, async () => {
    const out = mkdtempSync(join(tmpdir(), 'quirky-soak-feedback-'))
    const before = sourceOutputs()
    try {
      const code = await main(['--fault', 'feedback', '--windows', String(count), '--minutes', '0.4', '--out', out])
      expect(code).toBe(1)
      const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
      expect(report.fault).toMatchObject({ kind: 'feedback', check: 'refreshes', detail: { refreshes: 17 } })
      expect(report.fault!.at).toBeGreaterThanOrEqual(2)
      expect(report.checks.refreshes.ok).toBe(false)
      expect(report.checks.refreshes.peakPer5s).toBeGreaterThanOrEqual(9)
      expect(report.checks.refreshes.missingWindows).toEqual([])
      expect(report.checks.events.byType.find(({ type }) => type === 'soak.faults/feedbackChanged')).toMatchObject({ total: 17, peakPer5s: 17 })
      expect(report.qualifies).toBe(false)
      expect(report.disqualified).toContain('fault injected: feedback')
      expect(report.windows).toHaveLength(count)
      expect(new Set(report.windows.map(({ connId }) => connId)).size).toBe(count)
      expect(new Set(report.windows.map(({ worktree }) => worktree)).size).toBe(count)
      expect(report.windows.every(({ open, shown }) => open && shown)).toBe(true)
      const refreshes = report.panelRefreshes.filter(({ method }) => method === 'soak.faults/feedbackRefresh')
      expect(refreshes).toHaveLength(17)
      expect(refreshes.at(-1)!.at - refreshes[0]!.at).toBeLessThanOrEqual(5)
      expect(refreshes[0]!.at).toBeGreaterThanOrEqual(report.fault!.at)
      const pair = report.fault!.detail.worktrees!
      expect(pair).toEqual([report.windows[0]!.worktree, report.windows[1]!.worktree])
      refreshes.forEach((record, index) => {
        expect(record.index).toBe(index % 2)
        expect(record.worktree).toBe(pair[index % 2]!)
        expect(record.at).toBeGreaterThanOrEqual(0)
        expect(record.at).toBeLessThanOrEqual(report.durationSeconds)
      })
      if (count === 3) expect(refreshes.some(({ index }) => index === 2)).toBe(false)
      for (const file of ['browser.pid', 'daemon.pid']) expect(isAlive(Number(readFileSync(join(out, file), 'utf8').trim()))).toBe(false)
    } finally {
      expect(sourceOutputs()).toEqual(before)
      rmSync(out, { recursive: true, force: true })
    }
  }, 240_000)
}

test.skipIf(executable === null)('rejects 3000 mounted flood ticks under the calibrated default with an untouched peer', async () => {
  const temporaryDirectory = tmpdir()
  const root = mkdtempSync(join(temporaryDirectory, 'quirky-soak-flood-'))
  const out = join(root, 'out')
  const before = sourceOutputs()
  const preload = join(root, 'events.ts')
  writeFileSync(preload, `
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { startWorld as realStartWorld } from ${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}
import { startProbe as realStartProbe } from ${JSON.stringify(join(repoRoot, 'scripts/soak/probe.ts'))}
const startWorld = realStartWorld
const startProbe = realStartProbe
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}, () => ({
  startWorld: async (options) => {
    const world = await startWorld(options)
    writeFileSync(${JSON.stringify(join(root, 'home.txt'))}, world.home)
    return world
  }
}))
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/probe.ts'))}, () => ({
  startProbe: (options) => {
    const probe = startProbe(options)
    const stop = probe.stop.bind(probe)
    probe.stop = () => {
      stop()
      writeFileSync(${JSON.stringify(join(root, 'events.json'))}, JSON.stringify(probe.events))
    }
    return probe
  }
}))
`)
  const child = Bun.spawn([process.execPath, '--preload', preload, join(repoRoot, 'scripts/soak.ts'), '--fault', 'flood', '--windows', '2', '--minutes', '0.4', '--out', out], {
    cwd: repoRoot,
    env: {
      ...createIsolatedRuntimeEnvironment(root, { repoRoot }),
      PLAYWRIGHT_BROWSERS_PATH: browserCache,
      TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  // real daemon and browser children cannot share the test process's fake timers
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 180_000)
  try {
    const code = await child.exited
    await output
    expect(code, await errors).toBe(1)
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    const target = report.windows.find(({ index }) => index === 0)!.worktree
    expect(report.version).toBe(1)
    expect(report.verdict).toBe('fail')
    expect(report.fault).toMatchObject({
      kind: 'flood', check: 'requests',
      detail: { pids: [], refreshes: 0, blockedMs: null, flood: { index: 0, worktree: target, requests: 3000 } },
    })
    expect(report.fault!.at).toBeGreaterThanOrEqual(2)
    expect(report.checks.requests).toMatchObject({
      ok: false, limitPerMinute: 2500, peakWindow: 0, peakWorktree: target,
    })
    const [owner, peer] = report.checks.requests.byWindow
    expect(owner!.peakPerMinute).toBeGreaterThanOrEqual(3000)
    expect(peer!.peakPerMinute).toBeGreaterThan(0)
    expect(peer!.peakPerMinute).toBeLessThan(2500)
    expect(report.windowRequests.find(({ method }) => method === 'soak.faults/floodTick')?.total).toBe(3000)
    const events = JSON.parse(readFileSync(join(root, 'events.json'), 'utf8')) as { type: string }[]
    expect(events.filter(({ type }) => type === 'soak.faults/floodStarted')).toHaveLength(1)
    expect(events.filter(({ type }) => type === 'soak.faults/changed' || type === 'soak.faults/feedbackChanged')).toEqual([])
    expect(report.panelRequests.some(({ panel }) => panel === 'feedback')).toBe(false)
    expect(report.panelRefreshes.some(({ method }) => method === 'soak.faults/floodTick')).toBe(false)
    expect(report.qualifies).toBe(false)
    expect(report.disqualified).toContain('fault injected: flood')
    expect(report.windows).toHaveLength(2)
    expect(new Set(report.windows.map(({ connId }) => connId)).size).toBe(2)
    expect(new Set(report.windows.map(({ worktree }) => worktree)).size).toBe(2)
    expect(report.windows.every(({ open, shown }) => open && shown)).toBe(true)
    expect(existsSync(readFileSync(join(root, 'home.txt'), 'utf8'))).toBe(false)
    for (const file of ['browser.pid', 'daemon.pid']) expect(isAlive(Number(readFileSync(join(out, file), 'utf8').trim()))).toBe(false)
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill('SIGTERM')
    await child.exited
    await Promise.all([output, errors])
    expect(sourceOutputs()).toEqual(before)
    rmSync(root, { recursive: true, force: true })
  }
}, 240_000)

for (const kind of ['feedback', 'flood']) {
test.skipIf(executable === null)(`bounds missing mounted ${kind} panel readiness and publishes no report`, async () => {
  const temporaryDirectory = tmpdir()
  const root = mkdtempSync(join(temporaryDirectory, `quirky-soak-${kind}-unready-`))
  const out = join(root, 'out')
  const before = sourceOutputs()
  const preload = join(root, 'unready.ts')
  writeFileSync(preload, `
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { startWorld as realStartWorld } from ${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}
const startWorld = realStartWorld
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}, () => ({
  startWorld: async (options) => {
    const world = await startWorld(options)
    writeFileSync(${JSON.stringify(join(root, 'home.txt'))}, world.home)
    const call = world.control.callAny.bind(world.control)
    world.control.callAny = async (method, params, ...rest) => {
      const result = await call(method, params, ...rest)
      if (method === 'ui.window.state') {
        for (const slot of result.slots ?? []) if (slot.id === ${JSON.stringify(`panel:soak.faults/${kind}`)}) delete slot.report
      }
      return result
    }
    return world
  }
}))
`)
  const child = Bun.spawn([process.execPath, '--preload', preload, join(repoRoot, 'scripts/soak.ts'), '--fault', kind, '--windows', '2', '--minutes', '0.4', '--out', out], {
    cwd: repoRoot,
    env: {
      ...createIsolatedRuntimeEnvironment(root, { repoRoot }),
      PLAYWRIGHT_BROWSERS_PATH: browserCache,
      // startWorld owns its temporary home; nesting it exceeds Linux socket path limits
      TMPDIR: temporaryDirectory,
      TMP: temporaryDirectory,
      TEMP: temporaryDirectory
    },
    stdout: 'pipe', stderr: 'pipe'
  })
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  const began = performance.now()
  // real Chromium/daemon readiness deadlines cannot advance on fake timers
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 180_000)
  try {
    expect(await child.exited).toBe(2)
    const stderr = await errors
    await output
    expect(stderr).toContain(`${kind} panel readiness`)
    expect(stderr).toContain('30000ms')
    expect(performance.now() - began).toBeLessThan(180_000)
    expect(existsSync(join(out, 'soak-report.json'))).toBe(false)
    expect(existsSync(readFileSync(join(root, 'home.txt'), 'utf8'))).toBe(false)
    for (const file of ['browser.pid', 'daemon.pid']) expect(isAlive(Number(readFileSync(join(out, file), 'utf8').trim()))).toBe(false)
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill('SIGTERM')
    await child.exited
    await Promise.all([output, errors])
    expect(sourceOutputs()).toEqual(before)
    rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
}

for (const contradiction of ['missing', 'duplicate', 'foreign-window', 'wrong-owner', 'outside-interval']) {
  test.skipIf(executable === null)(`rejects ${contradiction} live flood observation despite a completed daemon fixture`, async () => {
    const temporaryDirectory = tmpdir()
    const root = mkdtempSync(join(temporaryDirectory, 'quirky-soak-flood-observation-'))
    const out = join(root, 'out')
    const before = sourceOutputs()
    const preload = join(root, 'observation.ts')
    writeFileSync(preload, `
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { startWorld as realStartWorld } from ${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}
const startWorld = realStartWorld
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/world.ts'))}, () => ({
  startWorld: async (options) => {
    const world = await startWorld(options)
    writeFileSync(${JSON.stringify(join(root, 'home.txt'))}, world.home)
    return world
  }
}))
import { openWindows as realOpenWindows, chromiumPath } from ${JSON.stringify(join(repoRoot, 'scripts/soak/windows.ts'))}
const openWindows = realOpenWindows
mock.module(${JSON.stringify(join(repoRoot, 'scripts/soak/windows.ts'))}, () => ({
  chromiumPath,
  openWindows: async (options) => {
    let changed = false
    return openWindows({ ...options, onRequest: (request) => {
      if (!changed && request.method === 'soak.faults/floodTick') {
        changed = true
        switch (${JSON.stringify(contradiction)}) {
          case 'missing': return
          case 'duplicate': options.onRequest(request); break
          case 'foreign-window': request = { ...request, index: 1 }; break
          case 'wrong-owner': request = { ...request, params: { ...request.params, owner: 'foreign' } }; break
          case 'outside-interval': request = { ...request, at: 0 }; break
        }
      }
      options.onRequest(request)
    } })
  }
}))
`)
    const child = Bun.spawn([process.execPath, '--preload', preload, join(repoRoot, 'scripts/soak.ts'), '--fault', 'flood', '--windows', '2', '--minutes', '0.4', '--out', out], {
      cwd: repoRoot,
      env: {
        ...createIsolatedRuntimeEnvironment(root, { repoRoot }),
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
        TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    // the watchdog bounds a real daemon/browser child that cannot share fake timers
    const watchdog = setTimeout(() => child.kill('SIGTERM'), 180_000)
    try {
      expect(await child.exited).toBe(2)
      expect(await errors).toContain('flood observed')
      await output
      expect(existsSync(join(out, 'soak-report.json'))).toBe(false)
      expect(existsSync(readFileSync(join(root, 'home.txt'), 'utf8'))).toBe(false)
      for (const file of ['browser.pid', 'daemon.pid']) expect(isAlive(Number(readFileSync(join(out, file), 'utf8').trim()))).toBe(false)
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null) child.kill('SIGTERM')
      await child.exited
      await Promise.all([output, errors])
      expect(sourceOutputs()).toEqual(before)
      rmSync(root, { recursive: true, force: true })
    }
  }, 240_000)
}

test.skipIf(executable === null)('records every scheduled phase, switch, panel and git probe in a three-minute rotated run', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-rotated-'))
  const before = sourceOutputs()
  try {
    const code = await main(['--windows', '2', '--minutes', '3', '--out', out])
    expect([0, 1]).toContain(code)
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(report.disqualified).toEqual(['ran 3 minutes, needs 30'])
    expect(report.day?.enabled).toBe(true)
    expect(report.checks.day).toMatchObject({
      ok: true, expectedPhases: 1, expectedSwitches: 4, expectedTaskInteractions: 2, taskInteractions: 2,
      missing: [], duplicates: [], unscheduled: [], wrongTarget: [], failed: []
    })
    for (const phase of report.phases) expect(phase).toMatchObject({ ok: true, missing: [] })
    for (const record of report.switches) {
      expect(record.ok).toBe(true)
      expect(record.settled).toBe(record.requested)
      expect(record.proof?.worktree).toBe(record.requested)
    }
    expect(report.taskInteractions).toHaveLength(2)
    for (const record of report.taskInteractions) {
      expect(record).toMatchObject({ kind: 'task', seq: 0, method: 'quirky.tasks/preferences', ok: true, error: null })
      expect(record.proof?.method).toBe('quirky.tasks/state')
    }
    const expected = daySchedule({ seconds: 180, windows: report.day!.windows, worktrees: report.day!.worktrees })
    expect(report.switches.map(({ index, seq, requested }) => ({ index, seq, to: requested }))).toEqual(
      expected.filter((action) => action.kind === 'switch').map(({ index, seq, to }) => ({ index, seq, to }))
    )
    expect(report.taskInteractions.map(({ index, seq }) => ({ index, seq }))).toEqual(
      expected.filter((action) => action.kind === 'task').map(({ index, seq }) => ({ index, seq }))
    )
    for (const index of [0, 1]) {
      for (const panel of ['changes', 'checks', 'explorer', 'tasks']) {
        expect(report.checks.refreshes.byPanel.find((row) => row.index === index && row.panel === panel)?.total).toBeGreaterThan(0)
      }
    }
    for (const worktree of report.day!.worktrees) {
      expect(report.checks.stalls.git.byWorktree.find((row) => row.worktree === worktree)?.probes).toBeGreaterThanOrEqual(1)
    }
    expect(report.checks.requests.byWindow).toHaveLength(2)
    for (const row of report.checks.requests.byWindow) expect(row.peakPerMinute).toBeGreaterThan(0)
    expect(report.config.limits.maxWindowRequestsPerMinute).toBe(2500)
    expect(report.checks.requests.ok).toBe(true)
    console.log(`rotated soak: ${JSON.stringify({
      stalls: report.checks.stalls.ok, refreshes: report.checks.refreshes.ok, requests: report.checks.requests.ok,
      gitProbes: report.checks.stalls.git.probes, taskInteractions: report.checks.day.taskInteractions
    })}`)
  } finally {
    expect(sourceOutputs()).toEqual(before)
    rmSync(out, { recursive: true, force: true })
  }
}, 420_000)
