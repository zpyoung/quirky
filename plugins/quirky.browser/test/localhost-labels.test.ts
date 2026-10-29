import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { baseLabelForWorktree, labelFromHost, parseLabelTarget } from '../src/localhost-labels/labels'
import { LocalhostLabelProxy } from '../src/localhost-labels/proxy'

type DevServer = ReturnType<typeof Bun.serve>

function devServer(name: string): DevServer {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/ws' && server.upgrade(request, { data: undefined })) return undefined
      return new Response(`${name} ${request.headers.get('host')} ${url.pathname}${url.search}`)
    },
    websocket: { open(socket) { socket.send(`${name}-ws`) }, message() {} }
  })
}

/** Sends raw bytes over a CONNECT tunnel, as WebKit's session proxy does, and collects the reply. */
async function throughTunnel(proxyPort: number, authority: string, payload: string, until: (text: string) => boolean): Promise<string> {
  const socket = net.connect(proxyPort, '127.0.0.1')
  let text = ''
  let tunnelled = false
  const done = Promise.withResolvers<string>()
  socket.on('data', (chunk) => {
    text += chunk.toString('latin1')
    if (!tunnelled && text.includes('\r\n\r\n')) {
      tunnelled = true
      const [head] = text.split('\r\n')
      if (!head?.includes(' 200 ')) {
        done.resolve(text)
        return
      }
      text = ''
      socket.write(payload)
      return
    }
    if (tunnelled && until(text)) done.resolve(text)
  })
  socket.on('error', done.reject)
  socket.on('close', () => done.resolve(text))
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  try {
    return await done.promise
  } finally {
    socket.destroy()
  }
}

describe('localhost worktree labels', () => {
  test('derive a label from the worktree folder, giving a primary checkout its project name', () => {
    expect(baseLabelForWorktree({ id: 'w1', path: '/repos/quirky/.worktrees/Feature Login!', isMain: false })).toBe('feature-login')
    expect(baseLabelForWorktree({ id: 'w2', path: '/repos/quirky', isMain: true })).toBe('quirky-main')
    expect(baseLabelForWorktree({ id: 'w3', path: '/repos/!!!', isMain: false })).toBe('workspace')
  })

  test('label only loopback http URLs with an explicit port', () => {
    for (const url of ['http://localhost:5173/app?x=1', 'http://127.0.0.1:3000/', 'http://0.0.0.0:8080', 'http://[::1]:4000/']) {
      expect(parseLabelTarget(url)?.href).toBe(new URL(url).href)
    }
    for (const url of ['https://localhost:5173/', 'http://localhost/', 'http://example.test:5173/', 'http://user:pw@localhost:5173/', 'not a url']) {
      expect(parseLabelTarget(url)).toBeNull()
    }
    expect(labelFromHost('feature-login.quirky.localhost:4100')).toBe('feature-login')
    expect(labelFromHost('evil.example.test')).toBeNull()
    expect(labelFromHost('quirky.localhost')).toBeNull()
  })

  describe('label proxy', () => {
    const proxy = new LocalhostLabelProxy()
    let feature: DevServer
    let main: DevServer

    beforeAll(() => {
      feature = devServer('feature')
      main = devServer('main')
    })

    afterAll(async () => {
      await proxy.close()
      feature.stop(true)
      main.stop(true)
    })

    test('gives each worktree origin a stable, collision-free label', async () => {
      const first = await proxy.register('w-feature', 'feature', new URL(`http://localhost:${feature.port}/login?next=1`))
      const port = Number(new URL(first.url).port)
      expect(first).toEqual({
        label: 'feature',
        worktreeId: 'w-feature',
        target: `http://localhost:${feature.port}`,
        url: `http://feature.quirky.localhost:${port}/login?next=1`
      })
      expect((await proxy.register('w-feature', 'feature', new URL(`http://localhost:${feature.port}/other`))).label).toBe('feature')
      expect((await proxy.register('w-other', 'feature', new URL(`http://127.0.0.1:${main.port}/`))).label).toBe('feature-2')
      expect(proxy.list().map((route) => route.label)).toEqual(['feature', 'feature-2'])
    })

    test('routes a direct request by Host and rewrites Host for the dev server', async () => {
      const { url } = await proxy.register('w-feature', 'feature', new URL(`http://localhost:${feature.port}/`))
      const port = new URL(url).port
      const reply = await fetch(`http://127.0.0.1:${port}/page?q=2`, { headers: { host: `feature.quirky.localhost:${port}` } })
      expect(await reply.text()).toBe(`feature localhost:${feature.port} /page?q=2`)
      const other = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `feature-2.quirky.localhost:${port}` } })
      expect(await other.text()).toBe(`main 127.0.0.1:${main.port} /`)
      const unknown = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `missing.quirky.localhost:${port}` } })
      expect(unknown.status).toBe(404)
    })

    test('routes page loads and WebSockets tunnelled with CONNECT, as the native session proxy sends them', async () => {
      const { url } = await proxy.register('w-feature', 'feature', new URL(`http://localhost:${feature.port}/`))
      const port = Number(new URL(url).port)
      const authority = `feature.quirky.localhost:${port}`

      const page = await throughTunnel(port, authority, `GET /sub.js HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`, (text) => text.includes(`/sub.js`))
      expect(page).toStartWith('HTTP/1.1 200')
      expect(page).toEndWith(`feature localhost:${feature.port} /sub.js`)

      const upgrade = [
        'GET /ws HTTP/1.1', `Host: ${authority}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''
      ].join('\r\n')
      const socket = await throughTunnel(port, authority, upgrade, (text) => text.includes('feature-ws'))
      expect(socket).toStartWith('HTTP/1.1 101')
      expect(socket).toContain('feature-ws')
    })

    test('refuses to tunnel anything but a registered label', async () => {
      const { url } = await proxy.register('w-feature', 'feature', new URL(`http://localhost:${feature.port}/`))
      const port = Number(new URL(url).port)
      for (const authority of ['example.com:443', `localhost:${feature.port}`, `missing.quirky.localhost:${port}`]) {
        expect(await throughTunnel(port, authority, '', () => true)).toStartWith('HTTP/1.1 403')
      }
    })
  })
})
