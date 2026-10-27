import type { PtyWriteErrorCode } from '@quirky/protocol'

export type ShellState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

export type ShellReadyBarrierOptions = {
  enabled: boolean
  timeoutMs: number
  deliver(bytes: Uint8Array): void | number
  onState?(state: ShellState): void
  log?(message: string): void
}

const QUEUE_CAP_BYTES = 1024 * 1024
type ReceiptError = Error & { code: PtyWriteErrorCode; acceptedBytes: number | null }
type Receipt = { resolve(): void; reject(error: ReceiptError): void }
type QueuedInput = { bytes: Uint8Array; receipt?: Receipt }

export function makePtyWriteError(
  code: PtyWriteErrorCode,
  acceptedBytes: number | null,
  message: string
): ReceiptError {
  return Object.assign(new Error(message), { code, acceptedBytes })
}

/**
 * Holds a session's PTY input until its shell has printed the first prompt, so keystrokes sent
 * during slow rc files are not lost or echoed into a half-initialised line editor. Input is
 * released in order when `ready()` is called or after `timeoutMs`, whichever comes first.
 */
export class ShellReadyBarrier {
  private current: ShellState
  private queue: QueuedInput[] = []
  private queued = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private warned = false
  private disposed = false
  private releasing = false

  constructor(private readonly options: ShellReadyBarrierOptions) {
    this.current = options.enabled ? 'pending' : 'unsupported'
    if (options.enabled) this.arm()
  }

  get state(): ShellState {
    return this.current
  }

  /** Delivers `bytes` now, or holds a copy until the shell is ready. */
  input(bytes: Uint8Array): void {
    if (this.disposed) return
    if (this.current !== 'pending' && !this.releasing) {
      this.options.deliver(bytes)
      return
    }
    const room = QUEUE_CAP_BYTES - this.queued
    if (bytes.length > room) {
      this.dropped(bytes.length - room)
      if (room <= 0) return
      bytes = bytes.subarray(0, room)
    }
    this.queue.push({ bytes: bytes.slice() })
    this.queued += bytes.length
  }

  /** Resolves only after the queued bytes reach the child PTY write boundary. */
  inputAccepted(bytes: Uint8Array): Promise<void> {
    if (this.disposed) {
      return Promise.reject(makePtyWriteError('PTY_WRITE_REJECTED', 0, 'terminal write was dropped after disposal'))
    }
    if (this.current !== 'pending' && !this.releasing) {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      this.deliverAccepted(bytes, { resolve, reject })
      return promise
    }
    const room = QUEUE_CAP_BYTES - this.queued
    if (bytes.length > room) {
      this.dropped(bytes.length)
      return Promise.reject(makePtyWriteError('PTY_WRITE_REJECTED', 0, 'terminal write was dropped by the shell-ready barrier'))
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.queue.push({ bytes: bytes.slice(), receipt: { resolve, reject } })
    this.queued += bytes.length
    return promise
  }

  /** The shell printed its first prompt. Does nothing unless the barrier is still pending. */
  ready(): void {
    this.release('ready')
  }

  /** Re-arms a barrier for a shell that is starting again; a disabled barrier is unaffected. */
  restart(): void {
    if (this.disposed || !this.options.enabled) return
    this.clear()
    this.rejectQueued(this.queue, 'terminal write was dropped when the shell-ready barrier restarted')
    this.queue = []
    this.queued = 0
    this.releasing = false
    this.setState('pending')
    this.arm()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    this.rejectQueued(this.queue, 'terminal write was dropped when the shell-ready barrier was disposed')
    this.queue = []
    this.queued = 0
  }

  private arm(): void {
    this.timer = setTimeout(() => this.release('timed_out'), this.options.timeoutMs)
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private release(next: 'ready' | 'timed_out'): void {
    if (this.disposed || this.current !== 'pending') return
    this.clear()
    const held = this.queue
    this.queue = []
    this.queued = 0
    this.releasing = true
    try {
      this.setState(next)
      this.drain(held, next)
    } finally {
      if (this.state === next) this.releasing = false
    }
  }

  /** Delivers held input then reentrant input, preserving the original order. */
  private drain(held: QueuedInput[], next: ShellState): void {
    let batch = held
    while (batch.length > 0) {
      for (let index = 0; index < batch.length; index++) {
        if (this.disposed || this.current !== next) {
          this.rejectQueued(batch.slice(index), 'terminal write was dropped before delivery')
          this.rejectQueued(this.queue, 'terminal write was dropped before delivery')
          this.queue = []
          this.queued = 0
          return
        }
        const input = batch[index]
        if (input.receipt) this.deliverAccepted(input.bytes, input.receipt)
        else this.options.deliver(input.bytes)
      }
      batch = this.queue
      this.queue = []
      this.queued = 0
    }
  }

  private deliverAccepted(bytes: Uint8Array, receipt: Receipt): void {
    try {
      const result = this.options.deliver(bytes)
      if (typeof result !== 'number') {
        if (bytes.length === 0) receipt.resolve()
        else receipt.reject(makePtyWriteError('PTY_WRITE_UNCERTAIN', null, 'terminal child write did not report an accepted byte count'))
        return
      }
      if (result === bytes.length) receipt.resolve()
      else if (result === 0) {
        receipt.reject(makePtyWriteError('PTY_WRITE_REJECTED', 0, 'terminal child accepted no input bytes'))
      } else if (Number.isInteger(result) && result > 0 && result < bytes.length) {
        receipt.reject(makePtyWriteError('PTY_WRITE_UNCERTAIN', result, 'terminal child accepted only part of the input'))
      } else {
        receipt.reject(makePtyWriteError('PTY_WRITE_UNCERTAIN', null, 'terminal child write returned an invalid byte count'))
      }
    } catch (error) {
      receipt.reject(
        makePtyWriteError(
          'PTY_WRITE_UNCERTAIN',
          null,
          `terminal child write failed: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    }
  }

  private rejectQueued(inputs: QueuedInput[], message: string): void {
    for (const input of inputs) {
      input.receipt?.reject(makePtyWriteError('PTY_WRITE_REJECTED', 0, message))
    }
  }

  private setState(next: ShellState): void {
    this.current = next
    this.options.onState?.(next)
  }

  private dropped(count: number): void {
    if (this.warned) return
    this.warned = true
    this.options.log?.(`shell-ready barrier queue is full; dropped ${count} bytes of input`)
  }
}
