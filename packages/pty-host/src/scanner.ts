/** A notable event found in PTY output. */
export type ScanFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'title'; title: string }
  | { kind: 'cwd'; cwd: string }
  | { kind: 'ready' }
  | { kind: 'prompt' }
  | { kind: 'command-start' }
  | { kind: 'program-status'; body: string }

type State = 'ground' | 'esc' | 'esc-inter' | 'csi' | 'osc' | 'osc-esc' | 'string' | 'string-esc'

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a
const BACKSLASH = 0x5c
const RIGHT_BRACKET = 0x5d
const MAX_OSC_PAYLOAD = 4096
const MARKER = new TextEncoder().encode('777;quirky-shell-ready')

const isAbort = (b: number): boolean => b === CAN || b === SUB

/**
 * Incremental scanner over a PTY's output. It reports bells, titles, working directory, and prompt
 * marks as facts, and strips Quirky's shell-ready marker from the bytes. State carries across
 * `push` calls, so a sequence split at any byte position yields what the unsplit input would.
 */
export class OutputScanner {
  private state: State = 'ground'
  private utf8Need = 0
  private readonly payload = new Uint8Array(MAX_OSC_PAYLOAD)
  private payloadLen = 0
  private payloadOverflow = false
  // ESC ] plus the payload so far, kept back while the payload is still a prefix of the marker
  private held: number[] = []
  private lastTitle: string | null = null
  private lastCwd: string | null = null
  private out = new Uint8Array(0)
  private outLen = 0
  private facts: ScanFact[] = []

  /** True when a checkpoint taken at the end of the bytes seen so far lands between sequences. */
  get atBoundary(): boolean {
    return this.state === 'ground' && this.held.length === 0 && this.utf8Need === 0
  }

  /**
   * Scans one chunk. `bytes` is the chunk minus the ready marker; a pending ESC or a marker-looking
   * OSC prefix stays inside the scanner until a later byte decides what it was.
   */
  push(chunk: Uint8Array): { bytes: Uint8Array; facts: ScanFact[] } {
    // room for a previously held ESC ] + marker prefix to be released on top of the chunk itself
    this.out = new Uint8Array(chunk.length + MARKER.length + 8)
    this.outLen = 0
    this.facts = []
    for (let i = 0; i < chunk.length; i++) this.step(chunk[i]!)
    const result = { bytes: this.out.subarray(0, this.outLen), facts: this.facts }
    this.out = new Uint8Array(0)
    this.facts = []
    return result
  }

  private put(b: number): void {
    this.out[this.outLen++] = b
  }

  private step(b: number): void {
    switch (this.state) {
      case 'ground':
        if (b === ESC) {
          this.utf8Need = 0
          this.state = 'esc'
        } else if (b === BEL) {
          this.utf8Need = 0
          this.facts.push({ kind: 'bell' })
          this.put(b)
        } else {
          this.trackUtf8(b)
          this.put(b)
        }
        return
      case 'esc':
        this.stepEsc(b)
        return
      case 'esc-inter':
        if (b === ESC) this.state = 'esc'
        else {
          this.put(b)
          if (isAbort(b) || (b >= 0x30 && b <= 0x7e)) this.state = 'ground'
        }
        return
      case 'csi':
        if (b === ESC) this.state = 'esc'
        else {
          this.put(b)
          if (isAbort(b) || (b >= 0x40 && b <= 0x7e)) this.state = 'ground'
        }
        return
      case 'osc':
        this.stepOsc(b)
        return
      case 'osc-esc':
        this.stepOscEsc(b)
        return
      case 'string':
        this.put(b)
        if (b === ESC) this.state = 'string-esc'
        else if (isAbort(b)) this.state = 'ground'
        return
      case 'string-esc':
        this.put(b)
        if (b === BACKSLASH || isAbort(b)) this.state = 'ground'
        else if (b !== ESC) this.state = 'string'
        return
    }
  }

  /** The ESC that put us here is still unwritten: it may open the marker OSC. */
  private stepEsc(b: number): void {
    if (b === RIGHT_BRACKET) {
      this.state = 'osc'
      this.payloadLen = 0
      this.payloadOverflow = false
      this.held = [ESC, b]
      return
    }
    if (b === ESC) {
      this.put(ESC)
      return
    }
    this.put(ESC)
    this.put(b)
    if (b === 0x5b) this.state = 'csi'
    else if (b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) this.state = 'string'
    else if (b >= 0x20 && b <= 0x2f) this.state = 'esc-inter'
    else this.state = 'ground'
  }

