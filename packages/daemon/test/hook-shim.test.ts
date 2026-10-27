import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { QUIRKY_HOOK_SCRIPT } from '../src/launch'
import { makeTempHome } from './helpers'

type Captured = { path: string; search: string; headers: Headers; body: string }

let root: string
let home: string
let scriptPath: string
let stub: ReturnType<typeof Bun.serve>
let hits: Captured[]
const children: { kill(): void }[] = []

beforeEach(() => {
  root = makeTempHome('qd-hook-')
  home = join(root, 'q')
  mkdirSync(join(home, 'bin'), { recursive: true })
  scriptPath = join(home, 'bin', 'quirky-hook')
  writeFileSync(scriptPath, QUIRKY_HOOK_SCRIPT, { mode: 0o755 })
  hits = []
  stub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      hits.push({
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        body: await req.text()
      })
      return new Response('{}')
    }
  })
})
afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await stub.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const hookUrl = (port: number) => `http://127.0.0.1:${port}/hook`

/** A port nothing listens on: bind one, then release it. */
async function closedPort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  await probe.stop(true)
  return port
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    QUIRKY_HOME: home,
    QUIRKY_SESSION_ID: 's1',
    QUIRKY_HOOK_URL: hookUrl(stub.port as number),
    QUIRKY_HOOK_TOKEN: 'tok',
    ...extra
  }
}

type RunOptions = {
  args?: string[]
  env?: Record<string, string>
  stdin?: string
  /** names to drop from the environment */
  unset?: string[]
}

