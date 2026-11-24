/** The client side of one stdio bridge channel: its sentinel, then quirkyd's bytes. */
import { Transform, type TransformCallback } from 'node:stream'
import {
  QUIRKYD_STDIO_BRIDGE_NO_NODE,
  QUIRKYD_STDIO_BRIDGE_READY,
  QUIRKYD_STDIO_BRIDGE_REFUSED,
  type QuirkydStdioBridgeMode
} from './quirkyd-stdio-bridge-script'

export type QuirkydStdioBridgeSignal = 'ready' | 'refused' | 'no-node'

// What a login profile may print before the bridge starts; past this, it is not a bridge.
const MAX_PRELUDE_BYTES = 64 * 1024
const NEWLINE = 0x0a

function sentinelOf(line: string): QuirkydStdioBridgeSignal | null {
  const trimmed = line.trim()
  if (trimmed === QUIRKYD_STDIO_BRIDGE_READY) {
    return 'ready'
  }
  if (trimmed.startsWith(QUIRKYD_STDIO_BRIDGE_REFUSED)) {
    return 'refused'
  }
  return trimmed === QUIRKYD_STDIO_BRIDGE_NO_NODE ? 'no-node' : null
}

/**
 * Bridge stdout in, quirkyd's bytes out. Emits `signal` once with the sentinel it found; nothing
 * passes before `ready`, and nothing at all after `refused` or `no-node`.
 */
export class QuirkydStdioBridgeDecoder extends Transform {
  private prelude: Buffer = Buffer.alloc(0)
  private signal: QuirkydStdioBridgeSignal | null = null
  private pendingLine = ''

  constructor(private readonly mode: QuirkydStdioBridgeMode) {
    super()
  }

  get bridgeSignal(): QuirkydStdioBridgeSignal | null {
    return this.signal
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.signal === 'ready') {
      this.forward(chunk)
      done()
      return
    }
    if (this.signal) {
      done()
      return
    }
    this.prelude = Buffer.concat([this.prelude, chunk])
    let newline = this.prelude.indexOf(NEWLINE)
    while (newline !== -1) {
      const signal = sentinelOf(this.prelude.subarray(0, newline).toString('latin1'))
      this.prelude = this.prelude.subarray(newline + 1)
      if (signal) {
        this.signal = signal
        this.emit('signal', signal)
        const rest = this.prelude
        this.prelude = Buffer.alloc(0)
        if (signal === 'ready' && rest.length > 0) {
          this.forward(rest)
        }
        done()
        return
      }
      newline = this.prelude.indexOf(NEWLINE)
    }
    done(
      this.prelude.length > MAX_PRELUDE_BYTES
        ? new Error('The SSH host printed no stdio bridge sentinel.')
        : undefined
    )
  }

  private forward(chunk: Buffer): void {
    if (this.mode === 'raw') {
      this.push(chunk)
      return
    }
    const lines = (this.pendingLine + chunk.toString('latin1')).split('\n')
    this.pendingLine = lines.pop() ?? ''
    for (const line of lines) {
      const encoded = line.trim()
      if (encoded) {
        this.push(Buffer.from(encoded, 'base64'))
      }
    }
  }
}

/** Client bytes to one base64 line per chunk, the framing the Windows bridge reads. */
export class QuirkydStdioBridgeBase64Encoder extends Transform {
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    done(null, `${chunk.toString('base64')}\n`)
  }
}
