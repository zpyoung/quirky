import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, type ApiDescription, type CliContext, type LaunchSettings, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { commands } from '../cli'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import { call, createSession, SESSION_PLUGINS, startPluginHarness, testCliContext } from './support'

let h: Harness
let client: QuirkyClient

beforeEach(async () => {
  resetFakeAgents()
  h = await startPluginHarness(SESSION_PLUGINS)
  client = await h.connect('cli')
})
afterEach(async () => {
  fakeAgents().gate = null
  delete process.env.QUIRKY_TEST_REAL_WORKTREE
  await h.cleanup()
  removeTempDirs()
})

const run = async (name: keyof typeof commands, ctx: CliContext, positionals: string[] = [], flags: Record<string, unknown> = {}) =>
  commands[name]!({ positionals, flags }, ctx)

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { kind?: string }
  }
  throw new Error('expected a failure')
}

describe('session list', () => {
  test('prints v1 table and filters by worktree', async () => {
    const { ctx, lines } = testCliContext(client)
    await run('list', ctx)
    expect(lines).toEqual(['no sessions'])

    const main = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const other = await createSession(client, { worktree: 'id:wt_other', agent: 'claude' })
    lines.length = 0
    await run('list', ctx)
    expect(lines[0]).toBe(
      [
        'ID              AGENT   KIND      STATUS   WORKTREE  TITLE',
        `${main.id}  shell   terminal  running  wt_main   Shell`,
        `${other.id}  claude  terminal  running  wt_other  Claude`
      ].join('\n')
    )

    lines.length = 0
    await run('list', ctx, [], { worktree: 'name:other' })
    expect(lines[0]!.split('\n')).toHaveLength(2)
    expect(lines[0]).toContain(other.id)
  })

  test('--json prints the sessions', async () => {
    const created = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const { ctx, lines } = testCliContext(client, { json: true })
    await run('list', ctx)
    expect(JSON.parse(lines[0]!)).toEqual([created])
  })
})

