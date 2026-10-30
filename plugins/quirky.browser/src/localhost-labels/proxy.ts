import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { connectableHost, labelFromHost, LOCALHOST_LABEL_DOMAIN } from './labels'

export type LocalhostLabelRoute = { label: string; worktreeId: string; target: string; url: string }

type Route = { label: string; worktreeId: string; target: URL }

/**
 * Routes `<label>.quirky.localhost` to the loopback server each label was registered for.
 * Clients reach it either directly (Chrome resolves `*.localhost` to loopback) or as an HTTP
 * CONNECT proxy (the native pane's session proxy); both paths share one Host-based router,
 * which only ever dials registered loopback targets, so it is never an open proxy.
 */
export class LocalhostLabelProxy {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private port: number | null = null
  private readonly routes = new Map<string, Route>()
  private readonly labelsByKey = new Map<string, string>()

  /** Registers (or reuses) the label for one worktree's loopback origin and returns the labelled URL. */
  async register(worktreeId: string, baseLabel: string, target: URL): Promise<LocalhostLabelRoute> {
    const port = await this.start()
    const key = `${worktreeId}\n${target.origin}`
    const label = this.labelsByKey.get(key) ?? this.nextLabel(baseLabel)
    this.routes.set(label, { label, worktreeId, target: new URL(target.origin) })
    this.labelsByKey.set(key, label)
    return this.describe(label, target, port)
  }

  list(): LocalhostLabelRoute[] {
    if (this.port === null) return []
    const port = this.port
    return [...this.routes.values()].map((route) => this.describe(route.label, route.target, port))
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.starting = null
    this.port = null
    this.routes.clear()
    this.labelsByKey.clear()
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private describe(label: string, target: URL, port: number): LocalhostLabelRoute {
    const url = new URL(target.href)
    url.hostname = `${label}.${LOCALHOST_LABEL_DOMAIN}`
    url.port = String(port)
    return { label, worktreeId: this.routes.get(label)!.worktreeId, target: new URL(target.origin).origin, url: url.href }
  }

  private nextLabel(base: string): string {
    if (!this.routes.has(base)) return base
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`
      if (!this.routes.has(candidate)) return candidate
    }
    throw new Error('no localhost label is available')
  }

  private start(): Promise<number> {
    if (this.port !== null) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    const server = http.createServer((request, response) => this.forward(request, response))
    server.on('upgrade', (request, socket, head) => this.forwardUpgrade(request, socket, head))
    server.on('connect', (request, socket, head) => this.tunnel(request, socket, head))
    this.starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('the localhost label proxy did not bind a port'))
          return
        }
        this.server = server
        this.port = address.port
        resolve(address.port)
      })
    }).catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  private routeFor(host: string | undefined): Route | null {
    const label = labelFromHost(host ?? '')
    return label === null ? null : this.routes.get(label) ?? null
  }

  private targetFor(route: Route, request: IncomingMessage): { path: string; headers: http.OutgoingHttpHeaders } {
    // absolute-form request lines keep only their path; the Host header is the dev server's own
    const incoming = new URL(request.url || '/', route.target)
    return { path: `${incoming.pathname}${incoming.search}`, headers: { ...request.headers, host: route.target.host } }
  }

  private forward(request: IncomingMessage, response: ServerResponse): void {
    const route = this.routeFor(request.headers.host)
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Unknown Quirky localhost label.')
      return
    }
    const { path, headers } = this.targetFor(route, request)
    const upstream = http.request({
      hostname: connectableHost(route.target.hostname),
      port: route.target.port,
      method: request.method,
      path,
      headers
    })
    request.on('error', () => upstream.destroy())
    response.on('error', () => upstream.destroy())
    upstream.on('response', (reply) => {
      reply.on('error', () => response.destroy())
      response.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(response)
    })
    upstream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`Quirky localhost label ${route.label} could not reach ${route.target.host}: ${error.message}`)
    })
    request.pipe(upstream)
  }

  private forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = this.routeFor(request.headers.host)
    if (!route) {
      socket.destroy()
      return
    }
    const { path, headers } = this.targetFor(route, request)
    const upstream = net.connect(Number(route.target.port), connectableHost(route.target.hostname), () => {
      const lines = [`${request.method ?? 'GET'} ${path} HTTP/${request.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) lines.push(`${name}: ${entry}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }

  private tunnel(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.routeFor(request.url) || this.port === null) {
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\n\r\nQuirky only tunnels registered localhost labels.')
      return
    }
    // loop the tunnel back into this server so tunnelled requests get the same Host routing and rewrite
    const loop = net.connect(this.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) loop.write(head)
      loop.pipe(socket)
      socket.pipe(loop)
    })
    loop.on('error', () => socket.destroy())
    socket.on('error', () => loop.destroy())
  }
}
