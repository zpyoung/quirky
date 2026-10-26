export type ShellState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

export type ShellReadyBarrierOptions = {
  enabled: boolean
  timeoutMs: number
  deliver(bytes: Uint8Array): void
  onState?(state: ShellState): void
  log?(message: string): void
}

const QUEUE_CAP_BYTES = 1024 * 1024

/**
 * Holds a session's PTY input until its shell has printed the first prompt, so keystrokes sent
 * during slow rc files are not lost or echoed into a half-initialised line editor. Input is
 * released in order when `ready()` is called or after `timeoutMs`, whichever comes first.
 */
export class ShellReadyBarrier {
  private current: ShellState
  private queue: Uint8Array[] = []
  private queued = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private warned = false
  private disposed = false

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
    if (this.current !== 'pending') {
      this.options.deliver(bytes)
      return
    }
    const room = QUEUE_CAP_BYTES - this.queued
    if (bytes.length > room) {
      this.dropped(bytes.length - room)
      if (room <= 0) return
      bytes = bytes.subarray(0, room)
    }
    this.queue.push(bytes.slice())
    this.queued += bytes.length
  }

  /** The shell printed its first prompt. Does nothing unless the barrier is still pending. */
  ready(): void {
    this.release('ready')
  }

  /** Re-arms a barrier for a shell that is starting again; a disabled barrier is unaffected. */
  restart(): void {
    if (this.disposed || !this.options.enabled) return
    this.clear()
    this.queue = []
    this.queued = 0
    this.setState('pending')
    this.arm()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
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
    this.setState(next)
    for (const chunk of held) this.options.deliver(chunk)
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
