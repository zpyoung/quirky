import { WsFrameKind } from '@quirky/protocol'

const STREAM_BYTE_LIMIT = 4 * 1024 * 1024
const BINARY_BYTE_LIMIT = 8 * 1024 * 1024
const CONTROL_BYTE_LIMIT = 16 * 1024 * 1024

export type WebSocketOutputSocket = {
  readonly readyState: number
  getBufferedAmount(): number
  send(text: string, compress?: boolean): number
  sendBinary(bytes: Uint8Array, compress?: boolean): number
}

type LedgerEntry = {
  remaining: number
  streamId: number | null
  countsBinaryOutput: boolean
}

type PendingControl =
  | { kind: 'text'; text: string; wireBytes: number }
  | { kind: 'binary'; bytes: Uint8Array; wireBytes: number; markerStreamId: number }

function frameWireLength(payloadBytes: number): number {
  const headerBytes = payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10
  return payloadBytes + headerBytes
}

function terminalStreamId(bytes: Uint8Array): number | null {
  if (bytes[0] !== WsFrameKind.TerminalOutput || bytes.byteLength < 5) return null
  return (bytes[1] * 0x1000000 + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4]) >>> 0
}

function laggedStreamId(bytes: Uint8Array): number | null {
  if (bytes[0] !== WsFrameKind.TerminalLagged || bytes.byteLength !== 5) return null
  return (bytes[1] * 0x1000000 + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4]) >>> 0
}

export class WebSocketOutput {
  private disposed = false
  private readonly ledger: LedgerEntry[] = []
  private ledgerHead = 0
  private readonly streamBytes = new Map<number, number>()
  private outstandingBytes = 0
  private binaryBytes = 0
  private readonly controls: (PendingControl | undefined)[] = []
  private controlHead = 0
  private pendingControlBytes = 0

  constructor(
    private readonly socket: WebSocketOutputSocket,
    private readonly fail: () => void
  ) {}

  sendText(text: string): void {
    if (!this.ensureOpen()) return
    try {
      this.enqueueOrSendControl({
        kind: 'text',
        text,
        wireBytes: frameWireLength(Buffer.byteLength(text, 'utf8'))
      })
    } catch {
      this.failOnce()
    }
  }

  sendBinary(bytes: Uint8Array): boolean {
    if (!this.ensureOpen()) return false
    try {
      this.reconcile()
      const markerStreamId = laggedStreamId(bytes)
      if (markerStreamId !== null) {
        return this.enqueueOrSendControl({
          kind: 'binary',
          bytes,
          wireBytes: frameWireLength(bytes.byteLength),
          markerStreamId
        })
      }
      if (this.hasPendingControls()) return false

      const streamId = terminalStreamId(bytes)
      const wireBytes = frameWireLength(bytes.byteLength)
      const streamOutstanding = streamId === null ? 0 : (this.streamBytes.get(streamId) ?? 0)
      if (
        (streamId !== null && streamOutstanding + wireBytes > STREAM_BYTE_LIMIT) ||
        this.binaryBytes + wireBytes > BINARY_BYTE_LIMIT
      ) {
        return false
      }

      const result = this.socket.sendBinary(bytes, false)
      if (result === 0) {
        this.reconcile()
        return false
      }
      if (!(result > 0 || result === -1)) {
        this.failOnce()
        return false
      }

      this.appendLedger(wireBytes, streamId, true)
      this.reconcile()
      return true
    } catch {
      this.failOnce()
      return false
    }
  }

  closeStream(streamId: number): void {
    if (this.disposed) return
    for (let index = this.controlHead; index < this.controls.length; index++) {
      const control = this.controls[index]
      if (control?.kind !== 'binary' || control.markerStreamId !== streamId) continue
      this.pendingControlBytes -= control.wireBytes
      this.controls[index] = undefined
    }
    this.compactControls()
  }

