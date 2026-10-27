import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ampPluginSource } from '../src/install/sources/amp.ts'
import { hermesInitSource } from '../src/install/sources/hermes.ts'
import { openCodePluginSource, type OpenCodeFamilyAgent } from '../src/install/sources/opencode.ts'
import { piExtensionSource, type PiAgentKind } from '../src/install/sources/pi.ts'
import { normalizeAmp } from '../src/normalize/amp.ts'
import { normalizeHermes } from '../src/normalize/hermes.ts'
import { normalizeMimoCode, normalizeOpencode, normalizeOpencode2 } from '../src/normalize/opencode.ts'
import { normalizeOmp, normalizePi, normalizePrimeAgent } from '../src/normalize/pi.ts'
import type { Normalizer } from '../src/types.ts'

type Hit = { path: string; session: string | null; token: string | null; body: Record<string, any> }

const SESSION = 'sess-1'
const TOKEN = 'tok-123'
const hits: Hit[] = []
let server: ReturnType<typeof Bun.serve>
let work: string
let loads = 0
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['QUIRKY_SESSION_ID', 'QUIRKY_HOME', 'QUIRKY_HOOK_TOKEN', 'QUIRKY_HOOK_URL', 'QUIRKY_OPENCODE_AGENT', 'QUIRKY_PI_STATUS_OWNER', 'QUIRKY_PRIME_STATUS_OWNER', 'PRIME_AGENT_INTERNAL_DAEMON_WORKER', '_']

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      hits.push({
        path: url.pathname,
        session: url.searchParams.get('session'),
        token: request.headers.get('x-quirky-hook-token'),
        body: (await request.json()) as Record<string, any>
      })
      return new Response('{}')
    }
  })
  work = mkdtempSync(join(tmpdir(), 'quirky-plugin-sources-'))
  writeFileSync(join(work, 'runtime.json'), JSON.stringify({ port: server.port }))
})

afterAll(() => {
  server.stop(true)
  rmSync(work, { recursive: true, force: true })
})

