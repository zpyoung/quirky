type WritableSocket = {
  write(data: Uint8Array): number
  end(): void
}

/** Queues bytes for a socket whose `write` may accept only part of them; call `drain` on its drain event. */
export class SocketWriter {
  private queue: Uint8Array[] = []
  private queued = 0
  private closeWhenEmpty = false
  private waiters: Array<() => void> = []

  constructor(
    private readonly socket: WritableSocket,
    private readonly maxQueuedBytes = 256 * 1024 * 1024
  ) {}

  /** Returns false when the peer is too far behind and the connection should be dropped. */
  send(bytes: Uint8Array): boolean {
    if (this.queue.length > 0) {
      this.queue.push(bytes)
      this.queued += bytes.length
      return this.queued <= this.maxQueuedBytes
    }
    const written = Math.max(0, this.socket.write(bytes))
    if (written < bytes.length) {
      const rest = bytes.subarray(written)
      this.queue.push(rest)
      this.queued += rest.length
    } else {
      this.settle()
    }
    return this.queued <= this.maxQueuedBytes
  }

  drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      const written = Math.max(0, this.socket.write(head))
      this.queued -= written
      if (written < head.length) {
        this.queue[0] = head.subarray(written)
        return
      }
      this.queue.shift()
    }
    this.settle()
  }

  /** Ends the socket once everything queued so far has been written. */
  endAfterFlush(): void {
    this.closeWhenEmpty = true
    if (this.queue.length === 0) this.socket.end()
  }

  /** Resolves when nothing is waiting to be written. */
  flushed(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
    if (this.closeWhenEmpty) this.socket.end()
  }
}
