export type TerminalColors = { background: string; foreground: string; cursor: string }

/** The terminal's colors when no theme says otherwise. */
export const DEFAULT_TERMINAL_COLORS: TerminalColors = {
  background: '#16181d',
  foreground: '#d7dae0',
  cursor: '#d7dae0'
}

/** Terminal colors from the host's theme variables, falling back per color to the defaults. */
export function terminalColors(variables: Record<string, string>): TerminalColors {
  return {
    background: variables['--terminal-background'] ?? DEFAULT_TERMINAL_COLORS.background,
    foreground: variables['--terminal-foreground'] ?? DEFAULT_TERMINAL_COLORS.foreground,
    cursor: variables['--terminal-cursor'] ?? DEFAULT_TERMINAL_COLORS.cursor
  }
}
