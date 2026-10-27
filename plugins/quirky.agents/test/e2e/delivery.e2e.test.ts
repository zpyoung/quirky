import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { QuirkyClient, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startAgentsE2E, type E2E, type FakeBehavior, type FakeEvent } from '../support/e2e'

const BRACKETED_PASTE_ON = '\u001b[?2004h'
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const DAEMON_MAIN = resolve(import.meta.dir, '../../../../packages/daemon/src/main.ts')
const STDIN_DELIVERY_PLUGIN = join(import.meta.dir, 'fixtures-delivery/acme.stdin-delivery')

let e2e: E2E | undefined
let restartedClient: QuirkyClient | undefined
afterEach(async () => {
  restartedClient?.close()
  restartedClient = undefined
  await e2e?.cleanup()
  e2e = undefined
})

/** A fake that enables bracketed paste, prints a prompt line and goes quiet. */
const pasteFake = (delayMs = 50): FakeBehavior => ({
  raw: true,
  steps: [
    { afterMs: delayMs, write: BRACKETED_PASTE_ON },
    { afterMs: 10, write: '> \r\n' }
  ]
})

/** A fake that never enables bracketed paste, so no ready signal ever fires. */
const silentFake: FakeBehavior = { raw: true }

type SessionRecord = { id: string; status: string; promptDelivery: string | null; agent: string }

const startsOf = (events: FakeEvent[]) => events.filter((event) => event.type === 'start')

const inputChunks = (events: FakeEvent[]) =>
  events.flatMap((event) => (event.type === 'input' ? [{ text: Buffer.from(event.b64, 'base64').toString('utf8'), at: event.at }] : []))

const inputOf = (events: FakeEvent[]) =>
  inputChunks(events)
    .map((chunk) => chunk.text)
    .join('')

const paste = (text: string) => `${PASTE_START}${text}${PASTE_END}`

function createParams(agent: string, prompt: string, extra: Record<string, unknown> = {}) {
  return { worktree: `path:${e2e!.repo}`, agent, prompt, ...extra }
}

async function create(agent: string, prompt: string, extra: Record<string, unknown> = {}): Promise<SessionRecord> {
  return (await e2e!.call('quirky.session/create', createParams(agent, prompt, extra))) as SessionRecord
}

async function listed(sessionId: string): Promise<SessionRecord> {
  const result = await e2e!.cli(['session', 'list', '--json'])
  expect(result.code).toBe(0)
  const found = (JSON.parse(result.stdout) as SessionRecord[]).find((session) => session.id === sessionId)
  if (!found) throw new Error(`session ${sessionId} not listed`)
  return found
}

async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

test(
  'SC-20: a stdin-after-start agent gets one bracketed paste, then Enter',
  async () => {
    e2e = await startAgentsE2E({ fakes: { goose: pasteFake() }, timeScale: 1 })
    const session = await create('goose', 'a\r\nb\u001bc', { waitForPrompt: true })
    expect(session.promptDelivery).toBe('pasted')

    const events = await e2e.waitForFakeLog('goose', (log) => inputOf(log).endsWith(`${PASTE_END}\r`), 15_000)
    const chunks = inputChunks(events)
    expect(inputOf(events)).toBe(`${paste('a\rb␛c')}\r`)

    const enter = chunks.at(-1)!
    expect(enter.text).toBe('\r')
    const firstPasteChunk = chunks[0]!
    expect(firstPasteChunk.text.startsWith(PASTE_START)).toBe(true)
    // 500 ms settle plus 1 ms per 4 KiB; a few ms of slack for when each read was logged
    expect(enter.at - firstPasteChunk.at).toBeGreaterThanOrEqual(480)
    expect((await listed(session.id)).promptDelivery).toBe('pasted')
  },
  60_000
)

test(
  'SC-22: an agent that never signals ready gets a blind paste, reported as unconfirmed',
  async () => {
    const scale = 0.1
    e2e = await startAgentsE2E({ fakes: { aider: silentFake }, timeScale: scale })
    const startedAt = Date.now()
    const session = await create('aider', 'hi', { waitForPrompt: true })
    const elapsed = Date.now() - startedAt

    expect(session.promptDelivery).toBe('unconfirmed')
    // the 8 s deadline on the scaled clock, and well short of the unscaled one
    expect(elapsed).toBeGreaterThanOrEqual(8000 * scale * 0.9)
    expect(elapsed).toBeLessThan(8000 * 0.6)

    const events = await e2e.waitForFakeLog('aider', (log) => inputOf(log).endsWith(`${PASTE_END}\r`), 15_000)
    expect(inputOf(events)).toBe(`${paste('hi')}\r`)
    expect((await listed(session.id)).promptDelivery).toBe('unconfirmed')
  },
  60_000
)

