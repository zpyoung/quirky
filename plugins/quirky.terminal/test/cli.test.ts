import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { QuirkyClient, Session } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import { createSession, startPluginHarness, TERMINAL_PLUGINS, testCliContext } from './support'

let h: Harness
let client: QuirkyClient
let shell: Session

beforeEach(async () => {
  process.env.QUIRKY_TEST_ENTER_DELAY_MS = '20'
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('cli')
  shell = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
  h.pty.setReadResult({ lines: ['one', 'two'], cols: 80, rows: 24, alt: false })
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_ENTER_DELAY_MS
  await h.cleanup()
})

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { kind?: string }
  }
  throw new Error('expected a failure')
}

describe('term read', () => {
  test('prints the screen lines for the session given or the one in the env', async () => {
    const { ctx, lines } = testCliContext(client, { env: { QUIRKY_SESSION_ID: shell.id } })
    await commands.read!({ positionals: [], flags: { lines: 5 } }, ctx)
    await commands.read!({ positionals: [shell.id], flags: {} }, testCliContext(client).ctx)
    expect(lines).toEqual(['one\ntwo'])
    expect(h.pty.requests.filter((r) => r.type === 'read').map((r) => r.type === 'read' && r.lines)).toEqual([5, 50])
  })

  test('--json prints the read result', async () => {
    const { ctx, lines } = testCliContext(client, { env: { QUIRKY_SESSION_ID: shell.id }, json: true })
    await commands.read!({ positionals: [], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!)).toEqual({ lines: ['one', 'two'], cols: 80, rows: 24, alt: false })
  })

  test('usage errors keep their v1 wording', async () => {
    const { ctx } = testCliContext(client)
    expect(await failure(commands.read!({ positionals: [], flags: {} }, ctx))).toMatchObject({
      message: 'no session id; pass <sessionId> or set QUIRKY_SESSION_ID',
      kind: 'usage'
    })
    expect((await failure(commands.read!({ positionals: [shell.id], flags: { lines: 0 } }, ctx))).message).toBe('--lines must be at least 1')
    expect((await failure(commands.read!({ positionals: [shell.id, 'x'], flags: {} }, ctx))).message).toBe('unexpected argument "x"')
  })
})

describe('term send', () => {
  test('types the text, with an explicit or an implicit session', async () => {
    const { ctx, lines } = testCliContext(client, { env: { QUIRKY_SESSION_ID: shell.id } })
    await commands.send!({ positionals: [shell.id, 'ls -la'], flags: { enter: true } }, ctx)
    await commands.send!({ positionals: ['pwd'], flags: {} }, ctx)
    expect(lines).toEqual([`sent to ${shell.id}`, `sent to ${shell.id}`])
    await waitFor(() => h.pty.inputs.length === 2)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['ls -la\r', 'pwd'])
  })

  test('usage errors keep their v1 wording', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(commands.send!({ positionals: [], flags: {} }, ctx))).message).toBe('missing <text>')
    expect((await failure(commands.send!({ positionals: ['text'], flags: {} }, ctx))).message).toBe('missing <text>')
    expect((await failure(commands.send!({ positionals: ['a', 'b', 'c'], flags: {} }, ctx))).message).toBe('unexpected argument "c"')
  })
})

describe('through the real CLI', () => {
  test('SC-21: quirky terminal read defaults to the session in the env', async () => {
    const result = await runCli(['terminal', 'read', '--lines', '3'], { home: h.home, env: { QUIRKY_SESSION_ID: shell.id } })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('one\ntwo\n')
    expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ sessionId: shell.id, lines: 3 })
  })

  test('quirky terminal send types into the session and prints the v1 line', async () => {
    const result = await runCli(['terminal', 'send', shell.id, 'echo hi', '--enter'], { home: h.home })
    expect(result.stdout).toBe(`sent to ${shell.id}\n`)
    await waitFor(() => h.pty.inputs.length === 1)
    expect(h.pty.inputs[0]).toEqual({ sessionId: shell.id, text: 'echo hi\r' })
  })

  test('without a session it is a usage error', async () => {
    const result = await runCli(['terminal', 'read'], { home: h.home })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('no session id')
  })
})
