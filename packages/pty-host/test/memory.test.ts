import { afterEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createScopedSession, ready, runCleanups, scopeForHome, startProcess, tempHome, waitFor } from './helpers'

afterEach(runCleanups)

const SESSIONS = 40
const LAST_LINE = 650000
const FLOOD_SESSION = 'memory-flood'
const FLOOD_BYTES = 512 * 1024 * 1024
const FLOOD_BLOCK_BYTES = 1024 * 1024
const FLOOD_BLOCKS = 1024
const FLOOD_INTERVAL_MS = 25

async function residentMiB(pid: number, home: string): Promise<number> {
  const proc = scopeForHome(home).spawn(['ps', '-o', 'rss=', '-p', String(pid)], { stdout: 'pipe' })
  const kib = Number((await new Response(proc.stdout).text()).trim())
  await proc.exited
  return kib / 1024
}
async function processState(pid: number, home: string): Promise<string> {
  const proc = scopeForHome(home).spawn(['ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe' })
  const state = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  return state
}

test(
  'host memory stays bounded while sessions print megabytes of output',
  async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)

    const before = await residentMiB(host.pid, home)
    for (let i = 0; i < SESSIONS; i++) {
      await createScopedSession(client, home, {
        sessionId: `m${i}`,
        cwd: '/tmp',
        argv: ['/bin/sh', '-c', `seq 1 ${LAST_LINE}`],
        env: { PATH: '/usr/bin:/bin' },
        cols: 80,
        rows: 24
      })
    }
    await waitFor(
      async () => (await client.request('list', {})).every((s) => s.state === 'exited'),
      90000,
      'every session to exit'
    )
    // a loaded machine delays the host's garbage collection, so give it time to settle; a leak never does
    const bound = SESSIONS * 1.5 + 40
    let growth = Infinity
    const settled = Date.now() + 15000
    while (growth >= bound && Date.now() < settled) {
      growth = (await residentMiB(host.pid, home)) - before
      if (growth >= bound) await Bun.sleep(250)
    }
    expect(growth).toBeLessThan(bound)

    // history ends where the screen begins, so the newest rows are the screen's and not in the page
    const page = await client.request('history', { sessionId: 'm0', lines: 20 })
    const numbers = page.lines.map((line) => Number(line.trim()))
    expect(numbers).toHaveLength(20)
    expect(numbers[19]).toBeGreaterThan(LAST_LINE - 100)
    expect(numbers[19]).toBeLessThan(LAST_LINE)
    expect(numbers[19] - numbers[0]).toBe(19)
  },
  120000
)