describe('session new', () => {
  test('starts a session in the worktree given and prints the v1 record', async () => {
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { agent: 'shell', worktree: 'branch:other' })
    const [session] = await call<Session[]>(client, 'quirky.session/list')
    expect(session).toMatchObject({ worktreeId: 'wt_other', agent: 'shell' })
    expect(lines[0]).toBe(`id: ${session!.id}\nagent: shell\nkind: terminal\nstatus: running\nworktree: wt_other\nprompt: none`)
  })

  test('without --agent it starts what quirky.agents picks', async () => {
    fakeAgents().pick = 'codex'
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { worktree: 'id:wt_main' })
    expect(lines[0]).toContain('agent: codex')
    expect((await call<Session[]>(client, 'quirky.session/list'))[0]).toMatchObject({ agent: 'codex' })
  })

  test('SC-38: a new claude session gets the agent-status hook argument before the prompt', async () => {
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { agent: 'claude', prompt: 'hi', worktree: 'id:wt_main' })
    expect(lines[0]).toEndWith('prompt: command-line')
    const request = h.pty.requests.find((r) => r.type === 'create')
    expect(request?.type === 'create' && request.argv[3]).toContain(`exec claude '--settings' '${h.home}/hooks/claude-settings.json' 'hi'`)
  })

  test('SC-18: the prompt row shows how the prompt was delivered', async () => {
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { agent: 'codex', prompt: 'p', worktree: 'id:wt_main' })
    await run('new', ctx, [], { agent: 'codex', worktree: 'id:wt_main' })
    expect(lines.map((l) => l.split('\n').at(-1))).toEqual(['prompt: command-line', 'prompt: none'])
  })

  test('SC-28: --wait blocks until a pasted prompt settles and prints the outcome', async () => {
    let release!: () => void
    fakeAgents().gate = new Promise<void>((resolve) => (release = resolve))
    const { ctx, lines } = testCliContext(client)
    let finished = false
    const running = run('new', ctx, [], { agent: 'goose', prompt: 'p', wait: true, worktree: 'id:wt_main' }).then(() => (finished = true))
    await Bun.sleep(50)
    expect(finished).toBe(false)
    release()
    await running
    expect(lines[0]!.split('\n').at(-1)).toBe('prompt: pasted')
  })

  test('SC-23: --wait prints not-delivered when the prompt did not arrive', async () => {
    fakeAgents().outcome = 'not-delivered'
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { agent: 'goose', prompt: 'review', draft: true, wait: true, worktree: 'id:wt_main' })
    expect(lines[0]!.split('\n').at(-1)).toBe('prompt: not-delivered')
    expect(fakeAgents().calls.find((c) => c.method === 'deliver')!.params).toMatchObject({ text: 'review', submit: false })
    expect((await call<Session[]>(client, 'quirky.session/list'))[0]).toMatchObject({ promptDelivery: 'not-delivered', status: 'running' })
  })

  test('without --wait the command prints the pending delivery', async () => {
    fakeAgents().gate = new Promise<void>(() => {})
    const { ctx, lines } = testCliContext(client)
    await run('new', ctx, [], { agent: 'goose', prompt: 'p', worktree: 'id:wt_main' })
    expect(lines[0]!.split('\n').at(-1)).toBe('prompt: pending')
  })

  test('--draft leaves the prompt unsubmitted', async () => {
    const { ctx } = testCliContext(client)
    await run('new', ctx, [], { agent: 'claude', prompt: 'p', draft: true, wait: true, worktree: 'id:wt_main' })
    expect(fakeAgents().calls.find((c) => c.method === 'prepareLaunch')!.params).toMatchObject({ prompt: 'p', submitPrompt: false })
  })

  test('an unknown agent is the daemon\'s error and a disabled one is refused', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('new', ctx, [], { agent: 'vim', worktree: 'id:wt_main' }))).message).toBe('unknown agent: vim')
    fakeAgents().disabled.add('claude')
    expect((await failure(run('new', ctx, [], { agent: 'claude', worktree: 'id:wt_main' }))).message).toBe('agent claude is disabled')
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('SC-21: without --worktree it starts in the worktree of the calling session', async () => {
    const inside = await QuirkyClient.connect(rpcUrl(h.runtime), {
      role: 'cli',
      cwd: '/fake/other/src',
      sessionId: 's_caller',
      worktreeId: 'wt_main'
    })
    try {
      const { ctx } = testCliContext(inside)
      await run('new', ctx, [], { agent: 'shell' })
      const [session] = await call<Session[]>(client, 'quirky.session/list')
      expect(session).toMatchObject({ worktreeId: 'wt_main', cwd: '/fake/alpha' })
    } finally {
      inside.close()
    }
  })

  test('passes the prompt to the agent', async () => {
    const { ctx } = testCliContext(client)
    await run('new', ctx, [], { agent: 'claude', prompt: 'go', worktree: 'id:wt_main' })
    const request = h.pty.requests.find((r) => r.type === 'create')
    expect(request?.type === 'create' && request.argv[3]).toContain(`'go'`)
  })

  test('--background starts a structured session', async () => {
    const { ctx, lines } = testCliContext(client, { json: true })
    await run('new', ctx, [], { agent: 'claude', prompt: 'go', background: true, worktree: 'id:wt_main' })
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'structured', agent: 'claude', worktreeId: 'wt_main' })
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
  })

  test('usage errors', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('new', ctx, [], { agent: '' }))).message).toBe('--agent must name an agent')
    const background = await failure(run('new', ctx, [], { agent: 'claude', background: true }))
    expect(background).toMatchObject({ message: '--background requires --prompt', kind: 'usage' })
    expect((await failure(run('new', ctx, [], { background: true, prompt: 'p' }))).message).toBe('--background requires --agent')
    expect((await failure(run('new', ctx, [], { agent: 'claude', prompt: 'p', background: true, wait: true }))).message).toBe(
      '--wait and --draft do not apply to --background'
    )
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })
})

