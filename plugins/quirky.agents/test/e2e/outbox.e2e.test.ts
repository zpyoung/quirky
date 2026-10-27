import { afterEach, expect, test } from 'bun:test'
import { startAgentsE2E, type E2E } from '../support/e2e'

let e2e: E2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

async function screenOf(session: string): Promise<string> {
  const { lines } = (await e2e!.call('quirky.terminal/read', { session, lines: 50 })) as { lines: string[] }
  return lines.join('\n')
}

async function waitForScreen(session: string, text: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const screen = await screenOf(session)
    if (screen.includes(text)) return screen
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} on screen:\n${screen}`)
    await Bun.sleep(50)
  }
}

test(
  'print: text appended to the outbox of a running fake reaches the session screen',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: { raw: true } } })
    const created = await e2e.cli(['session', 'new', '--agent', 'claude', '--json'])
    expect(created.code).toBe(0)
    const session = (JSON.parse(created.stdout) as { id: string }).id
    await e2e.waitForFakeLog('claude', (events) => events.some((event) => event.type === 'start'), 15_000)

    e2e.print('claude', 'first line\r\n')
    await waitForScreen(session, 'first line', 10_000)
    e2e.print('claude', 'second line\r\n')
    const screen = await waitForScreen(session, 'second line', 10_000)
    expect(screen.split('first line').length - 1).toBe(1)
  },
  40_000
)

test(
  'print: output already in the outbox when the fake starts is not replayed',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: { raw: true } } })
    e2e.print('claude', 'stale text\r\n')
    const created = await e2e.cli(['session', 'new', '--agent', 'claude', '--json'])
    expect(created.code).toBe(0)
    const session = (JSON.parse(created.stdout) as { id: string }).id
    await e2e.waitForFakeLog('claude', (events) => events.some((event) => event.type === 'start'), 15_000)

    e2e.print('claude', 'fresh text\r\n')
    const screen = await waitForScreen(session, 'fresh text', 10_000)
    expect(screen).not.toContain('stale text')
  },
  40_000
)
