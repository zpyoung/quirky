import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { QuirkyClient, Session } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { Screen } from '../../../packages/pty-host/src/screen'
import { commands } from '../cli'
import { createSession, startPluginHarness, TERMINAL_PLUGINS, testCliContext } from './support'

const ANSI_SCREEN = '\x1b[1mprompt$ \x1b[0mls\r\n\x1b[32mfile.txt\x1b[0m\x1b[2;9H'

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

describe('term snapshot', () => {
  test('prints the screen rows as plain text, and --json the whole snapshot', async () => {
    const snapshot = {
      ansi: ANSI_SCREEN,
      cols: 80,
      rows: 24,
      cursor: { x: 8, y: 1 },
      modes: { alternateScreen: false, bracketedPaste: true, mouseTracking: false, applicationCursor: false },
      cwd: '/tmp/w/api/src',
      title: 'build',
      shellState: 'ready' as const,
      offset: 12
    }
    h.pty.setSnapshotResult(snapshot)
    h.pty.setReadResult({ lines: ['prompt$ ls', 'file.txt'], cols: 80, rows: 24, alt: false })
    const text = testCliContext(client, { env: { QUIRKY_SESSION_ID: shell.id } })
    await commands.snapshot!({ positionals: [], flags: {} }, text.ctx)
    expect(text.lines).toEqual(['prompt$ ls\nfile.txt'])

    const json = testCliContext(client, { json: true })
    await commands.snapshot!({ positionals: [shell.id], flags: {} }, json.ctx)
    expect(JSON.parse(json.lines[0]!)).toEqual(snapshot)
  })

  test('prints the host screen rows when the serialized snapshot reprints a character or moves the cursor', async () => {
    const screen = new Screen({ cols: 5, rows: 3 })
    screen.write('abcdeFGHIJ')
    await screen.settled()
    const wrapped = screen.snapshot()
    const rows = screen.lines().map((row) => row.text.trimEnd())
    screen.dispose()
    expect(wrapped.ansi).toContain('\x1b[2;5H\x1b[0mJ')
    h.pty.setSnapshotResult({ ...wrapped, cwd: '/tmp/w', title: 't', shellState: 'ready', offset: 10 })
    h.pty.setReadResult({ lines: ['abcde', 'FGHIJ'], cols: 5, rows: 3, alt: false })
    expect(rows).toEqual(['abcde', 'FGHIJ', ''])

    const text = testCliContext(client)
    await commands.snapshot!({ positionals: [shell.id], flags: {} }, text.ctx)
    expect(text.lines).toEqual(['abcde\nFGHIJ'])
    expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ sessionId: shell.id, lines: 0 })

    const json = testCliContext(client, { json: true })
    const reads = h.pty.requests.filter((r) => r.type === 'read').length
    await commands.snapshot!({ positionals: [shell.id], flags: {} }, json.ctx)
    expect(JSON.parse(json.lines[0]!).ansi).toBe(wrapped.ansi)
    expect(h.pty.requests.filter((r) => r.type === 'read')).toHaveLength(reads)
  })

  test('without a session it is a usage error', async () => {
    expect(await failure(commands.snapshot!({ positionals: [], flags: {} }, testCliContext(client).ctx))).toMatchObject({
      message: 'no session id; pass <sessionId> or set QUIRKY_SESSION_ID',
      kind: 'usage'
    })
  })
})

describe('term history', () => {
  test('prints rows oldest first and passes the paging flags', async () => {
    h.pty.setHistoryResult({ lines: ['h-1', 'h-2'], cursor: 'c1' })
    const { ctx, lines } = testCliContext(client)
    await commands.history!({ positionals: [shell.id], flags: { lines: 2, before: 'c0', ansi: true } }, ctx)
    expect(lines).toEqual(['h-1\nh-2'])
    expect(h.pty.requests.filter((r) => r.type === 'history').at(-1)).toMatchObject({
      sessionId: shell.id,
      lines: 2,
      before: 'c0',
      format: 'ansi'
    })
  })

  test('--json prints the page with its cursor', async () => {
    h.pty.setHistoryResult({ lines: ['h-1'], cursor: null })
    const { ctx, lines } = testCliContext(client, { json: true })
    await commands.history!({ positionals: [shell.id], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!)).toEqual({ lines: ['h-1'], cursor: null })
    expect((h.pty.requests.filter((r) => r.type === 'history').at(-1) as { format?: string }).format).toBeUndefined()
  })

  test('rejects a page size below 1', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(commands.history!({ positionals: [shell.id], flags: { lines: 0 } }, ctx))).message).toBe('--lines must be at least 1')
  })
})

