type WritableSocket = {
  write(data: Uint8Array): number
  end(): void
}

type QueuedChunk = { bytes: Uint8Array; tag?: string; started: boolean }

/** Queues bytes for a socket whose `write` may accept only part of them; call `drain` on its drain event. */
export class SocketWriter {
  private queue: QueuedChunk[] = []
  private queued = 0
  private closeWhenEmpty = false
  private waiters: Array<() => void> = []
  private tagBytes = new Map<string, number>()


  constructor(
    private readonly socket: WritableSocket,
    private readonly maxQueuedBytes = 256 * 1024 * 1024
  ) {}
  get queuedBytes(): number {
    return this.queued
  }

  queuedForTag(tag: string): number {
    return this.tagBytes.get(tag) ?? 0
  }

  dropTag(tag: string): number {
    let dropped = 0
    let kept = 0
    for (const entry of this.queue) {
      if (entry.tag === tag && !entry.started) {
        dropped += entry.bytes.length
        this.queued -= entry.bytes.length
      } else {
        this.queue[kept++] = entry
      }
    }
    this.queue.length = kept
    this.tagBytes.delete(tag)
    if (this.queue.length === 0) this.settle()
    return dropped
  }

  clear(): void {
    this.queue.length = 0
    this.queued = 0
    this.tagBytes.clear()
    this.closeWhenEmpty = false
    this.settle()
  }


  /** Returns false when the peer is too far behind and the connection should be dropped. */
  send(bytes: Uint8Array, tag?: string): boolean {
    if (this.queue.length > 0) {
      if (this.queued + bytes.length > this.maxQueuedBytes) return false
      const entry: QueuedChunk = { bytes, started: false }
      if (tag !== undefined) entry.tag = tag
      this.queue.push(entry)
      this.queued += bytes.length
      this.addTagBytes(tag, bytes.length)
      return true
    }
    const written = Math.max(0, this.socket.write(bytes))
    if (written < bytes.length) {
      const rest = bytes.subarray(written)
      if (rest.length > this.maxQueuedBytes) return false
      const started = written > 0
      const entry: QueuedChunk = { bytes: rest, started }
      if (tag !== undefined) entry.tag = tag
      this.queue.push(entry)
      this.queued += rest.length
      if (!started) this.addTagBytes(tag, rest.length)
    } else {
      this.settle()
    }
    return true
  }


  drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      const written = Math.max(0, this.socket.write(head.bytes))
      this.queued -= written
      if (!head.started && written > 0) {
        this.removeTagBytes(head.tag, head.bytes.length)
        head.started = true
      }
      if (written < head.bytes.length) {
        head.bytes = head.bytes.subarray(written)
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

  private addTagBytes(tag: string | undefined, bytes: number): void {
    if (tag === undefined) return
    this.tagBytes.set(tag, (this.tagBytes.get(tag) ?? 0) + bytes)
  }

  private removeTagBytes(tag: string | undefined, bytes: number): void {
    if (tag === undefined) return
    const remaining = (this.tagBytes.get(tag) ?? 0) - bytes
    if (remaining === 0) this.tagBytes.delete(tag)
    else this.tagBytes.set(tag, remaining)
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
    if (this.closeWhenEmpty) this.socket.end()
  }
}
