import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { QUIRKY_GATE_SCRIPT } from '../src/launch'
import { makeTempHome } from './helpers'

type Captured = { path: string; search: string; headers: Headers; body: string }

const UNAVAILABLE = "Quirky's avatar gate is unavailable; try again shortly.\n"
const PAYLOAD = '{"hook_event_name":"PreToolUse","tool_name":"Bash"}'

let root: string
let home: string
let scriptPath: string
let stub: ReturnType<typeof Bun.serve>
let hits: Captured[]
let scope: ProcessScope
let reply: () => Response

beforeEach(() => {
  root = makeTempHome('qd-gate-')
  home = join(root, 'q')
  scope = createProcessScope(home)
  mkdirSync(join(home, 'bin'), { recursive: true })
  scriptPath = join(home, 'bin', 'quirky-gate')
  writeFileSync(scriptPath, QUIRKY_GATE_SCRIPT, { mode: 0o755 })
  hits = []
  reply = () => Response.json({ decision: 'allow', reason: 'ok', encoded: '{}' })
  stub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      hits.push({ path: url.pathname, search: url.search, headers: req.headers, body: await req.text() })
      return reply()
    }
  })
})

afterEach(async () => {
  await stub.stop(true)
  await scope.cleanup()
  rmSync(root, { recursive: true, force: true })
})

function mark(sessionId: string): void {
  const dir = join(home, 'plugin-data', 'quirky.avatar', 'supervised')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, sessionId), '')
}

async function closedPort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  await probe.stop(true)
  return port
}

async function run(options: { args?: string[]; env?: Record<string, string>; unset?: string[]; stdin?: string } = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    QUIRKY_HOME: home,
    QUIRKY_SESSION_ID: 's1',
    QUIRKY_HOOK_URL: `http://127.0.0.1:${stub.port}/hook`,
    QUIRKY_HOOK_TOKEN: 'tok',
    ...options.env
  }
  for (const name of options.unset ?? []) delete env[name]
  const proc = scope.spawn(['/bin/sh', scriptPath, ...(options.args ?? ['claude'])], {
    env,
    stdin: new Blob([options.stdin ?? PAYLOAD]),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

describe('unsupervised sessions', () => {
  test('without a session id prints {} and never calls the daemon', async () => {
    mark('s1')
    const r = await run({ unset: ['QUIRKY_SESSION_ID'] })
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    expect(hits).toEqual([])
  })

  test('without a marker file prints {} and never calls the daemon', async () => {
    const r = await run()
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    expect(hits).toEqual([])
  })

  test('a marker for another session does not supervise this one', async () => {
    mark('s2')
    const r = await run()
    expect(r.stdout).toBe('{}\n')
    expect(hits).toEqual([])
  })
})

describe('supervised sessions', () => {
  test('posts the payload and prints the encoded decision verbatim', async () => {
    mark('s1')
    const encoded = '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"a \\"b\\" \\\\ c\\nd é"}}'
    reply = () => Response.json({ decision: 'allow', reason: 'fine', encoded })
    const r = await run({ env: { QUIRKY_HOOK_EVENT: 'PreToolUse' } })
    expect(r).toEqual({ code: 0, stdout: encoded, stderr: '' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe('/gate/claude')
    expect(hits[0]!.headers.get('x-quirky-hook-token')).toBe('tok')
    expect(hits[0]!.body).toBe(PAYLOAD)
    const query = new URLSearchParams(hits[0]!.search)
    expect(query.get('session')).toBe('s1')
    expect(query.get('event')).toBe('PreToolUse')
    expect(query.get('deadline')).toBe('30000')
  })

  test('takes the event name from the payload when the environment has none', async () => {
    mark('s1')
    await run()
    expect(new URLSearchParams(hits[0]!.search).get('event')).toBe('PreToolUse')
  })

  test('takes the deadline from the second argument', async () => {
    mark('s1')
    await run({ args: ['codex', '25000'] })
    expect(hits[0]!.path).toBe('/gate/codex')
    expect(new URLSearchParams(hits[0]!.search).get('deadline')).toBe('25000')
  })

  test('finds the daemon through runtime.json before the environment URL', async () => {
    mark('s1')
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: 1, port: stub.port }))
    const r = await run({ env: { QUIRKY_HOOK_URL: `http://127.0.0.1:${await closedPort()}/hook` } })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(1)
  })

  test('propagates exitCode and keeps the order of fields irrelevant', async () => {
    mark('s1')
    reply = () => Response.json({ exitCode: 2, encoded: '{"decision":"block"}', reason: 'no', decision: 'deny' })
    const r = await run()
    expect(r).toEqual({ code: 2, stdout: '{"decision":"block"}', stderr: '' })
  })

  test('keeps a trailing newline in the encoded text', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'allow', reason: '', encoded: '{}\n' })
    expect((await run()).stdout).toBe('{}\n')
  })
})

describe('failure', () => {
  test('daemon down: exits 2 with the retry message on stderr', async () => {
    mark('s1')
    const r = await run({ env: { QUIRKY_HOOK_URL: `http://127.0.0.1:${await closedPort()}/hook` } })
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('no daemon address at all: exits 2', async () => {
    mark('s1')
    const r = await run({ unset: ['QUIRKY_HOOK_URL'] })
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test.each([400, 401, 500])('HTTP %i: exits 2', async (status) => {
    mark('s1')
    reply = () => Response.json({ decision: 'allow', reason: '', encoded: '{}' }, { status })
    const r = await run()
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('a null encoded answer exits 2', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'unavailable', reason: 'none', encoded: null })
    const r = await run()
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('a body that is not a decision exits 2', async () => {
    mark('s1')
    reply = () => new Response('<html>nope</html>')
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })
})

test('the script is a plain POSIX shell file and does not touch the reporting hook shim', () => {
  expect(QUIRKY_GATE_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true)
  expect(statSync(scriptPath).mode & 0o111).not.toBe(0)
})