describe('term sessions, kill, kill-all and restart-host', () => {
  const confirmed = (options: Parameters<typeof testCliContext>[1] = {}) => {
    const made = testCliContext(client, options)
    // the real CLI link adds yes under --yes
    made.ctx.call = (method, params = {}) => client.callAny(method, { ...params, yes: true })
    return made
  }

  test('sessions prints a table of running sessions', async () => {
    const { ctx, lines } = testCliContext(client)
    await commands.sessions!({ positionals: [], flags: {} }, ctx)
    const rows = lines[0]!.split('\n')
    expect(rows[0]!.split(/\s+/)).toEqual(['ID', 'STATE', 'SHELL', 'PID', 'WORKSPACE'])
    expect(rows[1]!.split(/\s+/)).toEqual([shell.id, 'running', 'unsupported', expect.stringMatching(/^\d+$/), 'fake/alpha'])
  })

  test('kill prints the session it killed', async () => {
    const { ctx, lines } = confirmed()
    await commands.kill!({ positionals: [shell.id], flags: {} }, ctx)
    expect(lines).toEqual([`killed ${shell.id}`])
    expect(h.pty.requests.filter((r) => r.type === 'kill').at(-1)).toMatchObject({ sessionId: shell.id, reason: 'killed' })
  })

  test('kill needs a session', async () => {
    expect(await failure(commands.kill!({ positionals: [], flags: {} }, testCliContext(client).ctx))).toMatchObject({
      message: 'missing <session>',
      kind: 'usage'
    })
  })

  test('kill-all prints the count', async () => {
    h.pty.exit(shell.id, 0)
    const { ctx, lines } = confirmed()
    await commands['kill-all']!({ positionals: [], flags: {} }, ctx)
    expect(lines).toEqual(['killed 0 sessions'])
  })

  test('restart-host prints the new pid', async () => {
    const { ctx, lines } = confirmed()
    const done = commands['restart-host']!({ positionals: [], flags: {} }, ctx)
    await waitFor(() => h.pty.requests.some((r) => r.type === 'shutdown'))
    h.pty.dropConnections()
    await done
    expect(lines).toEqual([expect.stringMatching(/^terminal host restarted \(pid \d+\)$/)])
  })
})

describe('through the real CLI', () => {
  test('quirky terminal history prints the next cursor on stderr', async () => {
    h.pty.setHistoryResult({ lines: ['h-1', 'h-2'], cursor: 'c9' })
    const result = await runCli(['terminal', 'history', shell.id, '--lines', '2', '--ansi'], { home: h.home })
    expect(result.stdout).toBe('h-1\nh-2\n')
    expect(result.stderr).toBe('next: c9\n')
    expect(h.pty.requests.filter((r) => r.type === 'history').at(-1)).toMatchObject({ lines: 2, format: 'ansi' })
  })

  test('SC-23 and SC-24: kill and kill-all take --yes', async () => {
    const killed = await runCli(['terminal', 'kill', shell.id, '--yes'], { home: h.home })
    expect(killed.stdout).toBe(`killed ${shell.id}\n`)
    h.pty.exit(shell.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    const all = await runCli(['terminal', 'kill-all', '--yes', '--json'], { home: h.home })
    expect(JSON.parse(all.stdout)).toEqual({ killedCount: 0, remainingCount: 0, killedSessionIds: [] })
  })

  test('without --yes and without quirky.ask, kill says to pass --yes', async () => {
    const result = await runCli(['terminal', 'kill', shell.id], { home: h.home })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('pass --yes')
    expect(h.pty.requests.some((r) => r.type === 'kill')).toBe(false)
  })

  test('SC-40: sessions and snapshot reach the daemon by their group words', async () => {
    const sessions = await runCli(['term', 'sessions'], { home: h.home })
    expect(sessions.stdout).toContain(shell.id)
    h.pty.setReadResult({ lines: ['hello from the screen'], cols: 80, rows: 24, alt: false })
    const snapshot = await runCli(['terminal', 'snapshot', shell.id], { home: h.home })
    expect(snapshot.stdout).toBe('hello from the screen\n')
  })

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