test(
  'SC-23: a prompt lost behind a dialog is reported, never silent',
  async () => {
    const scale = 0.1
    const dialog: FakeBehavior = {
      raw: true,
      steps: [{ afterMs: 50, write: 'Update available! 0.1.0 -> 0.2.0\r\n  1. Update now\r\n  2. Skip\r\n  3. Skip until next version\r\n' }]
    }
    e2e = await startAgentsE2E({ fakes: { codex: dialog }, timeScale: scale })

    const startedAt = Date.now()
    const created = await e2e.cli(['session', 'new', '--agent', 'codex', '--prompt', 'review', '--draft', '--wait'])
    const elapsed = Date.now() - startedAt
    expect(created.code).toBe(0)
    expect(created.stdout).toContain('prompt: not-delivered')
    // codex waits out its 20 s deadline on the scaled clock and never pastes blind
    expect(elapsed).toBeGreaterThanOrEqual(20_000 * scale * 0.9)
    expect(elapsed).toBeLessThan(20_000 * 0.6)

    const json = await e2e.cli(['session', 'list', '--json'])
    const sessions = JSON.parse(json.stdout) as SessionRecord[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ agent: 'codex', status: 'running', promptDelivery: 'not-delivered' })

    // outlast the paste's Enter delays, so a late write would show
    await Bun.sleep(1500 * scale + 500)
    expect(startsOf(e2e.fakeLog('codex'))).toHaveLength(1)
    expect(inputChunks(e2e.fakeLog('codex'))).toEqual([])
  },
  60_000
)

test(
  'SC-24: a session that ends or closes first gets nothing',
  async () => {
    e2e = await startAgentsE2E({ fakes: { amp: { raw: true, exitAfterMs: 100 }, aider: silentFake }, timeScale: 0.1 })

    const amp = await create('amp', 'hello', { waitForPrompt: true })
    expect(amp.promptDelivery).toBe('not-delivered')
    expect((await listed(amp.id)).promptDelivery).toBe('not-delivered')

    const aider = await create('aider', 'hello')
    await e2e.call('quirky.session/close', { session: aider.id })
    const daemonLog = join(dirname(e2e.home), 'daemon.log')
    await waitFor(() => existsSync(daemonLog) && readFileSync(daemonLog, 'utf8').includes(`prompt for session ${aider.id} (aider) not-delivered`), 10_000, 'the aider delivery to settle as not-delivered')

    // outlast aider's scaled 8 s deadline, when a blind paste would have happened
    await Bun.sleep(8000 * 0.1 + 500)
    expect(inputChunks(e2e.fakeLog('amp'))).toEqual([])
    expect(inputChunks(e2e.fakeLog('aider'))).toEqual([])
  },
  60_000
)

test(
  'SC-25: per-agent Enter timing',
  async () => {
    const scale = 0.5
    e2e = await startAgentsE2E({ fakes: { qwen: pasteFake(), agy: pasteFake(), omp: pasteFake() }, timeScale: scale })
    const installed = (await e2e.call('plugin.install', { path: STDIN_DELIVERY_PLUGIN, yes: true })) as { id: string }
    expect(installed.id).toBe('acme.stdin-delivery')
    const listing = (await e2e.call('quirky.agents/list')) as { agents: { id: string; plugin: string; promptMode: string }[] }
    for (const id of ['antigravity', 'omp']) {
      expect(listing.agents.find((agent) => agent.id === id)).toMatchObject({ plugin: 'acme.stdin-delivery', promptMode: 'stdin-after-start' })
    }

    const prompt = 'one\ntwo\nthree'
    const body = paste('one\rtwo\rthree')
    const results = await Promise.all([
      create('qwen-code', prompt, { waitForPrompt: true }),
      create('antigravity', prompt, { waitForPrompt: true }),
      create('omp', prompt, { waitForPrompt: true })
    ])
    for (const result of results) expect(result.promptDelivery).toBe('pasted')
    await Bun.sleep(1200 * scale + 300)

    const slack = 20
    // qwen-code: paste, an Enter after the 500 ms settle, a second Enter 1,200 ms later
    const qwen = inputChunks(e2e.fakeLog('qwen'))
    expect(qwen.map((chunk) => chunk.text).join('')).toBe(`${body}\r\r`)
    const [qwenFirst, qwenSecond] = qwen.slice(-2)
    expect(qwenFirst!.text).toBe('\r')
    expect(qwenFirst!.at - qwen[0]!.at).toBeGreaterThanOrEqual(500 * scale - slack)
    expect(qwenSecond!.at - qwenFirst!.at).toBeGreaterThanOrEqual(1200 * scale - slack)
    expect(qwenSecond!.at - qwenFirst!.at).toBeLessThan(1200 * scale + 400)

    // antigravity: 45 ms per line is added to the settle, so three lines wait 500 + 135 ms
    const agy = inputChunks(e2e.fakeLog('agy'))
    expect(agy.map((chunk) => chunk.text).join('')).toBe(`${body}\r`)
    expect(agy.at(-1)!.text).toBe('\r')
    expect(agy.at(-1)!.at - agy[0]!.at).toBeGreaterThanOrEqual((500 + 3 * 45) * scale - slack)

    // omp: Enter rides in the paste's own write
    const omp = inputChunks(e2e.fakeLog('omp'))
    expect(omp.map((chunk) => chunk.text).join('')).toBe(`${body}\r`)
    expect(omp.find((chunk) => chunk.text.includes(PASTE_END))!.text.endsWith(`${PASTE_END}\r`)).toBe(true)
  },
  90_000
)