describe('session resume', () => {
  test('resumes with the flags mapped to the method and prints the new session', async () => {
    process.env.QUIRKY_TEST_REAL_WORKTREE = makeTempDir('qs-')
    const first = await createSession(client, { worktree: 'id:wt_real', agent: 'codex' })
    const { ctx, lines } = testCliContext(client)
    await run('resume', ctx, [first.id], { 'provider-session': 'thread-1', transcript: '/t.jsonl', fork: true })
    const resume = fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params
    expect(resume).toMatchObject({ agent: 'codex', fork: true, providerSession: { id: 'thread-1', transcriptPath: '/t.jsonl' } })
    const [, resumed] = await call<Session[]>(client, 'quirky.session/list')
    expect(resumed).toMatchObject({ resumedFrom: first.id, agent: 'codex' })
    expect(lines[0]).toBe(
      `id: ${resumed!.id}\nagent: codex\nkind: terminal\nstatus: running\nworktree: wt_real\nresumed-from: ${first.id}`
    )
  })

  test('needs a session, and a refusal is the daemon\'s message', async () => {
    const { ctx } = testCliContext(client)
    expect(await failure(run('resume', ctx))).toMatchObject({ message: 'missing <session>', kind: 'usage' })
    const shell = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect((await failure(run('resume', ctx, [shell.id]))).message).toBe(`session ${shell.id} is a shell, not an agent`)
  })
})

describe('session set-provider-session', () => {
  test('SC-30: stores the ID and transcript and prints a line', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    const { ctx, lines } = testCliContext(client)
    await run('set-provider-session', ctx, [session.id, '0199a-thread'], { transcript: '/t.jsonl' })
    expect(lines).toEqual([`set provider session of ${session.id} to 0199a-thread`])
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({
      providerSession: { id: '0199a-thread', transcriptPath: '/t.jsonl' }
    })
  })

  test('SC-30: an invalid ID is refused with its rule', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    const { ctx } = testCliContext(client)
    expect((await failure(run('set-provider-session', ctx, [session.id, '-x']))).message).toBe("provider session id can't start with '-'")
    expect(await failure(run('set-provider-session', ctx, [session.id]))).toMatchObject({ message: 'missing <id>', kind: 'usage' })
    expect(await failure(run('set-provider-session', ctx))).toMatchObject({ message: 'missing <session>', kind: 'usage' })
  })
})

describe('session close', () => {
  test('closes and prints the v1 line', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const { ctx, lines } = testCliContext(client)
    await run('close', ctx, [session.id])
    expect(lines).toEqual([`closed ${session.id}`])
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('needs a session', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('close', ctx))).message).toBe('missing <session>')
  })
})

describe('session restore', () => {
  test('restores a session lost with the host and prints the line', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitForAsync(async () => (await call<Session>(client, 'quirky.session/get', { session: session.id })).restorable)
    const { ctx, lines } = testCliContext(client)
    await run('restore', ctx, [session.id])
    expect(lines).toEqual([`restored ${session.id}`])
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ status: 'running', restorable: false })

    lines.length = 0
    await run('restore', ctx, [session.id])
    expect(lines).toEqual([`${session.id} is already running`])
    expect(h.pty.requests.filter((r) => r.type === 'create' && r.restore === true)).toHaveLength(1)
  })

  test('--json prints the session', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const { ctx, lines } = testCliContext(client, { json: true })
    await run('restore', ctx, [session.id])
    expect(JSON.parse(lines[0]!)).toEqual(session)
  })

  test('a session that ended normally fails with the conflict', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.exit(session.id, 0)
    await waitForAsync(async () => (await call<Session>(client, 'quirky.session/get', { session: session.id })).status === 'exited')
    const { ctx } = testCliContext(client)
    expect((await failure(run('restore', ctx, [session.id]))).message).toBe(
      `session ${session.id} ended normally and can't be restored`
    )
  })

  test('needs a session', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('restore', ctx))).message).toBe('missing <session>')
  })
})