// Real-time pacing is required to exercise OS-level PTY backpressure during the sustained flood.
test(
  'a SIGSTOPed PTY reader stays bounded during a 512 MiB flood',
  async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client, token } = await ready(home)
    const gatePath = join(home, 'flood-start')
    const floodStartedPath = join(home, 'flood-started')
    const readerReadyPath = join(home, 'stalled-reader-ready')
    const readerClosedPath = join(home, 'stalled-reader-closed')

    const floodProgram = `
while (!(await Bun.file(${JSON.stringify(gatePath)}).exists())) await Bun.sleep(20)
const block = Buffer.alloc(${FLOOD_BLOCK_BYTES})
for (let i = 0; i < ${FLOOD_BLOCKS}; i++) {
  await new Promise((resolve, reject) => {
    process.stdout.write(block, (error) => error ? reject(error) : resolve())
  })
  if (i === 0) await Bun.write(${JSON.stringify(floodStartedPath)}, 'started')
  await Bun.sleep(${FLOOD_INTERVAL_MS})
}
`
    await createScopedSession(client, home, {
      sessionId: FLOOD_SESSION,
      cwd: '/tmp',
      argv: [process.execPath, '-e', floodProgram],
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
      cols: 80,
      rows: 24
    })

    const clientModule = new URL('../src/client.ts', import.meta.url).href
    const readerCode = `
import { writeFileSync } from 'node:fs'
import { PtyClient } from ${JSON.stringify(clientModule)}
const client = await PtyClient.connect(${JSON.stringify(join(home, 'pty.sock'))})
await client.hello(${JSON.stringify(token)})
await client.request('subscribe', { sessionId: ${JSON.stringify(FLOOD_SESSION)}, mode: 'raw' })
writeFileSync(${JSON.stringify(readerReadyPath)}, 'ready')
setInterval(() => {
  if (!client.closed) return
  writeFileSync(${JSON.stringify(readerClosedPath)}, 'closed')
  process.exit(0)
}, 10)
`
    const reader = scopeForHome(home).spawn([process.execPath, '-e', readerCode], {
      stdout: 'ignore',
      stderr: 'ignore'
    })
    let readerStopped = false
    try {
      await waitFor(() => existsSync(readerReadyPath), 10000, 'stalled reader subscription')
      process.kill(reader.pid, 'SIGSTOP')
      readerStopped = true
      await waitFor(async () => /^[Tt]/.test(await processState(reader.pid, home)), 5000, 'reader process to stop')

      const baseline = await residentMiB(host.pid, home)
      writeFileSync(gatePath, 'go')
      await waitFor(() => existsSync(floodStartedPath), 10000, 'flood to start')
      const floodStartedAt = Date.now()
      const deadline = floodStartedAt + 120000
      let peakGrowth = 0
      let pollCount = 0
      let lastOffset = 0
      let lastState = ''
      let nextRssSampleAt = 0

      for (;;) {
        const sessions = await client.request('list', {})
        const session = sessions.find((item) => item.sessionId === FLOOD_SESSION)
        if (!session) throw new Error('flood session disappeared while the healthy client was polling')
        if (session.offset < lastOffset) throw new Error('flood session offset moved backwards')
        pollCount++
        lastOffset = session.offset
        lastState = session.state

        const elapsed = Date.now() - floodStartedAt
        const reachedTarget = session.offset >= FLOOD_BYTES && elapsed >= 10000
        if (Date.now() >= nextRssSampleAt || reachedTarget) {
          peakGrowth = Math.max(peakGrowth, (await residentMiB(host.pid, home)) - baseline)
          nextRssSampleAt = Date.now() + 250
        }
        if (reachedTarget) break
        if (Date.now() >= deadline) {
          throw new Error(`flood did not reach ${FLOOD_BYTES} bytes within 120 seconds; offset=${session.offset}`)
        }
        await Bun.sleep(100)
      }

      const reachedBytes = lastOffset
      const reachedDuration = Date.now() - floodStartedAt
      await client.request('kill', { sessionId: FLOOD_SESSION, reason: 'killed' })
      const killedAt = Date.now()
      await waitFor(
        async () => (await client.request('list', {})).some((session) => session.sessionId === FLOOD_SESSION && session.state === 'exited'),
        10000,
        'flood session to stop'
      )
      await Bun.sleep(Math.max(0, killedAt + 1500 - Date.now()))
      const afterKillGrowth = (await residentMiB(host.pid, home)) - baseline

      process.kill(reader.pid, 'SIGCONT')
      readerStopped = false
      await waitFor(() => existsSync(readerClosedPath), 5000, 'stalled reader to observe the severed socket')

      expect(reachedBytes).toBeGreaterThanOrEqual(FLOOD_BYTES)
      expect(reachedDuration).toBeGreaterThanOrEqual(10000)
      expect(lastState).toBe('running')
      expect(pollCount).toBeGreaterThanOrEqual(50)
      expect(peakGrowth).toBeLessThan(550)
      expect(afterKillGrowth).toBeLessThan(550)
    } finally {
      if (readerStopped && reader.exitCode === null) {
        try {
          process.kill(reader.pid, 'SIGCONT')
        } catch {}
      }
      if (reader.exitCode === null) {
        try {
          reader.kill('SIGKILL')
        } catch {}
      }
      await reader.exited
    }
  },
  180000
)
