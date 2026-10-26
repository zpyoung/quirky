import type { ClaudeQuery, ClaudeQueryParams } from '../../claude-runner'

/** A scripted stand-in for the Agent SDK's `Query`: tests push messages and read what the runner wrote. */
export class FakeQuery implements ClaudeQuery {
  written: any[] = []
  interrupted = 0
  closed = 0
  private buffer: any[] = []
  private waiting: { resolve: (r: IteratorResult<any>) => void; reject: (e: Error) => void } | null = null
  private failure: Error | null = null
  private ended = false

  constructor(readonly params: ClaudeQueryParams) {
    void (async () => {
      for await (const message of params.prompt) this.written.push(message)
    })()
  }

  emit(message: any) {
    if (this.waiting) {
      this.waiting.resolve({ value: message, done: false })
      this.waiting = null
    } else this.buffer.push(message)
  }

  end() {
    this.ended = true
    this.waiting?.resolve({ value: undefined, done: true })
    this.waiting = null
  }

  fail(error: Error) {
    this.failure = error
    this.waiting?.reject(error)
    this.waiting = null
  }

  async interrupt() {
    this.interrupted++
  }

  close() {
    this.closed++
    this.end()
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<any>> {
    if (this.buffer.length) return { value: this.buffer.shift(), done: false }
    if (this.failure) throw this.failure
    if (this.ended) return { value: undefined, done: true }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }
}