describe('the CLI catalog', () => {
  test('SC-17: lists the session group, its commands and its methods under quirky.session/', async () => {
    const api = (await call<ApiDescription>(client, 'api.describe')) as ApiDescription
    expect(api.cli.groups.find((g) => g.plugin === 'quirky.session')).toEqual({ plugin: 'quirky.session', words: 'session', aliases: [] })
    const own = api.cli.commands.filter((c) => c.plugin === 'quirky.session')
    expect(own.map((c) => c.words).sort()).toEqual([
      'session close',
      'session get',
      'session list',
      'session new',
      'session restore',
      'session resume',
      'session set-provider-session'
    ])
    expect(own.every((c) => c.module?.endsWith('/quirky.session/cli.ts'))).toBe(true)
    expect(own.find((c) => c.words === 'session new')!.methods).toEqual(['quirky.session/create', 'quirky.structured/create'])
    const names = api.methods.map((m) => m.name)
    for (const name of ['list', 'get', 'create', 'resume', 'setProviderSession', 'register', 'close', 'setStatus', 'restore']) expect(names).toContain(`quirky.session/${name}`)
    expect(own.find((c) => c.words === 'session resume')!.methods).toEqual(['quirky.session/resume'])
    expect(own.find((c) => c.words === 'session set-provider-session')!.methods).toEqual(['quirky.session/setProviderSession'])
    expect(own.find((c) => c.words === 'session new')!.flags.map((f) => f.name).sort()).toEqual([
      'agent',
      'background',
      'draft',
      'effort',
      'extra-args',
      'model',
      'option',
      'prompt',
      'wait',
      'worktree'
    ])
    expect(own.find((c) => c.words === 'session new')!.flags.find((f) => f.name === 'option')).toMatchObject({ type: 'string', repeatable: true })
    expect(own.find((c) => c.words === 'session get')).toMatchObject({ methods: ['quirky.session/get'], positionals: [{ name: 'session', required: true }] })
    expect(own.find((c) => c.words === 'session new')!.flags.find((f) => f.name === 'agent')!.required).toBeFalsy()
    expect(api.methods.find((m) => m.name === 'quirky.session/list')).toMatchObject({ readOnly: true })
    expect(api.methods.find((m) => m.name === 'quirky.session/get')).toMatchObject({ readOnly: true })
  })

  test('the new commands run through the real CLI with their positionals and flags', async () => {
    process.env.QUIRKY_TEST_REAL_WORKTREE = makeTempDir('qs-')
    const first = await createSession(client, { worktree: 'id:wt_real', agent: 'codex' })
    const set = await runCli(['session', 'set-provider-session', first.id, 'thread-1', '--transcript', '/t.jsonl', '--json'], { home: h.home })
    expect(set.code).toBe(0)
    expect(JSON.parse(set.stdout)).toMatchObject({ providerSession: { id: 'thread-1', transcriptPath: '/t.jsonl' } })

    const resumed = await runCli(['session', 'resume', first.id, '--fork', '--json'], { home: h.home })
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ resumedFrom: first.id, providerSession: null })
    expect(fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params).toMatchObject({
      fork: true,
      providerSession: { id: 'thread-1', transcriptPath: '/t.jsonl' }
    })

    const created = await runCli(['session', 'new', '--agent', 'goose', '--worktree', 'id:wt_main', '--prompt', 'p', '--draft', '--wait'], { home: h.home })
    expect(created.code).toBe(0)
    expect(created.stdout).toContain('prompt: pasted')
    expect(fakeAgents().calls.find((c) => c.method === 'deliver')!.params).toMatchObject({ text: 'p', submit: false })
  })

  test('generated commands reach the session methods through the real CLI', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const result = await runCli(['session', 'get', session.id, '--json'], { home: h.home })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(session)
  })

  test('session get shows the unread reason when one is set', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const plain = await runCli(['session', 'get', session.id], { home: h.home })
    expect(plain.stdout).not.toContain('unread')
    await call(client, 'quirky.session/setUnread', { session: session.id, unread: 'bell' })
    const marked = await runCli(['session', 'get', session.id], { home: h.home })
    expect(marked.stdout).toContain('unread: bell')
  })

  test('SC-20: the launch flags run through the real CLI, and a shell with a pick is refused', async () => {
    const refused = await runCli(['session', 'new', '--agent', 'shell', '--worktree', 'id:wt_main', '--model', 'opus', '--option', 'a=b'], {
      home: h.home
    })
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('Agent shell does not support launch-time model selection.')
    expect(await call(client, 'quirky.session/list')).toEqual([])

    const usage = await runCli(['session', 'new', '--agent', 'claude', '--effort', 'low'], { home: h.home })
    expect(usage.code).not.toBe(0)
    expect(usage.stderr).toContain('--effort requires --model')
  })
})

