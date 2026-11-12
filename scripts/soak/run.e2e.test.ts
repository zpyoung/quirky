import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../soak.ts'
import type { Sample, SoakReport } from './contracts.ts'
import { PROTOCOL_VERSION } from '@quirky/protocol'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures.ts'
import { startProbe } from './probe.ts'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('measures real workers, hooks, processes and probes and cleans up its daemon', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-e2e-'))
  try {
    const code = await main(['--minutes', '0.4', '--out', out, '--max-children', '1'])
    expect(code).toBe(1)
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(report.verdict).toBe('fail')
    expect(report.durationSeconds).toBeGreaterThanOrEqual(24)
    expect(report.durationSeconds).toBeLessThanOrEqual(40)
    expect(report.qualifies).toBe(false)
    expect(report.config.worktrees).toBe(7)
    expect(report.config.workers).toBe(7)
    expect(report.checks.children.ok).toBe(false)
    expect(report.checks.children.peak).toBeGreaterThanOrEqual(7)
    expect(report.checks.workers).toEqual({ ok: true, expected: 7, alive: 7, stale: [] })
    expect(report.checks.stalls.probes).toBeGreaterThanOrEqual(40)
    expect(report.checks.stalls.daemonExited).toBe(false)
    expect(report.checks.events.total).toBeGreaterThanOrEqual(1)
    expect(report.checks.events.byType.some(({ type }) => type === 'quirky.agent-status/changed')).toBe(true)
    expect(report.disqualified).toContain('ran 0.4 minutes, needs 30')
    expect(report.disqualified).toContain('0 windows connected, needs 2')
    expect(report.disqualified.some((reason) => reason.startsWith('limit loosened'))).toBe(false)
    const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Sample)
    expect(samples.length).toBeGreaterThanOrEqual(20)
    for (const sample of samples) {
      expect(Number.isFinite(sample.at)).toBe(true)
      expect(Array.isArray(sample.owned)).toBe(true)
      expect(sample.daemonRssKb === null || Number.isFinite(sample.daemonRssKb)).toBe(true)
    }
    expect(existsSync(join(out, 'daemon.log'))).toBe(true)
    const pid = Number(readFileSync(join(out, 'daemon.pid'), 'utf8').trim())
    expect(pid).toBe(report.daemon.pid)
    expect(isAlive(pid)).toBe(false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 180_000)

test('bounds a healthy endpoint that never answers the probe handshake', async () => {
  const home = mkdtempSync(join(tmpdir(), 'quirky-soak-handshake-'))
  let stallHealth = false
  const healthReply = Promise.withResolvers<Response>()
  const sockets = new Set<{ close(): void }>()
  const closeSockets = () => {
    for (const socket of sockets) socket.close()
  }
  const capture = (stream: ReadableStream<Uint8Array>) => new Response(stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      // the external stand-in releases its sockets once the child has judged the run
      closeSockets()
      controller.enqueue(chunk)
    }
  }))).text()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/rpc' && server.upgrade(request)) return
      if (stallHealth) return healthReply.promise
      return Response.json({ pid: process.pid })
    },
    websocket: {
      idleTimeout: 0,
      open(socket) { sockets.add(socket) },
      close(socket) { sockets.delete(socket) },
      message() {}
    }
  })
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({
    pid: process.pid, port: server.port, token: 'soak-test', hookToken: 'soak-test',
    daemonVersion: 'test', protocolVersion: PROTOCOL_VERSION, startedAt: Date.now()
  }))
  const abort = new AbortController()
  // a real websocket handshake needs the platform clock, not fake timers
  const timer = setTimeout(() => abort.abort(), 35_000)
  const began = performance.now()
  let failure: unknown
  try {
    try {
      await startProbe({ home, startedAt: began, onDaemonLost() {}, signal: abort.signal })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('30000')
    closeSockets()
    const repoRoot = resolve(import.meta.dir, '../..')
    const probePath = join(repoRoot, 'scripts/soak/probe.ts')
    const preload = join(home, 'probe-stall.ts')
    mkdirSync(join(home, 'tmp'))
    writeFileSync(preload, `
import { mock } from 'bun:test'
import { startProbe as originalStartProbe } from ${JSON.stringify(probePath)}
const startProbe = originalStartProbe
mock.module(${JSON.stringify(probePath)}, () => ({
  startProbe: (options) => startProbe({ ...options, home: ${JSON.stringify(home)} })
}))
`)
    for (const mode of ['handshake', 'health']) {
      stallHealth = mode === 'health'
      const out = join(home, mode)
      const child = Bun.spawn([process.execPath, '--preload', preload, join(repoRoot, 'scripts/soak.ts'), '--minutes', '0.4', '--out', out], {
        cwd: repoRoot,
        env: createIsolatedRuntimeEnvironment(home, { repoRoot }),
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const output = capture(child.stdout)
      const errors = capture(child.stderr)
      const watchdog = setTimeout(() => child.kill('SIGTERM'), 185_000)
      try {
        const code = await child.exited
        const stderr = await errors
        await output
        if (code !== 1) console.error(`soak ${mode} child exited ${code}\n${stderr}`)
        expect(code).toBe(1)
        const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
        expect(report.verdict).toBe('fail')
        expect(report.checks.stalls).toMatchObject({ ok: false, probes: 1, stalls: 1, daemonExited: false })
        if (mode === 'handshake') expect(report.checks.stalls.maxMs).toBe(30_000)
        else expect(report.checks.stalls.maxMs).toBeGreaterThanOrEqual(1000)
        expect(isAlive(report.daemon.pid)).toBe(false)
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null) child.kill('SIGTERM')
        await child.exited
        await Promise.all([output, errors])
      }
    }
  } finally {
    clearTimeout(timer)
    abort.abort()
    healthReply.resolve(Response.json({ pid: process.pid }))
    closeSockets()
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 225_000)

test('reports daemon loss between worker startup and probe connection as a failed run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-probe-loss-'))
  const out = join(root, 'out')
  const preload = join(root, 'probe-loss.ts')
  const repoRoot = resolve(import.meta.dir, '../..')
  const probePath = join(repoRoot, 'scripts/soak/probe.ts')
  const nodePath = join(repoRoot, 'packages/protocol/src/node/index.ts')
  mkdirSync(join(root, 'tmp'))
  writeFileSync(preload, `
import { mock } from 'bun:test'
import { startProbe as originalStartProbe } from ${JSON.stringify(probePath)}
import { readRuntime, isDaemonAlive } from ${JSON.stringify(nodePath)}
const startProbe = originalStartProbe
mock.module(${JSON.stringify(probePath)}, () => ({
  startProbe: async (options) => {
    const runtime = readRuntime(options.home)
    process.kill(runtime.pid, 'SIGTERM')
    while (await isDaemonAlive(runtime, 100)) await Bun.sleep(10)
    return startProbe(options)
  }
}))
`)
  const child = Bun.spawn([process.execPath, '--preload', preload, join(repoRoot, 'scripts/soak.ts'), '--minutes', '0.4', '--out', out], {
    cwd: repoRoot,
    env: createIsolatedRuntimeEnvironment(root, { repoRoot }),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill('SIGTERM'), 150_000)
  try {
    const code = await child.exited
    const stderr = await errors
    await output
    if (code !== 1) console.error(`soak daemon-loss child exited ${code}\n${stderr}`)
    expect(code).toBe(1)
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(report.verdict).toBe('fail')
    expect(report.checks.stalls.daemonExited).toBe(true)
    expect(report.checks.stalls.ok).toBe(false)
    expect(isAlive(report.daemon.pid)).toBe(false)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGTERM')
    await child.exited
    await Promise.all([output, errors])
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
