import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, type ApiDescription, type CliContext, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { commands } from '../cli'
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

describe('the CLI catalog', () => {
  test('SC-17: lists the session group, its commands and its methods under quirky.session/', async () => {
    const api = (await call<ApiDescription>(client, 'api.describe')) as ApiDescription
    expect(api.cli.groups.find((g) => g.plugin === 'quirky.session')).toEqual({ plugin: 'quirky.session', words: 'session', aliases: [] })
    const own = api.cli.commands.filter((c) => c.plugin === 'quirky.session')
    expect(own.map((c) => c.words).sort()).toEqual([
      'session close',
      'session list',
      'session new',
      'session resume',
      'session set-provider-session'
    ])
    expect(own.every((c) => c.module?.endsWith('/quirky.session/cli.ts'))).toBe(true)
    expect(own.find((c) => c.words === 'session new')!.methods).toEqual(['quirky.session/create', 'quirky.structured/create'])
    const names = api.methods.map((m) => m.name)
    for (const name of ['list', 'get', 'create', 'resume', 'setProviderSession', 'register', 'close', 'setStatus']) expect(names).toContain(`quirky.session/${name}`)
    expect(own.find((c) => c.words === 'session resume')!.methods).toEqual(['quirky.session/resume'])
    expect(own.find((c) => c.words === 'session set-provider-session')!.methods).toEqual(['quirky.session/setProviderSession'])
    expect(own.find((c) => c.words === 'session new')!.flags.map((f) => f.name).sort()).toEqual([
      'agent',
      'background',
      'draft',
      'prompt',
      'wait',
      'worktree'
    ])
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
    const result = await runCli(['session', 'get', '--session', session.id, '--json'], { home: h.home })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(session)
  })
})
