import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { QUIRKY_GATE_SCRIPT } from '../src/launch'
import { makeTempHome } from './helpers'

type Captured = { path: string; search: string; headers: Headers; body: string; bodyBytes: Buffer }

const UNAVAILABLE = "Quirky's avatar gate is unavailable; try again shortly.\n"
const PR_DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Quirky\'s avatar gate is unavailable; try again shortly."}}}'
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
      const bodyBytes = Buffer.from(await req.arrayBuffer())
      hits.push({ path: url.pathname, search: url.search, headers: req.headers, body: bodyBytes.toString('utf8'), bodyBytes })
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

type RunOptions = {
  args?: string[]
  env?: Record<string, string>
  unset?: string[]
  stdin?: string
  captureStdoutBytes?: boolean
}

type RunResult = { code: number; stdout: string; stderr: string }

function run(options: RunOptions & { captureStdoutBytes: true }): Promise<RunResult & { stdoutBytes: Buffer }>
function run(options?: RunOptions): Promise<RunResult>
async function run(options: RunOptions = {}) {
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
  const [stdoutBuffer, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text()
  ])
  const stdoutBytes = Buffer.from(stdoutBuffer)
  const result = {
    code: await proc.exited,
    stdout: stdoutBytes.toString('utf8'),
    stderr
  }
  return options.captureStdoutBytes ? { ...result, stdoutBytes } : result
}

async function expectPermissionRequestRefusal(options: Pick<RunOptions, 'env' | 'unset' | 'stdin'> = {}) {
  const result = await run({ ...options, args: ['claude', '30000', 'PermissionRequest'] })
  expect(result).toEqual({ code: 0, stdout: `${PR_DENY}\n`, stderr: UNAVAILABLE })
  const denial = JSON.parse(result.stdout)
  expect(denial.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
  expect(denial.hookSpecificOutput.decision.behavior).toBe('deny')
  expect(denial.hookSpecificOutput.decision.message).toBe(UNAVAILABLE.trimEnd())
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

  test('without a marker and a PermissionRequest event prints {} and never calls the daemon', async () => {
    const r = await run({ args: ['claude', '30000', 'PermissionRequest'] })
    expect(r).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    expect(hits).toEqual([])
  })
})

