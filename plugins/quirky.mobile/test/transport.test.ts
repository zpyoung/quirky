import WebSocket from 'ws'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_MOBILE_INBOUND_FRAME_BYTES, MAX_MOBILE_WEBSOCKETS, MobileTransport, type MobilePeer } from '../src/daemon/transport'

const temporaryDirectories: string[] = []
function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'quirky-mobile-transport-'))
  temporaryDirectories.push(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('mobile listener lifecycle', () => {
  test('falls through the persisted port ladder and reuses its actual fallback after restart', async () => {
    const blocker = createServer()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    blocker.once('error', reject)
    blocker.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
    await promise
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('blocker did not bind a TCP port')
    const preferredPort = address.port
    const dataDir = temporaryDirectory()
    const start = (onConnection: () => void) => new MobileTransport({ dataDir, hasPairedHistory: false, preferredPort, onConnection })
    const first = start(() => {})
    try {
      expect(await first.start()).toBe(true)
      expect(first.host).toBe('127.0.0.1')
      expect(first.port).not.toBe(preferredPort)
      const fallback = JSON.parse(readFileSync(join(dataDir, 'mobile-ws-fallback-port.json'), 'utf8')) as { port: number }
      expect(fallback.port).toBe(first.port)
      expect(statSync(join(dataDir, 'mobile-ws-fallback-port.json')).mode & 0o777).toBe(0o600)
      const firstPort = first.port
      await first.stop()
      const restarted = start(() => {})
      try {
        expect(await restarted.start()).toBe(true)
        expect(restarted.port).toBe(firstPort)
      } finally {
        await restarted.stop()
      }
    } finally {
      await first.stop()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  test('pins loopback against widening and serves only generic 404 HTTP routes', async () => {
    const transport = new MobileTransport({ dataDir: temporaryDirectory(), hasPairedHistory: false, portValue: '0', hostValue: '127.0.0.1', onConnection: () => {} })
    try {
      expect(await transport.start()).toBe(true)
      expect(await transport.ensureNetworkExposure()).toBe(false)
      expect(transport.host).toBe('127.0.0.1')
      const base = `http://127.0.0.1:${transport.port}`
      for (const path of ['/', '/rpc', '/health', '/assets/ui.js', '/hook/test']) {
        expect((await fetch(`${base}${path}`)).status).toBe(404)
      }
    } finally {
      await transport.stop()
    }
  })

  test('an explicit occupied port is pinned and does not fall back', async () => {
    const blocker = createServer()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    blocker.once('error', reject)
    blocker.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
    await promise
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('blocker did not bind a TCP port')
    const transport = new MobileTransport({ dataDir: temporaryDirectory(), hasPairedHistory: false, portValue: String(address.port), onConnection: () => {} })
    try {
      expect(await transport.start()).toBe(false)
      expect(transport.available).toBe(false)
    } finally {
      await transport.stop()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
  test('closes overflow with 1013 and releases queued process budgets on disconnect', async () => {
    const acceptors: ((peer: MobilePeer) => void)[] = []
    const transport = new MobileTransport({
      dataDir: temporaryDirectory(),
      hasPairedHistory: false,
      portValue: '0',
      onConnection: (peer) => acceptors.shift()?.(peer)
    })
    const clients: WebSocket[] = []
    const peers: MobilePeer[] = []
    const openClient = async (): Promise<{ socket: WebSocket; peer: MobilePeer }> => {
      const accepted = Promise.withResolvers<MobilePeer>()
      acceptors.push(accepted.resolve)
      const socket = new WebSocket(`ws://127.0.0.1:${transport.port}/rpc`)
      const opened = Promise.withResolvers<void>()
      socket.once('open', opened.resolve)
      socket.once('error', opened.reject)
      await opened.promise
      const peer = await accepted.promise
      clients.push(socket)
      peers.push(peer)
      return { socket, peer }
    }
    try {
      expect(await transport.start()).toBe(true)
      for (let index = 0; index < 5; index++) await openClient()
      const overflowClose = Promise.withResolvers<number>()
      clients[4]!.once('close', (code) => overflowClose.resolve(code))
      const largeFrame = new Uint8Array(8 * 1024 * 1024)
      for (const peer of peers) peer.sendBinary(largeFrame)
      expect(await overflowClose.promise).toBe(1013)

      const closes = clients.slice(0, 4).map((socket) => {
        const closed = Promise.withResolvers<void>()
        socket.once('close', closed.resolve)
        socket.close()
        return closed.promise
      })
      await Promise.all(closes)

      const next = await openClient()
      const received = Promise.withResolvers<string>()
      next.socket.once('message', (data) => received.resolve(data.toString()))
      next.peer.sendText('budget released')
      expect(await received.promise).toBe('budget released')
      const burst = Promise.withResolvers<string[]>()
      const receivedBurst: string[] = []
      next.socket.on('message', (data) => {
        const text = data.toString()
        if (!text.startsWith('burst-')) return
        receivedBurst.push(text)
        if (receivedBurst.length === 3) burst.resolve([...receivedBurst])
      })
      next.peer.sendText('burst-1')
      next.peer.sendText('burst-2')
      next.peer.sendText('burst-3')
      expect(await burst.promise).toEqual(['burst-1', 'burst-2', 'burst-3'])
      next.socket.close()
    } finally {
      for (const socket of clients) socket.terminate()
      await transport.stop()
    }
  }, 30_000)
  test('caps WebSocket admissions and rejects inbound payloads over one MiB', async () => {
    const waiting: (() => void)[] = []
    const transport = new MobileTransport({
      dataDir: temporaryDirectory(),
      hasPairedHistory: false,
      portValue: '0',
      onConnection: () => waiting.shift()?.()
    })
    const clients: WebSocket[] = []
    try {
      expect(await transport.start()).toBe(true)
      const openAccepted = async (): Promise<WebSocket> => {
        const accepted = Promise.withResolvers<void>()
        waiting.push(accepted.resolve)
        const socket = new WebSocket(`ws://127.0.0.1:${transport.port}/rpc`)
        const opened = Promise.withResolvers<void>()
        socket.once('open', opened.resolve)
        socket.once('error', opened.reject)
        await opened.promise
        await accepted.promise
        clients.push(socket)
        return socket
      }
      for (let index = 0; index < MAX_MOBILE_WEBSOCKETS; index++) await openAccepted()

      const refused = new WebSocket(`ws://127.0.0.1:${transport.port}/rpc`)
      const rejected = Promise.withResolvers<Error>()
      refused.once('error', rejected.resolve)
      refused.once('open', () => rejected.reject(new Error('the 129th socket was accepted')))
      expect((await rejected.promise).message).toContain('503')
      refused.terminate()

      const closedClients = clients.map((socket) => {
        const closed = Promise.withResolvers<void>()
        socket.once('close', closed.resolve)
        socket.terminate()
        return closed.promise
      })
      await Promise.all(closedClients)

      const oversized = await openAccepted()
      const closeCode = Promise.withResolvers<number>()
      oversized.once('close', (code) => closeCode.resolve(code))
      oversized.send(Buffer.alloc(MAX_MOBILE_INBOUND_FRAME_BYTES + 1), { binary: true })
      expect(await closeCode.promise).toBe(1009)
    } finally {
      for (const socket of clients) socket.terminate()
      await transport.stop()
    }
  }, 30_000)
})