beforeEach(() => {
  hits.length = 0
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.QUIRKY_SESSION_ID = SESSION
  process.env.QUIRKY_HOME = work
  process.env.QUIRKY_HOOK_TOKEN = TOKEN
  delete process.env.QUIRKY_HOOK_URL
  delete process.env.QUIRKY_OPENCODE_AGENT
  delete process.env.QUIRKY_PI_STATUS_OWNER
  delete process.env.QUIRKY_PRIME_STATUS_OWNER
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

async function waitForHits(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && hits.length < count; attempt++) await Bun.sleep(10)
  expect(hits.length).toBeGreaterThanOrEqual(count)
}

async function settle(): Promise<void> {
  await Bun.sleep(150)
}

async function load(name: string, source: string): Promise<any> {
  // a fresh directory per load: Bun's resolver caches directory listings, so a file added later is not found
  const dir = join(work, `load-${loads++}`)
  mkdirSync(dir)
  const path = join(dir, name)
  writeFileSync(path, source)
  return import(path)
}

function states(normalizer: Normalizer): (string | null)[] {
  const cache = new Map<string, unknown>()
  return hits.map((hit) => normalizer(hit.body, String(hit.body.hook_event_name), cache)?.state ?? null)
}

describe('Amp plugin', () => {
  function stand(): { amp: { on: (name: string, fn: (event: any) => any) => void }; fire: (name: string, event: any) => any } {
    const handlers = new Map<string, (event: any) => any>()
    return { amp: { on: (name, fn) => void handlers.set(name, fn) }, fire: (name, event) => handlers.get(name)?.(event) }
  }
  const thread = { id: 'T-1' }

  test('posts agent.start and agent.end to the hook endpoint and the row reads working then done', async () => {
    const module = await load('amp.ts', ampPluginSource())
    const host = stand()
    module.default(host.amp)
    host.fire('session.start', { thread })
    host.fire('agent.start', { thread, id: 'a1', message: 'fix the bug' })
    expect(host.fire('tool.call', { thread, toolUseID: 'u1', tool: 'Bash', input: { cmd: 'ls' } })).toEqual({ action: 'allow' })
    host.fire('agent.end', { thread, id: 'a1', message: 'done', status: 'done' })
    await waitForHits(4)
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['session.start', 'agent.start', 'tool.call', 'agent.end'])
    expect(hits[1]).toMatchObject({ path: '/hook/amp', session: SESSION, token: TOKEN, body: { threadId: 'T-1', message: 'fix the bug' } })
    expect(states(normalizeAmp)).toEqual([null, 'working', 'working', 'done'])
  })

  test('posts nothing outside a Quirky session', async () => {
    delete process.env.QUIRKY_SESSION_ID
    const module = await load('amp.ts', ampPluginSource())
    const host = stand()
    module.default(host.amp)
    host.fire('agent.start', { thread, id: 'a1', message: 'hi' })
    host.fire('agent.end', { thread, id: 'a1', status: 'done' })
    await settle()
    expect(hits).toEqual([])
  })

  test('survives an event without a thread and a dead endpoint', async () => {
    const module = await load('amp.ts', ampPluginSource())
    const host = stand()
    module.default(host.amp)
    expect(() => host.fire('agent.start', {})).not.toThrow()
    expect(host.fire('tool.call', {})).toEqual({ action: 'allow' })
    process.env.QUIRKY_HOME = join(work, 'missing')
    process.env.QUIRKY_HOOK_URL = 'http://127.0.0.1:9/hook'
    host.fire('agent.start', { thread, id: 'a2', message: 'hi' })
    await settle()
    expect(hits).toEqual([])
  })

  test('falls back to QUIRKY_HOOK_URL when runtime.json has no port', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'quirky-plugin-empty-'))
    try {
      process.env.QUIRKY_HOME = empty
      process.env.QUIRKY_HOOK_URL = `http://127.0.0.1:${server.port}/hook/`
      const module = await load('amp.ts', ampPluginSource())
      const host = stand()
      module.default(host.amp)
      host.fire('agent.start', { thread, id: 'a1', message: 'hi' })
      await waitForHits(1)
      expect(hits[0]!.path).toBe('/hook/amp')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('OpenCode-family plugin', () => {
  const normalizers: Record<OpenCodeFamilyAgent, Normalizer> = {
    opencode: normalizeOpencode,
    opencode2: normalizeOpencode2,
    'mimo-code': normalizeMimoCode
  }

  for (const agent of ['opencode', 'opencode2', 'mimo-code'] as OpenCodeFamilyAgent[]) {
    test(`${agent}: busy then idle posts and the row reads working then done`, async () => {
      process.env.QUIRKY_OPENCODE_AGENT = agent
      const module = await load(`${agent}.js`, openCodePluginSource(agent))
      const hooks = await module.default({})
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } })
      await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError' } } } })
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } } })
      const names = agent === 'mimo-code' ? ['SessionBusy', 'SessionIdle'] : ['SessionStart', 'SessionBusy', 'SessionIdle']
      await waitForHits(names.length)
      await settle()
      expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(names)
      expect(hits[0]).toMatchObject({ path: `/hook/${agent}`, session: SESSION, token: TOKEN })
      expect(hits.at(-1)!.body).toMatchObject({ sessionID: 'ses_1', root_state: 'done', root_turn_error_name: 'MessageAbortedError' })
      expect(states(normalizers[agent]).slice(-2)).toEqual(['working', 'done'])
    })
  }

  test('a duplicate idle is posted once', async () => {
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const hooks = await module.default({})
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } } })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } })
    await settle()
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['SessionBusy', 'SessionIdle'])
  })

  test('permission and question prompts post as waiting and a reply resumes work', async () => {
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const hooks = await module.default({})
    await hooks.event({
      event: { type: 'permission.asked', properties: { sessionID: 's', id: 'p1', permission: 'bash', patterns: ['rm *'], metadata: { command: 'rm -rf x' } } }
    })
    await hooks.event({ event: { type: 'permission.replied', properties: { sessionID: 's' } } })
    await hooks.event({ event: { type: 'question.asked', properties: { sessionID: 's', id: 'q1', questions: [{ question: 'Which?' }] } } })
    await settle()
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['PermissionRequest', 'SessionBusy', 'AskUserQuestion'])
    expect(states(normalizeOpencode)).toEqual(['waiting', 'working', 'waiting'])
    expect(hits[0]!.body).toMatchObject({ permission: 'bash', metadata: { command: 'rm -rf x' } })
  })

  test('child sessions do not move the root and their prompts are attributed to it', async () => {
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const lookups = new Map<string, any>([
      ['root', { id: 'root' }],
      ['kid', { id: 'kid', parentID: 'root' }]
    ])
    const client = { session: { get: async ({ path }: any) => ({ data: lookups.get(path.id) }) } }
    const hooks = await module.default({ client })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'busy' } } } })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'kid', status: { type: 'idle' } } } })
    await hooks.event({ event: { type: 'permission.asked', properties: { sessionID: 'kid', id: 'p', permission: 'edit' } } })
    await settle()
    expect(hits.map((hit) => [hit.body.hook_event_name, hit.body.sessionID])).toEqual([
      ['SessionBusy', 'root'],
      ['PermissionRequest', 'root']
    ])
  })

  test('user and assistant text parts post as MessagePart with the role', async () => {
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const hooks = await module.default({})
    await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'm1', role: 'user' } } } })
    await hooks.event({ event: { type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'do it', messageID: 'm1' } } } })
    await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'm2', role: 'assistant' } } } })
    await hooks.event({ event: { type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'done it', messageID: 'm2' } } } })
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } } })
    await settle()
    expect(hits.map((hit) => [hit.body.hook_event_name, hit.body.role, hit.body.text])).toEqual([
      ['MessagePart', 'user', 'do it'],
      ['MessagePart', 'assistant', 'done it'],
      ['SessionIdle', undefined, undefined]
    ])
  })

  test('opencode and opencode2 share a config dir, so a file stays quiet in the other binary', async () => {
    process.env.QUIRKY_OPENCODE_AGENT = 'opencode2'
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const hooks = await module.default({})
    expect(hooks).toEqual({})
  })

  test('the OpenCode 2 setup hook reports the execution lifecycle', async () => {
    process.env.QUIRKY_OPENCODE_AGENT = 'opencode2'
    const module = await load('opencode2.js', openCodePluginSource('opencode2'))
    const stream = (async function* () {
      yield { type: 'session.created', data: { sessionID: 'n1' } }
      yield { type: 'session.execution.started', data: { sessionID: 'n1' } }
      yield { type: 'session.execution.succeeded', data: { sessionID: 'n1' } }
    })()
    const dispose = await module.default.setup({
      session: { hook: async () => ({ dispose: async () => {} }), get: async () => ({ id: 'n1' }) },
      event: { subscribe: () => stream }
    })
    await waitForHits(3)
    await dispose()
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['SessionStart', 'SessionBusy', 'SessionIdle'])
  })

  test('posts nothing outside a Quirky session', async () => {
    delete process.env.QUIRKY_SESSION_ID
    const module = await load('opencode.js', openCodePluginSource('opencode'))
    const hooks = await module.default({})
    await hooks.event?.({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } } })
    await hooks.event?.({ event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } } })
    await settle()
    expect(hits).toEqual([])
  })
})