const settings: LaunchSettings = {
  agent: 'claude',
  options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
  args: { value: '--add-dir docs', source: 'explicit' },
  summary: 'Claude · Opus · Effort: high'
}

describe('session get', () => {
  test('prints the record rows, then the launch summary and arguments when the session has launch settings', async () => {
    const registered = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude',
      launchSettings: settings
    })
    const { ctx, lines } = testCliContext(client)
    await run('get', ctx, [registered.id])
    expect(lines[0]).toBe(
      [
        `id: ${registered.id}`,
        'agent: claude',
        'kind: structured',
        'status: starting',
        'worktree: wt_main',
        'launch: Claude · Opus · Effort: high',
        'launch args: --add-dir docs'
      ].join('\n')
    )
  })

  test('SC-22: a session without launch settings prints no launch row', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    const { ctx, lines } = testCliContext(client)
    await run('get', ctx, [session.id])
    expect(lines[0]).not.toContain('launch')
  })

  test('launch args is left out when the snapshot has none', async () => {
    const { args: _args, ...withoutArgs } = settings
    const registered = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude',
      launchSettings: withoutArgs
    })
    const { ctx, lines } = testCliContext(client)
    await run('get', ctx, [registered.id])
    expect(lines[0]!.split('\n').slice(-1)).toEqual(['launch: Claude · Opus · Effort: high'])
  })

  test('a stored launchSettings without a string summary prints the record without a launch row', async () => {
    const { ctx, lines } = stubbed(sessionWith({ agent: 'claude', options: {}, summary: undefined, args: { value: 7 } } as unknown as LaunchSettings))
    await run('get', ctx, ['s_x'])
    expect(lines[0]).toBe(['id: s_x', 'agent: claude', 'kind: terminal', 'status: running', 'worktree: wt_main'].join('\n'))
  })

  test('--json prints the Session with its launchSettings', async () => {
    const registered = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude',
      launchSettings: settings
    })
    const { ctx, lines } = testCliContext(client, { json: true })
    await run('get', ctx, [registered.id])
    expect(JSON.parse(lines[0]!)).toEqual(registered)
    expect(JSON.parse(lines[0]!).launchSettings).toEqual(settings)
  })

  test('needs a session, and an unknown one is the daemon\'s error', async () => {
    const { ctx } = testCliContext(client)
    expect(await failure(run('get', ctx))).toMatchObject({ message: 'missing <session>', kind: 'usage' })
    expect((await failure(run('get', ctx, ['s_nope']))).message).toBe('no such session: s_nope')
  })
})

/** A context whose calls are recorded and answered with `session`, for the CLI's own logic. */
function stubbed(session: Session) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const { ctx, lines } = testCliContext(client)
  return {
    calls,
    lines,
    ctx: {
      ...ctx,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params })
        return session
      }
    } as CliContext
  }
}

const sessionWith = (launchSettings: LaunchSettings | null): Session => ({
  id: 's_x',
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'wt_main',
  cwd: '/work',
  title: 'Claude',
  status: 'running',
  createdAt: 1,
  lastActivityAt: 1,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false,
  promptDelivery: null,
  launchSettings
})

