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

/** `color` (#rgb or #rrggbb) with `alpha` applied as an rgba() string; any other format, or an alpha of 1, is returned as it was. */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return color
  const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join('') : hex[1]!
  const [red, green, blue] = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16))
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, alpha)})`
}
