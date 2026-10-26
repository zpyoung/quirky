import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeDaemon, runCli, spawnCli, type FakeDaemonOptions } from './fixtures/fake-daemon'

let daemon: FakeDaemon

function start(options?: FakeDaemonOptions): FakeDaemon {
  daemon = new FakeDaemon(options).start()
  return daemon
}

beforeEach(() => start())
afterEach(() => daemon.stop())

const run = (args: string[], extra: { cwd?: string; env?: Record<string, string> } = {}) =>
  runCli(args, { home: daemon.home, ...extra })

describe('status', () => {
  test('prints key: value lines', async () => {
    const result = await run(['status'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('daemon: 0.0.0-fake')
    expect(result.stdout).toContain(`home: ${daemon.home}`)
    expect(result.stdout).toContain('pty host: alive (pid 4242)')
  })

  test('--json prints one JSON document, before or after the command', async () => {
    for (const args of [['--json', 'status'], ['status', '--json']]) {
      const result = await run(args)
      expect(result.code).toBe(0)
      const body = JSON.parse(result.stdout)
      expect(body.daemonVersion).toBe('0.0.0-fake')
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
    }
  })
})

describe('repos and worktrees', () => {
  test('repo add resolves the path against the cwd', async () => {
    const result = await run(['repo', 'add', 'some/dir'], { cwd: daemon.home })
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('repo.add')).toEqual([{ path: join(daemon.home, 'some/dir') }])
  })

  test('repo list renders a table and --json an array', async () => {
    const repo = daemon.addRepo('alpha')
    const table = await run(['repo', 'list'])
    expect(table.stdout).toContain('ID')
    expect(table.stdout).toContain(repo.id)
    expect(table.stdout).toContain(repo.path)
    const json = JSON.parse((await run(['repo', 'list', '--json'])).stdout)
    expect(json).toEqual([repo])
  })

  test('repo rm surfaces daemon errors as exit 1 on stderr', async () => {
    const result = await run(['repo', 'rm', 'nope'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('quirky: repo not found: nope\n')
    expect(result.stdout).toBe('')
  })

  test('wt list filters by repo', async () => {
    const repo = daemon.addRepo('alpha')
    daemon.addWorktree(repo, 'feat')
    const result = await run(['wt', 'list', '--repo', repo.id])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('feat')
    expect(daemon.methodCalls('worktree.list')).toEqual([{ repoId: repo.id }])
  })

  test('wt create passes the base ref', async () => {
    const repo = daemon.addRepo('alpha')
    const result = await run(['wt', 'create', repo.id, 'topic', '--base', 'main'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('worktree.create')).toEqual([{ repoId: repo.id, name: 'topic', baseRef: 'main' }])
  })

  test('wt rm passes force', async () => {
    const result = await run(['wt', 'rm', 'wt_x', '--force'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('worktree.remove')).toEqual([{ worktreeId: 'wt_x', force: true }])
  })
})

describe('sessions', () => {
  test('session new defaults the worktree from the cwd', async () => {
    const repo = daemon.addRepo('alpha')
    daemon.addWorktree(repo, 'other')
    const target = daemon.addWorktree(repo, 'feat')
    const nested = join(target.path, 'src')
    await Bun.$`mkdir -p ${nested}`
    const result = await run(['session', 'new', '--agent', 'claude', '--prompt', 'hi'], { cwd: nested })
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('session.create')).toEqual([{ worktreeId: target.id, agent: 'claude', prompt: 'hi' }])
  })

  test('the longest containing worktree wins', async () => {
    const repo = daemon.addRepo('alpha')
    const outer = daemon.addWorktree(repo, 'outer')
    const inner = daemon.addWorktree(repo, 'inner', join(outer.path, 'nested'))
    const result = await run(['session', 'new', '--agent', 'shell'], { cwd: inner.path })
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('session.create')[0].worktreeId).toBe(inner.id)
  })

  test('QUIRKY_WORKTREE_ID beats the cwd and --worktree beats both', async () => {
    const env = { QUIRKY_WORKTREE_ID: 'wt_env' }
    await run(['session', 'new', '--agent', 'shell'], { env })
    await run(['session', 'new', '--agent', 'shell', '--worktree', 'wt_flag'], { env })
    expect(daemon.methodCalls('session.create').map((call) => call.worktreeId)).toEqual(['wt_env', 'wt_flag'])
    expect(daemon.methodCalls('worktree.list')).toEqual([])
  })

  test('a cwd outside every worktree is a usage error', async () => {
    const result = await run(['session', 'new', '--agent', 'shell'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/quirky: .*worktree/)
  })

  test('--background uses createStructured and needs a prompt', async () => {
    const env = { QUIRKY_WORKTREE_ID: 'wt_env' }
    const missing = await run(['session', 'new', '--agent', 'claude', '--background'], { env })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('--prompt')
    const ok = await run(['session', 'new', '--agent', 'claude', '--background', '--prompt', 'go'], { env })
    expect(ok.code).toBe(0)
    expect(daemon.methodCalls('session.createStructured')).toEqual([
      { worktreeId: 'wt_env', agent: 'claude', prompt: 'go' }
    ])
    expect(daemon.methodCalls('session.create')).toEqual([])
  })

  test('session list and close', async () => {
    await run(['session', 'new', '--agent', 'shell'], { env: { QUIRKY_WORKTREE_ID: 'wt_a' } })
    const listed = await run(['session', 'list', '--worktree', 'wt_a'])
    expect(listed.stdout).toContain('sess_1')
    expect(listed.stdout).toContain('shell')
    const closed = await run(['session', 'close', 'sess_1'])
    expect(closed.code).toBe(0)
    expect(daemon.methodCalls('session.close')).toEqual([{ sessionId: 'sess_1' }])
  })
})

describe('terminals', () => {
  test('term read defaults to QUIRKY_SESSION_ID and prints lines', async () => {
    const result = await run(['term', 'read', '--lines', '10'], { env: { QUIRKY_SESSION_ID: 'sess_9' } })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('first line\nsecond line\n')
    expect(daemon.methodCalls('terminal.read')).toEqual([{ sessionId: 'sess_9', lines: 10 }])
  })

  test('term read without any session id is a usage error', async () => {
    const result = await run(['term', 'read'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('QUIRKY_SESSION_ID')
  })

  test('term send passes text and --enter', async () => {
    const result = await run(['term', 'send', 'sess_1', 'ls -la', '--enter'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('terminal.send')).toEqual([{ sessionId: 'sess_1', text: 'ls -la', enter: true }])
  })
})

describe('ask', () => {
  const spec = JSON.stringify({ questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] })

  test('prints the registered line immediately, then the answered envelope', async () => {
    daemon.stop()
    start({ answerAfterMs: 1200 })
    const proc = spawnCli(['ask', '--spec', spec], {
      home: daemon.home,
      env: { QUIRKY_SESSION_ID: 'sess_7', QUIRKY_WORKTREE_ID: 'wt_7' }
    })
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const startedAt = Date.now()
    while (!seen.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    const firstLineAt = Date.now() - startedAt
    expect(JSON.parse(seen.split('\n')[0])).toEqual({ status: 'registered', askId: 'ask_1' })
    expect(firstLineAt).toBeLessThan(1000)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    expect(await proc.exited).toBe(0)
    const lines = seen.trim().split('\n')
    expect(lines).toHaveLength(2)
    const envelope = JSON.parse(lines[1])
    expect(envelope.status).toBe('answered')
    expect(envelope.askId).toBe('ask_1')
    expect(envelope.answers.go).toEqual({ value: 'yes', source: 'input' })
    expect(daemon.methodCalls('ask.create')[0].sessionId).toBe('sess_7')
    expect(daemon.methodCalls('ask.create')[0].worktreeId).toBe('wt_7')
    expect(daemon.methodCalls('ask.wait')[0].timeoutMs).toBe(60000)
  })

  test('--spec @file is read relative to the cwd', async () => {
    writeFileSync(join(daemon.home, 'spec.json'), spec)
    const result = await run(['ask', '--spec', '@spec.json'], { cwd: daemon.home })
    expect(result.code).toBe(0)
    expect(result.stdout.trim().split('\n')).toHaveLength(2)
  })

  test('--timeout-ms cancels the ask, prints it as timed_out and exits 0', async () => {
    daemon.stop()
    start({ answerAfterMs: null })
    const result = await run(['ask', '--spec', spec, '--timeout-ms', '400'])
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(JSON.parse(lines[0]).status).toBe('registered')
    expect(JSON.parse(lines[1])).toEqual({ status: 'timed_out', askId: 'ask_1', answers: {}, skipped: [] })
    expect(daemon.methodCalls('ask.cancel')).toEqual([{ askId: 'ask_1' }])
    expect(daemon.methodCalls('ask.wait')[0].timeoutMs).toBeLessThanOrEqual(400)
  })

  test('an ask that is answered before --timeout-ms is not cancelled', async () => {
    daemon.stop()
    start({ answerAfterMs: 100 })
    const result = await run(['ask', '--spec', spec, '--timeout-ms', '5000'])
    expect(JSON.parse(result.stdout.trim().split('\n')[1]).status).toBe('answered')
    expect(daemon.methodCalls('ask.cancel')).toEqual([])
  })

  test('--timeout-ms still prints timed_out when the cancel call fails', async () => {
    daemon.stop()
    start({ answerAfterMs: null, failCancel: true })
    const result = await run(['ask', '--spec', spec, '--timeout-ms', '200'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n')[1]).status).toBe('timed_out')
  })

  test('ask wait --id resumes an abandoned ask and ask cancel --id prints the envelope', async () => {
    daemon.stop()
    start({ answerAfterMs: null })
    const first = spawnCli(['ask', '--spec', spec], { home: daemon.home })
    const reader = first.stdout.getReader()
    const { value } = await reader.read()
    const askId = JSON.parse(new TextDecoder().decode(value).split('\n')[0]).askId
    first.kill()
    await first.exited
    const resumed = await run(['ask', 'wait', '--id', askId, '--timeout-ms', '100'])
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout).status).toBe('timed_out')
    expect(daemon.methodCalls('ask.cancel')).toEqual([{ askId }])
    const cancelled = await run(['ask', 'cancel', '--id', askId])
    expect(cancelled.code).toBe(0)
    expect(JSON.parse(cancelled.stdout)).toEqual({ status: 'declined', askId, answers: {}, skipped: [] })
  })

  test('reconnects when the connection drops mid-wait', async () => {
    daemon.stop()
    start({ answerAfterMs: 200, dropFirstWait: true })
    const result = await run(['ask', '--spec', spec])
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(JSON.parse(lines[1]).status).toBe('answered')
    expect(daemon.connections).toBeGreaterThanOrEqual(2)
  })

  test('invalid specs exit 2 naming the field, without contacting the daemon', async () => {
    const bad = JSON.stringify({ questions: [{ id: 'a', type: 'text', question: 'x' }, { id: 'a', type: 'text', question: 'y' }] })
    const result = await run(['ask', '--spec', bad])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('questions[1].id')
    expect(daemon.methodCalls('ask.create')).toEqual([])
  })

  test('ask without --spec is a usage error', async () => {
    const result = await run(['ask'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--spec')
  })
})

describe('usage', () => {
  test('unknown command exits 2', async () => {
    const result = await run(['frobnicate'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command "frobnicate"')
  })

  test('unknown flag and missing argument exit 2', async () => {
    expect((await run(['status', '--bogus'])).code).toBe(2)
    const missing = await run(['repo', 'rm'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('repoId')
  })

  test('a command group without a subcommand exits 2', async () => {
    expect((await run(['repo'])).code).toBe(2)
  })

  test('help, --help and <command> --help exit 0 on stdout', async () => {
    for (const args of [['help'], ['--help'], [], ['ask', '--help'], ['help', 'ask', 'wait'], ['repo', '--help']]) {
      const result = await run(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('usage:')
    }
    expect((await run(['ask', '--help'])).stdout).toContain('--spec')
  })

  test('help never contacts the daemon', async () => {
    await run(['help'])
    expect(daemon.calls).toEqual([])
  })
})

describe('flag parsing', () => {
  test('an unknown flag names the command and the valid flags', async () => {
    const result = await run(['wt', 'list', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('quirky: unknown flag --bogus for wt list\nvalid flags: --repo, --json, --help\n')
    expect(result.stderr).toContain("run 'quirky help' for usage")
    expect(daemon.calls).toEqual([])
  })

  test('a valued flag without a value exits 2 and starts no session', async () => {
    const env = { QUIRKY_WORKTREE_ID: 'w1' }
    const atEnd = await run(['session', 'new', '--agent', 'claude', '--worktree', 'w1', '--prompt'], { env })
    expect(atEnd.code).toBe(2)
    expect(atEnd.stderr).toContain('--prompt requires a value')
    const dashed = await run(['session', 'new', '--agent', 'claude', '--worktree', 'w1', '--prompt', '--json'], { env })
    expect(dashed.code).toBe(2)
    expect(dashed.stderr).toContain('--prompt requires a value; write --prompt=<value> for a value starting with --')
    expect(daemon.methodCalls('session.create')).toEqual([])
    expect(daemon.methodCalls('session.createStructured')).toEqual([])
  })

  test('a value starting with -- is passed with =', async () => {
    const result = await run(['session', 'new', '--agent', 'claude', '--worktree', 'w1', '--prompt=--x'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('session.create')).toEqual([{ worktreeId: 'w1', agent: 'claude', prompt: '--x' }])
  })

  test('a missing required flag is reported by name before any call', async () => {
    const result = await run(['ask', 'wait'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing required flag --id')
    expect(daemon.calls).toEqual([])
  })
})