describe('supervised sessions', () => {
  test('posts the payload and prints the encoded decision verbatim', async () => {
    mark('s1')
    const encoded = '{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"a \\"b\\" \\\\ c\\nd é"}}'
    reply = () => Response.json({ decision: 'allow', reason: 'fine', encoded })
    const r = await run({ args: ['claude', '30000', 'PreToolUse'] })
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

  test('does not infer the event from payload text, even when a nested field names one', async () => {
    mark('s1')
    const stdin = '{"hook_event_name":"PreToolUse","tool_name":"Grep","tool_input":{"filter":{"hook_event_name":"PermissionRequest"}}}'
    const r = await run({ args: ['claude'], stdin })
    expect(r.code).toBe(0)
    expect(hits).toHaveLength(1)
    expect(new URLSearchParams(hits[0]!.search).has('event')).toBe(false)
    expect(Buffer.from(hits[0]!.bodyBytes)).toEqual(Buffer.from(stdin))
  })

  test.each(['PreToolUse', 'PermissionRequest'])('sends a valid event argument: %s', async (event) => {
    mark('s1')
    const r = await run({ args: ['claude', '30000', event] })
    expect(r).toEqual({ code: 0, stdout: '{}', stderr: '' })
    expect(new URLSearchParams(hits[0]!.search).get('event')).toBe(event)
  })

  test.each(['Pre ToolUse', 'a/b', '', 'a'.repeat(65)])('ignores invalid event argument %j and refuses a failed request', async (event) => {
    mark('s1')
    reply = () => new Response('', { status: 500 })
    const r = await run({ args: ['claude', '30000', event] })
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
    expect(hits).toHaveLength(1)
    expect(new URLSearchParams(hits[0]!.search).has('event')).toBe(false)
  })

  test('does not read QUIRKY_HOOK_EVENT', async () => {
    mark('s1')
    reply = () => new Response('', { status: 500 })
    const r = await run({ args: ['claude', '30000'], env: { QUIRKY_HOOK_EVENT: 'PermissionRequest' } })
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
    expect(hits).toHaveLength(1)
    expect(new URLSearchParams(hits[0]!.search).has('event')).toBe(false)
  })

  test.each([
    ['08', '8'],
    ['007', '7'],
    ['00030000', '30000'],
    ['0', '30000'],
    ['00', '30000'],
    ['-5', '30000'],
    ['1e3', '30000'],
    ['1234567890', '30000'],
    ['99999999999999999999', '30000'],
    ['2500', '2500'],
    ['600001', '600000']
  ])('normalizes deadline %s to %s', async (deadline, expected) => {
    mark('s1')
    const r = await run({ args: ['claude', deadline] })
    expect(r).toEqual({ code: 0, stdout: '{}', stderr: '' })
    expect(new URLSearchParams(hits[0]!.search).get('deadline')).toBe(expected)
  })

  const environmentDeadlineCases: Array<[string, string[], string, string]> = [
    ['environment deadline', ['claude'], '45000', '45000'],
    ['environment deadline with leading zero', ['claude'], '08', '8'],
    ['second argument takes precedence', ['claude', '25000'], '45000', '25000']
  ]
  test.each(environmentDeadlineCases)('uses the %s', async (_label, args, environmentDeadline, expected) => {
    mark('s1')
    const r = await run({ args, env: { QUIRKY_GATE_DEADLINE_MS: environmentDeadline } })
    expect(r).toEqual({ code: 0, stdout: '{}', stderr: '' })
    expect(new URLSearchParams(hits[0]!.search).get('deadline')).toBe(expected)
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

  test('decodes escaped JSON strings into the exact UTF-8 bytes', async () => {
    mark('s1')
    reply = () => new Response(String.raw`{"decision":"allow","reason":"","encoded":"{\"a\":\"${'é😀'}A \/ \t\"}"}`)
    const r = await run({ captureStdoutBytes: true })
    expect(r.code).toBe(0)
    expect(r.stdoutBytes).toEqual(Buffer.from('{"a":"é😀A / \t"}'))
  })

  test.each(['', ' \n', '\t\r\n '])('refuses a deny with blank encoded text %j', async (encoded) => {
    mark('s1')
    reply = () => Response.json({ decision: 'deny', reason: 'no', encoded })
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('refuses an allow with empty encoded text', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'allow', reason: 'ok', encoded: '' })
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test.each([
    '{"decision":"unavailable","reason":"x","encoded":"{}"}',
    '{"decision":"maybe","reason":"x","encoded":"{}"}',
    '{"reason":"x","encoded":"{}"}',
    '{"decision":1,"reason":"x","encoded":"{}"}'
  ])('refuses an unsupported decision body: %s', async (body) => {
    mark('s1')
    reply = () => new Response(body)
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('prints a passthrough decision', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'passthrough', reason: 'run', encoded: '{}' })
    expect(await run()).toEqual({ code: 0, stdout: '{}', stderr: '' })
  })

  test.each([-1, 256, 2.5, 1000])('refuses an out-of-range exitCode %s', async (exitCode) => {
    mark('s1')
    reply = () => Response.json({ decision: 'deny', reason: 'x', encoded: '{"d":1}', exitCode })
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('refuses a string exitCode', async () => {
    mark('s1')
    reply = () => new Response(String.raw`{"decision":"deny","reason":"x","encoded":"{\"d\":1}","exitCode":"2"}`)
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test.each([
    [255, 255],
    [0, 0]
  ])('prints a valid exitCode %s', async (exitCode, expected) => {
    mark('s1')
    reply = () => Response.json({ decision: 'deny', reason: 'x', encoded: '{"d":1}', exitCode })
    expect(await run()).toEqual({ code: expected, stdout: '{"d":1}', stderr: '' })
  })

  test('uses top-level decision fields, not nested fields', async () => {
    mark('s1')
    reply = () => new Response(String.raw`{"reason":{"encoded":"nested","decision":"allow"},"decision":"deny","encoded":"{\"real\":1}"}`)
    expect(await run()).toEqual({ code: 0, stdout: '{"real":1}', stderr: '' })
  })

  test('refuses when the only decision is nested', async () => {
    mark('s1')
    reply = () => new Response(String.raw`{"reason":{"decision":"allow","encoded":"{}"}}`)
    expect(await run()).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })

  test('refuses when printing the encoded answer fails', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'allow', reason: 'ok', encoded: '{}' })
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'cat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const r = await run({ env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } })
    expect(r).toEqual({ code: 2, stdout: '', stderr: UNAVAILABLE })
  })
})

describe('PermissionRequest refusals', () => {
  test('refuses when the daemon port is closed', async () => {
    mark('s1')
    await expectPermissionRequestRefusal({
      env: { QUIRKY_HOOK_URL: `http://127.0.0.1:${await closedPort()}/hook` }
    })
  })

  test('refuses when no daemon address is available', async () => {
    mark('s1')
    await expectPermissionRequestRefusal({ unset: ['QUIRKY_HOOK_URL'] })
  })

  test.each([500, 413])('refuses an HTTP %i response', async (status) => {
    mark('s1')
    reply = () => new Response('', { status })
    await expectPermissionRequestRefusal()
  })

  test('refuses an unavailable answer', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'unavailable', reason: 'none', encoded: null })
    await expectPermissionRequestRefusal()
  })

  test('refuses a denial with blank encoded text', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'deny', reason: 'no', encoded: '' })
    await expectPermissionRequestRefusal()
  })

  test('refuses a non-JSON response body', async () => {
    mark('s1')
    reply = () => new Response('<html>nope</html>')
    await expectPermissionRequestRefusal()
  })

  test('prints a real denial decision without changing it', async () => {
    mark('s1')
    reply = () => Response.json({ decision: 'deny', reason: 'no', encoded: '{"x":1}' })
    const r = await run({ args: ['claude', '30000', 'PermissionRequest'] })
    expect(r).toEqual({ code: 0, stdout: '{"x":1}', stderr: '' })
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

  test.each([400, 401, 413, 500])('HTTP %i: exits 2', async (status) => {
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

test('the script is a plain POSIX shell file and is executable', () => {
  expect(QUIRKY_GATE_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true)
  expect(statSync(scriptPath).mode & 0o111).not.toBe(0)
})