test(
  'SC-28: create returns at spawn unless asked to wait',
  async () => {
    // the fake's signal arrives about 1 s after the process starts, well inside the scaled 4 s deadline
    e2e = await startAgentsE2E({ fakes: { qwen: pasteFake(1000) }, timeScale: 0.5 })
    const events: QuirkyEvent[] = []
    e2e.client.onEvent((event) => events.push(event))
    await e2e.client.call('events.subscribe', {})

    const refused = await e2e
      .call('quirky.session/create', createParams('qwen-code', 'before\u0000after'))
      .then(() => null, (error: { code: number; message: string }) => error)
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'the prompt contains a NUL character' })
    expect((await e2e.cli(['session', 'list', '--json'])).stdout.trim()).toBe('[]')
    expect(startsOf(e2e.fakeLog('qwen'))).toHaveLength(0)

    const session = await create('qwen-code', 'tell me more')
    expect(session.promptDelivery).toBe('pending')
    expect(inputChunks(e2e.fakeLog('qwen'))).toEqual([])
    expect((await listed(session.id)).promptDelivery).toBe('pending')

    const changed = await waitFor(
      () =>
        events.find((event) => {
          if (event.type !== 'quirky.session/changed' || !('data' in event)) return false
          const changedSession = (event.data as { session?: SessionRecord }).session
          return changedSession?.id === session.id && changedSession.promptDelivery === 'pasted'
        }),
      20_000,
      'quirky.session/changed with delivery pasted'
    )
    expect(changed).toBeDefined()
    expect(inputOf(e2e.fakeLog('qwen')).startsWith(paste('tell me more'))).toBe(true)
    expect((await listed(session.id)).promptDelivery).toBe('pasted')
  },
  60_000
)

test(
  'SC-28: a delivery still pending when the daemon restarts is marked not-delivered at startup',
  async () => {
    e2e = await startAgentsE2E({ fakes: { aider: silentFake }, timeScale: 1 })
    const session = await create('aider', 'hello')
    expect(session.promptDelivery).toBe('pending')

    // a crash, not a stop: a graceful stop would settle the delivery itself and hide the startup sweep
    const old = readRuntime(e2e.home)!
    process.kill(old.pid, 'SIGKILL')
    await waitFor(async () => !(await isDaemonAlive(old)), 10_000, 'the old daemon to die')

    const root = dirname(e2e.home)
    const restarted = e2e.processScope.spawn([process.execPath, DAEMON_MAIN], {
      env: {
        QUIRKY_HOME: e2e.home,
        HOME: e2e.userHome,
        SHELL: join(root, 'shells/sh'),
        PATH: `${e2e.fakebin}:/usr/bin:/bin`,
        QUIRKY_AGENT_SEARCH_DIRS: '',
        QUIRKY_PORT: '0',
        QUIRKY_TEST_AGENT_TIME_SCALE: '1',
        ...e2e.processScope.env
      },
      stdout: 'ignore',
      stderr: 'ignore'
    })

    const runtime = await waitFor(async () => {
      if (restarted.exitCode !== null) throw new Error(`the restarted daemon exited ${restarted.exitCode}`)
      const info = readRuntime(e2e!.home)
      return info && info.pid !== old.pid && (await isDaemonAlive(info)) ? info : undefined
    }, 20_000, 'the restarted daemon')
    restartedClient = await QuirkyClient.connect(rpcUrl(runtime), { role: 'cli', name: 'agents-e2e-restart' })

    const after = (await waitFor(async () => {
      const sessions = (await restartedClient!.callAny('quirky.session/list', {})) as SessionRecord[]
      return sessions.find((record) => record.id === session.id)
    }, 10_000, 'the session after restart'))
    expect(after.promptDelivery).toBe('not-delivered')
    expect(inputChunks(e2e.fakeLog('aider'))).toEqual([])
  },
  90_000
)
