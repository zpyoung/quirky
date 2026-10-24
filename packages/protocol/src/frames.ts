/**
 * Binary framing for terminal bytes, so output is never JSON-encoded.
 *
 * Daemon to client, one WebSocket binary message per frame:
 *   [kind u8 = TERMINAL_OUTPUT][streamId u32 BE][bytes...]
 *
 * PTY host socket (a byte stream), both directions:
 *   [kind u8][length u32 BE][payload]
 *   kind PTY_JSON: payload is one UTF-8 JSON message (see ./pty.ts)
 *   kind PTY_DATA: payload is [idLength u8][sessionId UTF-8][bytes...]
 *                  host to client is output; client to host is input
 */

export const WsFrameKind = { TerminalOutput: 1 } as const

export function encodeTerminalOutput(streamId: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + bytes.length)
  out[0] = WsFrameKind.TerminalOutput
  new DataView(out.buffer).setUint32(1, streamId >>> 0, false)
  out.set(bytes, 5)
  return out
}

export function decodeTerminalOutput(
  message: ArrayBuffer | Uint8Array
): { streamId: number; bytes: Uint8Array } | null {
  const view = message instanceof Uint8Array ? message : new Uint8Array(message)
  if (view.length < 5 || view[0] !== WsFrameKind.TerminalOutput) return null
  const streamId = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(1, false)
  return { streamId, bytes: view.subarray(5) }
}

export const PtyFrameKind = { Json: 0, Data: 1 } as const

const MAX_PTY_FRAME = 16 * 1024 * 1024

export function encodePtyJson(message: unknown): Uint8Array {
  return encodePtyFrame(PtyFrameKind.Json, new TextEncoder().encode(JSON.stringify(message)))
}

export function encodePtyData(sessionId: string, bytes: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(sessionId)
  if (id.length > 255) throw new Error('session id too long')
  const payload = new Uint8Array(1 + id.length + bytes.length)
  payload[0] = id.length
  payload.set(id, 1)
  payload.set(bytes, 1 + id.length)
  return encodePtyFrame(PtyFrameKind.Data, payload)
}

function encodePtyFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = kind
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

export type PtyFrame =
  | { kind: 'json'; message: unknown }
  | { kind: 'data'; sessionId: string; bytes: Uint8Array }

/** Reassembles PTY host frames from arbitrary socket chunks. */
export class PtyFrameDecoder {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): PtyFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.length)
    const frames: PtyFrame[] = []
    let pos = 0
    while (merged.length - pos >= 5) {
      const kind = merged[pos]
      const length = new DataView(merged.buffer, merged.byteOffset + pos + 1, 4).getUint32(0, false)
      if (length > MAX_PTY_FRAME) throw new Error(`pty frame too large: ${length}`)
      if (merged.length - pos - 5 < length) break
      const payload = merged.slice(pos + 5, pos + 5 + length)
      pos += 5 + length
      if (kind === PtyFrameKind.Json) {
        frames.push({ kind: 'json', message: JSON.parse(new TextDecoder().decode(payload)) })
      } else if (kind === PtyFrameKind.Data) {
        const idLength = payload[0]
        const sessionId = new TextDecoder().decode(payload.subarray(1, 1 + idLength))
        frames.push({ kind: 'data', sessionId, bytes: payload.subarray(1 + idLength) })
      } else {
        throw new Error(`unknown pty frame kind: ${kind}`)
      }
    }
    this.buffer = merged.slice(pos)
    return frames
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
