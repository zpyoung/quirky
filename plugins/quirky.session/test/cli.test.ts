import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, type ApiDescription, type CliContext, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import { call, createSession, SESSION_PLUGINS, startPluginHarness, testCliContext } from './support'

let h: Harness
let client: QuirkyClient

beforeEach(async () => {
  h = await startPluginHarness(SESSION_PLUGINS)
  client = await h.connect('cli')
})
afterEach(() => h.cleanup())

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
    expect(lines[0]).toBe(`id: ${session!.id}\nagent: shell\nkind: terminal\nstatus: running\nworktree: wt_other`)
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

  test('usage errors keep their v1 wording', async () => {
    const { ctx } = testCliContext(client)
    expect((await failure(run('new', ctx, [], {}))).message).toBe('--agent is required')
    expect((await failure(run('new', ctx, [], { agent: 'vim' }))).message).toBe(
      '--agent must be one of shell, claude, codex, opencode, gemini'
    )
    const background = await failure(run('new', ctx, [], { agent: 'claude', background: true }))
    expect(background).toMatchObject({ message: '--background requires --prompt', kind: 'usage' })
    expect(await call(client, 'quirky.session/list')).toEqual([])
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
    expect(own.map((c) => c.words).sort()).toEqual(['session close', 'session list', 'session new'])
    expect(own.every((c) => c.module?.endsWith('/quirky.session/cli.ts'))).toBe(true)
    expect(own.find((c) => c.words === 'session new')!.methods).toEqual(['quirky.session/create', 'quirky.structured/create'])
    const names = api.methods.map((m) => m.name)
    for (const name of ['list', 'get', 'create', 'register', 'close', 'setStatus']) expect(names).toContain(`quirky.session/${name}`)
    expect(api.methods.find((m) => m.name === 'quirky.session/list')).toMatchObject({ readOnly: true })
    expect(api.methods.find((m) => m.name === 'quirky.session/get')).toMatchObject({ readOnly: true })
  })

  test('generated commands reach the session methods through the real CLI', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const result = await runCli(['session', 'get', '--session', session.id, '--json'], { home: h.home })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(session)
  })
})
