/** Decodes byte-counted JSON frames shared by tsserver and LSP. */
export class MessageReader {
  private buffer = Buffer.alloc(0)
  private length: number | undefined

  push(chunk: Uint8Array): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    const messages: unknown[] = []
    while (true) {
      if (this.length === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) break
        const header = this.buffer.subarray(0, end).toString('ascii')
        const match = /^content-length:\s*(\d+)\s*$/im.exec(header)
        if (!match) throw new Error('Missing Content-Length header')
        const length = Number(match[1])
        if (!Number.isSafeInteger(length)) throw new Error('Invalid Content-Length header')
        this.length = length
        this.buffer = this.buffer.subarray(end + 4)
      }
      if (this.buffer.length < this.length) break
      const body = this.buffer.subarray(0, this.length).toString('utf8')
      this.buffer = this.buffer.subarray(this.length)
      this.length = undefined
      messages.push(JSON.parse(body))
    }
    return messages
  }
}