async function run(source: string, options: RunOptions = {}) {
  const env = baseEnv(options.env)
  for (const name of options.unset ?? []) delete env[name]
  const started = Date.now()
  const proc = Bun.spawn(['/bin/sh', scriptPath, source, ...(options.args ?? [])], {
    env,
    stdin: new Blob([options.stdin ?? '']),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  const code = await proc.exited
  return { code, stdout, stderr, ms: Date.now() - started }
}

const PAYLOAD = '{"hook_event_name":"Stop","session_id":"p1"}'

describe('answers (SC-30)', () => {
  test('claude PermissionRequest prints {}', async () => {
    const r = await run('claude', {
      env: { QUIRKY_HOOK_EVENT: 'PermissionRequest' },
      stdin: '{"hook_event_name":"PermissionRequest"}'
    })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
    expect(r.stderr).toBe('')
  })

  test.each([
    'claude',
    'openclaude',
    'qoder',
    'qoder-cn',
    'qwen-code',
    'codebuddy',
    'droid',
    'devin',
    'muse',
    'zcode',
    'kimi',
    'command-code'
  ])('%s prints {}', async (source) => {
    const r = await run(source, { stdin: PAYLOAD })
    expect(r.stdout.trim()).toBe('{}')
  })

  test('cursor answers by event', async () => {
    const answer = async (event: string) =>
      (await run('cursor', { env: { QUIRKY_HOOK_EVENT: event }, stdin: '{}' })).stdout.trim()
    expect(await answer('preToolUse')).toBe('{"permission":"allow"}')
    expect(await answer('beforeShellExecution')).toBe('{"permission":"allow"}')
    expect(await answer('beforeMCPExecution')).toBe('{"permission":"allow"}')
    expect(await answer('beforeSubmitPrompt')).toBe('{"continue":true}')
    expect(await answer('stop')).toBe('{}')
  })

  test('antigravity answers by event', async () => {
    const answer = async (event: string) =>
      (await run('antigravity', { env: { QUIRKY_HOOK_EVENT: event }, stdin: '{"a":1}' })).stdout.trim()
    expect(await answer('PreToolUse')).toBe('{"decision":"ask"}')
    expect(await answer('Stop')).toBe('{"decision":""}')
    expect(await answer('SessionStart')).toBe('{}')
  })

  test('other agents print nothing', async () => {
    for (const source of ['codex', 'gemini', 'grok', 'copilot']) {
      const r = await run(source, { stdin: PAYLOAD, args: source === 'codex' ? [PAYLOAD] : [] })
      expect(r.stdout).toBe('')
    }
  })
})

describe('staying quiet', () => {
  test('no session id: answers, posts nothing', async () => {
    const r = await run('claude', { unset: ['QUIRKY_SESSION_ID'], stdin: PAYLOAD })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
    expect(hits).toHaveLength(0)
  })

  test('empty session id posts nothing', async () => {
    const r = await run('claude', { env: { QUIRKY_SESSION_ID: '' }, stdin: PAYLOAD })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(0)
  })

  test('CLAUDE_JOB_DIR set posts nothing', async () => {
    const r = await run('claude', { env: { CLAUDE_JOB_DIR: '/tmp/job' }, stdin: PAYLOAD })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
    expect(hits).toHaveLength(0)
    expect(existsSync(join(home, 'hook-spool'))).toBe(false)
  })

  test('empty payload posts nothing', async () => {
    const r = await run('claude', { stdin: '' })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(0)
  })

  test('antigravity with CLAUDE_JOB_DIR returns at once while stdin stays open', async () => {
    const proc = Bun.spawn(['/bin/sh', scriptPath, 'antigravity'], {
      env: baseEnv({ CLAUDE_JOB_DIR: '/x', QUIRKY_HOOK_EVENT: 'Stop' }),
      stdin: 'pipe',
      stdout: 'pipe'
    })
    children.push(proc)
    const code = await Promise.race([proc.exited, Bun.sleep(2000).then(() => 'timeout' as const)])
    expect(code).toBe(0)
  })
})

describe('posting', () => {
  test('stdin payload posts to /hook/<source> with session and token', async () => {
    const r = await run('claude', { stdin: PAYLOAD })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(1)
    const hit = hits[0]
    expect(hit.path).toBe('/hook/claude')
    expect(hit.search).toBe('?session=s1')
    expect(hit.headers.get('x-quirky-hook-token')).toBe('tok')
    expect(hit.headers.get('content-type')).toBe('application/json')
    expect(hit.body).toBe(PAYLOAD)
  })

  test('codex posts its last argument', async () => {
    const payload = '{"type":"agent-turn-complete","thread-id":"t1"}'
    const r = await run('codex', { args: ['notify', payload], stdin: 'ignored' })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe('/hook/codex')
    expect(hits[0].body).toBe(payload)
  })

  test('adds pid, urlencoded pstart and event; omits empty params', async () => {
    const pid = String(process.pid)
    const lstart = Bun.spawnSync(['/bin/ps', '-p', pid, '-o', 'lstart='], {
      env: { TZ: 'UTC0', LC_ALL: 'C' }
    })
      .stdout.toString()
      .trim()
    expect(lstart).not.toBe('')
    await run('cursor', {
      env: { QUIRKY_HOOK_AGENT_PID: pid, QUIRKY_HOOK_EVENT: 'stop' },
      stdin: '{"a":1}'
    })
    expect(hits).toHaveLength(1)
    const params = new URLSearchParams(hits[0].search)
    expect(params.get('session')).toBe('s1')
    expect(params.get('pid')).toBe(pid)
    expect(params.get('pstart')).toBe(lstart)
    expect(hits[0].search).not.toContain(' ')
    expect(params.get('event')).toBe('stop')

    hits.length = 0
    await run('claude', { stdin: PAYLOAD })
    expect([...new URLSearchParams(hits[0].search).keys()]).toEqual(['session'])
  })

  test('a non-numeric pid is dropped', async () => {
    await run('claude', { env: { QUIRKY_HOOK_AGENT_PID: '12;rm' }, stdin: PAYLOAD })
    expect([...new URLSearchParams(hits[0].search).keys()]).toEqual(['session'])
  })

  test('a pid with no process posts pid without pstart', async () => {
    await run('claude', { env: { QUIRKY_HOOK_AGENT_PID: '2147483' }, stdin: PAYLOAD })
    const params = new URLSearchParams(hits[0].search)
    expect(params.get('pid')).toBe('2147483')
    expect(params.has('pstart')).toBe(false)
  })

  test('runtime.json port wins over QUIRKY_HOOK_URL', async () => {
    const dead = await closedPort()
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ port: stub.port }))
    const r = await run('claude', {
      env: { QUIRKY_HOOK_URL: hookUrl(dead) },
      stdin: PAYLOAD
    })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe('/hook/claude')
    expect(existsSync(join(home, 'hook-spool'))).toBe(false)
  })

  test('falls back to QUIRKY_HOOK_URL without runtime.json', async () => {
    await run('claude', { stdin: PAYLOAD })
    expect(hits).toHaveLength(1)
  })
})

