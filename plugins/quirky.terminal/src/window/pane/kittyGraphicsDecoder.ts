const ESC = new Uint8Array([27])
const APC = new Uint8Array([27, 95])
const ASCII = new TextDecoder('ascii')

/** Recognizes only Kitty APC frames; ordinary output remains byte-exact and is not decoded. */
export class KittyGraphicsDecoder {
  private mode: 'text' | 'escape' | 'prefix' | 'frame' | 'end' = 'text'
  private parts: string[] = []
  private size = 0
  private overflow = false

  constructor(
    private readonly text: (bytes: Uint8Array) => void,
    private readonly frame: (data: string) => void,
    private readonly limit = 4 * 1024 * 1024
  ) {}
  get pending(): boolean { return this.mode !== 'text' }

  push(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) {
      if (this.mode === 'text') {
        const end = bytes.indexOf(27, offset)
        if (end < 0) { this.text(offset === 0 ? bytes : bytes.subarray(offset)); return }
        if (end > offset) this.text(bytes.subarray(offset, end))
        offset = end + 1
        this.mode = 'escape'
        continue
      }
      const byte = bytes[offset]!
      if (this.mode === 'escape') {
        if (byte === 95) { offset++; this.mode = 'prefix' }
        else { this.text(ESC); this.mode = 'text' }
      } else if (this.mode === 'prefix') {
        if (byte === 71) {
          offset++; this.mode = 'frame'; this.parts = []; this.size = 0; this.overflow = false
        } else { this.text(APC); this.mode = 'text' }
      } else if (this.mode === 'end') {
        if (byte === 92) {
          offset++; this.mode = 'text'
          if (!this.overflow) this.frame(this.parts.join(''))
          this.parts = []
        } else {
          this.append(ESC)
          this.mode = 'frame'
        }
      } else {
        if (byte === 24 || byte === 26) {
          offset++; this.parts = []; this.mode = 'text'
        } else if (byte === 27) {
          offset++; this.mode = 'end'
        } else {
          let end = offset + 1
          while (end < bytes.length && bytes[end] !== 27 && bytes[end] !== 24 && bytes[end] !== 26) end++
          this.append(bytes.subarray(offset, end))
          offset = end
        }
      }
    }
  }

  private append(bytes: Uint8Array): void {
    this.size += bytes.length
    if (this.overflow) return
    if (this.size > this.limit || bytes.some((byte) => byte > 127)) {
      this.overflow = true; this.parts = []
      return
    }
    this.parts.push(ASCII.decode(bytes))
  }

  dispose(): void { this.parts = []; this.mode = 'text'; this.size = 0; this.overflow = false }
}
