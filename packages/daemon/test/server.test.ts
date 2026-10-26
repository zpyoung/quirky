import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, RPC_PATH, PROTOCOL_VERSION, RpcErrorCode, RpcError } from '@quirky/protocol'
import { readRuntime } from '@quirky/protocol/node'
import { startHarness, writeUiFixture, type Harness } from './helpers'

let harness: Harness | null = null
afterEach(async () => {
  await harness?.cleanup()
  harness = null
})

function url(h: Harness, path: string) {
  return `http://127.0.0.1:${h.runtime.port}${path}`
}

describe('runtime and health', () => {
  test('writes a private runtime.json and answers /health', async () => {
    harness = await startHarness()
    const info = readRuntime(harness.home)
    expect(info).toMatchObject({
      pid: process.pid,
      port: harness.daemon.port,
      protocolVersion: PROTOCOL_VERSION
    })
    expect(info?.token.length).toBeGreaterThan(16)
    expect(info?.hookToken).not.toBe(info?.token)
    expect(statSync(join(harness.home, 'runtime.json')).mode & 0o777).toBe(0o600)

    const health = await (await fetch(url(harness, '/health'))).json()
    expect(health).toMatchObject({ ok: true, pid: process.pid })
    expect(typeof health.daemonVersion).toBe('string')
  })

  test('stop removes runtime.json', async () => {
    harness = await startHarness()
    await harness.daemon.stop()
    expect(existsSync(join(harness.home, 'runtime.json'))).toBe(false)
  })
})

describe('rpc auth', () => {
  test('rejects a websocket with a wrong token', async () => {
    harness = await startHarness()
    const socket = new WebSocket(`ws://127.0.0.1:${harness.runtime.port}${RPC_PATH}?token=nope`)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('open'))
      socket.addEventListener('error', () => resolve('error'))
      socket.addEventListener('close', () => resolve('close'))
    })
    expect(outcome).not.toBe('open')
    const plain = await fetch(url(harness, `${RPC_PATH}?token=nope`))
    expect(plain.status).toBe(401)
  })

  test('requires client.hello first', async () => {
    harness = await startHarness()
    const socket = new WebSocket(
      `ws://127.0.0.1:${harness.runtime.port}${RPC_PATH}?token=${harness.runtime.token}`
    )
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
    const reply = new Promise<any>((resolve) =>
      socket.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true })
    )
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status.get', params: {} }))
    const message = await reply
    expect(message.id).toBe(1)
    expect(message.error.code).toBe(RpcErrorCode.Unauthorized)
    socket.close()
  })

  test('hello records role and name, status.get lists clients', async () => {
    harness = await startHarness()
    await harness.connect('desktop', 'shell')
    const cli = await harness.connect('cli', 'tester')
    const status = await cli.call('status.get', {})
    expect(status.pid).toBe(process.pid)
    expect(status.home).toBe(harness.home)
    expect(status.ptyHost.alive).toBe(true)
    expect(status.clients).toEqual(
      expect.arrayContaining([
        { role: 'desktop', name: 'shell' },
        { role: 'cli', name: 'tester' }
      ])
    )
  })

  test('maps malformed input to protocol errors', async () => {
    harness = await startHarness()
    const client = await harness.connect()
    const code = async (method: string, params: unknown) => {
      try {
        await (client as any).call(method, params)
        return null
      } catch (error) {
        return (error as RpcError).code
      }
    }
    expect(await code('nope.nothing', {})).toBe(RpcErrorCode.MethodNotFound)
    expect(await code('plugin.enable', {})).toBe(RpcErrorCode.InvalidParams)
    expect(await code('plugin.enable', { id: 5 })).toBe(RpcErrorCode.InvalidParams)
    expect(await code('plugin.activate', { pluginId: 'acme.missing' })).toBe(RpcErrorCode.NotFound)
    expect(await code('setting.get', { id: 'setting:acme.none/x' })).toBe(RpcErrorCode.NotFound)
  })
})

describe('hook endpoint auth', () => {
  test('requires the hook token header', async () => {
    harness = await startHarness()
    const target = url(harness, '/hook/claude?session=s_x')
    const none = await fetch(target, { method: 'POST', body: '{}' })
    expect(none.status).toBe(401)
    const wrong = await fetch(target, {
      method: 'POST',
      body: '{}',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.token }
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(target, {
      method: 'POST',
      body: '{}',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.hookToken }
    })
    expect(right.status).toBe(200)
  })
})

describe('static ui', () => {
  test('serves files with content types and falls back to index.html', async () => {
    const home = (await import('./helpers')).makeTempHome()
    const uiDir = join(home, 'ui')
    writeUiFixture(uiDir)
    harness = await startHarness({ home, uiDir })

    const index = await fetch(url(harness, '/'))
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')

    const js = await fetch(url(harness, '/assets/app.js'))
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(await js.text()).toContain('console.log')

    const css = await fetch(url(harness, '/assets/app.css'))
    expect(css.headers.get('content-type')).toContain('text/css')

    const spa = await fetch(url(harness, '/worktrees/abc'))
    expect(spa.status).toBe(200)
    expect(await spa.text()).toBe(readFileSync(join(uiDir, 'index.html'), 'utf8'))

    expect((await fetch(url(harness, '/assets/missing.js'))).status).toBe(404)
    expect((await fetch(url(harness, '/../../etc/passwd'))).status).not.toBe(500)
  })

  test('answers /favicon.ico with 204', async () => {
    harness = await startHarness()
    const response = await fetch(url(harness, '/favicon.ico'))
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  test('returns 404 when the ui dir is missing', async () => {
    harness = await startHarness()
    expect((await fetch(url(harness, '/'))).status).toBe(404)
  })
})
