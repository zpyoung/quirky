export type ReplayTarget = { write(data: Uint8Array, callback?: () => void): void }

export type InputGate = {
  allows(): boolean
  mute(): void
  unmute(): void
}

/** Decides whether terminal-generated input (`onData`) may reach the shell right now. */
export function createInputGate(): InputGate {
  let muted = false
  return {
    allows: () => !muted,
    mute: () => {
      muted = true
    },
    unmute: () => {
      muted = false
    }
  }
}

/**
 * Writes replayed output into the terminal with input muted until xterm has parsed it, so replies
 * to queries embedded in old output (cursor position, device attributes) never reach the live shell.
 */
export function writeReplay(term: ReplayTarget, bytes: Uint8Array, gate: InputGate): void {
  if (bytes.length === 0) return
  gate.mute()
  term.write(bytes, () => gate.unmute())
}
