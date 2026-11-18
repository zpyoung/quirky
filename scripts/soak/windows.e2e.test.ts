import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../soak.ts'
import type { Sample, SoakReport } from './contracts.ts'
import { windowAlive } from './verdict.ts'
import { chromiumPath, openWindows, type SoakWindows } from './windows.ts'
import { startWorld, type SoakWorld } from './world.ts'

const executable = chromiumPath()
if (executable === null) console.warn('Skipping soak window proof: run bunx playwright install chromium')

function sourceOutputs(): unknown[] {
  const entries: unknown[] = []
  const visit = (path: string) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) { entries.push([path, 'absent']); return }
    entries.push([path, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'directory'])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  const plugins = resolve(import.meta.dir, '../../plugins')
  for (const plugin of readdirSync(plugins).sort()) {
    if (statSync(join(plugins, plugin)).isDirectory()) visit(join(plugins, plugin, 'dist'))
  }
  return entries
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(executable === null)('measures two real renderer windows without counting browser processes and cleans up', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-windows-'))
  const before = sourceOutputs()
  try {
    await main(['--minutes', '0.4', '--out', out, '--windows', '2'])
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(report.config.windows).toBe(2)
    expect(report.checks.windows).toEqual({ ok: true, expected: 2, alive: 2, lost: [] })
    expect(report.checks.refreshes.ok).toBe(true)
    expect(report.checks.refreshes.missingWindows).toEqual([])
    expect(report.checks.refreshes.byWindow).toHaveLength(2)
    for (const record of report.panelRefreshes) {
      expect(Number.isFinite(record.at)).toBe(true)
      expect(record.at).toBeGreaterThanOrEqual(0)
      expect(record.at).toBeLessThanOrEqual(report.durationSeconds)
      expect(['quirky.git/status', 'quirky.reviews/checksRefresh']).toContain(record.method)
      expect(report.windows.some((window) => window.index === record.index && window.worktree === record.worktree)).toBe(true)
    }
    const gitRefreshes = report.panelRefreshes.filter(({ method }) => method === 'quirky.git/status')
    for (const window of report.windows) {
      expect(gitRefreshes.filter((record) => record.index === window.index && record.worktree === window.worktree).length).toBeGreaterThanOrEqual(3)
    }
    expect(gitRefreshes.length).toBeGreaterThanOrEqual(6)
    expect(report.disqualified).toContain('ran 0.4 minutes, needs 30')
    expect(report.disqualified.some((reason) => reason.includes('windows connected'))).toBe(false)
    expect(report.windows).toHaveLength(2)
    expect(report.windows.map(({ index }) => index)).toEqual([0, 1])
    expect(report.windows[0]!.worktree).not.toBe(report.windows[1]!.worktree)
    expect(report.windows[0]!.connId).not.toBe(report.windows[1]!.connId)
    for (const record of report.windows) {
      expect(record.open).toBe(true)
      expect(record.shown).toBe(true)
      expect(record.requests).toBeGreaterThanOrEqual(10)
      expect(record.sockets).toBeGreaterThanOrEqual(1)
    }
    const browserPid = Number(readFileSync(join(out, 'browser.pid'), 'utf8').trim())
    const daemonPid = Number(readFileSync(join(out, 'daemon.pid'), 'utf8').trim())
    const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Sample)
    for (const sample of samples) {
      for (const row of sample.owned) {
        expect(row.pid).not.toBe(browserPid)
        expect(row.ppid).not.toBe(browserPid)
      }
    }
    expect(isAlive(browserPid)).toBe(false)
    expect(isAlive(daemonPid)).toBe(false)
  } finally {
    expect(sourceOutputs()).toEqual(before)
    rmSync(out, { recursive: true, force: true })
  }
}, 240_000)

test.skipIf(executable === null)('marks a closed window lost while the other renderer keeps polling', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-window-loss-'))
  const before = sourceOutputs()
  let world: SoakWorld | undefined
  let windows: SoakWindows | undefined
  try {
    world = await startWorld({ out, repoRoot: resolve(import.meta.dir, '../..'), windows: 2 })
    windows = await openWindows({ world, count: 2, executable: executable!, out, signal: new AbortController().signal })
    const builtinRoot = world.env.QUIRKY_BUILTIN_PLUGINS_DIR!
    expect(builtinRoot).toBe(join(world.home, 'builtin-plugins'))
    expect(world.env.QUIRKY_PLUGINS_DIR).toBe(builtinRoot)
    expect(lstatSync(builtinRoot).isSymbolicLink()).toBe(false)
    expect(realpathSync(builtinRoot)).toBe(join(realpathSync(world.home), 'builtin-plugins'))
    const resources = await windows.pages[0]!.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name))
    const generated = resources.find((url) => new URL(url).pathname.startsWith('/plugins/quirky.git/dist/') && new URL(url).pathname.endsWith('.js'))
    expect(generated).toBeDefined()
    const path = new URL(generated!).pathname.replace('/plugins/', '')
    const response = await windows.pages[0]!.request.get(generated!)
    expect(response.ok()).toBe(true)
    expect(await response.text()).toBe(readFileSync(join(builtinRoot, path), 'utf8'))
    await windows.pages[0]!.screenshot({ path: join(out, 'staged-renderer.png') })
    await windows.pages[0]!.context().close()
    // real renderer sockets and daemon disconnects cannot advance on fake timers
    await Bun.sleep(1000)
    const result = await windows.finish()
    expect(result.records[0]!.open).toBe(false)
    expect(windowAlive(result.records[0]!)).toBe(false)
    expect(result.records[1]!.open).toBe(true)
    expect(result.records[1]!.shown).toBe(true)
    expect(windowAlive(result.records[1]!)).toBe(true)
  } finally {
    try {
      await windows?.stop()
    } finally {
      await world?.stop()
      expect(sourceOutputs()).toEqual(before)
      rmSync(out, { recursive: true, force: true })
    }
  }
}, 240_000)
