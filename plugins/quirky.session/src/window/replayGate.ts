export type ReplayTarget = { write(data: Uint8Array, callback?: () => void): void }

export type InputGate = {
  allows(): boolean
  mute(): void
  unmute(): void
}

/** Decides whether terminal-generated input (`onData`) may reach the shell right now. */
export function createInputGate(): InputGate {
  let pendingReplays = 0
  return {
    allows: () => pendingReplays === 0,
    mute: () => {
      pendingReplays += 1
    },
    unmute: () => {
      pendingReplays = Math.max(0, pendingReplays - 1)
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
