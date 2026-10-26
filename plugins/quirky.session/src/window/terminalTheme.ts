export type TerminalColors = { background: string; foreground: string; cursor: string }

/** The terminal's colors when no theme says otherwise. */
export const DEFAULT_TERMINAL_COLORS: TerminalColors = {
  background: '#16181d',
  foreground: '#d7dae0',
  cursor: '#d7dae0'
}

/** Terminal colors from theme variables, falling back per color to the defaults. */
export function terminalColors(variables: Record<string, string>): TerminalColors {
  const read = (name: string, fallback: string) => variables[name]?.trim() || fallback
  return {
    background: read('--terminal-background', DEFAULT_TERMINAL_COLORS.background),
    foreground: read('--terminal-foreground', DEFAULT_TERMINAL_COLORS.foreground),
    cursor: read('--terminal-cursor', DEFAULT_TERMINAL_COLORS.cursor)
  }
}

/** The terminal colors in effect at `element`, from the `--terminal-*` custom properties it inherits. */
export function readTerminalColors(element: Element): TerminalColors {
  const style = getComputedStyle(element)
  const variables: Record<string, string> = {}
  for (const name of ['--terminal-background', '--terminal-foreground', '--terminal-cursor']) {
    variables[name] = style.getPropertyValue(name)
  }
  return terminalColors(variables)
}
