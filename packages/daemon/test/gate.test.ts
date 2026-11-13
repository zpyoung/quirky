import { afterEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, type PluginInfo, type ToolGateDecision } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from './helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './plugins/fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type PostOptions = { agent?: string; query?: string; body?: string; token?: string | null }

type GatePlugin = {
  id: string
  agents?: string[]
  provider: string
  contributes?: boolean
  overrides?: string[]
  provideId?: string
}

function gatePlugin({
  id,
  agents,
  provider,
  contributes = true,
  overrides = [],
  provideId = `${id}/gate`
}: GatePlugin): { manifest: { id: string } & Record<string, unknown>; behavior: ModuleBehavior } {
  return {
    manifest: {
      id,
      ...(contributes ? { contributes: { 'tool-gate': [{ id: 'gate', ...(agents ? { agents } : {}) }] } } : {}),
      ...(overrides.length ? { overrides: overrides.map((override) => ({ id: override })) } : {})
    },
    behavior: { activate: `context.provide('tool-gate:${provideId}', ${provider})` }
  }
}

function paddedGateBody(byteLength: number): string {
  const prefix = '{"tool_name":"Write","pad":"'
  const suffix = '"}'
  return `${prefix}${'x'.repeat(byteLength - Buffer.byteLength(prefix + suffix))}${suffix}`
}

async function rawGatePost(
  port: number,
  { token, chunks, chunked = false }: { token: string | null; chunks: string[]; chunked?: boolean }
): Promise<{ status: number; body: string }> {
  let incoming = ''
  let settled = false
  const parts: Uint8Array[] = []
  let partIndex = 0
  let partOffset = 0
  const { promise: response, resolve: resolveResponse, reject: rejectResponse } =
    Promise.withResolvers<{ status: number; body: string }>()

  const parseResponse = (closed: boolean) => {
    const headerEnd = incoming.indexOf('\r\n\r\n')
    if (headerEnd < 0) return null
    const headers = incoming.slice(0, headerEnd)
    const status = Number(/^HTTP\/\d\.\d\s+(\d+)/.exec(headers)?.[1])
    const bodyStart = headerEnd + 4
    const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(headers)
    if (contentLength) {
      const length = Number(contentLength[1])
      if (incoming.length < bodyStart + length) return null
      return { status, body: incoming.slice(bodyStart, bodyStart + length) }
    }
    return closed ? { status, body: incoming.slice(bodyStart) } : null
  }

  const pump = (socket: Bun.Socket) => {
    if (settled) return
    while (partIndex < parts.length) {
      const part = parts[partIndex]
      const written = socket.write(part.subarray(partOffset))
      if (written <= 0) return
      partOffset += written
      if (partOffset < part.byteLength) return
      partIndex++
      partOffset = 0
    }
  }

  void Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(socket, chunk) {
        incoming += Buffer.from(chunk).toString('latin1')
        const result = parseResponse(false)
        if (!result || settled) return
        settled = true
        socket.end()
        resolveResponse(result)
      },
      drain(socket) {
        pump(socket)
      },
      close() {
        if (settled) return
        settled = true
        const result = parseResponse(true)
        if (result) resolveResponse(result)
        else rejectResponse(new Error('gate server closed before completing its response'))
      },
      error(_socket, error) {
        if (settled) return
        settled = true
        rejectResponse(error)
      }
    }
  })
    .then((socket) => {
      const byteLength = chunks.reduce((length, chunk) => length + Buffer.byteLength(chunk), 0)
      const headers = [
        'POST /gate/claude?session=s1 HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        ...(token === null ? [] : [`${HOOK_TOKEN_HEADER}: ${token}`]),
        ...(chunked ? ['Transfer-Encoding: chunked'] : [`Content-Length: ${byteLength}`]),
        'Connection: close',
        '',
        ''
      ].join('\r\n')
      parts.push(Buffer.from(headers))
      if (chunked) {
        for (const chunk of chunks) {
          parts.push(Buffer.from(`${Buffer.byteLength(chunk).toString(16)}\r\n`), Buffer.from(chunk), Buffer.from('\r\n'))
        }
        parts.push(Buffer.from('0\r\n\r\n'))
      } else {
        for (const chunk of chunks) parts.push(Buffer.from(chunk))
      }
      pump(socket)
    })
    .catch((error: unknown) => {
      if (settled) return
      settled = true
      rejectResponse(error instanceof Error ? error : new Error(String(error)))
    })

  return response
}

