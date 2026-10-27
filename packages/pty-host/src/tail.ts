/** Fixed-capacity buffer holding the most recent bytes of a session's output. */
export class TailBuffer {
  private readonly buffer: Uint8Array
  private writePos = 0
  private filled = 0
  /** Output position after the newest byte: `startTotal` plus every byte appended, overwritten or not. */
  total: number
  private readonly base: number

  /**
   * `startTotal` is the output position the first appended byte will have, for a session that
   * continues earlier output. Those earlier bytes are not this buffer's to have kept, so they
   * never count as dropped.
   */
  constructor(
    readonly capacity: number,
    startTotal = 0
  ) {
    this.buffer = new Uint8Array(capacity)
    this.total = startTotal
    this.base = startTotal
  }

  /** True once bytes appended to this buffer have been overwritten. */
  get wrapped(): boolean {
    return this.total - this.base > this.capacity
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