describe('Pi-family extension', () => {
  const normalizers: Record<PiAgentKind, Normalizer> = { pi: normalizePi, omp: normalizeOmp, 'prime-agent': normalizePrimeAgent }

  function stand(): { pi: { on: (name: string, fn: (event: any, ctx?: any) => void) => void }; fire: (name: string, event?: any, ctx?: any) => void } {
    const handlers = new Map<string, (event: any, ctx?: any) => void>()
    return { pi: { on: (name, fn) => void handlers.set(name, fn) }, fire: (name, event, ctx) => handlers.get(name)?.(event, ctx) }
  }
  const ctx = { sessionManager: { getSessionId: () => 'pi-sess', getSessionFile: () => '/tmp/pi-sess.jsonl' }, model: { provider: 'anthropic', id: 'sonnet' } }

  for (const kind of ['pi', 'omp', 'prime-agent'] as PiAgentKind[]) {
    test(`${kind}: start and end events post and the row reads working then done`, async () => {
      if (kind === 'prime-agent') process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER = '1'
      process.env._ = kind === 'omp' ? '/usr/local/bin/omp' : '/usr/local/bin/pi'
      const module = await load(`${kind}.ts`, piExtensionSource(kind === 'omp' ? 'omp' : kind))
      const host = stand()
      module.default(host.pi)
      host.fire('before_agent_start', { prompt: 'fix it' }, ctx)
      host.fire('agent_start', {}, ctx)
      host.fire('tool_call', { toolName: 'bash', input: { command: 'ls' } }, ctx)
      host.fire('agent_end', {}, ctx)
      await waitForHits(4)
      expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['before_agent_start', 'agent_start', 'tool_call', 'agent_end'])
      expect(hits[0]).toMatchObject({
        path: `/hook/${kind}`,
        session: SESSION,
        token: TOKEN,
        body: { prompt: 'fix it', session_id: 'pi-sess', session_file: '/tmp/pi-sess.jsonl', model: 'anthropic/sonnet' }
      })
      expect(hits[2]!.body).toMatchObject({ tool_name: 'bash', tool_input: { command: 'ls' } })
      expect(states(normalizers[kind])).toEqual(['working', 'working', 'working', 'done'])
    })
  }

  test('a Pi file running inside Oh My Pi reports as omp and forwards its approvals', async () => {
    process.env._ = '/usr/local/bin/omp'
    const module = await load('pi.ts', piExtensionSource('pi'))
    const host = stand()
    module.default(host.pi)
    host.fire('tool_approval_requested', { toolName: 'bash', reason: 'needs approval' }, ctx)
    host.fire('tool_approval_resolved', { toolName: 'bash', approved: true }, ctx)
    await waitForHits(2)
    expect(hits.map((hit) => [hit.path, hit.body.hook_event_name])).toEqual([
      ['/hook/omp', 'tool_approval_requested'],
      ['/hook/omp', 'tool_approval_resolved']
    ])
    expect(states(normalizeOmp)).toEqual(['blocked', 'working'])
  })

  test('a Pi dialog posts ui_prompt events while a turn runs', async () => {
    process.env._ = '/usr/local/bin/pi'
    const module = await load('pi.ts', piExtensionSource('pi'))
    const host = stand()
    module.default(host.pi)
    host.fire('agent_start', {}, ctx)
    host.fire('ui_prompt_start', {})
    host.fire('ui_prompt_end', {}, { isIdle: () => false })
    await waitForHits(3)
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['agent_start', 'ui_prompt_start', 'ui_prompt_end'])
    expect(hits[2]!.body.is_idle).toBe(false)
    expect(states(normalizePi)).toEqual(['working', 'waiting', 'working'])
  })

  test('credential paths in tool input are redacted', async () => {
    const module = await load('pi.ts', piExtensionSource('pi'))
    const host = stand()
    module.default(host.pi)
    host.fire('tool_call', { toolName: 'bash', input: { command: 'cat ~/.ssh/id_rsa' } }, ctx)
    await waitForHits(1)
    expect(hits[0]!.body.tool_input).toEqual({ redacted: true })
  })

  test('posts nothing outside a Quirky session', async () => {
    delete process.env.QUIRKY_SESSION_ID
    const module = await load('pi.ts', piExtensionSource('pi'))
    const host = stand()
    module.default(host.pi)
    host.fire('agent_start', {}, ctx)
    host.fire('agent_end', {}, ctx)
    await settle()
    expect(hits).toEqual([])
  })

  test('a handler that throws does not reach the host', async () => {
    const module = await load('pi.ts', piExtensionSource('pi'))
    const host = stand()
    module.default(host.pi)
    expect(() => host.fire('tool_call', null, { sessionManager: { getSessionId: () => { throw new Error('boom') } } })).not.toThrow()
  })
})

