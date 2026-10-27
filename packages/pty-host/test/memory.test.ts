import { afterEach, expect, test } from 'bun:test'
import { ready, runCleanups, startProcess, tempHome, waitFor } from './helpers'

afterEach(runCleanups)

const SESSIONS = 40
const LAST_LINE = 650000

async function residentMiB(pid: number): Promise<number> {
  const proc = Bun.spawn(['ps', '-o', 'rss=', '-p', String(pid)], { stdout: 'pipe' })
  const kib = Number((await new Response(proc.stdout).text()).trim())
  await proc.exited
  return kib / 1024
}

test(
  'host memory stays bounded while sessions print megabytes of output',
  async () => {
    const home = tempHome()
    const host = startProcess(home)
    const { client } = await ready(home)

    const before = await residentMiB(host.pid)
    for (let i = 0; i < SESSIONS; i++) {
      await client.request('create', {
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
    const after = await residentMiB(host.pid)

    expect(after - before).toBeLessThan(SESSIONS * 1.5 + 40)

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