async function boot(plugins: GatePlugin[] = []) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const plugin of plugins) {
    const { manifest, behavior } = gatePlugin(plugin)
    writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  }
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const base = `http://127.0.0.1:${harness.runtime.port}`
  return {
    harness,
    marker,
    post(options: PostOptions = {}) {
      const token = options.token === undefined ? harness.runtime.hookToken : options.token
      return fetch(`${base}/gate/${options.agent ?? 'claude'}?${options.query ?? 'session=s1&event=PreToolUse&deadline=5000'}`, {
        method: 'POST',
        body: options.body ?? '{"tool_name":"Bash"}',
        headers: token === null ? {} : { [HOOK_TOKEN_HEADER]: token }
      })
    },
    async decide(options?: PostOptions) {
      const response = await this.post(options)
      expect(response.status).toBe(200)
      return (await response.json()) as ToolGateDecision
    }
  }
}

const allow = `async (request) => ({ decision: 'allow', reason: JSON.stringify(request), encoded: '{"ok":true}', exitCode: 0 })`

describe('/gate route', () => {
  test('401 without the hook token and with a wrong one', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ token: null })).status).toBe(401)
    expect((await s.post({ token: 'wrong' })).status).toBe(401)
  })

  test('400 on a body that is not JSON', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ body: 'not json' })).status).toBe(400)
  })

  test('400 without a session', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ query: 'event=PreToolUse' })).status).toBe(400)
  })

  test('no provider: 200 with an unavailable decision and no encoded answer', async () => {
    const s = await boot()
    const decision = await s.decide()
    expect(decision.decision).toBe('unavailable')
    expect(decision.encoded).toBeNull()
    expect(decision.reason).not.toBe('')
  })

  test('hands the provider the request and returns its decision', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({ agent: 'codex', query: 'session=s9&event=Stop&deadline=7000', body: '{"a":1}' })
    expect(decision).toMatchObject({ decision: 'allow', encoded: '{"ok":true}', exitCode: 0 })
    expect(JSON.parse(decision.reason)).toEqual({
      agent: 'codex',
      sessionId: 's9',
      event: 'Stop',
      deadlineMs: 7000,
      payload: { a: 1 }
    })
  })

  test('takes the event from the payload when the query has none', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({ query: 'session=s1', body: '{"hook_event_name":"PreToolUse"}' })
    expect(JSON.parse(decision.reason).event).toBe('PreToolUse')
  })

  test('a provider that throws yields unavailable, never allow', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `async () => { throw new Error('boom') }` }])
    const decision = await s.decide()
    expect(decision).toMatchObject({ decision: 'unavailable', encoded: null })
    expect(decision.reason).toContain('boom')
  })

  test('a provider that returns something else yields unavailable', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `async () => ({ decision: 'maybe' })` }])
    expect((await s.decide()).decision).toBe('unavailable')
  })

  test('a provider that outlives deadlineMs yields unavailable and its signal aborts', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `(request, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => { record('aborted'); resolve({ decision: 'allow', reason: 'late', encoded: '{}' }) })
        })`
      }
    ])
    const started = Date.now()
    const decision = await s.decide({ query: 'session=s1&event=PreToolUse&deadline=300' })
    expect(decision).toMatchObject({ decision: 'unavailable', encoded: null })
    expect(Date.now() - started).toBeLessThan(3000)
    await waitFor(() => (readMarker(s.marker).includes('aborted') ? true : undefined))
  })

  test('a provider limited to other agents is not asked', async () => {
    const s = await boot([{ id: 'acme.gate', agents: ['claude'], provider: allow }])
    expect((await s.decide({ agent: 'claude' })).decision).toBe('allow')
    expect((await s.decide({ agent: 'codex' })).decision).toBe('unavailable')
  })

  test('only POST is accepted', async () => {
    const s = await boot()
    const response = await fetch(`http://127.0.0.1:${s.harness.runtime.port}/gate/claude?session=s1`)
    expect(response.status).toBe(405)
  })
  test('a deny with blank encoded is unavailable', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async (request) => ({ decision: 'deny', reason: 'no', encoded: request.payload.encoded })`
      }
    ])
    for (const encoded of ['', ' \n\t']) {
      expect(await s.decide({ body: JSON.stringify({ encoded }) })).toEqual({
        decision: 'unavailable',
        reason: 'the tool gate returned an invalid decision',
        encoded: null
      })
    }
  })

  test('a deny with null encoded remains a denial', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `async () => ({ decision: 'deny', reason: 'no', encoded: null })` }])
    expect(await s.decide()).toEqual({ decision: 'deny', reason: 'no', encoded: null })
  })

  test('allow and passthrough accept an empty encoded answer', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async (request) => ({ decision: request.payload.decision, reason: request.payload.reason, encoded: '' })`
      }
    ])
    for (const answer of [
      { decision: 'allow', reason: 'ok' },
      { decision: 'passthrough', reason: '' }
    ] as const) {
      expect(await s.decide({ body: JSON.stringify(answer) })).toEqual({ ...answer, encoded: '' })
    }
  })

  test('exitCode must be an integer from zero through 255', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async (request) => ({ decision: 'deny', reason: 'no', encoded: '{"d":1}', exitCode: request.payload.exitCode })`
      }
    ])
    for (const exitCode of [-1, 256, 1.5, '2']) {
      expect(await s.decide({ body: JSON.stringify({ exitCode }) })).toEqual({
        decision: 'unavailable',
        reason: 'the tool gate returned an invalid decision',
        encoded: null
      })
    }
    expect(await s.decide({ body: '{"exitCode":2}' })).toEqual({
      decision: 'deny',
      reason: 'no',
      encoded: '{"d":1}',
      exitCode: 2
    })
  })

  test('unavailable drops encoded and exitCode', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async () => ({ decision: 'unavailable', reason: 'busy', encoded: '{}', exitCode: 0 })`
      }
    ])
    expect(await s.decide()).toEqual({ decision: 'unavailable', reason: 'busy', encoded: null })
  })

  test('a non-function provider is unavailable with its registration error', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `({ not: 'a function' })` }])
    const decision = await s.decide()
    expect(decision.decision).toBe('unavailable')
    expect(decision.encoded).toBeNull()
    expect(decision.reason).toContain('tool-gate:acme.gate/gate must be provided as a function')
  })

  test('the payload event takes precedence over the query event', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({
      query: 'session=s1&event=PermissionRequest',
      body: '{"hook_event_name":"PreToolUse"}'
    })
    expect(JSON.parse(decision.reason).event).toBe('PreToolUse')
  })

  test('the query event is the fallback for absent or invalid payload events', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const payloads = [
      { tool_name: 'Bash' },
      { hook_event_name: 7 },
      { hook_event_name: 'Pre ToolUse' },
      { hook_event_name: 'a'.repeat(65) }
    ]
    for (const payload of payloads) {
      const decision = await s.decide({ query: 'session=s1&event=tool_call', body: JSON.stringify(payload) })
      expect(JSON.parse(decision.reason).event).toBe('tool_call')
    }
  })

  test('the event is empty when neither payload nor query names one', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({ query: 'session=s1', body: '{"tool_name":"Bash"}' })
    expect(JSON.parse(decision.reason).event).toBe('')
  })

  test('only the top-level payload event is used', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const topLevel = await s.decide({
      query: 'session=s1',
      body: '{"tool_input":{"hook_event_name":"PermissionRequest"},"hook_event_name":"PreToolUse"}'
    })
    const nestedOnly = await s.decide({
      query: 'session=s1',
      body: '{"tool_input":{"hook_event_name":"PermissionRequest"}}'
    })
    expect(JSON.parse(topLevel.reason).event).toBe('PreToolUse')
    expect(JSON.parse(nestedOnly.reason).event).toBe('')
  })

  test('deadline defaults and caps invalid or oversized query values', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const cases = [
      ['session=s1', 30000],
      ['session=s1&deadline=0', 30000],
      ['session=s1&deadline=abc', 30000],
      ['session=s1&deadline=-5', 30000],
      ['session=s1&deadline=1234567890', 30000],
      ['session=s1&deadline=999999999', 600000],
      ['session=s1&deadline=600000', 600000],
      ['session=s1&deadline=7000', 7000]
    ] as const
    for (const [query, expected] of cases) {
      const decision = await s.decide({ query })
      expect(JSON.parse(decision.reason).deadlineMs).toBe(expected)
    }
  })

  test('requires an agent', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ agent: '', query: 'session=s1' })).status).toBe(400)
  })

  test('rejects a declared body one byte over 8 MiB before calling the provider', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async () => { record('called'); return { decision: 'allow', reason: 'called', encoded: '{}' } }`
      }
    ])
    const body = paddedGateBody(8 * 1024 * 1024 + 1)
    expect(Buffer.byteLength(body)).toBe(8 * 1024 * 1024 + 1)
    const response = await rawGatePost(s.harness.runtime.port, { token: s.harness.runtime.hookToken, chunks: [body] })
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toEqual({ error: 'body too large' })
    expect(readMarker(s.marker)).not.toContain('called')
  })

  test('accepts a valid JSON body exactly 8 MiB long', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async () => { record('called'); return { decision: 'allow', reason: 'called', encoded: '{}' } }`
      }
    ])
    const body = paddedGateBody(8 * 1024 * 1024)
    expect(Buffer.byteLength(body)).toBe(8 * 1024 * 1024)
    const response = await s.post({ body })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ decision: 'allow' })
    expect(readMarker(s.marker)).toContain('called')
  })

  test('rejects a chunked stream over 8 MiB without a Content-Length header', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async () => { record('called'); return { decision: 'allow', reason: 'called', encoded: '{}' } }`
      }
    ])
    const chunk = 'x'.repeat(1024 * 1024)
    const response = await rawGatePost(s.harness.runtime.port, {
      token: s.harness.runtime.hookToken,
      chunks: Array(9).fill(chunk),
      chunked: true
    })
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toEqual({ error: 'body too large' })
    expect(readMarker(s.marker)).not.toContain('called')
  })

  test('checks the token before rejecting an oversized declared body', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `async () => { record('called'); return { decision: 'allow', reason: 'called', encoded: '{}' } }`
      }
    ])
    const body = paddedGateBody(8 * 1024 * 1024 + 1)
    const response = await rawGatePost(s.harness.runtime.port, { token: null, chunks: [body] })
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' })
    expect(readMarker(s.marker)).not.toContain('called')
  })

})

describe('tool-gate registration', () => {
  test('a second plugin declaring tool-gate is invalid with a clear error and the first still answers', async () => {
    const s = await boot([
      { id: 'acme.first', provider: allow },
      { id: 'acme.second', provider: allow }
    ])
    const client = await s.harness.connect()
    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    const first = listed.find((plugin) => plugin.id === 'acme.first')!
    const second = listed.find((plugin) => plugin.id === 'acme.second')!
    expect(first.state).not.toBe('invalid')
    expect(second.state).toBe('invalid')
    expect(second.diagnostics.map((item) => item.message)).toEqual(['only one plugin may declare tool-gate; acme.first already does'])
    expect((await s.decide()).decision).toBe('allow')
  })

  test('a real daemon rejects a gate override and still uses the declaring provider', async () => {
    const s = await boot([
      {
        id: 'acme.first',
        provider: `async () => ({ decision: 'allow', reason: 'first', encoded: '{"from":"first"}' })`
      },
      {
        id: 'acme.over',
        contributes: false,
        overrides: ['tool-gate:acme.first/gate'],
        provideId: 'acme.first/gate',
        provider: `async () => ({ decision: 'allow', reason: 'over', encoded: '{"from":"over"}' })`
      }
    ])
    const client = await s.harness.connect()
    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    const over = listed.find((plugin) => plugin.id === 'acme.over')!
    expect(over.state).toBe('invalid')
    expect(over.diagnostics.map((item) => item.message)).toEqual([
      "tool-gate can't be overridden: tool-gate:acme.first/gate"
    ])
    expect((await s.decide()).encoded).toBe('{"from":"first"}')
  })

  test('tool-gate rejects unknown fields and a malformed agents list', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.bad',
      contributes: { 'tool-gate': [{ id: 'gate', agents: 'claude', extra: 1 }] }
    })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    const bad = ((await client.call('plugin.list', {})) as PluginInfo[]).find((plugin) => plugin.id === 'acme.bad')!
    expect(bad.state).toBe('invalid')
    const messages = bad.diagnostics.map((item) => item.message).join('\n')
    expect(messages).toContain('unknown field `extra`')
    expect(messages).toContain('agents must be a list of agent names')
  })
})

describe('quirky-gate shim installation', () => {
  test('the daemon writes an executable quirky-gate next to quirky-hook', async () => {
    const s = await boot()
    const hook = statSync(join(s.harness.home, 'bin', 'quirky-hook'))
    const gate = statSync(join(s.harness.home, 'bin', 'quirky-gate'))
    expect(gate.mode & 0o777).toBe(0o755)
    expect(hook.mode & 0o777).toBe(0o755)
  })
})