describe('session new launch flags', () => {
  test('SC-18: prints the launch summary and arguments before the prompt row', async () => {
    const { ctx, lines } = stubbed(sessionWith(settings))
    await run('new', ctx, [], { agent: 'claude', model: 'opus', effort: 'high' })
    expect(lines[0]).toBe(
      [
        'id: s_x',
        'agent: claude',
        'kind: terminal',
        'status: running',
        'worktree: wt_main',
        'launch: Claude · Opus · Effort: high',
        'launch args: --add-dir docs',
        'prompt: none'
      ].join('\n')
    )
  })

  test('prints no launch row without launch settings', async () => {
    const { ctx, lines } = stubbed(sessionWith(null))
    await run('new', ctx, [], { agent: 'claude' })
    expect(lines[0]).not.toContain('launch')
  })

  test('maps --model, --effort, --option and --extra-args onto the create params', async () => {
    const { ctx, calls } = stubbed(sessionWith(null))
    await run('new', ctx, [], {
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      option: ['fastMode=true', 'thinking=false', 'speed=a=b', 'tier=fast'],
      'extra-args': '--add-dir docs'
    })
    expect(calls).toEqual([
      {
        method: 'quirky.session/create',
        params: {
          agent: 'claude',
          model: 'opus',
          options: { effort: 'high', fastMode: true, thinking: false, speed: 'a=b', tier: 'fast' },
          extraArgs: '--add-dir docs'
        }
      }
    ])
  })

  test('sends no pick params when no launch flag is given', async () => {
    const { ctx, calls } = stubbed(sessionWith(null))
    await run('new', ctx, [], { agent: 'claude' })
    expect(Object.keys(calls[0]!.params)).toEqual(['agent'])
  })

  test('--background passes the same params to quirky.structured/create', async () => {
    const { ctx, calls } = stubbed(sessionWith(null))
    await run('new', ctx, [], { agent: 'claude', prompt: 'go', background: true, model: 'opus', effort: 'high', 'extra-args': '--x' })
    expect(calls).toEqual([
      {
        method: 'quirky.structured/create',
        params: { agent: 'claude', prompt: 'go', model: 'opus', options: { effort: 'high' }, extraArgs: '--x' }
      }
    ])
  })

  test('an option key that is a prototype name stays an own key', async () => {
    const { ctx, calls } = stubbed(sessionWith(null))
    await run('new', ctx, [], { agent: 'claude', model: 'opus', option: ['__proto__=x'] })
    const options = calls[0]!.params.options as Record<string, unknown>
    expect(Object.keys(options)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(options)).toBeNull()
  })

  test('SC-9: usage errors are raised before any call, naming the problem', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ effort: 'low' }, '--effort requires --model'],
      [{ option: ['fastMode=true'] }, '--option requires --model'],
      [{ model: 'opus', effort: 'low', option: ['effort=high'] }, 'effort is set by both --effort and --option effort=…'],
      [{ model: 'opus', option: ['speed=a', 'speed=b'] }, '--option speed given more than once'],
      [{ model: 'opus', option: ['=fast'] }, '--option needs a key before "=", got "=fast"'],
      [{ model: 'opus', option: ['speed'] }, '--option expects KEY=VALUE, got "speed"']
    ]
    for (const [flags, message] of cases) {
      const { ctx, calls } = stubbed(sessionWith(null))
      expect(await failure(run('new', ctx, [], { agent: 'claude', ...flags }))).toMatchObject({ message, kind: 'usage' })
      expect(calls).toEqual([])
    }
  })

  test('--extra-args alone needs no model, and a model alone sends no options', async () => {
    const { ctx, calls } = stubbed(sessionWith(null))
    await run('new', ctx, [], { agent: 'claude', 'extra-args': '--add-dir docs' })
    await run('new', ctx, [], { agent: 'claude', model: 'opus' })
    expect(calls.map((c) => c.params)).toEqual([
      { agent: 'claude', extraArgs: '--add-dir docs' },
      { agent: 'claude', model: 'opus' }
    ])
  })

  test('SC-20: a shell with a pick is refused by the daemon and no session appears', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('new', ctx, [], { agent: 'shell', model: 'opus', worktree: 'id:wt_main' }))).message).toBe(
      'Agent shell does not support launch-time model selection.'
    )
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })
})
