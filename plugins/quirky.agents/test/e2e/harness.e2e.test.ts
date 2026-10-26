import { afterEach, expect, test } from 'bun:test'
import { startAgentsE2E, type E2E } from '../support/e2e'

let e2e: E2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test(
  'harness: a fake claude receives the prompt in a temp HOME and leaves no process behind',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true } })
    const created = await e2e.cli(['session', 'new', '--agent', 'claude', '--prompt', 'hello world'])
    expect(created.code).toBe(0)

    const start = await e2e.waitForFakeLog('claude', (events) => events.some((event) => event.type === 'start'), 15_000)
    const first = start.find((event) => event.type === 'start')
    if (first?.type !== 'start') throw new Error('no start event')
    expect(first.argv.at(-1)).toBe('hello world')
    expect(first.env.HOME).toBe(e2e.userHome)

    const listed = await e2e.cli(['session', 'list', '--json'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('claude')

    const pids = e2e.fakeLog('claude').flatMap((event) => (event.type === 'start' ? [event.pid] : []))
    const hostPid = e2e.ptyHostPid()
    expect(pids.length).toBe(1)
    expect(hostPid).toBeGreaterThan(0)
    expect(alive(pids[0]!)).toBe(true)
    expect(alive(hostPid)).toBe(true)

    await e2e.cleanup()
    await e2e.cleanup()
    for (const pid of [...pids, hostPid]) expect(alive(pid)).toBe(false)
  },
  30_000
)