  private stepOsc(b: number): void {
    if (b === BEL) {
      this.finishOsc([BEL])
    } else if (b === ESC) {
      this.state = 'osc-esc'
    } else if (isAbort(b)) {
      this.releaseHeld()
      this.put(b)
      this.state = 'ground'
    } else {
      this.appendPayload(b)
    }
  }

  private stepOscEsc(b: number): void {
    if (b === BACKSLASH) {
      this.finishOsc([ESC, BACKSLASH])
    } else if (isAbort(b)) {
      this.releaseHeld()
      this.put(ESC)
      this.put(b)
      this.state = 'ground'
    } else {
      // ESC not followed by ST ends the OSC unfinished and begins a new escape sequence
      this.releaseHeld()
      this.state = 'esc'
      this.step(b)
    }
  }

  private appendPayload(b: number): void {
    if (this.payloadLen < MAX_OSC_PAYLOAD) this.payload[this.payloadLen++] = b
    else this.payloadOverflow = true

    if (this.held.length > 0 && this.payloadLen <= MARKER.length && !this.payloadOverflow && this.matchesMarkerPrefix()) {
      this.held.push(b)
      return
    }
    this.releaseHeld()
    this.put(b)
  }

  private matchesMarkerPrefix(): boolean {
    for (let i = 0; i < this.payloadLen; i++) if (this.payload[i] !== MARKER[i]) return false
    return true
  }

  private releaseHeld(): void {
    for (const b of this.held) this.put(b)
    this.held = []
  }

  private finishOsc(terminator: number[]): void {
    this.state = 'ground'
    const isMarker =
      this.held.length > 0 && this.payloadLen === MARKER.length && !this.payloadOverflow && this.matchesMarkerPrefix()
    if (isMarker) {
      this.held = []
      this.facts.push({ kind: 'ready' })
      return
    }
    this.releaseHeld()
    for (const b of terminator) this.put(b)
    if (!this.payloadOverflow) this.reportOsc(new TextDecoder().decode(this.payload.subarray(0, this.payloadLen)))
  }

  private reportOsc(text: string): void {
    const sep = text.indexOf(';')
    if (sep === -1) return
    const code = text.slice(0, sep)
    const rest = text.slice(sep + 1)

    if (code === '0' || code === '2') {
      if (rest !== this.lastTitle) {
        this.lastTitle = rest
        this.facts.push({ kind: 'title', title: rest })
      }
    } else if (code === '7') {
      const cwd = parseFileUrlPath(rest)
      if (cwd !== null && cwd !== this.lastCwd) {
        this.lastCwd = cwd
        this.facts.push({ kind: 'cwd', cwd })
      }
    } else if (code === '133') {
      this.reportPromptMark(rest)
    } else if (code === '7501') {
      this.facts.push({ kind: 'program-status', body: rest })
    }
  }

  private reportPromptMark(mark: string): void {
    const [kind, arg] = mark.split(';')
    if (kind === 'A') this.facts.push({ kind: 'prompt' })
    else if (kind === 'C') this.facts.push({ kind: 'command-start' })
    else if (kind === 'D') {
      const exitCode = arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null
      this.facts.push({ kind: 'command-finished', exitCode })
    }
  }

  private trackUtf8(b: number): void {
    if (this.utf8Need > 0 && (b & 0xc0) === 0x80) {
      this.utf8Need--
      return
    }
    if (b >= 0xf0 && b <= 0xf7) this.utf8Need = 3
    else if (b >= 0xe0 && b <= 0xef) this.utf8Need = 2
    else if (b >= 0xc0 && b <= 0xdf) this.utf8Need = 1
    else this.utf8Need = 0
  }
}

/** Path part of a `file://host/path` URL, percent-decoded; null for any other URL. */
function parseFileUrlPath(url: string): string | null {
  if (!url.startsWith('file://')) return null
  const afterScheme = url.slice('file://'.length)
  const slash = afterScheme.indexOf('/')
  if (slash === -1) return null
  const rawPath = afterScheme.slice(slash)
  try {
    return decodeURIComponent(rawPath)
  } catch {
    return rawPath
  }
}