describe('daemon down', () => {
  async function down(): Promise<Record<string, string>> {
    return { QUIRKY_HOOK_URL: hookUrl(await closedPort()) }
  }
  const spoolFile = () => join(home, 'hook-spool', 's1.jsonl')

  test('closed port exits 0 within 2 seconds (SC-30 f)', async () => {
    const r = await run('claude', { env: await down(), stdin: PAYLOAD })
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(2000)
    expect(r.stderr).toBe('')
  })

  test('spools one line with base64 fields and 0700/0600 permissions', async () => {
    const pid = String(process.pid)
    const payload = '{"hook_event_name":"Stop","text":"héllo\\nworld"}\n'
    await run('claude', {
      env: { ...(await down()), QUIRKY_HOOK_AGENT_PID: pid, QUIRKY_HOOK_EVENT: 'Stop' },
      stdin: payload
    })
    const lines = readFileSync(spoolFile(), 'utf8').split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines).toHaveLength(2)
    const [source, spoolPid, pstart, event, body] = lines[0].split(' ')
    expect(source).toBe('claude')
    expect(spoolPid).toBe(pid)
    expect(Buffer.from(pstart, 'base64').toString()).toMatch(/\d{4}$/)
    expect(event).toBe('Stop')
    expect(Buffer.from(body, 'base64').toString()).toBe(payload.replace(/\n+$/, ''))
    expect(statSync(join(home, 'hook-spool')).mode & 0o777).toBe(0o700)
    expect(statSync(spoolFile()).mode & 0o777).toBe(0o600)
  })

  test('empty fields are written as -', async () => {
    await run('claude', { env: await down(), stdin: PAYLOAD })
    const [source, pid, pstart, event, body] = readFileSync(spoolFile(), 'utf8').trim().split(' ')
    expect([source, pid, pstart, event]).toEqual(['claude', '-', '-', '-'])
    expect(Buffer.from(body, 'base64').toString()).toBe(PAYLOAD)
  })

  test('appends successive hooks', async () => {
    const env = await down()
    await run('claude', { env, stdin: PAYLOAD })
    await run('codex', { env, args: [PAYLOAD] })
    const lines = readFileSync(spoolFile(), 'utf8').trim().split('\n')
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['claude', 'codex'])
  })

  test('PreToolUse then Stop: only Stop is spooled (SC-18)', async () => {
    const env = await down()
    const pre = (await run('claude', {
      env,
      stdin: '{"hook_event_name": "PreToolUse", "tool_name":"Bash"}'
    })).code
    const stop = (await run('claude', { env, stdin: PAYLOAD })).code
    expect([pre, stop]).toEqual([0, 0])
    const lines = readFileSync(spoolFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(Buffer.from(lines[0].split(' ')[4], 'base64').toString()).toBe(PAYLOAD)
  })

  test.each([
    '{"hookEventName":"PostToolUse","x":1}',
    '{"hook_event_name" :\n "PostToolUseFailure"}'
  ])('tool event payload is not spooled: %s', async (payload) => {
    await run('claude', { env: await down(), stdin: payload })
    expect(existsSync(spoolFile())).toBe(false)
  })

  test('a tool event named only by QUIRKY_HOOK_EVENT is not spooled', async () => {
    await run('antigravity', {
      env: { ...(await down()), QUIRKY_HOOK_EVENT: 'PreToolUse' },
      stdin: '{"tool":"x"}'
    })
    expect(existsSync(spoolFile())).toBe(false)
  })

  test('a spool file over 5242880 bytes takes no more lines', async () => {
    mkdirSync(join(home, 'hook-spool'), { recursive: true })
    writeFileSync(spoolFile(), Buffer.alloc(5242881, 0x61))
    await run('claude', { env: await down(), stdin: PAYLOAD })
    expect(statSync(spoolFile()).size).toBe(5242881)
  })

  test('a spool file at the cap still takes a line', async () => {
    mkdirSync(join(home, 'hook-spool'), { recursive: true })
    writeFileSync(spoolFile(), Buffer.alloc(5242880, 0x61))
    await run('claude', { env: await down(), stdin: PAYLOAD })
    expect(statSync(spoolFile()).size).toBeGreaterThan(5242880)
  })

  test('a successful post spools nothing', async () => {
    await run('claude', { stdin: PAYLOAD })
    expect(existsSync(join(home, 'hook-spool'))).toBe(false)
  })

  test('a session id with a slash is never used as a path', async () => {
    await run('claude', {
      env: { ...(await down()), QUIRKY_SESSION_ID: '../evil' },
      stdin: PAYLOAD
    })
    expect(existsSync(join(home, 'evil.jsonl'))).toBe(false)
    expect(existsSync(join(root, 'evil.jsonl'))).toBe(false)
  })
})

describe('agents that keep stdin open', () => {
  test.each(['grok', 'antigravity'])('%s posts within 2 s of the JSON', async (source) => {
    const payload = '{"hook_event_name":"SessionStart","text":"héllo"}'
    const proc = Bun.spawn(['/bin/sh', scriptPath, source], {
      env: baseEnv({ QUIRKY_HOOK_EVENT: 'SessionStart' }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    children.push(proc)
    const wrote = Date.now()
    proc.stdin.write(payload)
    await proc.stdin.flush()
    const code = await Promise.race([proc.exited, Bun.sleep(2000).then(() => 'timeout' as const)])
    expect(code).toBe(0)
    expect(Date.now() - wrote).toBeLessThan(2000)
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe(`/hook/${source}`)
    expect(hits[0].body).toBe(payload)
  })

  test('trailing bytes after the first JSON value are not posted', async () => {
    const proc = Bun.spawn(['/bin/sh', scriptPath, 'grok'], {
      env: baseEnv(),
      stdin: 'pipe',
      stdout: 'pipe'
    })
    children.push(proc)
    proc.stdin.write('  {"a":1}\n')
    await proc.stdin.flush()
    await Promise.race([proc.exited, Bun.sleep(2000)])
    expect(hits[0]?.body).toBe('{"a":1}')
  })
})
