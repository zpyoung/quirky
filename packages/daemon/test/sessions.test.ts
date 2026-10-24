import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, RpcError, type QuirkyClient, type QuirkyEvent, type Worktree } from '@quirky/protocol'
import { buildArgv, shellQuote } from '../src/launch'
import { notificationScript } from '../src/notify'
import { startHarness, waitFor, type Harness, waitForAsync } from './helpers'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let worktree: Worktree

beforeEach(async () => {
  h = await startHarness()
  h.git.addRepo('/fake/alpha')
  ;({ client, events } = await h.connectWithEvents('cli'))
  const repo = await client.call('repo.add', { path: '/fake/alpha' })
  ;[worktree] = await client.call('worktree.list', { repoId: repo.id })
})
afterEach(() => h.cleanup())

function created(sessionId: string) {
  const request = h.pty.requests.find((r) => r.type === 'create' && r.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request
}

describe('launch commands', () => {
  test('shellQuote handles quotes and spaces', () => {
    expect(shellQuote("it's a $test")).toBe(`'it'\\''s a $test'`)
  })

  test('notification script escapes quotes', () => {
    expect(notificationScript('a "b"', 'c\\d')).toBe(
      'display notification "c\\\\d" with title "a \\"b\\""'
    )
  })

  test('each agent gets its documented argv', () => {
    const base = { home: '/h', shell: '/bin/zsh' }
    expect(buildArgv({ ...base, agent: 'shell' })).toEqual(['/bin/zsh', '-l'])
    expect(buildArgv({ ...base, agent: 'claude' })).toEqual([
      '/bin/zsh',
      '-l',
      '-c',
      `exec claude --settings '/h/hooks/claude-settings.json'`
    ])
    expect(buildArgv({ ...base, agent: 'claude', prompt: "fix it's bug" })[3]).toBe(
      `exec claude --settings '/h/hooks/claude-settings.json' 'fix it'\\''s bug'`
    )
    expect(buildArgv({ ...base, agent: 'codex', prompt: 'hi' })[3]).toBe(
      `exec codex -c 'notify=["/h/bin/quirky-hook","codex"]' 'hi'`
    )
    expect(buildArgv({ ...base, agent: 'opencode', prompt: 'hi' })[3]).toBe(`exec opencode --prompt 'hi'`)
    expect(buildArgv({ ...base, agent: 'opencode' })[3]).toBe('exec opencode')
    expect(buildArgv({ ...base, agent: 'gemini', prompt: 'hi' })[3]).toBe(`exec gemini --prompt-interactive 'hi'`)
    expect(buildArgv({ ...base, agent: 'gemini', prompt: '   ' })[3]).toBe('exec gemini')
  })
})

describe('session.create', () => {
  test('starts a shell with the documented env and emits session.changed', async () => {
    const session = await client.call('session.create', {
      worktreeId: worktree.id,
      agent: 'shell',
      cols: 100,
      rows: 30
    })
    expect(session).toMatchObject({
      kind: 'terminal',
      agent: 'shell',
      title: 'Shell',
      status: 'running',
      worktreeId: worktree.id,
      cwd: '/fake/alpha',
      exitCode: null
    })
    expect(session.id).toMatch(/^s_[0-9a-f]+$/)

    const request = created(session.id)
    expect(request).toMatchObject({ cwd: '/fake/alpha', argv: ['/bin/zsh', '-l'], cols: 100, rows: 30 })
    expect(request.env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      QUIRKY_HOME: h.home,
      QUIRKY_SESSION_ID: session.id,
      QUIRKY_WORKTREE_ID: worktree.id,
      QUIRKY_HOOK_URL: `http://127.0.0.1:${h.runtime.port}/hook`,
      QUIRKY_HOOK_TOKEN: h.runtime.hookToken
    })
    expect(request.env.PATH.startsWith(`${h.home}/bin:`)).toBe(true)
    await waitFor(() => events.find((e) => e.type === 'session.changed' && e.session.id === session.id))
    expect(await client.call('session.list', { worktreeId: worktree.id })).toHaveLength(1)
  })

  test('claude, codex, opencode and gemini run under the login shell with their prompt', async () => {
    const claude = await client.call('session.create', {
      worktreeId: worktree.id,
      agent: 'claude',
      prompt: 'do the thing'
    })
    expect(claude.title).toBe('Claude')
    expect(created(claude.id).argv).toEqual([
      '/bin/zsh',
      '-l',
      '-c',
      `exec claude --settings '${h.home}/hooks/claude-settings.json' 'do the thing'`
    ])
    const codex = await client.call('session.create', { worktreeId: worktree.id, agent: 'codex' })
    expect(created(codex.id).argv[3]).toBe(`exec codex -c 'notify=["${h.home}/bin/quirky-hook","codex"]'`)
    const gemini = await client.call('session.create', {
      worktreeId: worktree.id,
      agent: 'gemini',
      prompt: 'x'
    })
    expect(created(gemini.id).argv[3]).toBe(`exec gemini --prompt-interactive 'x'`)
  })

  test('writes the Claude settings file and executable shims', async () => {
    await client.call('session.create', { worktreeId: worktree.id, agent: 'claude' })
    const settings = JSON.parse(readFileSync(join(h.home, 'hooks', 'claude-settings.json'), 'utf8'))
    const hookCommand = `'${h.home}/bin/quirky-hook' claude`
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']) {
      expect(settings.hooks[event][0].hooks[0]).toEqual({ type: 'command', command: hookCommand })
    }
    for (const name of ['quirky-hook', 'quirky']) {
      expect(statSync(join(h.home, 'bin', name)).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(h.home, 'bin', 'quirky'), 'utf8')).toBe(
      `#!/bin/sh\nexec "${process.execPath}" "/opt/quirky/cli/main.ts" "$@"\n`
    )
    const hook = readFileSync(join(h.home, 'bin', 'quirky-hook'), 'utf8')
    expect(hook.startsWith('#!/bin/sh\n')).toBe(true)
    expect(hook).toContain('x-quirky-hook-token')
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true)
  })

  test('the quirky-hook shim posts to the daemon', async () => {
    await client.call('session.create', { worktreeId: worktree.id, agent: 'claude' })
    const session = (await client.call('session.list', {}))[0]
    const env = {
      PATH: process.env.PATH ?? '',
      QUIRKY_HOOK_URL: `http://127.0.0.1:${h.runtime.port}/hook`,
      QUIRKY_HOOK_TOKEN: h.runtime.hookToken,
      QUIRKY_SESSION_ID: session.id
    }
    const run = Bun.spawn([join(h.home, 'bin', 'quirky-hook'), 'claude'], {
      env,
      stdin: new Blob([JSON.stringify({ hook_event_name: 'UserPromptSubmit' })]),
      stdout: 'ignore',
      stderr: 'ignore'
    })
    expect(await run.exited).toBe(0)
    await waitForAsync(async () => events.find((e) => e.type === 'session.changed' && e.session.status === 'working'))

    const codex = Bun.spawn([join(h.home, 'bin', 'quirky-hook'), 'codex', '{"type":"agent-turn-complete"}'], {
      env,
      stdout: 'ignore',
      stderr: 'ignore'
    })
    expect(await codex.exited).toBe(0)
    await waitFor(() => events.find((e) => e.type === 'session.changed' && e.session.status === 'done'))

    const unreachable = Bun.spawn([join(h.home, 'bin', 'quirky-hook'), 'claude'], {
      env: { ...env, QUIRKY_HOOK_URL: 'http://127.0.0.1:1/hook' },
      stdin: new Blob(['{}']),
      stdout: 'ignore',
      stderr: 'ignore'
    })
    expect(await unreachable.exited).toBe(0)
  })

  test('rejects unknown worktrees, agents and failed starts', async () => {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise
        return null
      } catch (error) {
        return (error as RpcError).code
      }
    }
    expect(await code(client.call('session.create', { worktreeId: 'wt_nope', agent: 'shell' }))).toBe(
      RpcErrorCode.NotFound
    )
    expect(await code((client as any).call('session.create', { worktreeId: worktree.id, agent: 'vim' }))).toBe(
      RpcErrorCode.InvalidParams
    )
  })

  test('close forgets the session and emits session.removed', async () => {
    const session = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    await client.call('session.close', { sessionId: session.id })
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
    expect(await client.call('session.list', {})).toEqual([])
    await waitFor(() => events.find((e) => e.type === 'session.removed' && e.sessionId === session.id))
  })

  test('pty exit marks the session exited with its code', async () => {
    const session = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
    h.pty.exit(session.id, 3)
    const event = await waitFor(() =>
      events.find((e) => e.type === 'session.changed' && e.session.status === 'exited')
    )
    expect(event).toMatchObject({ session: { id: session.id, exitCode: 3 } })
    expect((await client.call('session.list', {}))[0]).toMatchObject({ status: 'exited', exitCode: 3 })
  })
})
