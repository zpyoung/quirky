/** Fixed-capacity buffer holding the most recent bytes of a session's output. */
export class TailBuffer {
  private readonly buffer: Uint8Array
  private writePos = 0
  private filled = 0
  /** Total bytes ever appended, including those that have been overwritten. */
  total = 0

  constructor(readonly capacity: number) {
    this.buffer = new Uint8Array(capacity)
  }

  /** True once earlier bytes have been dropped. */
  get wrapped(): boolean {
    return this.total > this.capacity
  }

  append(bytes: Uint8Array): void {
    this.total += bytes.length
    if (bytes.length >= this.capacity) {
      this.buffer.set(bytes.subarray(bytes.length - this.capacity))
      this.writePos = 0
      this.filled = this.capacity
      return
    }
    const head = Math.min(bytes.length, this.capacity - this.writePos)
    this.buffer.set(bytes.subarray(0, head), this.writePos)
    this.buffer.set(bytes.subarray(head), 0)
    this.writePos = (this.writePos + bytes.length) % this.capacity
    this.filled = Math.min(this.capacity, this.filled + bytes.length)
  }

  /** The retained bytes in output order. */
  snapshot(): Uint8Array {
    if (this.filled < this.capacity) return this.buffer.slice(0, this.filled)
    const out = new Uint8Array(this.capacity)
    out.set(this.buffer.subarray(this.writePos), 0)
    out.set(this.buffer.subarray(0, this.writePos), this.capacity - this.writePos)
    return out
  }

  /**
   * What a new subscriber should be sent: the whole tail, or, once it has wrapped, the part after
   * its first newline so the replay never starts in the middle of a line.
   */
  replay(): Uint8Array {
    const bytes = this.snapshot()
    if (!this.wrapped) return bytes
    const newline = bytes.indexOf(10)
    return newline < 0 ? bytes : bytes.subarray(newline + 1)
  }
}