  drain(): void {
    if (!this.ensureOpen()) return
    try {
      this.reconcile()
      this.flushControls()
    } catch {
      this.failOnce()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearState()
  }

  private enqueueOrSendControl(control: PendingControl): boolean {
    if (control.wireBytes > CONTROL_BYTE_LIMIT || this.pendingControlBytes + control.wireBytes > CONTROL_BYTE_LIMIT) {
      this.failOnce()
      return false
    }
    if (this.hasPendingControls()) return this.enqueueControl(control)
    return this.sendControlNow(control)
  }

  private sendControlNow(control: PendingControl): boolean {
    if (!this.ensureOpen()) return false
    this.reconcile()
    const result = this.sendNativeControl(control)
    if (result === 0) {
      const buffered = this.reconcile()
      if (buffered === 0) {
        this.failOnce()
        return false
      }
      return this.enqueueControl(control)
    }
    if (!(result > 0 || result === -1)) {
      this.failOnce()
      return false
    }

    this.appendLedger(control.wireBytes, null, false)
    this.reconcile()
    return true
  }

  private flushControls(): void {
    this.skipRemovedControls()
    while (this.controlHead < this.controls.length) {
      if (!this.ensureOpen()) return
      const control = this.controls[this.controlHead]
      if (!control) {
        this.controlHead++
        this.skipRemovedControls()
        continue
      }

      this.reconcile()
      const result = this.sendNativeControl(control)
      if (result === 0) {
        if (this.reconcile() === 0) this.failOnce()
        return
      }
      if (!(result > 0 || result === -1)) {
        this.failOnce()
        return
      }

      this.appendLedger(control.wireBytes, null, false)
      this.pendingControlBytes -= control.wireBytes
      this.controls[this.controlHead] = undefined
      this.controlHead++
      this.reconcile()
      if (this.disposed) return
      this.skipRemovedControls()
    }
    this.compactControls()
  }

  private sendNativeControl(control: PendingControl): number {
    return control.kind === 'text'
      ? this.socket.send(control.text, false)
      : this.socket.sendBinary(control.bytes, false)
  }

  private enqueueControl(control: PendingControl): boolean {
    if (this.pendingControlBytes + control.wireBytes > CONTROL_BYTE_LIMIT) {
      this.failOnce()
      return false
    }
    this.controls.push(control)
    this.pendingControlBytes += control.wireBytes
    return true
  }

  private hasPendingControls(): boolean {
    this.skipRemovedControls()
    return this.controlHead < this.controls.length
  }

  private skipRemovedControls(): void {
    while (this.controlHead < this.controls.length && this.controls[this.controlHead] === undefined) {
      this.controlHead++
    }
  }

  private compactControls(): void {
    this.skipRemovedControls()
    if (this.controlHead === this.controls.length) {
      this.controls.length = 0
      this.controlHead = 0
    } else if (this.controlHead > 64 && this.controlHead * 2 >= this.controls.length) {
      this.controls.splice(0, this.controlHead)
      this.controlHead = 0
    }
  }

  private appendLedger(wireBytes: number, streamId: number | null, countsBinaryOutput: boolean): void {
    this.ledger.push({ remaining: wireBytes, streamId, countsBinaryOutput })
    this.outstandingBytes += wireBytes
    if (countsBinaryOutput) this.binaryBytes += wireBytes
    if (streamId !== null) this.streamBytes.set(streamId, (this.streamBytes.get(streamId) ?? 0) + wireBytes)
  }

  private reconcile(): number {
    const buffered = this.socket.getBufferedAmount()
    if (!Number.isSafeInteger(buffered) || buffered < 0) throw new Error('invalid WebSocket buffered amount')
    if (buffered > this.outstandingBytes) {
      this.appendLedger(buffered - this.outstandingBytes, null, false)
      return buffered
    }

    let drained = this.outstandingBytes - buffered
    while (drained > 0) {
      const entry = this.ledger[this.ledgerHead]
      if (!entry) break
      const consumed = Math.min(entry.remaining, drained)
      entry.remaining -= consumed
      drained -= consumed
      this.outstandingBytes -= consumed
      if (entry.countsBinaryOutput) this.binaryBytes -= consumed
      if (entry.streamId !== null) {
        const outstanding = (this.streamBytes.get(entry.streamId) ?? 0) - consumed
        if (outstanding === 0) this.streamBytes.delete(entry.streamId)
        else this.streamBytes.set(entry.streamId, outstanding)
      }
      if (entry.remaining === 0) this.ledgerHead++
    }
    this.compactLedger()
    return buffered
  }

  private compactLedger(): void {
    if (this.ledgerHead === this.ledger.length) {
      this.ledger.length = 0
      this.ledgerHead = 0
    } else if (this.ledgerHead > 64 && this.ledgerHead * 2 >= this.ledger.length) {
      this.ledger.splice(0, this.ledgerHead)
      this.ledgerHead = 0
    }
  }

  private ensureOpen(): boolean {
    if (this.disposed) return false
    if (this.socket.readyState === 1) return true
    this.failOnce()
    return false
  }

  private failOnce(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearState()
    try {
      this.fail()
    } catch {
      return
    }
  }

  private clearState(): void {
    this.ledger.length = 0
    this.ledgerHead = 0
    this.streamBytes.clear()
    this.outstandingBytes = 0
    this.binaryBytes = 0
    this.controls.length = 0
    this.controlHead = 0
    this.pendingControlBytes = 0
  }
}