describe('Hermes plugin', () => {
  const driver = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("quirky_status", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
hooks = {}
class Ctx:
    def register_hook(self, name, fn):
        hooks[name] = fn
module.register(Ctx())
hooks["pre_llm_call"](session_id="h1", user_message="fix it", model="m")
hooks["pre_tool_call"](session_id="h1", tool_name="terminal", args={"command": "ls"})
hooks["pre_approval_request"](command="rm x", description="remove")
hooks["post_llm_call"](session_id="h1", assistant_response="all done")
`

  async function run(env: Record<string, string | undefined>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'quirky-hermes-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '__init__.py'), hermesInitSource())
      writeFileSync(join(dir, 'driver.py'), driver)
      const clean: Record<string, string> = {}
      for (const [key, value] of Object.entries({ PATH: process.env.PATH, ...env })) if (value !== undefined) clean[key] = value
      const child = Bun.spawn(['python3', '-I', join(dir, 'driver.py'), join(dir, '__init__.py')], { env: clean, stdout: 'pipe', stderr: 'pipe' })
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ code, err }).toEqual({ code: 0, err: '' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('posts its hooks inside a session and the row reads working, waiting then done', async () => {
    await run({ QUIRKY_SESSION_ID: SESSION, QUIRKY_HOME: work, QUIRKY_HOOK_TOKEN: TOKEN })
    expect(hits.map((hit) => hit.body.hook_event_name)).toEqual(['pre_llm_call', 'pre_tool_call', 'pre_approval_request', 'post_llm_call'])
    expect(hits[0]).toMatchObject({ path: '/hook/hermes', session: SESSION, token: TOKEN, body: { prompt: 'fix it', session_id: 'h1' } })
    expect(hits[1]!.body).toMatchObject({ tool_name: 'terminal', tool_input: { command: 'ls' } })
    expect(states(normalizeHermes)).toEqual(['working', 'working', 'waiting', 'done'])
  })

  test('uses QUIRKY_HOOK_URL when there is no runtime.json', async () => {
    await run({ QUIRKY_SESSION_ID: SESSION, QUIRKY_HOOK_URL: `http://127.0.0.1:${server.port}/hook` })
    expect(hits).toHaveLength(4)
    expect(hits[0]!.path).toBe('/hook/hermes')
  })

  test('posts nothing outside a session, and a dead endpoint is not an error', async () => {
    await run({ QUIRKY_HOME: work })
    expect(hits).toEqual([])
    await run({ QUIRKY_SESSION_ID: SESSION, QUIRKY_HOOK_URL: 'http://127.0.0.1:9/hook' })
    expect(hits).toEqual([])
  })
})
