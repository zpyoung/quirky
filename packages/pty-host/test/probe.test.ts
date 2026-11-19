import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePtyJson, PtyFrameDecoder } from '@quirky/protocol'
import { socketPath as resolveSocketPath } from '@quirky/protocol/node'
import { probeHost } from '../src/client'
import { runCleanups, tempHome } from './helpers'

afterEach(runCleanups)

type HelloRequest = { id: number; type: string }

function listen(home: string, onHello: (send: (frame: Uint8Array) => number, request: HelloRequest) => void) {
  const decoder = new PtyFrameDecoder()
  return Bun.listen({
    unix: resolveSocketPath(home, 'pty.sock'),
    socket: {
      data(socket, chunk) {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'data') onHello((bytes) => socket.write(bytes), frame.message as HelloRequest)
        }
      }
    }
  })
}

describe('probeHost', () => {
  test('counts a protocol-version rejection as an answer', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'pty.token'), 'probe-token', { mode: 0o600 })
    const listener = listen(home, (send, request) => {
      if (request.type === 'hello') {
        send(encodePtyJson({ id: request.id, ok: false, error: 'unsupported protocol version 4, host speaks 3' }))
      }
    })

    try {
      expect(await probeHost(home, 300)).toBe('answers')
    } finally {
      listener.stop(true)
    }
  })

  test('reports silent for an accepted socket with no token or reply', async () => {
    const home = tempHome()
    let accepts = 0
    let hellos = 0
    const decoder = new PtyFrameDecoder()
    const listener = Bun.listen({
      unix: resolveSocketPath(home, 'pty.sock'),
      socket: {
        open() {
          accepts++
        },
        data(_socket, chunk) {
          for (const frame of decoder.push(chunk)) {
            if (frame.kind !== 'data' && (frame.message as HelloRequest).type === 'hello') hellos++
          }
        }
      }
    })

    try {
      expect(existsSync(join(home, 'pty.token'))).toBe(false)
      expect(await probeHost(home, 100)).toBe('silent')
      expect(accepts).toBe(1)
      expect(hellos).toBe(1)
    } finally {
      listener.stop(true)
    }
  })

  test('reports absent when the socket file does not exist', async () => {
    expect(await probeHost(tempHome(), 100)).toBe('absent')
  })
})
